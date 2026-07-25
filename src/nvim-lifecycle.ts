import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NeovimClient } from "./neovim-client";
import { NvimServer, NvimCommand } from "./nvim-server";
import type { EditsEntry } from "./types";
import { existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

const SOCKET_PREFIX = "/tmp/pi-nvim";
const PID = process.pid;

function nvimSocketPath(): string {
  return `${SOCKET_PREFIX}-${PID}.sock`;
}

function nvimBackSocketPath(): string {
  return `${SOCKET_PREFIX}-back-${PID}.sock`;
}

export type { EditsEntry };

export type ConnectionStatus = "disconnected" | "connected";

/**
 * Operating mode of the extension.
 *
 * - "tmux":     pi.dev runs in a tmux pane. The extension spawns a separate
 *               Neovim instance in a right-side tmux pane via tmux split-window.
 *               Used when pi.dev is launched from a tmux session.
 *
 * - "embedded": pi.dev runs inside a Neovim :terminal buffer. The extension
 *               communicates directly with the host Neovim via the $NVIM socket
 *               that Neovim exports to all terminal children. No tmux commands.
 *               Detected automatically when $NVIM is set.
 */
export type NvimMode = "tmux" | "embedded";

/** Detect the operating mode from the environment. */
export function detectMode(): NvimMode {
  return process.env.NVIM ? "embedded" : "tmux";
}

/**
 * Manages the full lifecycle of the Neovim instance:
 * spawn, connect, Lua injection, reverse server, shutdown.
 */
export function createNvimLifecycle(pi: ExtensionAPI, luaDir: string) {
  const mode: NvimMode = detectMode();
  // In embedded mode, the host Neovim's RPC socket is available via $NVIM.
  // In tmux mode, we spawn a fresh Neovim with --listen to create our own.
  const hostNvimSocket: string | null = mode === "embedded" ? (process.env.NVIM || null) : null;

  let status: ConnectionStatus = "disconnected";
  let client: NeovimClient | null = null;
  let server: NvimServer | null = null;
  let tmuxPaneId: string | null = null;
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

  /**
   * Open Neovim: in tmux mode, spawn a new Neovim in a tmux split pane.
   * In embedded mode, connect to the host Neovim via $NVIM socket.
   */
  async function open(params: {
    files?: string[];
    focus_file?: string;
    focus_line?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
    // ── helper: open files/focus whether first connection or subsequent call ──
    async function openRequestedFiles(p: typeof params) {
      if (!client?.isConnected) return;
      if (p.files && p.files.length > 0) {
        for (const file of p.files) {
          try { await client.openFile(file); } catch { /* may not exist yet */ }
        }
      }
      if (p.focus_file) {
        try {
          await client.openFile(p.focus_file);
          if (p.focus_line) await client.setCursor(p.focus_line);
        } catch { /* best effort */ }
      }
    }

    if (status === "connected") {
      // Already connected — still open any requested files.
      await openRequestedFiles(params);
      return {
        content: [{ type: "text", text: "Neovim is already open and connected." }],
        details: { status: "connected" },
      };
    }

    let nvimSocket: string;

    if (mode === "tmux") {
      // ── tmux mode: spawn a fresh Neovim instance ──────────────────
      nvimSocket = nvimSocketPath();
      const targetPane = process.env.TMUX_PANE || "";
      const spawnCmd = `tmux split-window -h -l 50% ${targetPane ? "-t " + targetPane : ""} -P -F '#{pane_id}' nvim --listen ${nvimSocket}`;

      try {
        tmuxPaneId = execSync(spawnCmd, { encoding: "utf-8", timeout: 5000 }).trim();
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to spawn Neovim: ${err.message || err}` }],
          details: { status: "error", error: String(err) },
        };
      }

      // Wait for the Neovim socket to appear
      await waitForSocket(nvimSocket, 5000);
    } else {
      // ── embedded mode: connect to the host Neovim socket ──────────
      if (!hostNvimSocket) {
        return {
          content: [{ type: "text", text: "Embedded mode detected ($NVIM set) but socket path is empty." }],
          details: { status: "error" },
        };
      }
      nvimSocket = hostNvimSocket;
    }

    // Connect msgpack-RPC client (common path for both modes)
    client = new NeovimClient();
    try {
      await client.connect(nvimSocket);
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Failed to connect to Neovim RPC: ${err.message || err}` }],
        details: { status: "error", error: String(err) },
      };
    }

    // 4. Inject Lua support module via require(). Directory resolved
    //    at factory init since __dirname is unreliable in pi's runtime.
    try {
      const escaped = luaDir.replace(/\\/g, "\\\\");
      await client.execLua(`package.path = package.path .. ";${escaped}/?.lua;${escaped}/?/init.lua"`);
      await client.execLua(`require("pi-nvim"); return nil`);
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Failed to inject Lua module: ${err.message || err}` }],
        details: { status: "error", error: String(err) },
      };
    }

    // 5. Start the reverse-command server FIRST so the socket exists
    //    when the Lua module's setup() tries to connect.
    const backSocket = nvimBackSocketPath();
    server = new NvimServer(backSocket);
    await server.start(handleNvimCommand);

    // 6. Now call setup — the socket is ready for connection
    try {
      await client.execLua(
        `return require("pi-nvim").setup({ socket_path = "${backSocket}", pi_pid = ${PID} })`,
      );
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Failed to setup Lua module: ${err.message || err}` }],
        details: { status: "error", error: String(err) },
      };
    }

    // 7. Open requested files
    await openRequestedFiles(params);

    status = "connected";

    const modeLabel = mode === "embedded" ? `host Neovim (${nvimSocket})` : "right tmux pane";
    return {
      content: [
        {
          type: "text",
          text: `Connected to ${modeLabel}. RPC established. Lua module injected. Back-channel server listening.`,
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

  /**
   * Push the edits list to Neovim's scratch buffer.
   */
  async function pushEditsBuffer(entries: EditsEntry[]): Promise<void> {
    if (!client || !client.isConnected) return;
    await client.updateEditsBuffer(entries);
  }

  /**
   * Shut down the integration.
   *
   * In tmux mode: quit the spawned Neovim and kill its tmux pane.
   * In embedded mode: disconnect only — the host Neovim must stay alive.
   */
  async function shutdown(): Promise<void> {
    if (mode === "tmux") {
      // Quit the Neovim we spawned
      if (client?.isConnected) {
        try {
          await client.command("qa!", 3_000);
        } catch {
          // Best effort
        }
      }

      // Kill the tmux pane we spawned
      if (tmuxPaneId) {
        try {
          execSync(`tmux kill-pane -t ${tmuxPaneId}`, { timeout: 3000 });
        } catch {
          // Best effort
        }
      }
    }
    // In embedded mode: just disconnect — never kill the host Neovim.

    cleanup();
  }

  /**
   * Handle disconnect from Neovim (user closed it, or crashed).
   */
  function handleDisconnect(_reason: "user_closed" | "crashed" | "unknown"): void {
    cleanup();
  }

  function cleanup(): void {
    client?.disconnect();
    server?.stop();
    client = null;
    server = null;
    tmuxPaneId = null;
    status = "disconnected";

    // Clean up socket files we created.
    // In tmux mode: remove both the --listen socket and the back-channel socket.
    // In embedded mode: only remove the back-channel socket (the host socket is
    // owned by the parent Neovim, not us).
    const socketsToClean = mode === "tmux"
      ? [nvimSocketPath(), nvimBackSocketPath()]
      : [nvimBackSocketPath()];
    for (const sock of socketsToClean) {
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
      case "pi_prompt":
        pi.sendUserMessage(cmd.text as string, { deliverAs: "followUp" });
        break;
      case "pi_edit": {
        const e = cmd as { cmd: "pi_edit"; file: string; diff: string; added?: number; removed?: number };
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
        const s = cmd as {
          cmd: "pi_select";
          file: string;
          lines: string;
          line_start?: number;
          line_end?: number;
          prompt?: string;
        };
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
    if (!client?.isConnected) return;
    await client.reloadFile(filepath);
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

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Poll for a Unix socket file to appear.
 */
function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (existsSync(path)) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for socket: ${path}`));
      } else {
        setTimeout(check, 100);
      }
    }
    check();
  });
}

// NOTE: No module-level singleton. The extension factory is re-invoked on
// /resume, /new, /fork, and /reload, each time with a fresh `pi` bound to
// the new session. A cached instance would hold a stale `pi` and throw when
// Neovim sends commands ("This extension ctx is stale after session
// replacement or reload"). Create a fresh lifecycle per factory invocation.
