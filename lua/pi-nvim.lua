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
  if not sock or sock:is_closing() then
    return
  end
  local ok, json = pcall(vim.fn.json_encode, cmd)
  if not ok then
    return
  end
  sock:write(json .. "\n")
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

--- Report a buffer save/edit to pi.
--- Opens a :vert diffsplit showing git diff HEAD for the file.
local function show_diff_for_file(filepath)
  -- Check if file is in a git repo
  local in_git = vim.fn.system("git -C " .. vim.fn.shellescape(vim.fn.fnamemodify(filepath, ":h")) .. " rev-parse --is-inside-work-tree 2>/dev/null")

  if vim.v.shell_error == 0 then
    -- Git repo: show git diff HEAD
    vim.cmd("vert diffsplit " .. vim.fn.fnameescape(filepath))
    vim.cmd("diffthis")
    vim.fn.system("git -C " .. vim.fn.shellescape(vim.fn.fnamemodify(filepath, ":h")) .. " show HEAD:" .. vim.fn.shellescape(filepath))
    -- TODO: implement proper git diff using :Gvdiffsplit or manual buffer population
  else
    -- Not in git: diff against empty buffer
    vim.cmd("vert diffsplit " .. vim.fn.fnameescape(filepath))
    vim.cmd("diffthis")
  end
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

      -- Open the file in a vertical diff split
      local ft = vim.filetype.match({ filename = filepath })
      local in_git = vim.fn.systemlist(
        "git -C " .. vim.fn.shellescape(vim.fn.fnamemodify(filepath, ":h")) ..
        " rev-parse --is-inside-work-tree 2>/dev/null"
      )

      if #in_git > 0 and in_git[1] == "true" then
        -- Git file: open current version in left split, show git diff HEAD
        vim.cmd("exec 'vert diffsplit ' .. fnameescape('" .. vim.fn.fnameescape(filepath) .. "')")
        vim.cmd("diffthis")
        vim.cmd("wincmd h")
        -- Read git HEAD version into the original buffer
        local head_content = vim.fn.systemlist(
          "git -C " .. vim.fn.shellescape(vim.fn.fnamemodify(filepath, ":h")) ..
          " show HEAD:" .. vim.fn.shellescape(filepath) .. " 2>/dev/null"
        )
        if vim.v.shell_error == 0 then
          vim.api.nvim_buf_set_lines(0, 0, -1, false, head_content)
          vim.bo.modified = false
          vim.bo.buftype = "nofile"
          vim.cmd("diffthis")
        end
      else
        -- Non-git file: diff against empty buffer
        vim.cmd("exec 'vert diffsplit ' .. fnameescape('" .. vim.fn.fnameescape(filepath) .. "')")
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
