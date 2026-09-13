// This repo's own fast, change-scoped test check (`bun run test:changed`,
// AC-7 of the redundant-checks-cut plan). Runs `bun test` against only the
// test files a change plausibly touches instead of the full suite — the
// pipeline's `renderProjectCommands` prefers this over `test` whenever it's
// present. It is never what the deterministic Tester-skip gate
// (`runPipelinePrecheck`) runs — that continues to run the full `bun test`
// unchanged, so this script's job is only to be a faster stand-in when
// there IS test coverage to run, never an authority on "nothing needs
// testing" (that's `findUnreferencedAcs`'s job).
//
// Base ref resolution order:
//   1. `AGETOR_TEST_CHANGED_BASE` env var, if set.
//   2. `git merge-base HEAD main` (falls back to `origin/main` if plain
//      `main` doesn't resolve locally).
//   3. `HEAD~1` if neither `main` nor `origin/main` resolve (a shallow
//      clone, or a detached first commit).
import { TEST_PATH_PATTERNS } from "../src/bun/pipeline-precheck.ts";
import { existsSync } from "node:fs";
import path from "node:path";

function runGit(args: string[]): string | null {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString("utf8").trim();
}

function resolveBaseRef(): string {
  const envBase = process.env.AGETOR_TEST_CHANGED_BASE;
  if (envBase && envBase.trim() !== "") return envBase.trim();

  for (const ref of ["main", "origin/main"]) {
    const merged = runGit(["merge-base", "HEAD", ref]);
    if (merged) return merged;
  }
  return "HEAD~1";
}

function changedPaths(baseRef: string): string[] {
  const fromBase = runGit(["diff", "--name-only", `${baseRef}...HEAD`]) ?? "";
  const uncommitted = runGit(["diff", "--name-only", "HEAD"]) ?? "";
  const paths = new Set<string>();
  for (const line of [...fromBase.split("\n"), ...uncommitted.split("\n")]) {
    const trimmed = line.trim();
    if (trimmed !== "") paths.add(trimmed);
  }
  return [...paths];
}

function isTestFile(rel: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(rel));
}

/** For a changed non-test `.ts`/`.tsx` file, its sibling `<basename>.test.ts(x)`
 *  in the same directory, if it exists on disk. */
function siblingTestFile(rel: string): string | null {
  if (!/\.tsx?$/.test(rel)) return null;
  const dir = path.dirname(rel);
  const base = rel.slice(dir === "." ? 0 : dir.length + 1).replace(/\.tsx?$/, "");
  const ext = rel.endsWith(".tsx") ? "tsx" : "ts";
  for (const candidateExt of [ext, "ts", "tsx"]) {
    const candidate = dir === "." ? `${base}.test.${candidateExt}` : path.join(dir, `${base}.test.${candidateExt}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function testFilesFor(paths: string[]): string[] {
  const out = new Set<string>();
  for (const rel of paths) {
    if (isTestFile(rel)) {
      if (existsSync(rel)) out.add(rel);
      continue;
    }
    const sibling = siblingTestFile(rel);
    if (sibling) out.add(sibling);
  }
  return [...out];
}

async function main(): Promise<void> {
  const baseRef = resolveBaseRef();
  const paths = changedPaths(baseRef);
  const files = testFilesFor(paths);

  if (files.length === 0) {
    console.log("test:changed — no test files affected by this diff");
    process.exit(0);
    return;
  }

  console.log(`test:changed — running ${files.length} affected test file(s) against base ${baseRef}`);
  const proc = Bun.spawn(["bun", "test", ...files], { stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;
  process.exit(exitCode);
}

await main();
