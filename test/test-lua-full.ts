/**
 * pi-nvim Lua integration test (focused).
 *
 * Spins up a mock pi Unix-socket server, starts headless nvim, injects the
 * pi-nvim Lua module, and verifies the behavior of the pi://edits scratch
 * buffer: socket comms, edits-buffer rendering + keymaps, user commands,
 * and the save-report autocmd. Covers the surface that replaced the old
 * quickfix-based design.
 *
 * Requires nvim on PATH. Run with:  npx tsx test/test-lua-full.ts
 */

import { spawn } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, Server, Socket } from "node:net";
import { createInterface } from "node:readline";
import { NeovimClient } from "../src/neovim-client";

// ── Config ──────────────────────────────────────────────────────────────

const NVIM_SOCKET = "/tmp/pi-nvim-test-nvim.sock";
const MOCK_PI_SOCKET = "/tmp/pi-nvim-test-pi.sock";
const LUA_DIR = resolve(__dirname, "..", "lua");
const EDITS_BUF_NAME = "pi://edits";

let passed = 0;
let failed = 0;

// ── Helpers ──────────────────────────────────────────────────────────────

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolveP, reject) => {
    const check = () => {
      if (existsSync(path)) return resolveP();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for socket: ${path}`));
      setTimeout(check, 100);
    };
    check();
  });
}

function cleanup() {
  for (const s of [NVIM_SOCKET, MOCK_PI_SOCKET]) {
    try { if (existsSync(s)) unlinkSync(s); } catch { /* ok */ }
  }
}

// ── Mock pi server ──────────────────────────────────────────────────────

class MockPiServer {
  private server: Server | null = null;
  private socket: Socket | null = null;
  received: object[] = [];
  connections = 0;

  async start(): Promise<void> {
    return new Promise((resolveP, reject) => {
      this.server = createServer((sock) => {
        this.connections++;
        this.socket = sock;
        const rl = createInterface({ input: sock, crlfDelay: Infinity });
        rl.on("line", (line: string) => {
          try { this.received.push(JSON.parse(line)); } catch { /* skip */ }
        });
      });
      this.server.on("error", reject);
      this.server.on("listening", () => {
        try { require("fs").chmodSync(MOCK_PI_SOCKET, 0o666); } catch {}
      });
      this.server.listen(MOCK_PI_SOCKET, resolveP);
    });
  }

  stop(): void {
    this.socket?.destroy();
    this.server?.close();
    this.server = null;
    this.socket = null;
  }

  async waitForMessages(count: number, timeoutMs = 3000): Promise<object[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.received.length < count && Date.now() < deadline) await sleep(50);
    return [...this.received];
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  cleanup();
  const mock = new MockPiServer();

  // ─── Phase 1: mock pi server ────────────────────────────────────────
  console.log("── Phase 1: Start mock pi server ──");
  await mock.start();
  assert("mock server listening", existsSync(MOCK_PI_SOCKET));

  // ─── Phase 2: headless nvim + RPC client ───────────────────────────
  console.log("── Phase 2: Start headless nvim + connect RPC ──");
  const nvim = spawn("nvim", ["--headless", "--listen", NVIM_SOCKET], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  nvim.stderr?.on("data", (d: Buffer) => process.stderr.write(`[nvim] ${d}`));
  await waitForSocket(NVIM_SOCKET, 5000);
  const client = new NeovimClient();
  await client.connect(NVIM_SOCKET);
  assert("nvim RPC connected", client.isConnected);

  const escapedLuaDir = LUA_DIR.replace(/\\/g, "\\\\");

  // ─── Phase 3: inject module via require ───────────────────────────
  console.log("── Phase 3: Inject Lua module ──");
  await client.execLua(
    `package.path = package.path .. ";${escapedLuaDir}/?.lua;${escapedLuaDir}/?/init.lua"`,
  );
  await client.execLua(`_pi_nvim = require("pi-nvim"); return nil`);
  const modTable = await client.execLua(`
    local keys = {}
    for k, v in pairs(_pi_nvim) do keys[#keys + 1] = k .. ":" .. type(v) end
    table.sort(keys)
    return keys
  `) as string[];
  const modFns = (modTable || []).filter((k) => k.endsWith(":function")).map((k) => k.replace(":function", ""));
  for (const fn of ["setup", "update_edits_buffer", "show_edits_buffer", "telescope_edits", "is_connected", "send_command"]) {
    assert(`module exposes ${fn}()`, modFns.includes(fn), `keys: ${(modTable || []).join(", ")}`);
  }

  // ─── Phase 4: setup() ─────────────────────────────────────────────
  console.log("── Phase 4: Call setup() ──");
  const setupRes = await client.execLua(`
    local ok, err = pcall(function()
      _pi_nvim.setup({ socket_path = "${MOCK_PI_SOCKET}", pi_pid = ${process.pid} })
    end)
    return { ok = ok, err = tostring(err) }
  `) as { ok: boolean; err?: string };
  assert("setup() succeeds", setupRes.ok === true, setupRes.err);
  await sleep(500);
  assert("socket connection received by mock", mock.connections >= 1, `connections: ${mock.connections}`);
  assert("is_connected() reports true", (await client.execLua(`return _pi_nvim.is_connected()`)) === true);

  // ─── Phase 5: send_command (nvim → pi) ────────────────────────────
  console.log("── Phase 5: Test send_command ──");
  await client.execLua(`_pi_nvim.send_command("pi_prompt", { text = "hello from nvim" }); return nil`);
  await sleep(200);
  const msgs = mock.received;
  assert("send_command delivers JSON to pi", msgs.length >= 1);
  if (msgs.length > 0) {
    const last = msgs[msgs.length - 1] as any;
    assert("pi_prompt cmd field", last.cmd === "pi_prompt");
    assert("pi_prompt text field", last.text === "hello from nvim");
  }

  // ─── Phase 6: edits buffer rendering ──────────────────────────────
  console.log("── Phase 6: Test pi://edits buffer ──");
  const entries = [
    { filename: "/tmp/test-a.txt", lnum: 1, col: 1, text: "/tmp/test-a.txt | write | 10:00:00" },
    { filename: "/tmp/test-b.txt", lnum: 1, col: 1, text: "/tmp/test-b.txt | edit | 10:01:00" },
  ];
  await client.execLua(`return _pi_nvim.update_edits_buffer(...)`, [JSON.stringify(entries)]);

  const bufInfo = await client.execLua(`
    local M = _pi_nvim
    -- find_edits_buf is local; reach the buffer via nvim_list_bufs by name
    local target = "${EDITS_BUF_NAME}"
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_valid(b) and vim.api.nvim_buf_get_name(b) == target then
        return {
          buf = b,
          name = vim.api.nvim_buf_get_name(b),
          buftype = vim.bo[b].buftype,
          modifiable = vim.bo[b].modifiable,
          lines = vim.api.nvim_buf_get_lines(b, 0, -1, false),
        }
      end
    end
    return nil
  `) as any;
  assert("edits buffer created", bufInfo !== null, bufInfo ? `buf=${bufInfo.buf}` : "not found");
  if (bufInfo) {
    assert("edits buffer name is pi://edits", bufInfo.name === EDITS_BUF_NAME, `got: ${bufInfo.name}`);
    assert("edits buffer buftype is nofile", bufInfo.buftype === "nofile");
    assert("edits buffer frozen (modifiable=false)", bufInfo.modifiable === false);
    const lines: string[] = bufInfo.lines || [];
    assert("edits buffer has header line", lines[0] === "pi.dev modified files", `got: ${lines[0]}`);
    assert("edits buffer has divider", lines[1] === "─────────────────────", `got: ${lines[1]}`);
    const entry = lines[2] || "";
    assert("first file entry rendered", /\/tmp\/test-a\.txt/.test(entry), `got: ${entry}`);
  }

  // ─── Phase 7: edits buffer keymaps ────────────────────────────────
  console.log("── Phase 7: Test edits buffer keymaps ──");
  const keymaps = await client.execLua(`
    local target = "${EDITS_BUF_NAME}"
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_valid(b) and vim.api.nvim_buf_get_name(b) == target then
        local maps = {}
        for _, m in ipairs(vim.api.nvim_buf_get_keymap(b, "n")) do
          maps[m.lhs] = true
        end
        return maps
      end
    end
    return {}
  `) as Record<string, boolean>;
  for (const key of ["<CR>", "d", "r", "q"]) {
    assert(`edits buffer maps '${key}'`, keymaps[key] === true, `maps: ${JSON.stringify(Object.keys(keymaps))}`);
  }

  // ─── Phase 8: user commands registered ────────────────────────────
  console.log("── Phase 8: User commands ──");
  const cmds = await client.execLua(`
    local ours = {}
    for name, def in pairs(vim.api.nvim_get_commands({})) do
      if name:match("^Pi") then ours[name] = def.desc or "(no desc)" end
    end
    return ours
  `) as Record<string, string>;
  for (const name of ["PiPrompt", "PiSendSelection", "PiEdits", "PiStatus"]) {
    assert(`:${name} registered`, cmds[name] !== undefined, cmds[name]);
  }

  // ─── Phase 9: autocmds registered ─────────────────────────────────
  console.log("── Phase 9: Autocmds ──");
  const evt = (e: string) => client.execLua(`
    local a = vim.api.nvim_get_autocmds({ group = "PiNeovim", event = "${e}" })
    return #a > 0
  `);
  assert("VimLeave autocmd registered", (await evt("VimLeave")) === true);
  assert("BufWritePost autocmd registered", (await evt("BufWritePost")) === true);

  // ─── Phase 10: BufWritePost → pi_edit (non-git file) ──────────────
  console.log("── Phase 10: BufWritePost → pi_edit ──");
  const savePath = "/tmp/pi-nvim-edit-test.txt";
  writeFileSync(savePath, "line 1\nline 2\n");
  await client.execLua(`
    vim.cmd("e! ${savePath}")
    vim.api.nvim_buf_set_lines(0, 0, -1, false, {"modified line 1", "line 2", "new line 3"})
    vim.cmd("w!")
    return nil
  `);
  await sleep(300);
  const edits = mock.received.filter((m: any) => m.cmd === "pi_edit");
  assert("BufWritePost emits pi_edit", edits.length >= 1, `received ${edits.length} pi_edit msgs`);
  if (edits.length > 0) {
    const e = edits[edits.length - 1] as any;
    assert("pi_edit includes file path", typeof e.file === "string" && e.file.endsWith("pi-nvim-edit-test.txt"), `file: ${e.file}`);
  }
  try { unlinkSync(savePath); } catch { /* ok */ }

  // ─── Results ──────────────────────────────────────────────────────
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
  client.disconnect();
  nvim.kill();
  mock.stop();
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  cleanup();
  process.exit(1);
});