import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { NeovimClient } from "../src/neovim-client";

const SOCK = "/tmp/pi-nvim-trace3.sock";
// Simulate RELATIVE path from quickfix
const FILEPATH = "_posts/2026-07-20-tour-alberta-2026.md";

async function main() {
  if (existsSync(SOCK)) try { unlinkSync(SOCK); } catch {}
  const nvim = spawn("nvim", ["--headless", "--listen", SOCK, "--cmd", "cd /home/brettk/blog"], { stdio: ["ignore","pipe","pipe"] });
  nvim.stderr?.on("data", (d: Buffer) => process.stderr.write(d.toString()));
  await new Promise(r => setTimeout(r, 2000));
  const c = new NeovimClient();
  await c.connect(SOCK);

  const trace = await c.execLua(`
    local filepath = [==[${FILEPATH}]==]
    local dir = vim.fn.fnamemodify(filepath, ":h")
    local reporoot = vim.fn.systemlist("git -C " .. vim.fn.shellescape(dir) .. " rev-parse --show-toplevel 2>/dev/null")
    local in_git = (#reporoot > 0 and reporoot[1] ~= "")
    
    return {
      filepath = filepath,
      dir = dir,
      in_git = in_git,
      reporoot = reporoot,
    }
  `);
  console.log(JSON.stringify(trace, null, 2));

  c.disconnect(); nvim.kill(); try { unlinkSync(SOCK); } catch {}
}
main().catch(e => { console.error(e); process.exit(1); });
