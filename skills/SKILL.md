# pi-neovim

Use this skill when you want to show the user code in a full editor or when the user wants to inspect files you've modified.

## When to Use

- The user asks to "see" or "browse" files you've been working on
- You've written or edited several files and want the user to review them
- The user wants an interactive way to explore your changes
- The user mentions Neovim, nvim, or the editor

## Available Tools

### `open_in_nvim`

Opens Neovim in a right tmux pane with a live quickfix list of all agent-modified files.

**Parameters:**
- `files` (optional) — array of file paths to open initially
- `focus_file` (optional) — which file to put the cursor on
- `focus_line` (optional) — line number in focus_file to jump to

**When to call:** Call this when the user asks to see your work, when you've finished making changes and want the user to review, or when the user seems to want editor-level interaction.

**Behavior:** Idempotent — if Neovim is already open, returns current status. If the user closed Neovim, spawns a fresh instance.

### `nvim_quickfix`

Query or refresh the list of modified files shown in Neovim's quickfix window.

**Parameters:**
- `action` — `"list"` to see the current list, `"refresh"` to push updates to Neovim

## What the User Sees in Neovim

- **Quickfix list** titled "pi-neovim modified files" showing every file you've written or edited
- **Enter** on any entry opens that file
- **d** on any entry opens a side-by-side diff (git HEAD vs current)
- **:PiPrompt _text_** sends a prompt back to you
- **:PiSendSelection** sends selected text as context
- **:PiQuickfix** requests a quickfix list refresh

## Two-Way Editing

When the user saves a file in Neovim (`:w`), the extension automatically detects the change, computes a git diff, and notifies you through the conversation. You'll see messages like "User saved file.ts (+5/-2 lines)".

## Tips

- Call `open_in_nvim` early when doing multi-file work so the user can follow along
- After calling `write` or `edit`, the quickfix list updates automatically — no need to call `nvim_quickfix` each time
- When the user asks "what did you change?", call `open_in_nvim` so they can browse with the 'd' diff key
- If Neovim is already open and the user asks for a refresh, use `nvim_quickfix` with action `"refresh"`
