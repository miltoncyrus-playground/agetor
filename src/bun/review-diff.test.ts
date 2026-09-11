import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeReviewDiff, capStat, reviewDiffPath, currentHeadSha, removeReviewDiff, MAX_STAT_LINES } from "./review-diff.ts";

async function git(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

async function repo(): Promise<{ dir: string; base: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-review-diff-"));
  await git(["init", "-q", "-b", "main"], dir);
  await git(["config", "user.email", "t@t"], dir);
  await git(["config", "user.name", "t"], dir);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  await git(["add", "-A"], dir);
  await git(["commit", "-q", "-m", "base"], dir);
  const base = await git(["rev-parse", "HEAD"], dir);
  return { dir, base };
}

test("writeReviewDiff writes the diff outside the worktree and reports stat, bytes, shas", async () => {
  const { dir, base } = await repo();
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(path.join(dir, "b.txt"), "new\n");
  await git(["add", "-A"], dir);
  await git(["commit", "-q", "-m", "work"], dir);
  const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-review-data-"));

  const r = await writeReviewDiff({ cwd: dir, taskId: "task1", sinceSha: base, dataDir });
  expect(r).not.toBeNull();
  expect(r!.file).toBe(reviewDiffPath(dataDir, "task1"));
  expect(r!.file.startsWith(dir)).toBe(false);
  const body = readFileSync(r!.file, "utf8");
  expect(body).toContain("+two");
  expect(body).toContain("b.txt");
  expect(r!.bytes).toBe(Buffer.byteLength(body));
  expect(r!.stat).toContain("a.txt");
  expect(r!.stat).toContain("2 files changed");
  expect(r!.sinceSha).toBe(base);
  expect(r!.headSha).toBe((await currentHeadSha(dir))!);
  expect(r!.empty).toBe(false);
  // The worktree stays clean — nothing for commitAll to sweep up.
  expect(await git(["status", "--porcelain"], dir)).toBe("");

  removeReviewDiff(dataDir, "task1");
  expect(existsSync(r!.file)).toBe(false);
});

test("writeReviewDiff: empty diff is flagged; bad sha and non-repo return null", async () => {
  const { dir, base } = await repo();
  const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-review-data-"));
  const same = await writeReviewDiff({ cwd: dir, taskId: "t", sinceSha: base, dataDir });
  expect(same?.empty).toBe(true);
  expect(await writeReviewDiff({ cwd: dir, taskId: "t", sinceSha: "not-a-sha", dataDir })).toBeNull();
  const plain = mkdtempSync(path.join(tmpdir(), "agetor-not-a-repo-"));
  expect(await writeReviewDiff({ cwd: plain, taskId: "t", sinceSha: base, dataDir })).toBeNull();
});

test("capStat keeps the last lines (summary included) and counts the dropped ones", () => {
  const lines = Array.from({ length: MAX_STAT_LINES + 5 }, (_, i) => ` f${i}.ts | 1 +`);
  lines.push(" 45 files changed, 45 insertions(+)");
  const capped = capStat(lines.join("\n"));
  expect(capped.split("\n").length).toBe(MAX_STAT_LINES + 1);
  expect(capped.startsWith("(6 more files not listed)")).toBe(true);
  expect(capped.endsWith("45 files changed, 45 insertions(+)")).toBe(true);
  expect(capStat("a | 1 +\n 1 file changed\n")).toBe("a | 1 +\n 1 file changed");
});
