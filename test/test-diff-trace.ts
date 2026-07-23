import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { NeovimClient } from "../src/neovim-client";

const SOCK = "/tmp/pi-nvim-trace.sock";
const FILEPATH = "/home/brettk/blog/_posts/2026-07-20-tour-alberta-2026.md";

async function main() {
  if (existsSync(SOCK)) try { unlinkSync(SOCK); } catch {}
  const nvim = spawn("nvim", ["--headless", "--listen", SOCK, "--cmd", "cd /home/brettk/blog"], { stdio: ["ignore","pipe","pipe"] });
  nvim.stderr?.on("data", (d: Buffer) => process.stderr.write(d.toString()));
  await new Promise(r => setTimeout(r, 2000));
  const c = new NeovimClient();
  await c.connect(SOCK);

  const result = await c.execLua(`
    local filepath = [==[${FILEPATH}]==]
    local dir = vim.fn.fnamemodify(filepath, ":h")
    local reporoot = vim.fn.systemlist("git -C " .. vim.fn.shellescape(dir) .. " rev-parse --show-toplevel 2>/dev/null")
    local root = (#reporoot > 0 and reporoot[1] ~= "") and reporoot[1] or nil
    if not root then return { error = "not in git" } end
    local relpath = string.sub(filepath, #root + 2)
    return {
      dir = dir,
      root = root,
      root_len = #root,
      filepath_len = #filepath,
      filepath = filepath,
      relpath = relpath,
    }
  `);
  console.log(JSON.stringify(result, null, 2));

  c.disconnect(); nvim.kill(); try { unlinkSync(SOCK); } catch {}
}
main().catch(e => { console.error(e); process.exit(1); });
