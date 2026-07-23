# pi-neovim: Design & Architecture

A pi.dev extension that integrates Neovim into the coding workflow. Supports two modes:

- **Tmux mode:** pi.dev runs in a tmux pane, spawns a separate Neovim in a right-side pane
- **Embedded mode:** pi.dev runs inside a Neovim `:terminal` buffer, connects to the host Neovim directly

Mode is auto-detected via the `$NVIM` environment variable (set by Neovim in terminal buffers).

## Overview

```
┌─────────────────────────────────────────────────────────┐
│ tmux mode                                               │
│ ┌──────────────────┐  ┌──────────────────────────────┐  │
│ │ pi (left)        │  │ nvim (right, spawned)        │  │
│ │                  │  │                              │  │
│ │ Extension:       │  │ Lua module (injected):       │  │
│ │ ┌──────────────┐ │  │ ┌──────────────────────────┐ │  │
│ │ │nvim RPC      │─┼──┼→│ receives nvim_* API      │ │  │
│ │ │client        │─┼──┼─│ calls from extension     │ │  │
│ │ │(msgpack)     │ │  │ └──────────────────────────┘ │  │
│ │ └──────────────┘ │  │                              │  │
│ │ ┌──────────────┐ │  │ ┌──────────────────────────┐ │  │
│ │ │unix socket   │←┼──┼─│ pi_cmd("prompt", ...)    │ │  │
│ │ │server (JSON) │ │  │ │ pi_report_edit(...)      │ │  │
│ │ └──────────────┘ │  │ └──────────────────────────┘ │  │
│ └──────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ embedded mode                                           │
│ ┌──────────────────────────────────────────────────────┐│
│ │ nvim (host)                                         ││
│ │ ┌────────────────────────────────────────────────┐  ││
│ │ │ :terminal buffer                               │  ││
│ │ │ ┌──────────────────┐                           │  ││
│ │ │ │ pi.dev           │                           │  ││
│ │ │ │                  │                           │  ││
│ │ │ │ Extension:       │──── nvim RPC client ──────┼──┼│
│ │ │ │                  │     (over $NVIM socket)    │  ││
│ │ │ │ unix socket      │←─── Lua module (same) ────┼──┼│
│ │ │ │ server (JSON)    │                           │  ││
│ │ │ └──────────────────┘                           │  ││
│ │ └────────────────────────────────────────────────┘  ││
│ └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Trigger** | Model-triggered tool | Model calls `open_in_nvim` when it wants to show files. Keeps UI clean — no Neovim unless useful. In embedded mode, connects to the host rather than spawning. |
| **Mode detection** | `$NVIM` environment variable | Neovim sets `$NVIM` in `:terminal` children with the host's RPC socket path. If set → embedded mode. Otherwise → tmux mode. |
| **Lifecycle** | Session-persistent | One Neovim connection per pi session. Buffers, quickfix, undo history survive across turns. In embedded mode: disconnect on shutdown but never kill the host. In tmux mode: closes spawned Neovim on `session_shutdown` or `pi_exit`. |
| **Communication** | Dual-channel msgpack + JSON | pi→nvim uses msgpack-RPC (Neovim's native protocol). nvim→pi uses a Unix socket server in the extension (JSON protocol). Both modes use the same channels — only the socket paths differ. |
| **Editing** | Full two-way with auto-diff | User edits in Neovim are diffed automatically and reported to pi. Pi can incorporate user changes into its model of the codebase. |
| **Quickfix** | Auto-updating modified files | Tracks `write`/`edit` tool calls. Quickfix list pushes to Neovim on every change. Pre-populated from session history at startup. |
| **Tmux** | Required for tmux mode only | When running in a tmux session, the extension uses `tmux split-window -h` to create the right pane. In embedded mode, no tmux commands are issued — the host Neovim is already the user's editor. |
| **Distribution** | npm pi-package, git-installed | `pi install git:github.com/user/pi-neovim`. Self-contained with runtime deps in `package.json`. |

## Package Structure

```
pi-neovim/
├── package.json           # npm pi-package manifest
├── DESIGN.md              # This file
├── src/
│   ├── index.ts           # Extension entry point
│   ├── neovim-client.ts   # msgpack-RPC client (pi → nvim)
│   ├── nvim-server.ts     # Unix socket server (nvim → pi)
│   ├── file-tracker.ts    # Modified file tracking + quickfix
│   └── nvim-lifecycle.ts  # Spawn, connect, inject Lua, cleanup
├── lua/
│   └── pi-nvim.lua        # Lua support module (injected into Neovim)
└── skills/ (optional)
    └── SKILL.md            # Optional skill to guide the model on usage
```

## Component Details

### 1. Extension Entry Point (`src/index.ts`)

Registers:
- **Tool: `open_in_nvim`** — The model calls this to open Neovim in the right tmux pane.
  - Idempotent: if Neovim is already connected, returns existing status.
  - If previously disconnected (user closed, crashed), spawns a fresh instance with full re-initialization.
  - Parameters: optional `files` array to open initially, optional `focus` boolean.
  - Execute: checks state, spawns Neovim via tmux, establishes connections, returns summary.
- **State tracking:** Maintains `connected | disconnected` status. Transitions to `disconnected` on graceful exit (`pi_exit` message), unexpected socket close, or `session_shutdown`.
- **Tool: `nvim_quickfix`** — The model queries or refreshes the modified-file quickfix list.
- **Command: `/nvim`** — User can manually open/refresh from the pi prompt.
- **Event hooks:**
  - `tool_call` (write/edit): track modified files, push quickfix update.
  - `session_start`: scan session entries for pre-existing write/edit operations.
  - `session_shutdown`: close Neovim and clean up sockets.
  - `tool_result`: hook for reporting nvim-sourced diffs back to the model.

### 2. Neovim RPC Client (`src/neovim-client.ts`)

- Connects to Neovim's msgpack-RPC socket (`--listen /tmp/pi-nvim-<PID>`).
- Wraps common `nvim_*` API calls:
  - `nvim_open_win` / `nvim_set_current_buf` — open files
  - `nvim_set_current_line` — jump to line
  - `nvim_setqflist` — update quickfix list
  - `nvim_exec_lua` — execute Lua in Neovim (used for injection, custom commands)
  - `nvim_buf_get_lines` / `nvim_buf_set_lines` — buffer manipulation
- Uses a minimal msgpack encoder/decoder (or `msgpack-lite` dependency).

### 3. Unix Socket Server (`src/nvim-server.ts`)

- Starts a `node:net` server on `/tmp/pi-nvim-back-<PID>.sock`.
- JSON-line protocol. Commands from Neovim:
  - `{"cmd": "pi_prompt", "text": "Explain this function"}` — Send a prompt to pi.
  - `{"cmd": "pi_edit", "buf": "...", "file": "...", "diff": "..."}` — Report a user edit to pi.
  - `{"cmd": "pi_open_file", "file": "..."}` — Ask pi to open a file in its own context.
  - `{"cmd": "pi_select", "lines": "...", "file": "..."}` — Send selected text as context.
  - `{"cmd": "pi_exit"}` — Sent by the Lua module's `VimLeave` autocmd just before Neovim closes.
- Responses back to Neovim (optional acknowledgements).
- **Connection lifecycle:** Listens for socket `'close'` events. If the socket closes without receiving a `pi_exit` message (crash/kill), it treats it as an unexpected disconnect. In both cases, the extension updates its internal state to "disconnected" and cleans up.

### 4. File Tracker (`src/file-tracker.ts`)

- In-memory set of `{path, toolName, timestamp}` entries.
- On `session_start`: scans `ctx.sessionManager.getEntries()` for `write`/`edit` tool calls, rebuilds list.
- On `tool_call` (write/edit with path): adds entry, pushes updated quickfix to Neovim.
- Formats quickfix entries: `path | tool | timestamp` with `lnum:1, col:1`.
- Exports `getQuickfixList(): QuickfixEntry[]` for push to Neovim.

### 5. Neovim Lifecycle (`src/nvim-lifecycle.ts`)

Orchestrates Neovim instance management. Detects operating mode at startup via `$NVIM`:

**Tmux mode** (`$NVIM` not set):
- `spawn()` — `tmux split-window -h -l 50% nvim --listen /tmp/pi-nvim-<PID>`. Creates the right pane and launches Neovim.
- `waitForReady()` — Polls the msgpack-RPC socket until Neovim responds.
- `shutdown()` — Calls `nvim_command("qa!")`, kills the tmux pane, cleans up sockets.

**Embedded mode** (`$NVIM` is set):
- `open()` — Connects directly to the `$NVIM` socket. No tmux commands, no spawning.
- `shutdown()` — Disconnects RPC and stops the reverse server. Does NOT kill the host Neovim or any tmux pane.

**Both modes (common):**
- `connect()` — Establishes msgpack-RPC client connection.
- `injectLua()` — Reads `lua/pi-nvim.lua`, sends via `nvim_exec_lua` to Neovim.
- `startServer()` — Starts the Unix socket server for reverse commands.
- `handleDisconnect(reason)` — Called when Neovim exits (either gracefully via `pi_exit` or unexpectedly). Updates state, cleans up.

### 6. Lua Support Module (`lua/pi-nvim.lua`)

Injected into Neovim at startup. Provides:

```lua
-- Core functions exposed to the pi extension via nvim_exec_lua
M = {}

-- Send a command to pi's Unix socket
function M.pi_cmd(method, args)
  -- Serialize to JSON, write to /tmp/pi-nvim-back-<PID>.sock
end

-- Report a buffer edit to pi
function M.pi_report_edit(bufnr)
  -- Compare buffer content to last-known state, send diff
end

-- Setup: connect to pi's socket, attach autocmds
function M.setup(opts)
  -- opts.socket_path: path to pi's Unix socket
  -- Connect socket, attach BufWritePost autocmd for edit reporting
  -- Define user commands: :PiPrompt, :PiSendSelection
  -- Setup quickfix integration (custom qf title, mappings)
end
```

**Autocmds:**
- `BufWritePost *` — Reports saved buffer diffs to pi.
- `VimLeave` — Sends `pi_exit` notification to pi before Neovim terminates.
- `TextChangedI` (debounced) — Optional live edit tracking.

**Quickfix mappings (buffer-local):**
- `Enter` — Open file under cursor (built-in quickfix behavior).
- `d` — Open `:vertical diffsplit` showing `git diff HEAD` for the file under cursor. Falls back to diff against empty buffer if not in a git repo. Mapped when `setqflist` is called via an `ftplugin`-style hook on the qf buffer.

**User commands in Neovim:**
- `:PiPrompt <text>` — Send a prompt to pi.
- `:PiSendSelection` — Send visually selected text as context to pi.
- `:PiQuickfix` — Refresh the modified-files quickfix list.

## Tool API Design

### `open_in_nvim`

```typescript
parameters: Type.Object({
  files: Type.Optional(Type.Array(Type.String())),  // files to open initially
  focus_file: Type.Optional(Type.String()),         // file to focus/cursor to
  focus_line: Type.Optional(Type.Number()),          // line to jump to
})
```

Returns:
```json
{
  "status": "connected" | "already_open",
  "nvim_pid": 12345,
  "open_buffers": ["src/foo.ts", "src/bar.ts"],
  "modified_files_count": 7
}
```

### `nvim_quickfix`

```typescript
parameters: Type.Object({
  action: StringEnum(["refresh", "list"]),
})
```

Returns the current modified-files list or refreshes from session.

## Quickfix List

### Format

```
pi-neovim modified files
─────────────────────────
src/index.ts         | write  | 14:32:05
src/neovim-client.ts | edit   | 14:32:12
src/nvim-server.ts   | write  | 14:33:01
```

The title "pi-neovim modified files" distinguishes it from other quickfix lists.

### Interactions

| Key | Action |
|-----|--------|
| `Enter` | Open the file at line 1 (standard quickfix behavior) |
| `d` | Open a vertical diff split showing changes for the file under cursor |

**d → diff implementation:** When `d` is pressed on an entry:
1. Resolve the filename from the quickfix entry under cursor.
2. If the file is in a git repo, show `git diff HEAD -- <file>` in a new vertical split using Neovim's built-in diff mode (`:vertical diffsplit`).
3. If not in a git repo, show the current file buffer in diff mode against an empty scratch buffer (all lines appear as additions).
4. The mapping is set as a buffer-local keymap on the quickfix window each time the list is populated, so it works even after the user closes and reopens the quickfix.

## Session Flow

```
1. pi session starts
   └─ Mode auto-detected
      ├─ $NVIM set → embedded mode (connect to host Neovim)
      └─ $NVIM not set → tmux mode
   └─ session_start: scan entries for write/edit ops → build initial file tracker
   └─ Neovim NOT started yet (model-triggered only)

2. Model calls open_in_nvim (first time)
   └─ If already connected → return "already connected" status (idempotent)

   [tmux mode]
   └─ tmux split-window -h -l 50% nvim --listen /tmp/pi-nvim-<PID>
   └─ Wait for socket to appear

   [embedded mode]
   └─ Connect directly to $NVIM socket

   [both modes continue]
   └─ Connect msgpack-RPC client
   └─ Start Unix socket server
   └─ Inject lua/pi-nvim.lua (includes VimLeave autocmd for exit detection)
   └─ Push quickfix list with already-modified files
   └─ Open requested files
   └─ Mark as "connected"

3. During coding (Neovim connected)
   └─ User can freely switch between pi and nvim
   └─ Model calls write/edit → file tracker updates → push quickfix
   └─ User edits in Neovim → BufWritePost fires → Lua sends diff to pi
   └─ Pi receives edit → may incorporate into context
   └─ User runs :PiPrompt → sends prompt to pi → pi processes it

3a. User closes Neovim manually (tmux mode)
   └─ VimLeave fires → Lua sends pi_exit over socket
   └─ pi's server receives pi_exit → handleDisconnect("user_closed")
   └─ Internal state → "disconnected"
   └─ Future open_in_nvim calls spawn a fresh instance (full re-initialization)

3b. Neovim crashes or is killed (tmux mode)
   └─ Socket 'close' event fires on pi's server
   └─ No pi_exit message received → handleDisconnect("crashed")
   └─ Same cleanup path as above

3c. Disconnect in embedded mode
   └─ Socket close or VimLeave → pi handles gracefully
   └─ State → "disconnected", clean up local sockets only
   └─ Host Neovim remains alive (pi.dev terminal may have been killed)

4. pi session ends (quit, /new, /resume)
   └─ session_shutdown:
      ├─ tmux mode: nvim_command("qa!"), kill tmux pane
      └─ embedded mode: disconnect only, host Neovim stays alive
   └─ Close sockets, cleanup temp files
```

## Dependencies

### Node.js (runtime)
- `msgpack-lite` or hand-rolled minimal msgpack — for Neovim RPC
- Node built-ins: `node:net`, `node:fs`, `node:path`, `node:child_process`

### Neovim
- Neovim 0.9+ (for `--listen` and `sockconnect()`)
- No external Lua dependencies — everything is built into Neovim's stdlib (`vim.fn`, `vim.api`, `vim.loop`)

### System
- tmux (required for tmux mode only; not needed in embedded mode)
- Neovim installed and on PATH

## Open Questions / Future Work

- [x] **Offline mode**: What if the user isn't in tmux? Fallback strategies?
  - Embedded mode: when pi.dev runs inside a Neovim terminal, connects to the host Neovim via `$NVIM` socket. No tmux needed.
- [x] **Multiple nvim instances**: Could the user open multiple panes? How to route?
  - No, there will only be one pi.dev-managed nvim instance.
- [x] **Diff granularity**: Full file diff vs. hunk-level diffs for edit reporting?
  - Full file diff (this should use the built-in diff view interface)
- [x] **Inline diagnostics**: Should pi push LSP diagnostics or annotations to Neovim?
  - Not at this time.
- [x] **Progress reporting**: Show pi's current task/status in Neovim's statusline?
  - No
- [x] **Skills file**: A `SKILL.md` to teach the model when and how to use these tools?
  - Yes
