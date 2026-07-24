-- pi-nvim.lua — Lua support module for pi.dev ↔ Neovim integration.
-- Injected into Neovim by the pi extension via nvim_exec_lua.
-- Provides a reverse-command channel back to pi over a Unix socket,
-- and manages the pi-edits scratch buffer (replaces quickfix).

local M = {}

-- ═══════════════════════════════════════════════════════════════════
-- Internal state
-- ═══════════════════════════════════════════════════════════════════

local socket_path = nil
local pi_pid = nil
local sock = nil
local connected = false

-- Buffer state
local edits_buf_name = "pi://edits"
local last_entries_json = nil -- cached entries for buffer rebuilds

-- ═══════════════════════════════════════════════════════════════════
-- Socket communication (pi → extension)
-- ═══════════════════════════════════════════════════════════════════

--- Send a JSON-line command over the socket to pi.
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
  if connected then return end
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

-- ═══════════════════════════════════════════════════════════════════
-- Edits buffer — a custom scratch buffer replacing the quickfix list
-- ═══════════════════════════════════════════════════════════════════

--- Format a single entry as a tab-separated display line.
local function format_entry(entry)
  -- entry: { filename, lnum, col, text }
  -- Display: <filename>\t<tool>\t<time>
  -- Use the text field which already contains "file | tool | time"
  local tool_time = entry.text or ""
  return entry.filename .. "\t" .. tool_time
end

--- Format all entries into buffer lines.
local function format_entries(entries)
  local lines = { "pi.dev modified files", "─────────────────────" }
  for _, e in ipairs(entries) do
    lines[#lines + 1] = format_entry(e)
  end
  if #entries == 0 then
    lines[#lines + 1] = "(no modified files tracked yet)"
  end
  return lines
end

--- Get the filename from a edits-buffer line (tab-separated, first field).
local function get_filename_from_line(line)
  if not line or line == "" then return nil end
  -- Skip header/divider/empty lines
  if line:match("^pi%.dev ") or line:match("^─+$") or line:match("^%(no ") then
    return nil
  end
  return (vim.split(line, "\t")[1] or ""):gsub("^%s+", ""):gsub("%s+$", "")
end

--- Open a vertical git-diff split for the given file.
--- LEFT = git HEAD content in a scratch buffer, RIGHT = working-tree file.
local function open_diff_for_file(filepath)
  filepath = vim.fn.fnamemodify(filepath, ":p")
  local dir = vim.fn.fnamemodify(filepath, ":h")
  local reporoot = vim.fn.systemlist(
    "git -C " .. vim.fn.shellescape(dir) .. " rev-parse --show-toplevel 2>/dev/null"
  )
  local in_git = (#reporoot > 0 and reporoot[1] ~= "")

  if in_git then
    local root = reporoot[1]
    local relpath = string.sub(filepath, #root + 2)

    -- vert diffsplit creates a new window to the LEFT of the current one.
    -- Layout after split: [LEFT=new: file] [RIGHT=old: original buffer]
    vim.cmd("vert diffsplit " .. vim.fn.fnameescape(filepath))
    -- We are now in the LEFT (new) window showing the file.
    -- Set up RIGHT side first: go right, load working-tree file, enable diff.
    vim.cmd("wincmd l")
    vim.cmd("e " .. vim.fn.fnameescape(filepath))
    vim.cmd("diffthis")
    -- Now set up LEFT side: go back left, replace with HEAD content.
    vim.cmd("wincmd h")
    vim.cmd("enew!")
    local head_content = vim.fn.systemlist(
      "git -C " .. vim.fn.shellescape(dir) .. " show HEAD:" .. relpath .. " 2>/dev/null"
    )
    if vim.v.shell_error == 0 then
      vim.api.nvim_buf_set_lines(0, 0, -1, false, head_content)
      vim.bo.modified = false
      vim.bo.buftype = "nofile"
    end
    vim.cmd("diffthis")
  else
    -- Non-git: diff against empty buffer
    vim.cmd("vert diffsplit " .. vim.fn.fnameescape(filepath))
    vim.cmd("wincmd l")
    vim.cmd("diffthis")
    vim.cmd("wincmd h")
    vim.cmd("enew")
    vim.bo.buftype = "nofile"
    vim.cmd("diffthis")
  end
end

--- Find the edits buffer by name, or return nil.
local function find_edits_buf()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(buf) then
      local name = vim.api.nvim_buf_get_name(buf)
      if name == edits_buf_name then
        return buf
      end
    end
  end
  return nil
end

--- Find a window that shows the given buffer.
local function find_window_for_buf(bufnr)
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_win_get_buf(win) == bufnr then
      return win
    end
  end
  return nil
end

--- Create the edits buffer (if it doesn't exist) with proper options and keymaps.
--- Set up buffer-local keymaps on the edits buffer.
--- Called every time the buffer is shown or created, so keymap fixes
--- take effect without requiring the user to wipe the buffer.
local function setup_edits_keymaps(bufnr)
  local opts = { noremap = true, silent = true, buffer = bufnr }

  -- Helper: find a suitable window for opening a file.
  -- Skips specialty windows (nvim-tree, terminal, quickfix) and the edits buffer.
  local function find_target_window()
    for _, win in ipairs(vim.api.nvim_list_wins()) do
      local buf = vim.api.nvim_win_get_buf(win)
      if buf ~= bufnr then
        local bt = vim.bo[buf].buftype or ""
        if bt ~= "nofile" and bt ~= "terminal" and bt ~= "quickfix" then
          return win
        end
      end
    end
    -- Fallback: any non-edits window
    for _, win in ipairs(vim.api.nvim_list_wins()) do
      if vim.api.nvim_win_get_buf(win) ~= bufnr then return win end
    end
  end

  -- <CR>: open file under cursor
  vim.keymap.set("n", "<CR>", function()
    local cursor = vim.api.nvim_win_get_cursor(0)
    local line = vim.api.nvim_buf_get_lines(bufnr, cursor[1] - 1, cursor[1], false)[1]
    local filename = get_filename_from_line(line)
    if not filename then return end
    local target = find_target_window()
    if target then vim.api.nvim_set_current_win(target) end
    vim.cmd("e " .. vim.fn.fnameescape(filename))
  end, opts)

  -- d: diff current file against git HEAD
  vim.keymap.set("n", "d", function()
    local cursor = vim.api.nvim_win_get_cursor(0)
    local line = vim.api.nvim_buf_get_lines(bufnr, cursor[1] - 1, cursor[1], false)[1]
    local filename = get_filename_from_line(line)
    if not filename then return end
    local target = find_target_window()
    if target then vim.api.nvim_set_current_win(target) end
    open_diff_for_file(filename)
  end, opts)

  -- r: request refresh from pi
  vim.keymap.set("n", "r", function()
    send_cmd({ cmd = "pi_open_file", file = "__pi_edits_refresh__" })
    vim.notify("pi-nvim: requested edits refresh", vim.log.levels.INFO)
  end, opts)

  -- q: close the edits window
  vim.keymap.set("n", "q", function()
    local win = find_window_for_buf(bufnr)
    if win then vim.api.nvim_win_close(win, true) end
  end, opts)
end

--- Create the edits buffer (if it doesn't exist) with proper options.
--- Keymaps are set up unconditionally so fixes take effect without
--- requiring the user to manually wipe the old buffer.
local function ensure_edits_buf()
  local bufnr = find_edits_buf()
  if not bufnr then
    -- Create a new buffer
    bufnr = vim.api.nvim_create_buf(false, true) -- listed=false, scratch=true
    vim.api.nvim_buf_set_name(bufnr, edits_buf_name)

    -- Buffer options
    vim.bo[bufnr].buftype = "nofile"
    vim.bo[bufnr].bufhidden = "hide"
    vim.bo[bufnr].buflisted = false
    vim.bo[bufnr].modifiable = true -- temporarily so we can write content
    vim.bo[bufnr].swapfile = false
  end

  -- Always refresh keymaps (overwrites any existing buffer-local mappings)
  setup_edits_keymaps(bufnr)

  return bufnr
end

--- Show the edits buffer (create + open a window for it).
function M.show_edits_buffer()
  local bufnr = ensure_edits_buf()

  -- Look for an existing window showing this buffer
  local existing_win = find_window_for_buf(bufnr)
  if existing_win then
    vim.api.nvim_set_current_win(existing_win)
    return
  end

  -- Open in a horizontal split below the current window
  vim.cmd("belowright split")
  local win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(win, bufnr)
  vim.api.nvim_win_set_height(win, math.min(12, math.floor(vim.o.lines / 3)))
end

--- Update the edits buffer content from a JSON string of entries.
--- Called by the pi extension via nvim_exec_lua.
--- @param json_entries string JSON array of {filename, lnum, col, text}
function M.update_edits_buffer(json_entries)
  last_entries_json = json_entries

  local ok, entries = pcall(vim.fn.json_decode, json_entries)
  if not ok then
    vim.notify("pi-nvim: failed to parse edits entries", vim.log.levels.ERROR)
    return
  end

  local bufnr = ensure_edits_buf()

  -- Remember cursor position so we can restore it
  local win = find_window_for_buf(bufnr)
  local saved_line = win and vim.api.nvim_win_get_cursor(win)[1] or 1

  -- Replace buffer content
  vim.bo[bufnr].modifiable = true
  local lines = format_entries(entries)
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.bo[bufnr].modifiable = false

  -- Restore cursor (clamp to new line count)
  if win then
    local max = vim.api.nvim_buf_line_count(bufnr)
    vim.api.nvim_win_set_cursor(win, { math.min(saved_line, max), 0 })
  end
end

--- Close the edits buffer window (buffer survives in background).
function M.close_edits_buffer()
  local bufnr = find_edits_buf()
  if not bufnr then return end
  local win = find_window_for_buf(bufnr)
  if win then
    vim.api.nvim_win_close(win, true)
  end
end

-- ═══════════════════════════════════════════════════════════════════
-- Public API (called by pi extension)
-- ═══════════════════════════════════════════════════════════════════

--- Initialize the pi-nvim integration.
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
        local diff_lines = vim.fn.systemlist(
          "git -C " .. vim.fn.shellescape(dir) .. " diff HEAD -- " .. vim.fn.shellescape(filepath)
        )
        local diff_text = table.concat(diff_lines, "\n")

        if diff_text ~= "" then
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
        send_cmd({
          cmd = "pi_edit",
          file = filepath,
          diff = "(non-git file)",
        })
      end
    end,
  })

  -- ══ User commands ══

  vim.api.nvim_create_user_command("PiPrompt", function(args)
    send_cmd({ cmd = "pi_prompt", text = args.args })
  end, { nargs = 1, desc = "Send a prompt to pi.dev" })

  vim.api.nvim_create_user_command("PiSendSelection", function()
    local _, ls, cs = unpack(vim.fn.getpos("'<"))
    local _, le, ce = unpack(vim.fn.getpos("'>"))
    local lines = vim.api.nvim_buf_get_lines(0, ls - 1, le, false)
    local text = table.concat(lines, "\n")
    local file = vim.fn.expand("%:p")
    vim.ui.input({
      prompt = "Prompt to send with selection: ",
    }, function(input)
      if input == nil or input == "" then return end
      send_cmd({
        cmd = "pi_select",
        file = file,
        lines = text,
        line_start = ls,
        line_end = le,
        prompt = input,
      })
    end)
  end, { range = true, desc = "Send selected text with a prompt to pi.dev" })

  vim.api.nvim_create_user_command("PiEdits", function()
    M.show_edits_buffer()
  end, { desc = "Show the pi.dev modified-files buffer" })

  vim.api.nvim_create_user_command("PiStatus", function()
    local info = {
      "pi-nvim status:",
      "  connected: " .. tostring(M.is_connected()),
      "  socket_path: " .. tostring(socket_path),
      "  pi_pid: " .. tostring(pi_pid),
      "  sock_active: " .. tostring(sock ~= nil and not sock:is_closing()),
    }
    vim.notify(table.concat(info, "\n"), vim.log.levels.INFO)
  end, { desc = "Show pi-nvim connection status" })
end

--- Check whether the module is actively connected to a pi.dev instance.
--- Returns true when the Unix socket to pi is established and healthy.
--- @return boolean
function M.is_connected()
  return connected and sock ~= nil and not sock:is_closing()
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
