import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NeovimClient } from "./neovim-client";
import { NvimServer, NvimCommand } from "./nvim-server";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const SOCKET_PREFIX = "/tmp/pi-nvim";
const PID = process.pid;

function nvimSocketPath(): string {
  return `${SOCKET_PREFIX}-${PID}.sock`;
}

function nvimBackSocketPath(): string {
  return `${SOCKET_PREFIX}-back-${PID}.sock`;
}

export type ConnectionStatus = "disconnected" | "connected";

export interface QuickfixEntry {
  filename: string;
  lnum: number;
  col: number;
  text: string;
}

/**
 * Manages the full lifecycle of the Neovim instance:
 * spawn, connect, Lua injection, reverse server, shutdown.
 */
export function createNvimLifecycle(pi: ExtensionAPI) {
  let status: ConnectionStatus = "disconnected";
  let client: NeovimClient | null = null;
  let server: NvimServer | null = null;
  let tmuxPaneId: string | null = null;

  function isReady(): boolean {
    return status === "connected";
  }

  function getStatus(): ConnectionStatus {
    return status;
  }

  /**
   * Open Neovim: split tmux pane, start nvim, connect, inject Lua, push quickfix.
   */
  async function open(params: {
    files?: string[];
    focus_file?: string;
    focus_line?: number;
  }): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
    if (status === "connected") {
      return {
        content: [{ type: "text", text: "Neovim is already open and connected." }],
        details: { status: "connected" },
      };
    }

    // 1. Spawn Neovim in a new tmux pane, capturing the pane ID
    const nvimSocket = nvimSocketPath();
    const spawnCmd = `tmux split-window -h -l 50% -P -F '#{pane_id}' nvim --listen ${nvimSocket}`;

    try {
      tmuxPaneId = execSync(spawnCmd, { encoding: "utf-8", timeout: 5000 }).trim();
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Failed to spawn Neovim: ${err.message || err}` }],
        details: { status: "error", error: String(err) },
      };
    }

    // 2. Wait for the Neovim socket to appear
    await waitForSocket(nvimSocket, 5000);

    // 3. Connect msgpack-RPC client
    client = new NeovimClient();
    try {
      await client.connect(nvimSocket);
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Failed to connect to Neovim RPC: ${err.message || err}` }],
        details: { status: "error", error: String(err) },
      };
    }

    // 4. Inject Lua support module
    const luaPath = resolve(__dirname, "..", "lua", "pi-nvim.lua");
    if (!existsSync(luaPath)) {
      return {
        content: [{ type: "text", text: `Lua module not found at ${luaPath}` }],
        details: { status: "error" },
      };
    }
    const luaSource = readFileSync(luaPath, "utf-8");
    try {
      await client.execLua(luaSource);
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Failed to inject Lua module: ${err.message || err}` }],
        details: { status: "error", error: String(err) },
      };
    }

    // 5. Call the Lua setup function with the back-socket path
    const backSocket = nvimBackSocketPath();
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

    // 6. Start the reverse-command server
    server = new NvimServer(backSocket);
    await server.start(handleNvimCommand);

    // 7. Open requested files
    if (params.files && params.files.length > 0) {
      for (const file of params.files) {
        try {
          await client.openFile(file);
        } catch {
          // File might not exist yet — that's fine
        }
      }
    }
    if (params.focus_file) {
      try {
        await client.openFile(params.focus_file);
        if (params.focus_line) {
          await client.setCursor(params.focus_line);
        }
      } catch {
        // Best effort
      }
    }

    status = "connected";

    return {
      content: [
        {
          type: "text",
          text: `Neovim opened in right pane. RPC connected. Lua module injected. Back-channel server listening.`,
        },
      ],
      details: {
        status: "connected",
        nvim_socket: nvimSocket,
        back_socket: backSocket,
      },
    };
  }

  /**
   * Push the quickfix list to Neovim.
   */
  async function pushQuickfix(entries: QuickfixEntry[]): Promise<void> {
    if (!client || !client.isConnected) return;
    await client.setQuickfixList(entries, "pi-neovim modified files");
  }

  /**
   * Shut down Neovim: close the tmux pane, disconnect, clean up sockets.
   */
  async function shutdown(): Promise<void> {
    if (client?.isConnected) {
      try {
        await client.command("qa!");
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

    // Clean up socket files
    for (const sock of [nvimSocketPath(), nvimBackSocketPath()]) {
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
        // Send the prompt to pi as a user message
        pi.sendUserMessage(cmd.text as string, { deliverAs: "followUp" });
        break;
      case "pi_edit":
        // Not yet implemented — will be used for two-way editing
        break;
      case "pi_open_file":
        // Not yet implemented
        break;
      case "pi_select":
        // Not yet implemented
        break;
    }
  }

  return {
    open,
    pushQuickfix,
    shutdown,
    handleDisconnect,
    isReady,
    getStatus,
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

// Singleton
let lifecycleInstance: ReturnType<typeof createNvimLifecycle> | null = null;

export function getLifecycle(pi: ExtensionAPI) {
  if (!lifecycleInstance) {
    lifecycleInstance = createNvimLifecycle(pi);
  }
  return lifecycleInstance;
}
