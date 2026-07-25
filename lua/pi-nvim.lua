-- pi-nvim.lua — Lua support module for pi.dev ↔ Neovim integration.
-- Injected into Neovim by the pi extension via nvim_exec_lua.
-- Provides a reverse-command channel back to pi over a Unix socket,
-- and manages the pi-edits scratch buffer (replaces quickfix).

local M = {}

-- vim.uv is the preferred handle on Neovim 0.10+; vim.loop is the 0.9 alias.
local uv = vim.uv or vim.loop

-- ═══════════════════════════════════════════════════════════════════
-- Internal state
-- ═══════════════════════════════════════════════════════════════════

local socket_path = nil
local pi_pid = nil
local sock = nil
local connected = false
local warned_offline = false -- latch so we warn about a dead socket only once

-- Buffer state
local edits_buf_name = "pi://edits"
local HEADER = "pi.dev modified files"
local DIVIDER = ("─"):rep(21)
local EMPTY_MSG = "(no modified files tracked yet)"
local HEADER_LINES = 2 -- header + divider precede the entry rows
-- Canonical list of tracked entries: { filename, tool, time }. This is the
-- single source of truth — both the pi://edits buffer and the telescope picker
-- render from it, so nothing has to parse formatted display text back to data.
local tracked_entries = {}

-- ═══════════════════════════════════════════════════════════════════
-- Socket communication (pi → extension)
-- ═══════════════════════════════════════════════════════════════════

--- Send a JSON-line command over the socket to pi.
local function send_cmd(cmd)
  if not sock or sock:is_closing() or not connected then
    -- Disconnected is a normal state (pi may have exited); warn only once per
    -- disconnect so background senders (BufWritePost, the `r` keymap) don't nag.
    if not warned_offline then
      warned_offline = true
      vim.schedule(function()
        local msg = "pi-nvim: cannot send — "
        if not sock then msg = msg .. "no socket"
        elseif sock:is_closing() then msg = msg .. "socket closing"
        else msg = msg .. "not connected" end
        vim.notify(msg, vim.log.levels.WARN)
      end)
    end
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
      -- The socket is broken; reflect that so is_connected() stops lying.
      connected = false
      vim.g.pi_nvim_connected = false
      vim.schedule(function()
        vim.notify("pi-nvim: write failed: " .. tostring(err), vim.log.levels.ERROR)
      end)
    end
  end)
end

--- Connect to pi's Unix socket server.
local function connect_socket()
  if connected then return end
  sock = uv.new_pipe()
  sock:connect(socket_path, function(err)
    if err then
      vim.schedule(function()
        vim.notify("pi-nvim: failed to connect to pi: " .. err, vim.log.levels.WARN)
      end)
      return
    end
    connected = true
    warned_offline = false
    vim.g.pi_nvim_connected = true
    vim.schedule(function()
      vim.notify("pi-nvim: connected to pi", vim.log.levels.INFO)
    end)
  end)
end

--- Notify pi that Neovim is closing.
local function on_vim_leave()
  -- Send *before* clearing `connected`, otherwise send_cmd short-circuits on
  -- `not connected` and pi_exit is never actually written.
  send_cmd({ cmd = "pi_exit" })
  connected = false
  vim.g.pi_nvim_connected = false
end

-- ═══════════════════════════════════════════════════════════════════
-- Edits buffer — a custom scratch buffer replacing the quickfix list
-- ═══════════════════════════════════════════════════════════════════

--- Render the current tracked entries into buffer lines.
--- Each entry row is tab-separated: <filename>\t<tool>\t<time>.
local function render_lines()
  local lines = { HEADER, DIVIDER }
  if #tracked_entries == 0 then
    lines[#lines + 1] = EMPTY_MSG
  else
    for _, e in ipairs(tracked_entries) do
      lines[#lines + 1] = e.filename .. "\t" .. e.tool .. "\t" .. e.time
    end
  end
  return lines
end

--- Map a 1-based buffer line number to its tracked entry.
--- Returns nil for the header, divider, or empty-state line — so keymaps that
--- act on "the file under the cursor" simply no-op there (no fragile text
--- pattern matching, no risk of opening a buffer named after the divider).
local function entry_for_line(lnum)
  local idx = lnum - HEADER_LINES
  if idx < 1 then return nil end
  return tracked_entries[idx]
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
    -- Repo-relative path. Guard the prefix: if filepath isn't under root (e.g.
    -- symlinked/realpath mismatch), fall back to the basename rather than
    -- slicing garbage.
    local relpath
    if filepath:sub(1, #root + 1) == root .. "/" then
      relpath = filepath:sub(#root + 2)
    else
      relpath = vim.fn.fnamemodify(filepath, ":t")
    end

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
      "git -C " .. vim.fn.shellescape(dir)
        .. " show " .. vim.fn.shellescape("HEAD:" .. relpath) .. " 2>/dev/null"
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
    local entry = entry_for_line(vim.api.nvim_win_get_cursor(0)[1])
    if not entry then return end
    local target = find_target_window()
    if target then vim.api.nvim_set_current_win(target) end
    vim.cmd("e " .. vim.fn.fnameescape(entry.filename))
  end, opts)

  -- d: diff current file against git HEAD
  vim.keymap.set("n", "d", function()
    local entry = entry_for_line(vim.api.nvim_win_get_cursor(0)[1])
    if not entry then return end
    local target = find_target_window()
    if target then vim.api.nvim_set_current_win(target) end
    open_diff_for_file(entry.filename)
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
  local ok, decoded = pcall(vim.fn.json_decode, json_entries)
  if not ok then
    vim.notify("pi-nvim: failed to parse edits entries", vim.log.levels.ERROR)
    return
  end

  -- Normalize into the canonical model. The extension packs display info into
  -- `text` as "path | tool | time"; split it into columns once, here.
  tracked_entries = {}
  for _, e in ipairs(decoded or {}) do
    local parts = vim.split(e.text or "", " | ", { plain = true })
    tracked_entries[#tracked_entries + 1] = {
      filename = e.filename,
      tool = parts[2] or "",
      time = parts[3] or "",
    }
  end

  local bufnr = ensure_edits_buf()

  -- Remember cursor position so we can restore it
  local win = find_window_for_buf(bufnr)
  local saved_line = win and vim.api.nvim_win_get_cursor(win)[1] or 1

  -- Replace buffer content
  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, render_lines())
  vim.bo[bufnr].modifiable = false

  -- Restore cursor (clamp to new line count)
  if win then
    local max = vim.api.nvim_buf_line_count(bufnr)
    vim.api.nvim_win_set_cursor(win, { math.min(saved_line, max), 0 })
  end
end

-- ═══════════════════════════════════════════════════════════════════
-- Telescope integration (optional — registered if telescope is loaded)
-- ═══════════════════════════════════════════════════════════════════

--- Open a telescope picker listing agent-modified files (from the
--- pi://edits buffer). Enter opens the file, d opens a git diff.
function M.telescope_edits()
  local has_telescope = pcall(require, "telescope")
  if not has_telescope then
    vim.notify("pi-nvim: telescope.nvim is not installed", vim.log.levels.WARN)
    return
  end

  local pickers = require("telescope.pickers")
  local finders = require("telescope.finders")
  local conf = require("telescope.config").values
  local actions = require("telescope.actions")
  local action_state = require("telescope.actions.state")

  -- Read straight from the canonical model — no display-text round-tripping.
  if #tracked_entries == 0 then
    vim.notify("pi-nvim: no modified files tracked yet", vim.log.levels.INFO)
    return
  end

  local function entry_maker(entry)
    return {
      value = entry,
      display = entry.filename,
      ordinal = entry.filename,
      path = entry.filename, -- required for file previewer
    }
  end

  pickers
    .new({}, {
      prompt_title = "pi-nvim modified files",
      finder = finders.new_table({
        results = tracked_entries,
        entry_maker = entry_maker,
      }),
      sorter = conf.generic_sorter({}),
      previewer = conf.file_previewer({}),
      attach_mappings = function(prompt_bufnr, map)
        -- Enter: open the file
        actions.select_default:replace(function()
          local selection = action_state.get_selected_entry()
          actions.close(prompt_bufnr)
          if selection and vim.fn.filereadable(selection.value.filename) == 1 then
            vim.cmd("e " .. vim.fn.fnameescape(selection.value.filename))
          end
        end)

        -- d: git diff
        map("n", "d", function()
          local selection = action_state.get_selected_entry()
          actions.close(prompt_bufnr)
          if selection then
            open_diff_for_file(selection.value.filename)
          end
        end)

        return true
      end,
    })
    :find()
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
            elseif line:match("^%-") and not line:match("^%-%-%-") then
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
    -- getpos returns { bufnum, lnum, col, off }; we send whole lines, so we
    -- only need the line numbers.
    local ls = vim.fn.getpos("'<")[2]
    local le = vim.fn.getpos("'>")[2]
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

  -- Eagerly register the telescope extension so :Telescope pi_nvim works
  -- immediately (not just after a lazy load triggered by :Telescope pi_nvim edits).
  -- require("telescope._extensions").load() requires the extension module,
  -- runs its setup, and populates telescope's manager cache.
  local has_telescope, telescope_ext = pcall(require, "telescope._extensions")
  if has_telescope and telescope_ext and telescope_ext.load then
    pcall(telescope_ext.load, "pi_nvim")
  end
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
