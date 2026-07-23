# pi-neovim

pi.dev extension integrating Neovim via tmux — live quickfix of agent-modified files, two-way editing, and bi-directional RPC communication.

## Install

```bash
pi install git:github.com/your-org/pi-neovim
```

Or for local development:

```bash
git clone <repo> ~/git/pi-neovim
cd ~/git/pi-neovim && npm install
# Add to ~/.pi/agent/settings.json:
#   "extensions": ["~/git/pi-neovim/src/index.ts"]
```

## Requirements

- tmux (the pi session must be running inside tmux)
- Neovim 0.9+ on PATH

## Usage

Once installed, pi can call the `open_in_nvim` tool to split the current tmux pane and open Neovim in the right side. The model decides when to open it.

**In Neovim:**
- A quickfix list titled "pi-neovim modified files" tracks every file pi modifies
- `Enter` on a quickfix entry opens the file
- `d` on a quickfix entry opens a vertical diff split showing changes
- `:PiPrompt <text>` sends a prompt to pi
- `:PiSendSelection` sends visually selected text to pi

## Architecture

See [DESIGN.md](./DESIGN.md) for the full architecture and design decisions.
