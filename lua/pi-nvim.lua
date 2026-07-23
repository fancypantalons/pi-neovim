-- pi-nvim.lua — Lua support module for pi.dev ↔ Neovim integration.
-- Injected into Neovim by the pi extension via nvim_exec_lua.
-- Provides a reverse-command channel back to pi over a Unix socket.

local M = {}

-- Internal state
local socket_path = nil
local pi_pid = nil
local sock = nil  -- uv_tcp_t handle for the socket connection
local connected = false

--- Send a JSON-line command over the socket to pi.
--- @param cmd table Command object with a "cmd" field
local function send_cmd(cmd)
  if not sock or sock:is_closing() or not connected then
    vim.schedule(function()
      local msg = "pi-nvim: cannot send — "
      if not sock then msg = msg .. "no socket"
      elseif sock:is_closing() then msg = msg .. "socket closing"
      elseif not connected then msg = msg .. "not connected" end
      vim.notify(msg, vim.log.levels.WARN)
    end)
    return
  end
  local ok, json = pcall(vim.fn.json_encode, cmd)
  if not ok then
    vim.schedule(function()
      vim.notify("pi-nvim: json encode failed", vim.log.levels.ERROR)
    end)
    return
  end
  sock:write(json .. "\n", function(err)
    if err then
      vim.schedule(function()
        vim.notify("pi-nvim: write failed: " .. tostring(err), vim.log.levels.ERROR)
      end)
    end
  end)
end

--- Connect to pi's Unix socket server.
local function connect_socket()
  if connected then
    return
  end
  sock = vim.loop.new_pipe()
  sock:connect(socket_path, function(err)
    if err then
      vim.schedule(function()
        vim.notify("pi-nvim: failed to connect to pi: " .. err, vim.log.levels.WARN)
      end)
      return
    end
    connected = true
    vim.schedule(function()
      vim.notify("pi-nvim: connected to pi", vim.log.levels.INFO)
    end)
  end)
end

--- Notify pi that Neovim is closing.
local function on_vim_leave()
  send_cmd({ cmd = "pi_exit" })
end

--- Set up buffer-local quickfix mappings.
--- Called whenever the quickfix list is populated.
local function setup_quickfix_mappings()
  -- Find the quickfix window
  local qf_winnr = nil
  for _, win in ipairs(vim.fn.getwininfo()) do
    if win.quickfix == 1 and win.loclist == 0 then
      qf_winnr = win.winnr
      break
    end
  end
  if not qf_winnr then
    return
  end

  local qf_bufnr = vim.fn.winbufnr(qf_winnr)
  if not qf_bufnr or qf_bufnr == -1 then
    return
  end

  -- d: open vertical diffsplit for the file under cursor
  vim.api.nvim_buf_set_keymap(qf_bufnr, "n", "d", "", {
    noremap = true,
    silent = true,
    callback = function()
      local qf_list = vim.fn.getqflist()
      local idx = vim.fn.line(".") -- 1-based line in qf window
      if idx < 1 or idx > #qf_list then
        return
      end
      local entry = qf_list[idx]
      local filepath = vim.fn.bufname(entry.bufnr)
      if filepath == "" then
        filepath = entry.filename or ""
      end
      if filepath == "" then
        return
      end

      -- Find a non-quickfix window to operate in 
      local target_win = nil
      for _, win in ipairs(vim.api.nvim_list_wins()) do
        local buf = vim.api.nvim_win_get_buf(win)
        if vim.bo[buf].buftype ~= "quickfix" then
          target_win = win
          break
        end
      end
      if not target_win then return end
      vim.api.nvim_set_current_win(target_win)

      -- Open the file in a vertical diff split
      -- Resolve to absolute first (quickfix paths may be relative)
      filepath = vim.fn.fnamemodify(filepath, ":p")
      local dir = vim.fn.fnamemodify(filepath, ":h")
      local reporoot = vim.fn.systemlist(
        "git -C " .. vim.fn.shellescape(dir) .. " rev-parse --show-toplevel 2>/dev/null"
      )
      local in_git = (#reporoot > 0 and reporoot[1] ~= "")

      if in_git then
        -- Convert absolute path to repo-relative for 'git show HEAD:'
        local root = reporoot[1]
        local relpath = string.sub(filepath, #root + 2) -- +2 for the trailing /

        -- Open the working-tree file in a vertical split (right side)
        vim.cmd("vert diffsplit " .. vim.fn.fnameescape(filepath))
        vim.cmd("diffthis")

        -- Left side: fresh scratch buffer for HEAD content
        vim.cmd("wincmd h")
        vim.cmd("enew!")  -- fresh buffer, avoids buffer-sharing with right side
        local head_content = vim.fn.systemlist(
          "git -C " .. vim.fn.shellescape(dir) .. " show HEAD:" .. relpath .. " 2>/dev/null"
        )
        if vim.v.shell_error == 0 then
          vim.api.nvim_buf_set_lines(0, 0, -1, false, head_content)
          vim.bo.modified = false
          vim.bo.buftype = "nofile"
          vim.cmd("diffthis")
        else
          -- git show failed; fall back to diff against empty buffer
          vim.cmd("diffthis")
        end
      else
        -- Non-git file: diff against empty buffer
        vim.cmd("vert diffsplit " .. vim.fn.fnameescape(filepath))
        vim.cmd("diffthis")
        vim.cmd("wincmd h")
        vim.cmd("enew")
        vim.bo.buftype = "nofile"
        vim.cmd("diffthis")
      end
    end,
  })
end

-- ── Public API ─────────────────────────────────────────────────────────

--- Initialize the pi-nvim integration.
--- Called by the pi extension after injecting this module.
--- @param opts table { socket_path: string, pi_pid: number }
function M.setup(opts)
  socket_path = opts.socket_path
  pi_pid = opts.pi_pid

  -- Connect to pi's socket server
  connect_socket()

  local augroup = vim.api.nvim_create_augroup("PiNeovim", { clear = true })

  -- VimLeave: notify pi that Neovim is closing
  vim.api.nvim_create_autocmd("VimLeave", {
    group = augroup,
    callback = on_vim_leave,
  })

  -- BufWinEnter: apply quickfix mappings when our quickfix buffer is shown
  vim.api.nvim_create_autocmd("BufWinEnter", {
    group = augroup,
    callback = function()
      if vim.bo.buftype == "quickfix" then
        local qf_title = vim.fn.getqflist({ title = 1 }).title
        if qf_title == "pi-neovim modified files" then
          -- Defer so the qf buffer is fully rendered
          vim.defer_fn(setup_quickfix_mappings, 50)
        end
      end
    end,
  })

  -- BufWritePost: auto-detect user saves and report diffs to pi
  vim.api.nvim_create_autocmd("BufWritePost", {
    group = augroup,
    callback = function(args)
      local filepath = vim.fn.fnamemodify(args.file, ":p")
      local dir = vim.fn.fnamemodify(filepath, ":h")

      -- Check if in git repo
      local in_git = vim.fn.systemlist(
        "git -C " .. vim.fn.shellescape(dir) .. " rev-parse --is-inside-work-tree 2>/dev/null"
      )

      if #in_git > 0 and in_git[1] == "true" then
        -- Get git diff HEAD for this file
        local diff_lines = vim.fn.systemlist(
          "git -C " .. vim.fn.shellescape(dir) .. " diff HEAD -- " .. vim.fn.shellescape(filepath)
        )
        local diff_text = table.concat(diff_lines, "\n")

        if diff_text ~= "" then
          -- Count added/removed lines
          local added, removed = 0, 0
          for _, line in ipairs(diff_lines) do
            if line:match("^%+") and not line:match("^%+%+%+") then
              added = added + 1
            elseif line:match("^- ") and not line:match("^---") then
              removed = removed + 1
            end
          end

          send_cmd({
            cmd = "pi_edit",
            file = filepath,
            diff = diff_text,
            added = added,
            removed = removed,
          })
        end
      else
        -- Non-git: send a notification that the file was saved
        send_cmd({
          cmd = "pi_edit",
          file = filepath,
          diff = "(non-git file)",
        })
      end
    end,
  })

  -- User commands
  vim.api.nvim_create_user_command("PiPrompt", function(args)
    send_cmd({ cmd = "pi_prompt", text = args.args })
  end, { nargs = 1, desc = "Send a prompt to pi.dev" })

  vim.api.nvim_create_user_command("PiSendSelection", function()
    local _, ls, cs = unpack(vim.fn.getpos("'<"))
    local _, le, ce = unpack(vim.fn.getpos("'>"))
    local lines = vim.api.nvim_buf_get_lines(0, ls - 1, le, false)
    local text = table.concat(lines, "\n")
    local file = vim.fn.expand("%:p")
    send_cmd({ cmd = "pi_select", file = file, lines = text })
  end, { range = true, desc = "Send selected text to pi.dev" })

  vim.api.nvim_create_user_command("PiQuickfix", function()
    -- Triggers pi to re-push the quickfix list
    send_cmd({ cmd = "pi_open_file", file = "__pi_quickfix_refresh__" })
  end, { desc = "Request quickfix refresh from pi.dev" })

  vim.api.nvim_create_user_command("PiStatus", function()
    local info = {
      "pi-nvim status:",
      "  connected: " .. tostring(connected),
      "  socket_path: " .. tostring(socket_path),
      "  pi_pid: " .. tostring(pi_pid),
      "  sock_active: " .. tostring(sock ~= nil and not sock:is_closing()),
    }
    vim.notify(table.concat(info, "\n"), vim.log.levels.INFO)
  end, { desc = "Show pi-nvim connection status" })
end

--- Send a command to pi. Useful for other Lua code to call.
--- @param method string The command method (pi_prompt, pi_select, etc.)
--- @param args table Additional arguments
function M.send_command(method, args)
  args = args or {}
  args.cmd = method
  send_cmd(args)
end

return M
