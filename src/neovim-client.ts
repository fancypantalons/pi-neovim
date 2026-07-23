import { encode, decode } from "@msgpack/msgpack";
import { connect, Socket } from "node:net";
import { once } from "node:events";

/**
 * Minimal msgpack-RPC client for Neovim.
 *
 * Neovim's protocol uses msgpack arrays:
 *   [type, msgid, method, args]
 *
 * type: 0 = request, 1 = response, 2 = notification
 *
 * We primarily use notifications (type 2) since most nvim_* API calls
 * don't need response handling. For calls that need a return value,
 * we use requests (type 0).
 */

const REQUEST = 0;
const RESPONSE = 1;
const NOTIFICATION = 2;

export class NeovimClient {
  private socket: Socket | null = null;
  private msgid = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = Buffer.alloc(0);
  private connected = false;

  /**
   * Connect to a Neovim instance via its listen socket.
   */
  async connect(socketPath: string): Promise<void> {
    if (this.connected) return;

    this.socket = connect(socketPath);
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
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
   */
  async request(method: string, ...args: unknown[]): Promise<unknown> {
    const id = this.msgid++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send([REQUEST, id, method, args]);
    });
  }

  /**
   * Call a Neovim API function and return the result.
   * Convenience wrapper around request().
   */
  async call(method: string, ...args: unknown[]): Promise<unknown> {
    try {
      const result = await this.request(method, ...args);
      // Neovim returns [error, result] for API calls
      if (Array.isArray(result) && result.length === 2) {
        const [err, val] = result;
        if (err !== null && err !== undefined) {
          throw new Error(`nvim error: ${JSON.stringify(err)}`);
        }
        return val;
      }
      return result;
    } finally {
      // no-op: error already thrown above
    }
  }

  /**
   * Execute Lua code in Neovim and return the result.
   * Returns the value returned by the Lua chunk.
   */
  async execLua(code: string, args: unknown[] = []): Promise<unknown> {
    return this.call("nvim_exec_lua", code, args);
  }

  /**
   * Execute a Vim command (like :e, :q, :split, etc.)
   */
  async command(cmd: string): Promise<void> {
    await this.call("nvim_command", cmd);
  }

  /**
   * Set the quickfix list. Uses JSON-in-Lua to avoid msgpack table
   * serialization issues across the RPC boundary.
   */
  async setQuickfixList(
    entries: Array<{
      filename: string;
      lnum: number;
      col: number;
      text: string;
    }>,
    title: string = "pi-neovim modified files",
  ): Promise<void> {
    // Embed JSON via Lua [==[...]==] so that the JSON's closing ]
    // doesn't get consumed by the Lua string closer.
    const json = JSON.stringify(entries);
    await this.execLua(`
      local entries = vim.fn.json_decode([==[${json}]==])
      vim.fn.setqflist({}, "r", { title = [==[${title}]==], items = entries })
      vim.cmd("copen")
      return nil
    `);
  }

  /**
   * Open a file in the current window.
   */
  async openFile(filepath: string): Promise<void> {
    await this.call("nvim_command", "e " + filepath);
  }

  /**
   * Jump to a specific line in the current buffer.
   */
  async setCursor(line: number, col: number = 0): Promise<void> {
    await this.call("nvim_win_set_cursor", 0, [line, col]);
  }

  /**
   * Force-reload a file in all buffers that have it open, but only if
   * the buffer has no unsaved changes (respects user's edits).
   */
  async reloadFile(filepath: string): Promise<void> {
    await this.execLua(`
      local target = [==[${filepath}]==]
      for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_valid(buf) then
          local name = vim.api.nvim_buf_get_name(buf)
          if name == target then
            local modified = vim.api.nvim_get_option_value("modified", { buf = buf })
            if not modified then
              vim.api.nvim_buf_call(buf, function()
                vim.cmd("edit!")
              end)
            end
          end
        end
      end
      return nil
    `);
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

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Try to decode complete msgpack messages
    while (this.buffer.length > 0) {
      try {
        const decoded = decode(this.buffer) as unknown;
        // We can only track consumed bytes if we decode the first value
        // Since msgpack is self-delimiting, a successful decode gives us
        // one complete message. We need to figure out how many bytes it consumed.
        const consumed = this.consumedBytes(this.buffer);
        this.buffer = this.buffer.subarray(consumed);
        this.handleMessage(decoded);
      } catch {
        // Incomplete message (or malformed) — wait for more data
        break;
      }
    }
  }

  /**
   * Determine how many bytes were consumed by the last successful decode.
   * We do this by encoding the decoded value back and measuring.
   */
  private consumedBytes(buf: Buffer): number {
    try {
      const decoded = decode(buf);
      const reEncoded = encode(decoded);
      return reEncoded.byteLength;
    } catch {
      return buf.length; // fallback — shouldn't happen after successful decode
    }
  }

  private handleMessage(msg: unknown): void {
    if (!Array.isArray(msg)) return;

    const [type, msgid] = msg as [number, number, unknown?, unknown?];

    if (type === RESPONSE) {
      const pending = this.pending.get(msgid);
      if (pending) {
        this.pending.delete(msgid);
        const [, , error, result] = msg as [number, number, unknown, unknown];
        if (error) {
          pending.reject(new Error(String(error)));
        } else {
          pending.resolve(result);
        }
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}
