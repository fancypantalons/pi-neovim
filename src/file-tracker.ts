import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export interface TrackedFile {
  path: string;
  toolName: string; // "write" or "edit"
  timestamp: number;
}

/**
 * Tracks files modified by the agent via write/edit tool calls.
 * Maintains a deduplicated list and can push it as a Neovim quickfix list.
 */
export function createFileTracker(
  lifecycle: {
    isReady(): boolean;
    pushQuickfix(entries: QuickfixEntry[]): Promise<void>;
    reloadFile(filepath: string): Promise<void>;
  }
) {
  const files = new Map<string, TrackedFile>();

  /**
   * A quickfix entry formatted for Neovim's setqflist.
   */
  interface QuickfixEntry {
    filename: string;
    lnum: number;
    col: number;
    text: string;
  }

  function getEntries(): TrackedFile[] {
    return Array.from(files.values()).sort(
      (a, b) => b.timestamp - a.timestamp,
    );
  }

  function toQuickfixEntries(): QuickfixEntry[] {
    return getEntries().map((f, i) => ({
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
  function scanSession(entries: Array<{ message?: { role?: string; content?: Array<{ type?: string; name?: string; input?: unknown }> } }>) {
    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.role !== "assistant") continue;
      for (const block of msg.content || []) {
        if (block.type === "toolCall" && (block.name === "write" || block.name === "edit")) {
          const input = block.input as { path?: string } | undefined;
          if (input?.path) {
            addFile(input.path, block.name, Date.now());
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
  function onToolResult(toolName: string, event: ToolResultEvent) {
    // Push the updated quickfix list to Neovim if connected
    pushToNeovim().catch(() => {});

    // If a file was written/edited, force Neovim to reload it
    // so the user sees the latest content immediately.
    const input = event.input as { path?: string } | undefined;
    if (input?.path) {
      lifecycle.reloadFile(input.path).catch(() => {});
    }
  }

  function addFile(path: string, toolName: string, timestamp: number) {
    // Deduplicate: keep the most recent operation
    const existing = files.get(path);
    if (!existing || timestamp > existing.timestamp) {
      files.set(path, { path, toolName, timestamp });
    }
  }

  async function pushToNeovim() {
    if (!lifecycle.isReady()) return;
    await lifecycle.pushQuickfix(toQuickfixEntries());
  }

  return {
    getEntries,
    toQuickfixEntries,
    scanSession,
    onToolCall,
    onToolResult,
    pushToNeovim,
  };
}

// NOTE: No module-level singleton. The extension factory is re-invoked on
// /resume, /new, /fork, and /reload. Create a fresh file tracker per
// factory invocation so it always references the current lifecycle.
