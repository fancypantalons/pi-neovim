/**
 * Git watcher + file-tracker delta test.
 *
 * Verifies that createGitWatcher attributes file changes by content signature
 * (not just path), so it catches:
 *   - a brand-new dirty file,
 *   - a further change to an *already-dirty* file (the case a path-only
 *     `git status` diff would miss),
 *   - a revert back to HEAD (reported for removal).
 * Also checks fileTracker.applyGitDelta add/remove behavior.
 *
 * Requires git on PATH. Run with:  npx tsx test/test-git-watcher.ts
 */

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitWatcher, type ExecFn } from "../src/git-watcher";
import { createFileTracker } from "../src/file-tracker";

let passed = 0;
let failed = 0;
function assert(label: string, cond: boolean, detail?: string) {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  cond ? passed++ : failed++;
}

const exec: ExecFn = (cmd, args, opts) =>
  new Promise((res) => {
    execFile(
      cmd,
      args,
      { cwd: opts?.cwd, timeout: opts?.timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const anyErr = err as (Error & { code?: number | string }) | null;
        const code =
          anyErr && typeof anyErr.code === "number" ? anyErr.code : anyErr ? 1 : 0;
        res({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });

const has = (list: string[], name: string) => list.some((p) => p.endsWith(name));

async function main() {
  const git = createGitWatcher(exec);
  const dir = mkdtempSync(join(tmpdir(), "pi-gitwatch-"));

  try {
    // ── init a repo with one committed file ─────────────────────────
    await exec("git", ["-C", dir, "init", "-q"]);
    await exec("git", ["-C", dir, "config", "user.email", "t@example.com"]);
    await exec("git", ["-C", dir, "config", "user.name", "Test"]);
    const aPath = join(dir, "a.txt");
    writeFileSync(aPath, "line1\n");
    await exec("git", ["-C", dir, "add", "."]);
    await exec("git", ["-C", dir, "commit", "-qm", "init"]);

    // ── clean tree ──────────────────────────────────────────────────
    const clean = await git.snapshot(dir);
    assert("snapshot works in a repo", clean !== null);
    assert("clean tree has no dirty files", !!clean && clean.files.size === 0,
      clean ? `size=${clean.files.size}` : "null");

    // ── modify committed file → changed ─────────────────────────────
    writeFileSync(aPath, "line1\nline2\n");
    const s1 = (await git.snapshot(dir))!;
    const d1 = git.delta(clean!, s1);
    assert("first modification is detected as changed", has(d1.changed, "a.txt"),
      d1.changed.join(","));
    assert("absolute paths are returned", d1.changed.every((p) => p.startsWith("/")));

    // ── modify the SAME already-dirty file again → still changed ─────
    // (a path-only `git status` diff would miss this: the porcelain line
    //  is identical "M a.txt" before and after.)
    writeFileSync(aPath, "line1\nline2\nline3\n");
    const s2 = (await git.snapshot(dir))!;
    const d2 = git.delta(s1, s2);
    assert("further change to an already-dirty file is detected", has(d2.changed, "a.txt"),
      d2.changed.join(","));

    // ── new untracked file → changed ────────────────────────────────
    const bPath = join(dir, "b.txt");
    writeFileSync(bPath, "brand new\n");
    const s3 = (await git.snapshot(dir))!;
    const d3 = git.delta(s2, s3);
    assert("new untracked file is detected as changed", has(d3.changed, "b.txt"),
      d3.changed.join(","));
    assert("unchanged dirty file is not re-reported", !has(d3.changed, "a.txt"),
      d3.changed.join(","));

    // ── revert a.txt back to HEAD → reverted ────────────────────────
    writeFileSync(aPath, "line1\n");
    const s4 = (await git.snapshot(dir))!;
    const d4 = git.delta(s3, s4);
    assert("revert to HEAD is reported as reverted", has(d4.reverted, "a.txt"),
      d4.reverted.join(","));

    // ── fileTracker.applyGitDelta add/remove ────────────────────────
    const tracker = createFileTracker({
      isReady: () => false,
      pushEditsBuffer: async () => {},
      reloadFile: async () => {},
    });
    assert("applyGitDelta(changed) adds", tracker.applyGitDelta([aPath, bPath], []) === true);
    assert("tracker has both files", tracker.getEntries().length === 2,
      `len=${tracker.getEntries().length}`);
    assert("applyGitDelta(reverted) removes", tracker.applyGitDelta([], [aPath]) === true);
    assert("tracker has one file after revert", tracker.getEntries().length === 1,
      `len=${tracker.getEntries().length}`);
    assert("remaining file is b.txt", tracker.getEntries()[0].path.endsWith("b.txt"));
    assert("removing an untracked path is a no-op", tracker.applyGitDelta([], ["/nope"]) === false);

    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
