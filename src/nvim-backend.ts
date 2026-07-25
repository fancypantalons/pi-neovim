import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import type { NvimEditor } from "./nvim-editor";

const SOCKET_PREFIX = "/tmp/pi-nvim";
const PID = process.pid;

export function nvimSocketPath(): string {
  return `${SOCKET_PREFIX}-${PID}.sock`;
}

export function nvimBackSocketPath(): string {
  return `${SOCKET_PREFIX}-back-${PID}.sock`;
}

/**
 * Operating mode of the extension.
 *
 * - "tmux":     pi.dev runs in a tmux pane. We spawn a separate Neovim in a
 *               right-side tmux pane via `tmux split-window`.
 * - "embedded": pi.dev runs inside a Neovim :terminal buffer. We talk directly
 *               to the host Neovim via the $NVIM socket it exports to terminal
 *               children. No tmux commands, and we never kill the host.
 */
export type NvimMode = "tmux" | "embedded";

/** Detect the operating mode from the environment. */
export function detectMode(): NvimMode {
  return process.env.NVIM ? "embedded" : "tmux";
}

/**
 * Strategy for acquiring and releasing the Neovim instance. Encapsulates the
 * differences between the two modes so the lifecycle's connect/inject/setup
 * path stays mode-agnostic.
 */
export interface NvimBackend {
  readonly mode: NvimMode;
  /**
   * Return the RPC socket path to connect to, spawning Neovim first if this
   * backend owns the instance. Throws on failure (spawn error / timeout).
   */
  acquireSocket(): Promise<string>;
  /** Tear down anything this backend spawned. Never touches a host Neovim. */
  teardown(editor: NvimEditor | null): Promise<void>;
  /** Socket files this backend owns and should unlink on cleanup. */
  ownedSockets(): string[];
  /** Human-readable label for the connection, for status messages. */
  connectionLabel(socket: string): string;
}

/** Create the backend appropriate for the current environment. */
export function createBackend(mode: NvimMode = detectMode()): NvimBackend {
  return mode === "embedded"
    ? createEmbeddedBackend(process.env.NVIM || null)
    : createTmuxBackend();
}

/**
 * tmux mode: spawn a fresh Neovim in a right-side split pane with its own
 * --listen socket, and clean it up on shutdown.
 */
export function createTmuxBackend(): NvimBackend {
  let tmuxPaneId: string | null = null;

  return {
    mode: "tmux",

    async acquireSocket() {
      const nvimSocket = nvimSocketPath();
      const targetPane = process.env.TMUX_PANE || "";
      const spawnCmd = `tmux split-window -h -l 50% ${targetPane ? "-t " + targetPane : ""} -P -F '#{pane_id}' nvim --listen ${nvimSocket}`;

      tmuxPaneId = execSync(spawnCmd, { encoding: "utf-8", timeout: 5000 }).trim();
      await waitForSocket(nvimSocket, 5000);
      return nvimSocket;
    },

    async teardown(editor) {
      // Quit the Neovim we spawned, then kill its pane. Both best-effort.
      if (editor?.isConnected) {
        try {
          await editor.quit(3_000);
        } catch {
          /* best effort */
        }
      }
      if (tmuxPaneId) {
        try {
          execSync(`tmux kill-pane -t ${tmuxPaneId}`, { timeout: 3000 });
        } catch {
          /* best effort */
        }
        tmuxPaneId = null;
      }
    },

    ownedSockets() {
      // We own both the --listen socket and the back-channel socket.
      return [nvimSocketPath(), nvimBackSocketPath()];
    },

    connectionLabel() {
      return "right tmux pane";
    },
  };
}

/**
 * embedded mode: connect to the host Neovim via the $NVIM socket. We never
 * spawn or kill anything — the host is the user's editor.
 */
export function createEmbeddedBackend(hostSocket: string | null): NvimBackend {
  return {
    mode: "embedded",

    async acquireSocket() {
      if (!hostSocket) {
        throw new Error("Embedded mode detected ($NVIM set) but socket path is empty.");
      }
      return hostSocket;
    },

    async teardown() {
      // Never kill the host Neovim.
    },

    ownedSockets() {
      // Only the back-channel socket is ours; the host socket belongs to the
      // parent Neovim.
      return [nvimBackSocketPath()];
    },

    connectionLabel(socket) {
      return `host Neovim (${socket})`;
    },
  };
}

/** Poll for a Unix socket file to appear. */
export function waitForSocket(path: string, timeoutMs: number): Promise<void> {
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
