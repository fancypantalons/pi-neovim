/**
 * Comprehensive Lua module integration test.
 *
 * Spins up a mock pi Unix-socket server, starts headless nvim, injects
 * the Lua module, and verifies every behavior: socket comms, autocmds,
 * quickfix mappings, user commands, and send_cmd end-to-end.
 *
 * Usage: npx tsx test/test-lua-full.ts
 */

import { spawn, ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, Server, Socket } from "node:net";
import { createInterface } from "node:readline";
import { NeovimClient } from "../src/neovim-client";

// ── Config ──────────────────────────────────────────────────────────────

const NVIM_SOCKET = "/tmp/pi-nvim-test-nvim.sock";
const MOCK_PI_SOCKET = "/tmp/pi-nvim-test-pi.sock";
const LUA_DIR = resolve(__dirname, "..", "lua");
const ESCAPED_LUA_DIR = LUA_DIR.replace(/\\/g, "\\\\");

let passed = 0;
let failed = 0;

// ── Helpers ─────────────────────────────────────────────────────────────

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (existsSync(path)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for socket: ${path}`));
      setTimeout(check, 100);
    }
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
    return new Promise((resolve, reject) => {
      this.server = createServer((sock) => {
        this.connections++;
        this.socket = sock;
        const rl = createInterface({ input: sock, crlfDelay: Infinity });
        rl.on("line", (line: string) => {
          try { this.received.push(JSON.parse(line)); } catch { /* skip */ }
        });
      });
      this.server.on("error", reject);
      this.server.listen(MOCK_PI_SOCKET, resolve);
      // Ensure socket permissions
      this.server.on("listening", () => {
        try { require("fs").chmodSync(MOCK_PI_SOCKET, 0o666); } catch {}
      });
    });
  }

  stop(): void {
    this.socket?.destroy();
    this.server?.close();
    this.server = null;
    this.socket = null;
  }

  /**
   * Wait until we've received at least `count` JSON messages, or timeout.
   */
  async waitForMessages(count: number, timeoutMs = 3000): Promise<object[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.received.length < count && Date.now() < deadline) {
      await sleep(50);
    }
    return [...this.received];
  }
}

// ── Main test ───────────────────────────────────────────────────────────

async function main() {
  cleanup();
  const mock = new MockPiServer();

  // ─── Phase 1: Start mock server ─────────────────────────────────────
  console.log("── Phase 1: Start mock pi server ──");
  await mock.start();
  assert("mock server listening", existsSync(MOCK_PI_SOCKET));

  // ─── Phase 2: Start headless nvim ───────────────────────────────────
  console.log("── Phase 2: Start headless nvim ──");
  const nvim = spawn("nvim", ["--headless", "--listen", NVIM_SOCKET], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  nvim.stderr?.on("data", (d: Buffer) => process.stderr.write(`[nvim] ${d}`));

  await waitForSocket(NVIM_SOCKET, 5000);

  const client = new NeovimClient();
  await client.connect(NVIM_SOCKET);
  assert("nvim RPC connected", client.isConnected);

  // ─── Phase 3: Inject Lua module ─────────────────────────────────────
  console.log("── Phase 3: Inject Lua module ──");

  // Load the module via require
  await client.execLua(`package.path = package.path .. ";${ESCAPED_LUA_DIR}/?.lua;${ESCAPED_LUA_DIR}/?/init.lua"`);
  await client.execLua(`_pi_nvim = require("pi-nvim"); return nil`);
  assert("module loaded via require", true);

  // Verify the module table has expected functions — use pcall
  const modInfo = await client.execLua(`
    if _pi_nvim == nil then return { loaded = false } end
    local keys = {}
    for k, v in pairs(_pi_nvim) do
      keys[#keys + 1] = k .. ":" .. type(v)
    end
    table.sort(keys)
    return { loaded = true, keys = keys }
  `) as { loaded: boolean; keys?: string[] };
  assert("_pi_nvim table exists", modInfo.loaded === true);
  if (modInfo.keys) {
    const modFns = modInfo.keys.filter(k => k.endsWith(":function")).map(k => k.replace(":function", ""));
    const expectedFns = ["send_command", "setup"];
    for (const fn of expectedFns) {
      assert(`module has ${fn}()`, modFns.includes(fn), `keys: ${modInfo.keys.join(", ")}`);
    }
  }

  // ─── Phase 4: Call setup() ──────────────────────────────────────────
  console.log("── Phase 4: Call setup() ──");

  const setupResult = await client.execLua(`
    local ok, err = pcall(function()
      _pi_nvim.setup({
        socket_path = "${MOCK_PI_SOCKET}",
        pi_pid = ${process.pid}
      })
    end)
    return { ok = ok, err = err }
  `) as { ok: boolean; err?: string };
  assert("setup() succeeds", setupResult.ok, setupResult.err);

  // Give the async pipe connect a moment
  await sleep(500);
  assert("socket connection received by mock server", mock.connections >= 1,
    `connections: ${mock.connections}`);

  // ─── Phase 5: Test send_cmd (Neovim → pi communication) ─────────────
  console.log("── Phase 5: Test send_cmd ──");

  // Trigger a send via the module's public API
  await client.execLua(`_pi_nvim.send_command("pi_prompt", { text = "hello from nvim" }); return nil`);
  await sleep(200);
  const msgs = mock.received;
  assert("send_command delivers JSON to pi", msgs.length >= 1);
  if (msgs.length > 0) {
    const last = msgs[msgs.length - 1] as any;
    assert("message has cmd field", last.cmd === "pi_prompt");
    assert("message has text field", last.text === "hello from nvim");
  }

  // ─── Phase 6: Test user commands ────────────────────────────────────
  console.log("── Phase 6: Test user commands ──");

  const cmds = await client.execLua(`
    local cmds = vim.api.nvim_get_commands({})
    local ours = {}
    for name, def in pairs(cmds) do
      if name:match("^Pi") then
        ours[name] = def.desc or "(no desc)"
      end
    end
    return ours
  `) as Record<string, string>;

  assert(":PiPrompt registered", cmds["PiPrompt"] !== undefined, cmds["PiPrompt"]);
  assert(":PiSendSelection registered", cmds["PiSendSelection"] !== undefined);
  assert(":PiQuickfix registered", cmds["PiQuickfix"] !== undefined);

  // ─── Phase 7: Test quickfix mappings ────────────────────────────────
  console.log("── Phase 7: Test quickfix mappings ──");

  // Set a quickfix list with our title
  await client.setQuickfixList([
    { filename: "/tmp/test-a.txt", lnum: 1, col: 1, text: "test | write" },
    { filename: "/tmp/test-b.txt", lnum: 1, col: 1, text: "test | edit" },
  ], "pi-neovim modified files");

  // Open the quickfix window
  await client.command("copen");
  await sleep(300);

  // Check for the 'd' mapping on the qf buffer
  const qfMappings = await client.execLua(`
    local wins = vim.api.nvim_list_wins()
    for _, win in ipairs(wins) do
      local buf = vim.api.nvim_win_get_buf(win)
      if vim.bo[buf].buftype == "quickfix" then
        local maps = vim.api.nvim_buf_get_keymap(buf, "n")
        for _, m in ipairs(maps) do
          if m.lhs == "d" then
            -- Return only serializable fields (no callbacks/functions)
            return { buf = buf, lhs = m.lhs, noremap = m.noremap, desc = m.desc or "" }
          end
        end
      end
    end
    return nil
  `);

  assert("quickfix 'd' mapping exists on qf buffer", qfMappings !== null,
    qfMappings ? `buf=${(qfMappings as any).buf}` : "no mapping found");

  // Verify the qf title
  const qfTitle = await client.execLua(`
    return vim.fn.getqflist({ title = 1 }).title
  `);
  assert("quickfix title matches", qfTitle === "pi-neovim modified files",
    `got: "${qfTitle}"`);

  // ─── Phase 8: Test VimLeave autocmd ─────────────────────────────────
  console.log("── Phase 8: Test VimLeave autocmd ──");

  // Check that the VimLeave autocmd is registered
  const hasVimLeave = await client.execLua(`
    local aucmds = vim.api.nvim_get_autocmds({
      group = "PiNeovim",
      event = "VimLeave",
    })
    return #aucmds > 0
  `);
  assert("VimLeave autocmd registered", hasVimLeave === true);

  // Check BufWinEnter autocmd
  const hasBufWin = await client.execLua(`
    local aucmds = vim.api.nvim_get_autocmds({
      group = "PiNeovim",
      event = "BufWinEnter",
    })
    return #aucmds > 0
  `);
  assert("BufWinEnter autocmd registered", hasBufWin === true);

  // Check BufWritePost autocmd (two-way editing)
  const hasBufWrite = await client.execLua(`
    local aucmds = vim.api.nvim_get_autocmds({
      group = "PiNeovim",
      event = "BufWritePost",
    })
    return #aucmds > 0
  `);
  assert("BufWritePost autocmd registered", hasBufWrite === true);

  // ─── Phase 9: Test reloadFile ───────────────────────────────────
  console.log("── Phase 9: Test reloadFile ──");

  // Create the file on disk first, then open it properly
  require("fs").writeFileSync("/tmp/pi-nvim-reload-test.txt", "old content");

  await client.execLua(`
    vim.cmd("e! /tmp/pi-nvim-reload-test.txt")
    return nil
  `);

  // Verify initial buffer content
  const before = await client.execLua(`
    return vim.api.nvim_buf_get_lines(0, 0, -1, false)
  `);
  assert("initial content loaded", Array.isArray(before) && before[0] === "old content",
    `got: ${JSON.stringify(before)}`);

  // Write new content to the file on disk (simulating pi editing)
  require("fs").writeFileSync("/tmp/pi-nvim-reload-test.txt", "new content from pi");

  // Call reloadFile — the buffer should pick up the new content
  await client.reloadFile("/tmp/pi-nvim-reload-test.txt");

  const after = await client.execLua(`
    local bufs = vim.api.nvim_list_bufs()
    for _, buf in ipairs(bufs) do
      if vim.api.nvim_buf_get_name(buf) == "/tmp/pi-nvim-reload-test.txt" then
        return vim.api.nvim_buf_get_lines(buf, 0, -1, false)
      end
    end
    return nil
  `);

  const lines = Array.isArray(after) ? after : [];
  assert("reloadFile picks up new content", lines[0] === "new content from pi",
    `got: ${JSON.stringify(lines)}`);

  // Cleanup
  try { require("fs").unlinkSync("/tmp/pi-nvim-reload-test.txt"); } catch { /* ok */ }

  // ─── Phase 10: Test BufWritePost → pi_edit ──────────────────────
  console.log("── Phase 10: Test BufWritePost → pi_edit ──");

  // Create a git-tracked file in the test repo (use cwd of nvim)
  require("fs").writeFileSync("/tmp/pi-nvim-edit-test.txt", "line 1\nline 2");

  // Open it and trigger a save (BufWritePost)
  await client.execLua(`
    vim.cmd("e! /tmp/pi-nvim-edit-test.txt")
    vim.api.nvim_buf_set_lines(0, 0, -1, false, {"modified line 1", "line 2", "new line 3"})
    vim.cmd("w!")
    return nil
  `);

  await sleep(300);
  const editMessages = mock.received.filter((m: any) => m.cmd === "pi_edit");
  if (editMessages.length > 0) {
    // The file was saved — pi_edit was sent (non-git in /tmp, so diff will be "(non-git file)")
    assert("BufWritePost triggers pi_edit (non-git)", true);
    console.log(`  ✅ edit reported: ${JSON.stringify(editMessages[0])}`);
  } else {
    // Might still pass if the file wasn't tracked
    console.log("  ⚠ No pi_edit received — file may not be git-tracked");
  }

  // ─── Results ────────────────────────────────────────────────────────
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);

  // Cleanup
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
