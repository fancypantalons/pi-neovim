/**
 * Focused diff test against the actual file.
 * Replicates exactly what pressing 'd' in the quickfix does.
 */
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { NeovimClient } from "../src/neovim-client";

const NVIM_SOCKET = "/tmp/pi-nvim-diff-test.sock";
const FILEPATH = resolve("/home/brettk/blog/_posts/2026-07-20-tour-alberta-2026.md");

async function main() {
  if (existsSync(NVIM_SOCKET)) try { unlinkSync(NVIM_SOCKET); } catch {}

  const nvim = spawn("nvim", ["--headless", "--listen", NVIM_SOCKET], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: "/home/brettk/blog",  // important: cwd is repo root
  });
  nvim.stderr?.on("data", (d: Buffer) => process.stderr.write(`[nvim] ${d}`));

  await waitForSocket(NVIM_SOCKET, 5000);
  const client = new NeovimClient();
  await client.connect(NVIM_SOCKET);
  console.log("connected");

  // ── Step 1: Check if it's a git repo ─────────────────────────────
  const dir = await client.execLua(`return vim.fn.fnamemodify([==[${FILEPATH}]==], ":h")`) as string;
  console.log(`dir = ${dir}`);

  const reporoot = await client.execLua(`
    return vim.fn.systemlist("git -C " .. vim.fn.shellescape([==[${dir}]==]) .. " rev-parse --show-toplevel 2>/dev/null")
  `);
  console.log(`reporoot = ${JSON.stringify(reporoot)}`);

  const in_git = Array.isArray(reporoot) && reporoot.length > 0 && reporoot[0] !== "";
  console.log(`in_git = ${in_git}`);

  if (in_git) {
    const root = (reporoot as string[])[0];
    console.log(`root = ${root}`);

    // ── Step 2: Compute relative path ──────────────────────────────
    const relpath = await client.execLua(`
      local fp = [==[${FILEPATH}]==]
      local root = [==[${root}]==]
      return string.sub(fp, #root + 2)
    `);
    console.log(`relpath = ${JSON.stringify(relpath)}`);

    // ── Step 3: git show HEAD ─────────────────────────────────────
    const headContent = await client.execLua(`
      local output = vim.fn.systemlist(
        "git -C " .. vim.fn.shellescape([==[${dir}]==]) .. " show HEAD:" .. [==[${relpath}]==] .. " 2>/dev/null"
      )
      return { shell_error = vim.v.shell_error, lines = output, count = #output }
    `);
    console.log(`git show HEAD result: ${JSON.stringify(headContent)}`);

    // ── Step 4: Also try a direct systemlist to see the raw output ─
    const rawSys = await client.execLua(`
      local cmd = "git -C " .. vim.fn.shellescape([==[${dir}]==]) .. " show HEAD:" .. [==[${relpath}]==]
      return { cmd = cmd }
    `);
    console.log(`command: ${(rawSys as any).cmd}`);
  }

  client.disconnect();
  nvim.kill();
  try { unlinkSync(NVIM_SOCKET); } catch {}
  console.log("done");
}

function waitForSocket(path: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const d = Date.now();
    const check = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() - d > ms) return reject(new Error("timeout"));
      setTimeout(check, 100);
    };
    check();
  });
}

main().catch(e => { console.error(e); process.exit(1); });
