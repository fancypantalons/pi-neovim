import { createServer, Server, Socket } from "node:net";
import { createInterface } from "node:readline";

/**
 * JSON-line protocol commands sent from Neovim's Lua module.
 */
export interface NvimCommand {
  cmd: "pi_prompt" | "pi_edit" | "pi_open_file" | "pi_select" | "pi_exit";
  [key: string]: unknown;
}

export interface PiPromptCommand extends NvimCommand {
  cmd: "pi_prompt";
  text: string;
}

export interface PiEditCommand extends NvimCommand {
  cmd: "pi_edit";
  file: string;
  diff: string;
}

export interface PiOpenFileCommand extends NvimCommand {
  cmd: "pi_open_file";
  file: string;
}

export interface PiSelectCommand extends NvimCommand {
  cmd: "pi_select";
  file: string;
  lines: string;
}

export interface PiExitCommand extends NvimCommand {
  cmd: "pi_exit";
}

export type NvimCommandHandler = (command: NvimCommand) => void;

/**
 * Unix socket server that receives JSON-line commands from the
 * Lua module injected into Neovim.
 */
export class NvimServer {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private handler: NvimCommandHandler | null = null;
  private socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /**
   * Start listening on the Unix socket.
   */
  async start(handler: NvimCommandHandler): Promise<void> {
    this.handler = handler;

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.socket = socket;
        const rl = createInterface({ input: socket, crlfDelay: Infinity });

        rl.on("line", (line: string) => {
          try {
            const cmd: NvimCommand = JSON.parse(line);
            this.handler?.(cmd);
          } catch {
            // Ignore malformed JSON lines
          }
        });

        socket.on("close", () => {
          // Neovim's socket connection closed.
          // This could be a graceful exit (we'll get pi_exit first via VimLeave)
          // or an unexpected disconnect. Fire a synthetic exit to be safe.
          this.handler?.({ cmd: "pi_exit" });
        });

        socket.on("error", () => {
          // Socket error — treat as disconnect
        });
      });

      this.server.on("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
  }

  /**
   * Stop the server and clean up.
   */
  stop(): void {
    this.socket?.destroy();
    this.server?.close();
    this.socket = null;
    this.server = null;
    this.handler = null;
  }
}
