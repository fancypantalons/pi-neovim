import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createNvimLifecycle } from "./nvim-lifecycle";
import { createFileTracker } from "./file-tracker";
import { createGitWatcher, type GitSnapshot } from "./git-watcher";

// Resolve the lua/ directory at factory init time so the lifecycle
// doesn't need to rely on __dirname (unreliable in pi's compiled
// extension runtime).
function findLuaDir(): string {
  const candidates = [
    resolve(__dirname, "..", "lua"),
    resolve(process.cwd(), "lua"),
    resolve(process.cwd(), "..", "lua"),
  ];
  for (const p of candidates) {
    if (existsSync(resolve(p, "pi-nvim.lua"))) return p;
  }
  throw new Error(
    "pi-nvim: cannot find lua/pi-nvim.lua. Tried: " + candidates.join(", "),
  );
}

// The factory is re-invoked on /resume, /new, /fork, and /reload, each
// time with a fresh `pi` bound to the new session. We create lifecycle and
// fileTracker per call so stale `pi` references never escape (the error
// "This extension ctx is stale after session replacement or reload" comes
// from a captured `pi` surviving past a session switch).
export default function (pi: ExtensionAPI) {
  const luaDir = findLuaDir();

  // ── State ──────────────────────────────────────────────────────────
  const lifecycle = createNvimLifecycle(pi, luaDir);
  const fileTracker = createFileTracker(lifecycle);
  // The git backstop is optional: it needs pi.exec, and it no-ops in projects
  // that aren't git repos. When either is unavailable the extension falls back
  // to the write/edit tool hooks alone.
  const gitWatcher =
    typeof pi.exec === "function" ? createGitWatcher(pi.exec.bind(pi)) : null;
  // Working-tree signature captured at turn_start, compared at turn_end to
  // attribute file changes to the turn (backstop for non-write/edit changes).
  let turnBaseline: Promise<GitSnapshot | null> | null = null;

  // Wire up edits refresh handler so Neovim's :PiEdits works
  lifecycle.setEditsRefreshHandler(() => {
    fileTracker.pushToNeovim().catch(() => {});
  });

  // Open (or attach to) Neovim and, once connected, push the current edits
  // list so already-modified files show immediately. Shared by the tool,
  // the /nvim command, and the embedded-mode auto-connect on session_start.
  async function openAndPush(params: Parameters<typeof lifecycle.open>[0]) {
    const result = await lifecycle.open(params);
    if (lifecycle.isReady()) {
      await fileTracker.pushToNeovim();
    }
    return result;
  }

  // ── Tool: open_in_nvim ─────────────────────────────────────────────
  pi.registerTool({
    name: "open_in_nvim",
    label: "Open Neovim",
    description:
      "Connect Neovim with a live quickfix list of agent-modified files. " +
      "In tmux sessions: opens Neovim in a right split pane. " +
      "When pi.dev runs inside a Neovim terminal: connects to the host Neovim directly. " +
      "Call this when you want the user to see, browse, or edit code in a full editor. " +
      "Idempotent: if Neovim is already connected, returns its current status.",
    promptSnippet:
      "Open Neovim so the user can see, browse, and diff the files you have modified",
    promptGuidelines: [
      "Call open_in_nvim when the user asks to see, browse, or review the files you changed, " +
        "and early in multi-file work so they can follow along. It is idempotent and cheap to call.",
    ],
    parameters: Type.Object({
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: "Files to open initially in Neovim buffers",
        }),
      ),
      focus_file: Type.Optional(
        Type.String({ description: "File to focus / move cursor to" }),
      ),
      focus_line: Type.Optional(
        Type.Number({ description: "Line number to jump to in focus_file" }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Directory to open Neovim in — set this to the git worktree you are working in " +
            "when it differs from your own working directory. Ignored when connecting to an " +
            "already-running Neovim.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return openAndPush(params);
    },
  });

  // ── Tool: nvim_quickfix ────────────────────────────────────────────
  pi.registerTool({
    name: "nvim_quickfix",
    label: "Neovim Edits",
    description:
      "Query or refresh the pi-edits scratch buffer showing agent-modified files in Neovim.",
    promptSnippet:
      "List the files modified this session, or push a refresh to Neovim's edits buffer",
    promptGuidelines: [
      "Use nvim_quickfix with action \"list\" to recall which files you have modified this session. " +
        "The Neovim edits buffer refreshes automatically after write and edit, so \"refresh\" is rarely needed.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description: '"list" to see current modified files, "refresh" to push updates to Neovim',
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.action === "list") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(fileTracker.getEntries(), null, 2),
            },
          ],
          details: {},
        };
      }
      await fileTracker.pushToNeovim();
      return {
        content: [
          {
            type: "text",
            text: `Edits refreshed. ${fileTracker.getEntries().length} modified files.`,
          },
        ],
        details: {},
      };
    },
  });

  // ── Command: /nvim ─────────────────────────────────────────────────
  pi.registerCommand("nvim", {
    description: "Open or refresh the Neovim integration",
    handler: async (_args, ctx) => {
      if (lifecycle.isReady()) {
        await fileTracker.pushToNeovim();
        ctx.ui.notify("Neovim edits refreshed", "info");
      } else {
        const result = await openAndPush({});
        ctx.ui.notify(
          `Neovim: ${(result.content[0] as any).text}`,
          "info",
        );
      }
    },
  });

  // ── Event hooks ────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    fileTracker.scanSession((ctx.sessionManager as any).getEntries() ?? []);

    // In embedded mode, auto-connect to the host Neovim immediately.
    // The host is already running (pi.dev lives inside its :terminal),
    // so there's no reason to wait for the model to call open_in_nvim.
    if (lifecycle.getMode() === "embedded" && !lifecycle.isReady()) {
      const result = await openAndPush({});
      if (!lifecycle.isReady()) {
        // Report connection failure so the user can see what went wrong
        const detail = result.details?.error || (result.content[0] as any)?.text || "unknown error";
        pi.sendMessage({
          customType: "nvim-edit",
          content: `[pi-nvim] Failed to auto-connect to host Neovim: ${detail}`,
          display: true,
        });
      }
    }
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      fileTracker.onToolCall(event.toolName, event.input as any);
    }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      // Fire-and-forget: don't block pi output on Neovim being responsive.
      // onToolResult launches pushToNeovim() and reloadFile() as background
      // promises with their own .catch() handlers.
      fileTracker.onToolResult(event.toolName, event);
    }
  });

  // ── Git backstop ───────────────────────────────────────────────────
  // The write/edit hooks above give immediate, mid-turn feedback. But the
  // agent can also change files via bash (`sed -i`, `mv`, redirects, …),
  // which those hooks never see. So we bracket each turn with a git
  // working-tree signature: snapshot at turn_start, compare at turn_end.
  // Files whose content changed during the turn are attributed to the agent;
  // files that went back to matching HEAD are pruned (reverts). Bracketing
  // per-turn keeps the attribution window small, so a user editing files
  // mid-turn is the only (unlikely) source of false positives.
  //
  // Which tree(s) to watch: pi's own cwd, plus the worktree Neovim is open in.
  // Linked worktrees are mutually invisible to `git status`, so if the agent
  // works in a worktree that isn't ctx.cwd, watching ctx.cwd alone detects
  // nothing at all. We watch both rather than swapping to Neovim's cwd, so
  // that fixing this case doesn't create the mirror-image blind spot for
  // agent changes in pi's own tree. Same-directory (the common case) dedupes
  // to a single scan inside snapshot().
  async function watchRoots(ctxCwd: string): Promise<string[]> {
    const nvimCwd = await lifecycle.getNvimCwd().catch(() => null);
    return nvimCwd && nvimCwd !== ctxCwd ? [ctxCwd, nvimCwd] : [ctxCwd];
  }

  if (gitWatcher) {
    pi.on("turn_start", (_event, ctx) => {
      turnBaseline = watchRoots(ctx.cwd)
        .then((roots) => gitWatcher.snapshot(roots))
        .catch(() => null);
    });

    pi.on("turn_end", async (event, ctx) => {
      const baseline = turnBaseline;
      turnBaseline = null;
      // Nothing ran that could touch files — skip the git work entirely.
      if (!baseline || event.toolResults.length === 0) return;

      const [before, after] = await Promise.all([
        baseline,
        watchRoots(ctx.cwd)
          .then((roots) => gitWatcher.snapshot(roots))
          .catch(() => null),
      ]);
      // Not a git repo (or a transient git error): fall back to the write/edit
      // hooks, which have already recorded this turn's tracked files.
      if (!before || !after) return;

      const { changed, reverted } = gitWatcher.delta(before, after);
      if (!fileTracker.applyGitDelta(changed, reverted)) return;

      // Reflect on-disk state in Neovim: reload changed files (bash edits aren't
      // reloaded by the write/edit path) and reverted ones.
      for (const p of [...changed, ...reverted]) {
        lifecycle.reloadFile(p).catch(() => {});
      }
      await fileTracker.pushToNeovim().catch(() => {});
    });
  }

  pi.on("session_shutdown", async () => {
    await lifecycle.shutdown();
  });
}
