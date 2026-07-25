import { resolve as resolvePath } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { EditsEntry } from "./types";

export interface TrackedFile {
  path: string;
  toolName: string; // "write" or "edit"
  timestamp: number;
}

/**
 * Tracks files modified by the agent via write/edit tool calls.
 * Maintains a deduplicated list and can push it to the Neovim edits buffer.
 */
export function createFileTracker(
  lifecycle: {
    isReady(): boolean;
    pushEditsBuffer(entries: EditsEntry[]): Promise<void>;
    reloadFile(filepath: string): Promise<void>;
  }
) {
  const files = new Map<string, TrackedFile>();

  function getEntries(): TrackedFile[] {
    return Array.from(files.values()).sort(
      (a, b) => b.timestamp - a.timestamp,
    );
  }

  function toEditsEntries(): EditsEntry[] {
    return getEntries().map((f) => ({
      filename: f.path,
      lnum: 1,
      col: 1,
      text: `${f.path} | ${f.toolName} | ${new Date(f.timestamp).toLocaleTimeString()}`,
    }));
  }

  /**
   * Scan session messages for pre-existing write/edit operations.
   * Called on session_start to rebuild state from session history.
   *
   * NOTE: Session entries are message-level. Tool calls live inside
   * assistant message content blocks. This scans the content blocks
   * for write/edit tool calls to pre-populate the tracker.
   */
  function scanSession(
    entries: Array<{
      message?: {
        role?: string;
        content?: Array<{ type?: string; name?: string; arguments?: unknown; input?: unknown }>;
      };
    }>,
  ) {
    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.role !== "assistant") continue;
      for (const block of msg.content || []) {
        if (block.type === "toolCall" && (block.name === "write" || block.name === "edit")) {
          // Assistant tool-call blocks carry their args in `arguments`
          // (the live `tool_call` event uses `input` instead). Prefer
          // `arguments`, fall back to `input` for robustness.
          const args = (block.arguments ?? block.input) as { path?: string } | undefined;
          if (args?.path) {
            addFile(args.path, block.name, Date.now());
          }
        }
      }
    }
  }

  /**
   * Called when a write/edit tool call is detected (pre-execution).
   * Tracks the file preemptively.
   */
  function onToolCall(toolName: string, input: { path?: string }) {
    if (input.path) {
      addFile(input.path, toolName, Date.now());
      pushToNeovim().catch(() => {
        /* Neovim may not be open yet — that's fine */
      });
    }
  }

  /**
   * Called when a write/edit tool result is received.
   * Confirms the file was actually written and pushes the quickfix.
   */
  function onToolResult(_toolName: string, event: ToolResultEvent) {
    // Push the updated quickfix list to Neovim if connected
    pushToNeovim().catch(() => {});

    // If a file was written/edited, force Neovim to reload it
    // so the user sees the latest content immediately.
    const input = event.input as { path?: string } | undefined;
    if (input?.path) {
      lifecycle.reloadFile(input.path).catch(() => {});
    }
  }

  function addFile(p: string, toolName: string, timestamp: number) {
    // Resolve to absolute so quickfix entries work regardless of Neovim's cwd.
    const resolved = resolvePath(p);
    // Deduplicate: keep the most recent operation
    const existing = files.get(resolved);
    if (!existing || timestamp > existing.timestamp) {
      files.set(resolved, { path: resolved, toolName, timestamp });
    }
  }

  async function pushToNeovim() {
    if (!lifecycle.isReady()) return;
    await lifecycle.pushEditsBuffer(toEditsEntries());
  }

  return {
    getEntries,
    toEditsEntries,
    scanSession,
    onToolCall,
    onToolResult,
    pushToNeovim,
  };
}

// NOTE: No module-level singleton. The extension factory is re-invoked on
// /resume, /new, /fork, and /reload. Create a fresh file tracker per
// factory invocation so it always references the current lifecycle.
