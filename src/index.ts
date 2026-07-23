import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getLifecycle } from "./nvim-lifecycle";
import { getFileTracker } from "./file-tracker";

export default function (pi: ExtensionAPI) {
  // ── State ──────────────────────────────────────────────────────────
  const lifecycle = getLifecycle(pi);
  const fileTracker = getFileTracker(lifecycle);

  // ── Tool: open_in_nvim ─────────────────────────────────────────────
  pi.registerTool({
    name: "open_in_nvim",
    label: "Open Neovim",
    description:
      "Open Neovim in a right tmux pane with a live quickfix list of agent-modified files. " +
      "Call this when you want the user to see, browse, or edit code in a full editor. " +
      "Idempotent: if Neovim is already open, returns its current status.",
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await lifecycle.open(params);
      // Push quickfix after opening so modified files show immediately
      if (lifecycle.isReady()) {
        await fileTracker.pushToNeovim();
      }
      return result;
    },
  });

  // ── Tool: nvim_quickfix ────────────────────────────────────────────
  pi.registerTool({
    name: "nvim_quickfix",
    label: "Neovim Quickfix",
    description:
      "Query or refresh the quickfix list of agent-modified files shown in Neovim.",
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
            text: `Quickfix refreshed. ${fileTracker.getEntries().length} modified files.`,
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
        ctx.ui.notify("Neovim quickfix refreshed", "info");
      } else {
        const result = await lifecycle.open({});
        ctx.ui.notify(
          `Neovim: ${(result.content[0] as any).text}`,
          "info",
        );
        // Push quickfix so already-modified files show immediately
        if (lifecycle.isReady()) {
          await fileTracker.pushToNeovim();
        }
      }
    },
  });

  // ── Event hooks ────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileTracker.scanSession((ctx.sessionManager as any).getEntries() ?? []);
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      fileTracker.onToolCall(event.toolName, event.input as any);
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      fileTracker.onToolResult(event.toolName, event);
    }
  });

  pi.on("session_shutdown", async () => {
    await lifecycle.shutdown();
  });
}
