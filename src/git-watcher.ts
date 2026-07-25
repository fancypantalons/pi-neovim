import { join } from "node:path";

/**
 * Minimal shape of pi's `exec` (or any exec backend). Kept structural so the
 * watcher is testable without pi — pi.exec is assignable to this.
 */
export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Sentinel signature for a file that is deleted in the working tree. */
const DELETED = "\0deleted";

/**
 * A snapshot of the working tree's dirty state: a map from absolute path to a
 * content signature (git blob hash, or {@link DELETED}). Only files that
 * differ from HEAD appear — clean files are absent by construction, which is
 * exactly the signal we want for the edits buffer.
 */
export interface GitSnapshot {
  root: string;
  files: Map<string, string>;
}

export interface GitDelta {
  /** Files whose content changed (new dirty file, or a different signature). */
  changed: string[];
  /** Files that were dirty before and are now clean/deleted — i.e. reverted. */
  reverted: string[];
}

/**
 * Detects which files the agent changed by diffing a `git status` content
 * signature taken before and after a turn. This catches changes made by any
 * mechanism (write/edit, but also `sed -i`, `mv`, redirects, external tools),
 * because it observes the filesystem result rather than the tool call.
 */
export function createGitWatcher(exec: ExecFn) {
  async function repoRoot(cwd: string): Promise<string | null> {
    try {
      const { stdout, code } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        timeout: 5_000,
      });
      if (code !== 0) return null;
      const root = stdout.trim();
      return root === "" ? null : root;
    } catch {
      return null;
    }
  }

  /**
   * Snapshot the dirty working-tree state as absolute-path -> signature.
   * Returns null when not inside a git repo (feature disables gracefully).
   */
  async function snapshot(cwd: string): Promise<GitSnapshot | null> {
    const root = await repoRoot(cwd);
    if (!root) return null;

    let statusOut: string;
    try {
      const res = await exec(
        "git",
        ["-C", root, "status", "--porcelain", "--no-renames", "-z"],
        { timeout: 10_000 },
      );
      if (res.code !== 0) return null;
      statusOut = res.stdout;
    } catch {
      return null;
    }

    const files = new Map<string, string>();
    const toHash: string[] = [];

    // --porcelain -z records: "XY<space>PATH" separated by NUL, no quoting.
    for (const rec of statusOut.split("\0")) {
      if (rec.length < 4) continue;
      const x = rec[0];
      const y = rec[1];
      const path = rec.slice(3);
      const abs = join(root, path);
      if (x === "D" || y === "D") {
        files.set(abs, DELETED);
      } else {
        files.set(abs, ""); // placeholder, filled by hash-object below
        toHash.push(abs);
      }
    }

    if (toHash.length > 0) {
      try {
        const { stdout, code } = await exec(
          "git",
          ["-C", root, "hash-object", "--", ...toHash],
          { timeout: 10_000 },
        );
        if (code === 0) {
          const shas = stdout.split("\n").filter((s) => s !== "");
          toHash.forEach((abs, i) => {
            if (shas[i]) files.set(abs, shas[i]);
          });
        }
      } catch {
        // Best effort: leave placeholders. A placeholder differs from any real
        // signature, so the file is treated as changed rather than dropped.
      }
    }

    return { root, files };
  }

  /** Compare two snapshots and classify per-file transitions. */
  function delta(before: GitSnapshot, after: GitSnapshot): GitDelta {
    const changed: string[] = [];
    const reverted: string[] = [];

    for (const [path, sig] of after.files) {
      if (sig === DELETED) {
        // Deleted in the working tree — nothing to show; drop if we had it.
        if (before.files.has(path)) reverted.push(path);
        continue;
      }
      if (before.files.get(path) !== sig) {
        changed.push(path);
      }
    }

    // Files that were dirty before and are absent now became clean (revert or
    // commit) — remove them.
    for (const path of before.files.keys()) {
      if (!after.files.has(path)) reverted.push(path);
    }

    return { changed, reverted };
  }

  return { snapshot, delta };
}
