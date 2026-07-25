/**
 * NvimEditor smoke test.
 *
 * Exercises the pi-nvim domain layer (module injection, setup, openFile,
 * updateEditsBuffer) against a real headless Neovim. This is the path that
 * passes values to Lua as nvim_exec_lua arguments rather than interpolating
 * them into the source, so it's worth verifying end to end.
 *
 * Requires nvim on PATH. Run with:  npx tsx test/test-editor.ts
 */

import { spawn } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, Server, Socket } from "node:net";
import { NeovimClient } from "../src/neovim-client";
import { NvimEditor } from "../src/nvim-editor";

const NVIM_SOCKET = "/tmp/pi-nvim-test-editor.sock";
const BACK_SOCKET = "/tmp/pi-nvim-test-editor-back.sock";
const LUA_DIR = resolve(__dirname, "..", "lua");
const EDITS_BUF_NAME = "pi://edits";

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean, detail?: string) {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  cond ? passed++ : failed++;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((res, rej) => {
    const check = () => {
      if (existsSync(path)) return res();
      if (Date.now() - start > timeoutMs) return rej(new Error(`Timeout waiting for socket: ${path}`));
      setTimeout(check, 100);
    };
    check();
  });
}

function cleanup() {
  for (const s of [NVIM_SOCKET, BACK_SOCKET]) {
    try { if (existsSync(s)) unlinkSync(s); } catch { /* ok */ }
  }
}

/** Minimal back-channel server: just counts connections from the Lua module. */
class MockBack {
  private server: Server | null = null;
  private sockets: Socket[] = [];
  connections = 0;
  async start(): Promise<void> {
    return new Promise((res, rej) => {
      this.server = createServer((sock) => { this.connections++; this.sockets.push(sock); });
      this.server.on("error", rej);
      this.server.listen(BACK_SOCKET, res);
    });
  }
  stop() {
    for (const s of this.sockets) s.destroy();
    this.server?.close();
  }
}

async function main() {
  cleanup();

  const nvim = spawn("nvim", ["--headless", "--listen", NVIM_SOCKET], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  nvim.stderr?.on("data", (d: Buffer) => process.stderr.write(`[nvim] ${d}`));
  await waitForSocket(NVIM_SOCKET, 5000);

  // Share the underlying client so we can make assertions via execLua.
  const client = new NeovimClient();
  const editor = new NvimEditor(client);
  await editor.connect(NVIM_SOCKET);
  assert("editor connected", editor.isConnected);

  // ── injectModule ──────────────────────────────────────────────────
  await editor.injectModule(LUA_DIR);
  const setupType = await client.execLua(`return type(require("pi-nvim").setup)`);
  assert("injectModule makes pi-nvim requireable", setupType === "function", `type=${setupType}`);

  // ── setup (connects back to us) ───────────────────────────────────
  const back = new MockBack();
  await back.start();
  await editor.setup(BACK_SOCKET, process.pid);
  await sleep(500);
  assert("setup connects to the back-channel", back.connections >= 1, `connections=${back.connections}`);

  // ── openFile ──────────────────────────────────────────────────────
  const tmpFile = "/tmp/pi-nvim-editor-open.txt";
  writeFileSync(tmpFile, "hello\n");
  await editor.openFile(tmpFile);
  const bufName = await client.execLua(`return vim.api.nvim_buf_get_name(0)`) as string;
  assert("openFile opens the file in the current buffer", bufName === tmpFile, `got ${bufName}`);

  // ── updateEditsBuffer ─────────────────────────────────────────────
  await editor.updateEditsBuffer([
    { filename: tmpFile, lnum: 1, col: 1, text: `${tmpFile} | write | 10:00:00` },
  ]);
  const editsLines = await client.execLua(`
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_valid(b) and vim.api.nvim_buf_get_name(b) == "${EDITS_BUF_NAME}" then
        return vim.api.nvim_buf_get_lines(b, 0, -1, false)
      end
    end
    return nil
  `) as string[] | null;
  assert("updateEditsBuffer renders the entry", !!editsLines && editsLines.some((l) => l.includes(tmpFile)),
    editsLines ? editsLines.join(" / ") : "no edits buffer");

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
  try { unlinkSync(tmpFile); } catch { /* ok */ }
  editor.disconnect();
  nvim.kill();
  back.stop();
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  cleanup();
  process.exit(1);
});
