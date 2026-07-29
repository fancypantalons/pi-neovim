import { resolve as resolvePath } from "node:path";
import { NeovimClient } from "./neovim-client";
import type { EditsEntry } from "./types";

/**
 * pi-nvim domain operations layered over the generic {@link NeovimClient}
 * transport. Everything that embeds pi-nvim's Lua module or knowledge of the
 * pi://edits buffer lives here, so the RPC client stays a reusable, protocol-
 * only client.
 *
 * Values are passed to Lua as `nvim_exec_lua` arguments (received via `...`)
 * rather than interpolated into the source, so paths and JSON never need
 * escaping and can't break out of the chunk.
 */
export class NvimEditor {
  constructor(private readonly client: NeovimClient = new NeovimClient()) {}

  async connect(socketPath: string): Promise<void> {
    await this.client.connect(socketPath);
  }

  get isConnected(): boolean {
    return this.client.isConnected;
  }

  disconnect(): void {
    this.client.disconnect();
  }

  /** Quit the connected Neovim (used only for instances we spawned). */
  async quit(timeoutMs?: number): Promise<void> {
    await this.client.command("qa!", timeoutMs);
  }

  /**
   * Add `luaDir` to Neovim's package.path and require the pi-nvim module.
   * The directory is passed as an argument, so no backslash escaping is
   * needed on Windows.
   */
  async injectModule(luaDir: string): Promise<void> {
    await this.client.execLua(
      `local dir = ...
       package.path = package.path .. ";" .. dir .. "/?.lua;" .. dir .. "/?/init.lua"`,
      [luaDir],
    );
    await this.client.execLua(`require("pi-nvim"); return nil`);
  }

  /** Call the pi-nvim module's setup() with the back-channel socket + pid. */
  async setup(backSocket: string, piPid: number): Promise<void> {
    await this.client.execLua(
      `local sock, pid = ...
       return require("pi-nvim").setup({ socket_path = sock, pi_pid = pid })`,
      [backSocket, piPid],
    );
  }

  /** Update the pi://edits scratch buffer content. Non-critical: short timeout. */
  async updateEditsBuffer(entries: EditsEntry[]): Promise<void> {
    await this.client.execLua(
      `return require("pi-nvim").update_edits_buffer(...)`,
      [JSON.stringify(entries)],
      5_000,
    );
  }

  /**
   * Open a file in the current window.
   * Resolves to an absolute path so it works regardless of Neovim's cwd.
   */
  async openFile(filepath: string): Promise<void> {
    await this.client.execLua(
      `vim.cmd("e " .. vim.fn.fnameescape(...))`,
      [resolvePath(filepath)],
    );
  }

  /**
   * The connected Neovim's *global* working directory.
   *
   * Uses `getcwd(-1, -1)` rather than bare `getcwd()`: the latter returns the
   * current window's directory, which swings around under `:lcd`/`:tcd` and
   * would make the git backstop's anchor depend on which split happens to be
   * focused. The global cwd is what identifies the worktree the user opened.
   */
  async getCwd(): Promise<string | null> {
    const cwd = await this.client.call("nvim_call_function", ["getcwd", [-1, -1]], 5_000);
    return typeof cwd === "string" && cwd !== "" ? cwd : null;
  }

  /** Jump to a specific line in the current buffer. */
  async setCursor(line: number, col: number = 0): Promise<void> {
    await this.client.call("nvim_win_set_cursor", [0, [line, col]]);
  }

  /**
   * Force-reload a file in all buffers that have it open, but only if the
   * buffer has no unsaved changes (respects the user's edits). Resolves to an
   * absolute path so the buffer-name comparison is reliable.
   */
  async reloadFile(filepath: string): Promise<void> {
    await this.client.execLua(
      `
      local target = ...
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
      `,
      [resolvePath(filepath)],
    );
  }
}
