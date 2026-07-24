# pi-neovim

Neovim integration for [pi.dev](https://pi.dev) — browse agent-modified files, side-by-side git diffs, and two-way editing. The extension auto-detects its context: in a tmux session it spawns a dedicated Neovim pane; when pi.dev runs inside a Neovim `:terminal` buffer it connects directly to the host editor.

This is an intentional inversion of control. Traditionally, these types of integrations are designed to embed an agent in your editor, and allow the editor to control the agent. Here we do the reverse, so that the agent can easily spawn the editor, open files, diffs, and so forth, while keeping the locus of control with the LLM.

Works both with Pi in tmux, where it can split your pane and run Neovim for you, or with Pi running inside a Neovim terminal buffer.

Note: This package incorporates a bunch of Neovim Lua right inside it, and injects it into your editor when the agent connects. If you don't like that, don't use this.

## Features

- **Automatic context detection** — tmux side-pane or embedded `:terminal`, no configuration needed
- **Edits buffer** — a custom scratch buffer (`pi://edits`) listing every file the agent modified, making for easy navigation and inspection of changed files
- **Git-aware diffs** — press `d` on any entry for a vertical split showing `git diff HEAD` changes
- **Two-way editing** — user saves a file in Neovim and the agent is notified with the diff
- **Reverse commands** — `:PiPrompt`, `:PiSendSelection`, `:PiEdits`, `:PiStatus`
- **Event-driven** — file tracking updates automatically when the model calls `write` or `edit`; no manual tool calls needed

## Requirements

| Mode | Requirements |
|------|-------------|
| **Tmux** | tmux, Neovim 0.9+ on PATH |
| **Embedded** | Neovim 0.9+ (already running as the host) |

## Install

```bash
pi install git:github.com/brettk/pi-neovim
```

Or for local development:

```bash
git clone https://github.com/fancypantalons/pi-neovim.git ~/git/pi-neovim
cd ~/git/pi-neovim && npm install
# Add to ~/.pi/agent/settings.json:
#   "extensions": ["~/git/pi-neovim/src/index.ts"]
```

## Usage

Once installed, the model calls `open_in_nvim` when it wants to show code in Neovim. You don't need to trigger it yourself — though `/nvim` is available as a manual fallback.

### In Neovim

| Command / Key | Action |
|--------------|--------|
| `:PiEdits` | Open the agent-modified files buffer |
| `Enter` (in edits buffer) | Open the file under cursor |
| `d` (in edits buffer) | Vertical diff split (git HEAD vs current) |
| `r` (in edits buffer) | Request refresh from pi |
| `q` (in edits buffer) | Close the edits window |
| `:PiPrompt <text>` | Send a prompt to pi |
| `:PiSendSelection` | Send visually selected text to pi |
| `:PiStatus` | Show connection status |

### Two-way editing

When you save a file in Neovim (`:w`), the extension computes a git diff and notifies pi through the conversation. The agent sees messages like `User saved file.ts (+5/-2 lines)` and can incorporate your changes.

## Architecture

See [docs/DESIGN.md](docs/DESIGN.md) for the full architecture, component details, design decisions, and session flow.

## License

MIT
