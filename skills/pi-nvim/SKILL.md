---
name: pi-nvim
description: Neovim integration for pi.dev — open files, browse agent-modified files in a custom scratch buffer, side-by-side git diffs, and two-way editing. Use when the user wants to see code in a full editor, review your changes, or interact with code through Neovim. Automatically adapts to tmux sessions and embedded terminal contexts.
---

# pi-neovim

Use this skill when you want to show the user code in a full editor or when the user wants to inspect files you've modified.

The extension automatically detects its context and adapts:
- **Tmux mode:** pi.dev runs in a tmux pane → spawns a separate Neovim in a side pane
- **Embedded mode:** pi.dev runs inside a Neovim `:terminal` buffer → connects to the host Neovim directly

## When to Use

- The user asks to "see" or "browse" files you've been working on
- You've written or edited several files and want the user to review them
- The user wants an interactive way to explore your changes
- The user mentions Neovim, nvim, or the editor

## Available Tools

### `open_in_nvim`

Connects Neovim with a live tracking list of all agent-modified files. In tmux mode, opens a right-side pane. In embedded mode (pi.dev inside a Neovim terminal), connects to the host Neovim directly. Modified files are displayed in a custom scratch buffer (the "pi-edits buffer") — not the global quickfix list, so it never conflicts with `:grep`, `:make`, or `:vimgrep`.

**Parameters:**
- `files` (optional) — array of file paths to open initially
- `focus_file` (optional) — which file to put the cursor on
- `focus_line` (optional) — line number in focus_file to jump to

**When to call:** Call this when the user asks to see your work, when you've finished making changes and want the user to review, or when the user seems to want editor-level interaction.

**Behavior:** Idempotent — if Neovim is already connected, returns current status. In tmux mode, if the user closed Neovim, spawns a fresh instance.

### `nvim_quickfix`

Query or refresh the list of modified files shown in the pi-edits buffer.

**Parameters:**
- `action` — `"list"` to see the current list, `"refresh"` to push updates to Neovim

## What the User Sees in Neovim

- **Pi-edits buffer** (opened with `:PiEdits`) showing every file you've written or edited
- **Enter** on any entry opens that file
- **d** on any entry opens a side-by-side diff (git HEAD vs current)
- **r** requests a refresh from pi
- **q** closes the edits window (buffer survives in background)
- **:PiPrompt _text_** sends a prompt back to you
- **:PiSendSelection** sends selected text as context
- The edits buffer is completely independent of the global quickfix — your `:grep` / `:make` results are never clobbered

## Two-Way Editing

When the user saves a file in Neovim (`:w`), the extension automatically detects the change, computes a git diff, and notifies you through the conversation. You'll see messages like "User saved file.ts (+5/-2 lines)".

## Tips

- Call `open_in_nvim` early when doing multi-file work so the user can follow along
- After calling `write` or `edit`, the edits buffer updates silently in the background — no need to call `nvim_quickfix` each time
- Tell the user they can run `:PiEdits` to view the list
- When the user asks "what did you change?", call `open_in_nvim` so they can browse with the 'd' diff key
