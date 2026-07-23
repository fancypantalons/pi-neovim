# pi-neovim: Design & Architecture

A pi.dev extension that integrates Neovim into the coding workflow via tmux. When the model decides to show files, it opens Neovim in a side pane with a live quickfix list of modified files and full two-way editing communication.

## Overview

```
┌─────────────────────────────────────────────────────────┐
│ tmux                                                    │
│ ┌──────────────────┐  ┌──────────────────────────────┐  │
│ │ pi (left)        │  │ nvim (right)                 │  │
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
```

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Trigger** | Model-triggered tool | Model calls `open_in_nvim` when it wants to show files. Keeps UI clean — no Neovim unless useful. |
| **Lifecycle** | Session-persistent | One Neovim instance per pi session. Buffers, quickfix, undo history survive across turns. Closes on `session_shutdown`. |
| **Communication** | Dual-channel msgpack + JSON | pi→nvim uses msgpack-RPC (Neovim's native protocol). nvim→pi uses a Unix socket server in the extension (JSON protocol). |
| **Editing** | Full two-way with auto-diff | User edits in Neovim are diffed automatically and reported to pi. Pi can incorporate user changes into its model of the codebase. |
| **Quickfix** | Auto-updating modified files | Tracks `write`/`edit` tool calls. Quickfix list pushes to Neovim on every change. Pre-populated from session history at startup. |
| **Tmux** | Assumed, extension-managed panes | Extension assumes it runs inside tmux. The tool calls `tmux split-window -h` to create the right pane, then launches Neovim in it. Closes the pane on `session_shutdown`. |
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

Orchestrates Neovim instance management:
- `spawn()` — Splits current tmux pane with `tmux split-window -h`, then runs `nvim --listen /tmp/pi-nvim-<PID>` in the new pane via `tmux send-keys`.
- `waitForReady()` — Polls the msgpack-RPC socket until Neovim responds.
- `connect()` — Establishes msgpack-RPC client connection.
- `injectLua()` — Reads `lua/pi-nvim.lua`, sends via `nvim_exec_lua` to Neovim.
- `startServer()` — Starts the Unix socket server for reverse commands.
- `shutdown()` — Calls `nvim_command("qa!")`, closes the tmux pane (`tmux kill-pane -t`), closes sockets, cleans up temp files.
- `handleDisconnect(reason)` — Called when Neovim exits (either gracefully via `pi_exit` or unexpectedly via socket close). Updates internal state to "disconnected", cleans up sockets/markers. If the tmux pane is still alive, kills it. Future `open_in_nvim` calls will spawn a fresh instance.

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

## Quickfix List Format

```
pi-neovim modified files
─────────────────────────
src/index.ts         | write  | 14:32:05
src/neovim-client.ts | edit   | 14:32:12
src/nvim-server.ts   | write  | 14:33:01
```

Each entry navigable; opens file at line 1 by default. The title "pi-neovim modified files" distinguishes it from other quickfix lists.

## Session Flow

```
1. pi session starts
   └─ session_start: scan entries for write/edit ops → build initial file tracker
   └─ Neovim NOT started yet (model-triggered only)

2. Model calls open_in_nvim (first time)
   └─ If already connected → return "already_open" status (idempotent)
   └─ tmux split-window -h -l 50% (creates right pane)
   └─ tmux send-keys to launch nvim --listen /tmp/pi-nvim-<PID>
   └─ Wait for socket to appear
   └─ Connect msgpack-RPC client
   └─ Start Unix socket server
   └─ Inject lua/pi-nvim.lua (includes VimLeave autocmd for exit detection)
   └─ Push quickfix list with already-modified files
   └─ Open requested files
   └─ Mark as "connected"

3. During coding (Neovim open in right pane)
   └─ User can freely switch between left (pi) and right (nvim) panes via tmux
   └─ Model calls write/edit → file tracker updates → push quickfix
   └─ User edits in Neovim → BufWritePost fires → Lua sends diff to pi
   └─ Pi receives edit → may incorporate into context
   └─ User runs :PiPrompt → sends prompt to pi → pi processes it

3a. User closes Neovim manually
   └─ VimLeave fires → Lua sends pi_exit over socket
   └─ pi's server receives pi_exit → handleDisconnect("user_closed")
   └─ Internal state → "disconnected"
   └─ If user/tmux didn't kill the pane, pi kills it via tmux kill-pane
   └─ Future open_in_nvim calls spawn a fresh instance (full re-initialization)

3b. Neovim crashes or is killed
   └─ Socket 'close' event fires on pi's server
   └─ No pi_exit message received → handleDisconnect("crashed")
   └─ Same cleanup path as above

4. pi session ends (quit, /new, /resume)
   └─ session_shutdown: nvim_command("qa!"), close tmux pane, close sockets, cleanup
```

## Dependencies

### Node.js (runtime)
- `msgpack-lite` or hand-rolled minimal msgpack — for Neovim RPC
- Node built-ins: `node:net`, `node:fs`, `node:path`, `node:child_process`

### Neovim
- Neovim 0.9+ (for `--listen` and `sockconnect()`)
- No external Lua dependencies — everything is built into Neovim's stdlib (`vim.fn`, `vim.api`, `vim.loop`)

### System
- tmux (assumed)
- Neovim installed and on PATH

## Open Questions / Future Work

- [ ] **Offline mode**: What if the user isn't in tmux? Fallback strategies?
- [ ] **Multiple nvim instances**: Could the user open multiple panes? How to route?
- [ ] **Diff granularity**: Full file diff vs. hunk-level diffs for edit reporting?
- [ ] **Inline diagnostics**: Should pi push LSP diagnostics or annotations to Neovim?
- [ ] **Progress reporting**: Show pi's current task/status in Neovim's statusline?
- [ ] **Skills file**: A `SKILL.md` to teach the model when and how to use these tools?
