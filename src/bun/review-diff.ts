import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Precomputed review diff for the Code Reviewer stage (O-6 in
 * docs/plans/pipeline-token-efficiency.md). In the measured pipelines the
 * reviewer ran `git diff <base>` up to 17 times and then re-Read whole
 * files; every one of those results rode along in context for the rest of
 * the turn. agetor now runs the diff ONCE, writes it OUTSIDE the worktree
 * (a file inside it would be untracked, and the pipeline's `commitAll`
 * backstop would commit it), and hands the reviewer the path plus a
 * diffstat. On a revision pass the diff starts at the sha the reviewer
 * last saw, not the branch base, so "check only that one issue" is also
 * what the reviewer is shown.
 */

export interface ReviewDiff {
  /** Absolute path of the `.diff` file. */
  file: string;
  bytes: number;
  /** `git diff --stat` output, capped to `MAX_STAT_LINES`. */
  stat: string;
  /** The sha the diff starts from (base, or the previously reviewed HEAD). */
  sinceSha: string;
  /** HEAD at the time the diff was taken — becomes the next `sinceSha`. */
  headSha: string;
  /** True when the diff is empty (nothing changed since `sinceSha`). */
  empty: boolean;
}

export const MAX_STAT_LINES = 40;
const GIT_TIMEOUT_MS = 60_000;

async function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, stdout, stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
}

/** Where a task's review diff lives: `<dataDir>/review-diffs/<taskId>.diff`. */
export function reviewDiffPath(dataDir: string, taskId: string): string {
  return join(dataDir, "review-diffs", `${taskId}.diff`);
}

export async function currentHeadSha(cwd: string): Promise<string | null> {
  const r = await git(["rev-parse", "HEAD"], cwd);
  return r.ok ? r.stdout.trim() || null : null;
}

/** Pure: cap a diffstat to its last `max` lines (the summary line is last)
 *  and mark how many were dropped. */
export function capStat(stat: string, max = MAX_STAT_LINES): string {
  const lines = stat.trimEnd().split("\n").filter((l) => l.length > 0);
  if (lines.length <= max) return lines.join("\n");
  const kept = lines.slice(lines.length - max);
  return `(${lines.length - max} more files not listed)\n${kept.join("\n")}`;
}

/**
 * Run `git diff <sinceSha>` in `cwd`, write it to the task's diff file, and
 * return what the prompt needs. `null` when git fails (not a repo, bad sha)
 * — the caller falls back to the old "run git diff yourself" instruction.
 * Never throws.
 */
export async function writeReviewDiff(opts: {
  cwd: string;
  taskId: string;
  sinceSha: string;
  dataDir: string;
}): Promise<ReviewDiff | null> {
  try {
    const head = await currentHeadSha(opts.cwd);
    if (!head) return null;
    const diff = await git(["diff", opts.sinceSha, "--", "."], opts.cwd);
    if (!diff.ok) return null;
    const stat = await git(["diff", "--stat", opts.sinceSha, "--", "."], opts.cwd);
    const file = reviewDiffPath(opts.dataDir, opts.taskId);
    mkdirSync(join(opts.dataDir, "review-diffs"), { recursive: true });
    writeFileSync(file, diff.stdout);
    return {
      file,
      bytes: Buffer.byteLength(diff.stdout),
      stat: capStat(stat.ok ? stat.stdout : ""),
      sinceSha: opts.sinceSha,
      headSha: head,
      empty: diff.stdout.trim().length === 0,
    };
  } catch {
    return null;
  }
}

/** Best-effort cleanup when a task is deleted. */
export function removeReviewDiff(dataDir: string, taskId: string): void {
  const file = reviewDiffPath(dataDir, taskId);
  if (existsSync(file)) {
    try { rmSync(file); } catch { /* best-effort */ }
  }
}
