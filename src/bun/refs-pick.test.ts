import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Top-level: capture AGETOR_DATA_DIR before db.ts is imported below.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-db-"));

const { tasks, db } = await import("./db.ts");
const { headlessPickCandidates, selectPick, MAX_PICK_CANDIDATES } = await import("./refs-pick.ts");

const createdTaskIds: string[] = [];
afterEach(() => {
  for (const id of createdTaskIds.splice(0)) {
    db.run(`DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE task_id = ?)`, [id]);
    db.run(`DELETE FROM runs WHERE task_id = ?`, [id]);
    tasks.delete(id);
  }
});

function makeTask(workdir: string, updatedAt: number) {
  const id = randomUUID();
  tasks.insert({
    id,
    title: "t",
    prompt: "p",
    column: "ready",
    agent: "claude-code",
    workdir,
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: updatedAt,
    updatedAt,
    pipelineStage: null,
    planApproved: false,
    implementationApproved: false,
    revisionCount: 0,
    pipelineFeedback: null,
    pausedAt: null,
    blockReason: null,
    parentTaskId: null,
    planSubtaskId: null,
    childMergeStatus: null,
    satisfiedSubtasks: [],
  });
  createdTaskIds.push(id);
  return id;
}

function withHome<T>(homeDir: string, fn: () => T): T {
  const saved = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
}

test("headlessPickCandidates includes a task's workdir", () => {
  const emptyHome = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-home-"));
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-wd-"));
  makeTask(workdir, Date.now());
  withHome(emptyHome, () => {
    const candidates = headlessPickCandidates();
    expect(candidates).toContain(realpathSync(workdir));
  });
});

test("headlessPickCandidates sorts task workdirs by updatedAt descending", () => {
  const emptyHome = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-home-"));
  const older = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-older-"));
  const newer = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-newer-"));
  makeTask(older, 1000);
  makeTask(newer, 2000);
  withHome(emptyHome, () => {
    const candidates = headlessPickCandidates();
    const olderIdx = candidates.indexOf(realpathSync(older));
    const newerIdx = candidates.indexOf(realpathSync(newer));
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeLessThan(olderIdx);
  });
});

test("headlessPickCandidates dedupes a symlinked workdir against its real target", () => {
  const emptyHome = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-home-"));
  const real = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-real-"));
  const linkParent = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-linkp-"));
  const link = path.join(linkParent, "link");
  symlinkSync(real, link);
  makeTask(real, 1000);
  makeTask(link, 2000);
  withHome(emptyHome, () => {
    const candidates = headlessPickCandidates();
    const matches = candidates.filter((c) => c === realpathSync(real));
    expect(matches.length).toBe(1);
  });
});

test("headlessPickCandidates only surfaces non-dot git-repo subdirectories of $HOME", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-home-"));
  const gitRepo = path.join(home, "repo");
  mkdirSync(gitRepo);
  mkdirSync(path.join(gitRepo, ".git"));
  const nonGit = path.join(home, "not-a-repo");
  mkdirSync(nonGit);
  const dotGitRepo = path.join(home, ".dotrepo");
  mkdirSync(dotGitRepo);
  mkdirSync(path.join(dotGitRepo, ".git"));
  withHome(home, () => {
    const candidates = headlessPickCandidates();
    expect(candidates).toContain(realpathSync(gitRepo));
    expect(candidates).not.toContain(realpathSync(nonGit));
    expect(candidates).not.toContain(realpathSync(dotGitRepo));
  });
});

test("headlessPickCandidates falls back to $HOME itself when there are no task workdirs or git repos", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-home-"));
  withHome(home, () => {
    const candidates = headlessPickCandidates();
    expect(candidates).toEqual([realpathSync(home)]);
  });
});

test("headlessPickCandidates caps at MAX_PICK_CANDIDATES, prioritizing the most recently updated workdirs", () => {
  const emptyHome = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-home-"));
  const workdirs: string[] = [];
  for (let i = 0; i < 60; i++) {
    const workdir = mkdtempSync(path.join(tmpdir(), `agetor-refs-pick-many-${i}-`));
    workdirs.push(workdir);
    makeTask(workdir, i);
  }
  withHome(emptyHome, () => {
    const candidates = headlessPickCandidates();
    expect(candidates.length).toBe(MAX_PICK_CANDIDATES);
    const realWorkdirs = new Set(workdirs.map((w) => realpathSync(w)));
    for (const c of candidates) expect(realWorkdirs.has(c)).toBe(true);
    // Most-recently-updated-first: the 50 kept are the 50 highest indices (10..59).
    const expectedOrder = workdirs
      .slice(10)
      .reverse()
      .map((w) => realpathSync(w));
    expect(candidates).toEqual(expectedOrder);
  });
});

test("headlessPickCandidates silently drops a task workdir that no longer exists on disk", () => {
  const emptyHome = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-home-"));
  const gone = path.join(tmpdir(), "agetor-refs-pick-does-not-exist-" + randomUUID());
  makeTask(gone, Date.now());
  withHome(emptyHome, () => {
    const candidates = headlessPickCandidates();
    expect(candidates).not.toContain(gone);
  });
});

test("selectPick folder mode returns a directory reference", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-refs-select-folder-"));
  const result = selectPick(dir, "folder");
  expect(result).toEqual({ refs: [{ path: dir, isDirectory: true }] });
});

test("selectPick files mode lists only visible immediate regular files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-refs-select-files-"));
  writeFileSync(path.join(dir, "b.txt"), "b");
  writeFileSync(path.join(dir, "a.txt"), "a");
  writeFileSync(path.join(dir, ".hidden"), "h");
  mkdirSync(path.join(dir, "subdir"));
  const result = selectPick(dir, "files");
  expect(result).toEqual({
    refs: [
      { path: path.join(dir, "a.txt"), isDirectory: false },
      { path: path.join(dir, "b.txt"), isDirectory: false },
    ],
  });
});

test("selectPick files mode on a directory with only subdirectories returns empty refs, not an error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-refs-select-onlydirs-"));
  mkdirSync(path.join(dir, "subdir"));
  const result = selectPick(dir, "files");
  expect(result).toEqual({ refs: [] });
});

test("selectPick rejects a non-absolute path", () => {
  const result = selectPick("relative/path", "folder");
  expect("error" in result).toBe(true);
});

test("selectPick rejects a path that does not exist", () => {
  const result = selectPick("/definitely/does/not/exist-" + randomUUID(), "folder");
  expect("error" in result).toBe(true);
});

test("selectPick rejects a path that is not a directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-refs-select-notdir-"));
  const file = path.join(dir, "file.txt");
  writeFileSync(file, "x");
  const result = selectPick(file, "folder");
  expect("error" in result).toBe(true);
});
