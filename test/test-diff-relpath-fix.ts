import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { NeovimClient } from "../src/neovim-client";

const SOCK = "/tmp/pi-nvim-fix.sock";
const FILEPATH = "_posts/2026-07-20-tour-alberta-2026.md";  // RELATIVE

async function main() {
  if (existsSync(SOCK)) try { unlinkSync(SOCK); } catch {}
  const nvim = spawn("nvim", ["--headless", "--listen", SOCK, "--cmd", "cd /home/brettk/blog"], { stdio: ["ignore","pipe","pipe"] });
  nvim.stderr?.on("data", (d: Buffer) => process.stderr.write(d.toString()));
  await new Promise(r => setTimeout(r, 2000));
  const c = new NeovimClient();
  await c.connect(SOCK);

  const trace = await c.execLua(`
    local filepath = [==[${FILEPATH}]==]
    filepath = vim.fn.fnamemodify(filepath, ":p")  -- THE FIX
    local dir = vim.fn.fnamemodify(filepath, ":h")
    local reporoot = vim.fn.systemlist("git -C " .. vim.fn.shellescape(dir) .. " rev-parse --show-toplevel 2>/dev/null")
    local root = reporoot[1]
    local relpath = string.sub(filepath, #root + 2)
    local cmd = "git -C " .. vim.fn.shellescape(dir) .. " show HEAD:" .. relpath
    local head = vim.fn.systemlist(cmd)
    
    return {
      abs_path = filepath,
      relpath = relpath,
      shell_error = vim.v.shell_error,
      head_lines = #head,
      head_sample = head[1],
    }
  `);
  console.log(JSON.stringify(trace, null, 2));

  c.disconnect(); nvim.kill(); try { unlinkSync(SOCK); } catch {}
}
main().catch(e => { console.error(e); process.exit(1); });
