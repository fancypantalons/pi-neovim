import { encode, decodeMultiStream } from "@msgpack/msgpack";
import { connect, Socket } from "node:net";
import { once } from "node:events";

/**
 * Minimal, protocol-only msgpack-RPC client for Neovim.
 *
 * Neovim's protocol uses msgpack arrays:
 *   [type, msgid, method, args]
 *
 * type: 0 = request, 1 = response, 2 = notification
 *
 * We primarily use notifications (type 2) since most nvim_* API calls
 * don't need response handling. For calls that need a return value,
 * we use requests (type 0).
 *
 * This class knows nothing about pi-nvim — the domain operations (edits
 * buffer, file open/reload, Lua module injection) live in {@link NvimEditor}.
 */

const REQUEST = 0;
const RESPONSE = 1;
const NOTIFICATION = 2;

/** Default timeout for RPC requests before rejecting. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class NeovimClient {
  private socket: Socket | null = null;
  private msgid = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();
  private connected = false;

  /**
   * Connect to a Neovim instance via its listen socket.
   */
  async connect(socketPath: string): Promise<void> {
    if (this.connected) return;

    this.socket = connect(socketPath);
    this.socket.on("close", () => {
      this.connected = false;
      this.rejectAll(new Error("Neovim socket closed"));
    });
    this.socket.on("error", (err) => {
      this.connected = false;
      this.rejectAll(err);
    });

    await once(this.socket, "connect");
    this.connected = true;

    // Consume the socket as a msgpack stream. decodeMultiStream handles all
    // partial-message buffering across chunk boundaries internally, so there's
    // no manual framing to get wrong. The loop ends when the socket closes.
    this.readLoop(this.socket).catch(() => {
      /* socket closed or decode error — 'close'/'error' handlers do cleanup */
    });
  }

  private async readLoop(socket: Socket): Promise<void> {
    for await (const msg of decodeMultiStream(socket)) {
      this.handleMessage(msg);
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send an RPC notification (no response expected).
   */
  notify(method: string, ...args: unknown[]): void {
    this.send([NOTIFICATION, 0, method, args]);
  }

  /**
   * Send an RPC request and wait for the response.
   * Times out after `timeoutMs` (default 10s) to prevent hangs when
   * Neovim is busy, stuck, or the connection has silently dropped.
   */
  async request(
    method: string,
    args: unknown[],
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.msgid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `nvim RPC timeout after ${timeoutMs}ms: ${method}`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });
      this.send([REQUEST, id, method, args]);
    });
  }

  /**
   * Call a Neovim API function and return the result.
   * Convenience wrapper around request().
   */
  async call(
    method: string,
    args: unknown[] = [],
    timeoutMs?: number,
  ): Promise<unknown> {
    const result = await this.request(method, args, timeoutMs);
    // Neovim returns [error, result] for API calls
    if (Array.isArray(result) && result.length === 2) {
      const [err, val] = result;
      if (err !== null && err !== undefined) {
        throw new Error(`nvim error: ${JSON.stringify(err)}`);
      }
      return val;
    }
    return result;
  }

  /**
   * Execute Lua code in Neovim and return the result.
   */
  async execLua(
    code: string,
    args: unknown[] = [],
    timeoutMs?: number,
  ): Promise<unknown> {
    return this.call("nvim_exec_lua", [code, args], timeoutMs);
  }

  /**
   * Execute a Vim command (like :e, :q, :split, etc.)
   */
  async command(cmd: string, timeoutMs?: number): Promise<void> {
    await this.call("nvim_command", [cmd], timeoutMs);
  }

  /**
   * Ping Neovim with a trivial API call. Returns true if responsive.
   * Used to detect silent disconnects.
   */
  async ping(timeoutMs: number = 3_000): Promise<boolean> {
    try {
      await this.call("nvim_get_api_info", [], timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close the connection.
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.rejectAll(new Error("Client disconnected"));
  }

  // ── internal ─────────────────────────────────────────────────────

  private send(data: unknown): void {
    if (!this.socket) throw new Error("Not connected");
    const packed = encode(data, { sortKeys: true });
    this.socket.write(packed);
  }

  private handleMessage(msg: unknown): void {
    if (!Array.isArray(msg)) return;

    const [type, msgid] = msg as [number, number, unknown?, unknown?];

    if (type === RESPONSE) {
      const entry = this.pending.get(msgid);
      if (entry) {
        this.pending.delete(msgid);
        // Clear the timeout timer
        if (entry.timer) clearTimeout(entry.timer);
        const [, , error, result] = msg as [number, number, unknown, unknown];
        if (error) {
          entry.reject(new Error(String(error)));
        } else {
          entry.resolve(result);
        }
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
