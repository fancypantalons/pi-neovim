/**
 * Layer 2 test: Replicate the nvim_exec_lua injection using the exact
 * same NeovimClient and Lua source as the real extension.
 *
 * Usage: npx tsx test/test-lua-injection.ts
 * Or:    node --import tsx test/test-lua-injection.ts
 *
 * What it does:
 * 1. Spawns nvim --headless --listen <socket>
 * 2. Connects our NeovimClient
 * 3. Calls execLua() with the full pi-nvim.lua source
 * 4. Reports success or the exact error message
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { NeovimClient } from "../src/neovim-client";

const SOCKET = "/tmp/pi-nvim-test-lua.sock";
const LUA_PATH = resolve(__dirname, "..", "lua", "pi-nvim.lua");

let failed = 0;
function fail(msg: string) {
  console.error(`❌ ${msg}`);
  failed++;
}

async function main() {
  // Clean up stale socket
  if (existsSync(SOCKET)) {
    try { unlinkSync(SOCKET); } catch { /* ok */ }
  }

  // Read the Lua source exactly as the extension does
  if (!existsSync(LUA_PATH)) {
    console.error(`❌ Lua file not found: ${LUA_PATH}`);
    process.exit(1);
  }
  const luaSource = readFileSync(LUA_PATH, "utf-8");
  console.log(`📄 Lua source: ${luaSource.length} bytes, ${luaSource.split("\n").length} lines`);

  // 1. Spawn headless Neovim
  console.log(`🚀 Starting nvim --headless --listen ${SOCKET}`);
  const nvim = spawn("nvim", ["--headless", "--listen", SOCKET], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Log any Neovim stderr (useful for diagnostics)
  nvim.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(`[nvim stderr] ${d}`);
  });

  // 2. Wait for socket to appear
  await waitForSocket(SOCKET, 5000);

  // 3. Connect our msgpack-RPC client
  const client = new NeovimClient();
  try {
    await client.connect(SOCKET);
    console.log("✅ Connected to Neovim RPC");
  } catch (err: any) {
    console.error(`❌ Failed to connect: ${err.message}`);
    nvim.kill();
    process.exit(1);
  }

  // 4. Test basic nvim_exec_lua with a trivial chunk first
  console.log("\n── Test 1: Simple execLua ──");
  try {
    const result = await client.execLua("return 42");
    console.log(`✅ execLua("return 42") = ${JSON.stringify(result)}`);
  } catch (err: any) {
    console.error(`❌ execLua("return 42") failed: ${err.message}`);
  }

  // 5. Test execLua with a table return (function-heavy)
  console.log("\n── Test 2: execLua with function table ──");
  try {
    const result = await client.execLua(`
      local M = {}
      function M.hello() return "world" end
      return M
    `);
    console.log(`✅ execLua(table with function) = ${JSON.stringify(result)}`);
  } catch (err: any) {
    console.error(`❌ execLua(table with function) failed: ${err.message}`);
  }

  // 6. Test execLua returning nil (no return statement)
  console.log("\n── Test 3: execLua returning nil ──");
  try {
    const result = await client.execLua(`
      local M = {}
      function M.hello() return "world" end
      -- no return statement
    `);
    console.log(`✅ execLua(no return) = ${JSON.stringify(result)}`);
  } catch (err: any) {
    console.error(`❌ execLua(no return) failed: ${err.message}`);
  }

  // 7. Inject the raw module source. This is EXPECTED to fail: the module
  //    ends with `return M`, and M is a table of functions which msgpack
  //    cannot serialize ("Cannot convert given Lua type"). This is exactly
  //    why the extension loads via require() (Test 5) instead. Informational
  //    only — not counted as a failure.
  console.log("\n── Test 4: execLua(raw source) [expected to fail — see Test 5] ──");
  try {
    const result = await client.execLua(luaSource);
    console.log(`   raw execLua returned = ${JSON.stringify(result)}`);
  } catch (err: any) {
    console.log(`   (expected) raw execLua rejected: ${err.message}`);
  }

  // 8. Try loading as a module instead of raw exec
  const luaDir = resolve(__dirname, "..", "lua");
  const escapedDir = luaDir.replace(/\\/g, "\\\\");
  
  console.log("\n── Test 5: require('pi-nvim') approach ──");
  try {
    await client.execLua(`
      package.path = package.path .. ";${escapedDir}/?.lua;${escapedDir}/?/init.lua"
    `);
    // nvim_exec_lua returns only the first value of a multi-return, so ask
    // for an explicit ok/err pair instead of returning pcall directly.
    const result = await client.execLua(`
      local ok, err = pcall(require, "pi-nvim")
      return { ok = ok, err = tostring(err) }
    `) as { ok: boolean; err?: string };
    console.log(`✅ require("pi-nvim") pcall = ${JSON.stringify(result)}`);
    if (!result || result.ok !== true) {
      fail(`require("pi-nvim") did not succeed: ${result?.err}`);
    }
  } catch (err: any) {
    fail(`require("pi-nvim") failed: ${err.message}`);
  }

  // 9. Test actually running setup (requires a socket server)
  console.log("\n── Test 6: Calling setup() ──");
  try {
    // Module already on package.path from Test 5
    await client.execLua(`pi_nvim = require("pi-nvim"); return nil`);
    // Call setup with a fake socket path — the connect will fail
    // but it should not crash nvim
    const result = await client.execLua(`
      local ok, err = pcall(function()
        pi_nvim.setup({
          socket_path = "/tmp/nonexistent.sock",
          pi_pid = 99999
        })
      end)
      return { ok = ok, err = tostring(err) }
    `) as { ok: boolean; err?: string };
    console.log(`✅ setup() pcall = ${JSON.stringify(result)}`);
    // setup() must not throw even when the pi socket is unreachable —
    // connect failures are handled asynchronously, not by raising.
    if (!result || result.ok !== true) {
      fail(`setup() raised instead of degrading gracefully: ${result?.err}`);
    }
  } catch (err: any) {
    fail(`setup() failed: ${err.message}`);
  }

  // Cleanup
  console.log("\n── Cleaning up ──");
  client.disconnect();
  nvim.kill();
  try { unlinkSync(SOCKET); } catch { /* ok */ }
  console.log(`\nDone. ${failed} failure(s).`);
  process.exit(failed > 0 ? 1 : 0);
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await sleep(100);
  }
  throw new Error(`Timeout waiting for socket: ${path}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
