import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NvimEditor } from "./nvim-editor";
import {
  NvimServer,
  NvimCommand,
  PiPromptCommand,
  PiEditCommand,
  PiSelectCommand,
} from "./nvim-server";
import {
  createBackend,
  detectMode,
  nvimBackSocketPath,
  type NvimBackend,
  type NvimMode,
} from "./nvim-backend";
import type { EditsEntry } from "./types";
import { existsSync, unlinkSync } from "node:fs";

const PID = process.pid;

export type { EditsEntry, NvimMode };
export { detectMode };

export type ConnectionStatus = "disconnected" | "connected";

interface OpenParams {
  files?: string[];
  focus_file?: string;
  focus_line?: number;
}

interface OpenResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function errorResult(text: string, err?: unknown): OpenResult {
  return {
    content: [{ type: "text", text }],
    details: err !== undefined ? { status: "error", error: String(err) } : { status: "error" },
  };
}

/**
 * Manages the full lifecycle of the Neovim integration: acquiring the
 * instance (delegated to the mode-specific {@link NvimBackend}), connecting,
 * Lua injection, the reverse-command server, and shutdown.
 */
export function createNvimLifecycle(pi: ExtensionAPI, luaDir: string) {
  const backend: NvimBackend = createBackend();
  const mode = backend.mode;

  let status: ConnectionStatus = "disconnected";
  let editor: NvimEditor | null = null;
  let server: NvimServer | null = null;
  let onRefreshEdits: (() => void) | null = null;

  function setEditsRefreshHandler(handler: () => void) {
    onRefreshEdits = handler;
  }

  function isReady(): boolean {
    return status === "connected";
  }

  function getStatus(): ConnectionStatus {
    return status;
  }

  /** Open the requested files / focus, whether first connection or subsequent call. */
  async function openRequestedFiles(p: OpenParams) {
    if (!editor?.isConnected) return;
    if (p.files && p.files.length > 0) {
      for (const file of p.files) {
        try { await editor.openFile(file); } catch { /* may not exist yet */ }
      }
    }
    if (p.focus_file) {
      try {
        await editor.openFile(p.focus_file);
        if (p.focus_line) await editor.setCursor(p.focus_line);
      } catch { /* best effort */ }
    }
  }

  /**
   * Open Neovim: the backend acquires the RPC socket (spawning in tmux mode,
   * or returning the host $NVIM socket in embedded mode); the rest of the
   * setup path is identical for both modes.
   */
  async function open(params: OpenParams): Promise<OpenResult> {
    if (status === "connected") {
      // Already connected — still open any requested files.
      await openRequestedFiles(params);
      return {
        content: [{ type: "text", text: "Neovim is already open and connected." }],
        details: { status: "connected" },
      };
    }

    let nvimSocket: string;
    try {
      nvimSocket = await backend.acquireSocket();
    } catch (err: any) {
      return errorResult(`Failed to start Neovim: ${err.message || err}`, err);
    }

    // Connect the RPC transport (common path for both modes).
    editor = new NvimEditor();
    try {
      await editor.connect(nvimSocket);
    } catch (err: any) {
      return errorResult(`Failed to connect to Neovim RPC: ${err.message || err}`, err);
    }

    // Inject the Lua support module via require(). luaDir was resolved at
    // factory init since __dirname is unreliable in pi's runtime.
    try {
      await editor.injectModule(luaDir);
    } catch (err: any) {
      return errorResult(`Failed to inject Lua module: ${err.message || err}`, err);
    }

    // Start the reverse-command server FIRST so the socket exists when the
    // Lua module's setup() tries to connect back.
    const backSocket = nvimBackSocketPath();
    server = new NvimServer(backSocket);
    await server.start(handleNvimCommand);

    // Now call setup — the back-channel socket is ready for connection.
    try {
      await editor.setup(backSocket, PID);
    } catch (err: any) {
      return errorResult(`Failed to setup Lua module: ${err.message || err}`, err);
    }

    await openRequestedFiles(params);

    status = "connected";

    return {
      content: [
        {
          type: "text",
          text: `Connected to ${backend.connectionLabel(nvimSocket)}. RPC established. Lua module injected. Back-channel server listening.`,
        },
      ],
      details: {
        status: "connected",
        mode,
        nvim_socket: nvimSocket,
        back_socket: backSocket,
      },
    };
  }

  /** Push the edits list to Neovim's scratch buffer. */
  async function pushEditsBuffer(entries: EditsEntry[]): Promise<void> {
    if (!editor?.isConnected) return;
    await editor.updateEditsBuffer(entries);
  }

  /**
   * Shut down the integration. The backend tears down whatever it spawned
   * (in embedded mode that's nothing — the host Neovim stays alive).
   */
  async function shutdown(): Promise<void> {
    await backend.teardown(editor);
    cleanup();
  }

  /** Handle disconnect from Neovim (user closed it, or crashed). */
  function handleDisconnect(_reason: "user_closed" | "crashed" | "unknown"): void {
    cleanup();
  }

  function cleanup(): void {
    editor?.disconnect();
    server?.stop();
    editor = null;
    server = null;
    status = "disconnected";

    // Remove the socket files this backend owns.
    for (const sock of backend.ownedSockets()) {
      try {
        if (existsSync(sock)) unlinkSync(sock);
      } catch {
        // Best effort
      }
    }
  }

  // ── internal ─────────────────────────────────────────────────────

  function handleNvimCommand(cmd: NvimCommand): void {
    switch (cmd.cmd) {
      case "pi_exit":
        handleDisconnect("user_closed");
        break;
      case "pi_prompt": {
        const p = cmd as PiPromptCommand;
        pi.sendUserMessage(p.text, { deliverAs: "followUp" });
        break;
      }
      case "pi_edit": {
        const e = cmd as PiEditCommand;
        const summary = e.added !== undefined
          ? `User saved ${e.file} (+${e.added}/-${e.removed} lines)`
          : `User saved ${e.file}`;
        pi.sendMessage({
          customType: "nvim-edit",
          content: `[neovim] ${summary}\n\`\`\`diff\n${e.diff}\n\`\`\``,
          display: true,
        });
        break;
      }
      case "pi_select": {
        const s = cmd as PiSelectCommand;
        const lineRange = (s.line_start !== undefined && s.line_end !== undefined)
          ? ` (lines ${s.line_start}-${s.line_end})`
          : "";
        const selectionBlock = `Selection from ${s.file}${lineRange}:\n\`\`\`\n${s.lines}\n\`\`\``;
        const prompt = (s.prompt || "").trim();
        if (prompt === "") {
          // No prompt from user; selection only.
          pi.sendUserMessage(`${selectionBlock}`, { deliverAs: "followUp" });
          break;
        }
        pi.sendUserMessage(`${prompt}\n\n${selectionBlock}`, { deliverAs: "followUp" });
        break;
      }
      case "pi_open_file":
        if (onRefreshEdits) onRefreshEdits();
        break;
    }
  }

  async function reloadFile(filepath: string): Promise<void> {
    if (!editor?.isConnected) return;
    await editor.reloadFile(filepath);
  }

  return {
    open,
    pushEditsBuffer,
    reloadFile,
    shutdown,
    handleDisconnect,
    setEditsRefreshHandler,
    isReady,
    getStatus,
    getMode: () => mode,
  };
}

// NOTE: No module-level singleton. The extension factory is re-invoked on
// /resume, /new, /fork, and /reload, each time with a fresh `pi` bound to
// the new session. A cached instance would hold a stale `pi` and throw when
// Neovim sends commands ("This extension ctx is stale after session
// replacement or reload"). Create a fresh lifecycle per factory invocation.
