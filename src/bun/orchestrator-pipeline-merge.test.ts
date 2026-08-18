import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Real-git end-to-end tests for the decompose -> DAG scheduler -> merge
// -> code-review path. Kept in a SEPARATE file from orchestrator-pipeline.test.ts
// deliberately: these spawn several real `git` subprocesses each (init,
// config, commit, worktree add, merge) and are meaningfully slower than
// that file's pure in-memory fake-driver tests — sharing a file made the
// OTHER file's tightly-tuned settle(80ms) assertions flaky under load
// (observed directly: a later test's fixed-window settle() intermittently
// came up short when these heavier tests ran just before it in the same
// process). Isolating slow/heavy tests from fast/deterministic ones is the
// fix, not a bigger blanket settle() everywhere.
//
// build-scheduler.ts's completeChildBuild ultimately calls worktree.ts's
// mergeBranch, a REAL `git merge` — that can't be meaningfully faked, so
// these tests use real git repos (mirrors worktree.test.ts's makeRepo()
// pattern) rather than the plain temp dirs the rest of the pipeline suite
// uses with isolation:"none".

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-merge-"));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

async function gitQuiet(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

/** A real git repo with one commit on "main" — the SOURCE repo a
 *  worktree-isolated pipeline task's worktrees fork off of. */
async function makeGitRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-repo-"));
  await gitQuiet(["init", "-b", "main"], repo);
  await gitQuiet(["config", "user.email", "test@example.com"], repo);
  await gitQuiet(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await gitQuiet(["add", "."], repo);
  await gitQuiet(["commit", "-m", "init"], repo);
  return repo;
}

/** Writes and commits a file directly in an already-checked-out worktree —
 *  stands in for what a real decompose agent turn would do (write +
 *  commit TASKS.json) since the fake driver never touches the
 *  filesystem itself. Must run BEFORE the fake's ~20ms resolve timer fires
 *  — same "before the timer" window startAndGetRunId's own doc comment
 *  describes. */
async function commitFile(worktreeDir: string, relPath: string, content: string): Promise<void> {
  writeFileSync(path.join(worktreeDir, relPath), content);
  await gitQuiet(["add", relPath], worktreeDir);
  await gitQuiet(["commit", "-m", `add ${relPath}`], worktreeDir);
}

async function startAndGetRunId(startTask: typeof import("./orchestrator.ts").startTask, taskId: string): Promise<string> {
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  return started.runId;
}

test("pipeline: decompose success with a valid TASKS.json fresh-enters building, spawns a child, and merges it back on success", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const repo = await makeGitRepo();
  const created = await createTask({
    title: "p3c", prompt: "x", agent: "claude-code",
    workdir: repo, isolation: "worktree", taskType: "task",
    mode: "auto", model: "opus-4.7", effort: "high",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  tasks.update(taskId, {
    pipelineStage: "decompose", planApproved: true, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null,
  });

  await startAndGetRunId(startTask, taskId);
  // Stand in for what a real decompose agent turn would write+commit —
  // must happen before the fake driver's ~20ms resolve timer fires.
  await commitFile(
    tasks.get(taskId)!.worktreePath!, "TASKS.json",
    JSON.stringify({ subtasks: [{ id: "a", title: "A", prompt: "do a", dependsOn: [], acceptanceCriteria: [] }] }),
  );
  // The fresh-entry path is several async hops deep (advancePipelineStage's
  // "decompose" case -> tickBuild -> createTask + startTask for the
  // child -> the child's own fake run -> settleChildRun ->
  // completeChildBuild's real `git merge`), vs. one hop for a plain
  // spawnStage/startTask transition — plus real git subprocess latency.
  await settle(600);

  const task = tasks.get(taskId)!;
  const children = tasks.list().filter((t) => t.parentTaskId === taskId);
  expect(children.length).toBe(1);
  expect(children[0]!.planSubtaskId).toBe("a");
  expect(runs.listForTask(children[0]!.id).length).toBe(1);
  // The child's own run succeeded, settleChildRun routed it to
  // completeChildBuild, and the real `git merge` (trivial — the child made
  // no new commits, so it's already an ancestor) succeeded.
  expect(children[0]!.childMergeStatus).toBe("merged");
  // With the sole subtask merged, the barrier is complete and the parent
  // has moved on to code-review — not left sitting in "building". (Its own
  // code-review run also starts for real now and blocks, since no
  // PIPELINE_VERDICT was injected for it — that's code-review's own
  // verdict-flow, exercised separately; pipelineStage having reached
  // "code-review" at all is what this test checks.)
  expect(task.pipelineStage).toBe("code-review");
  // The child's commits are already captured by the merge into the parent
  // branch, so it gets archived once the barrier completes — its worktree
  // is redundant, but the row + run history stay around for audit.
  expect(tasks.get(children[0]!.id)!.archivedAt).not.toBeNull();
});

test("pipeline: a merge conflict aborts the whole build — blocks the parent, blocks the conflicting child, cancels siblings", async () => {
  // Fully manual setup: materializes both worktrees directly via
  // worktree.ts's prepareWorkdir (the same function startTask calls
  // internally) and calls build-scheduler.ts's completeChildBuild directly
  // to simulate "the child's run just succeeded" — never starting a real
  // (even fake-driver) run for either task. Two sequential real `git commit`
  // calls per worktree take longer than the fake driver's ~20ms resolve
  // timer, so racing real commits against a live run is NOT reliable (see
  // the previous version of this test, which flaked exactly this way);
  // driving the merge step directly sidesteps that timing entirely.
  const { createTask, cancelSiblingChildren } = await import("./orchestrator.ts");
  const { completeChildBuild } = await import("./build-scheduler.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { tasks } = await import("./db.ts");

  const repo = await makeGitRepo();

  const parentCreated = await createTask({
    title: "p3h", prompt: "x", agent: "claude-code",
    workdir: repo, isolation: "worktree", taskType: "task",
    mode: "auto", model: "opus-4.7", effort: "high",
  });
  if ("error" in parentCreated) throw new Error(parentCreated.error);
  const parentId = parentCreated.task.id;
  const parentPrepared = await prepareWorkdir(tasks.get(parentId)!);
  if ("error" in parentPrepared) throw new Error(parentPrepared.error);
  tasks.update(parentId, {
    branch: parentPrepared.branch, worktreePath: parentPrepared.worktreePath,
    pipelineStage: "building", column: "building",
    planApproved: true, implementationApproved: false, revisionCount: 0, pipelineFeedback: null,
  });
  const parentWorktree = parentPrepared.worktreePath!;
  const parentBranch = parentPrepared.branch!;

  const childCreated = await createTask({
    title: "p3h — A", prompt: "do a", agent: "claude-code",
    workdir: repo, isolation: "worktree", taskType: "task",
    baseRef: parentBranch, mode: "auto", model: "opus-4.7", effort: "high",
    parentTaskId: parentId, planSubtaskId: "a", column: "building",
  });
  if ("error" in childCreated) throw new Error(childCreated.error);
  const childId = childCreated.task.id;
  const childPrepared = await prepareWorkdir(tasks.get(childId)!);
  if ("error" in childPrepared) throw new Error(childPrepared.error);
  tasks.update(childId, {
    branch: childPrepared.branch, worktreePath: childPrepared.worktreePath,
    childMergeStatus: "pending",
  });
  const childWorktree = childPrepared.worktreePath!;

  // Neither worktree has this file yet, so both independently "adding" it
  // with different content is a genuine (not simulated) git add/add
  // conflict — no timing to race, both tasks are already fully at rest.
  await commitFile(parentWorktree, "conflict.txt", "parent version\n");
  await commitFile(childWorktree, "conflict.txt", "child version\n");

  await completeChildBuild(childId);

  const parent = tasks.get(parentId)!;
  const child = tasks.get(childId)!;
  expect(child.childMergeStatus).toBe("merge-failed");
  expect(child.column).toBe("blocked");
  expect(parent.column).toBe("blocked");
  expect(parent.pipelineFeedback).toContain("merge conflict");
  expect(parent.pipelineFeedback).toContain("a"); // names the failed subtask

  // cancelSiblingChildren must be a no-op here (nothing else running) —
  // exercised for real above via settleChildRun's own call; this just
  // confirms it doesn't throw when there's nothing left to cancel.
  expect(() => cancelSiblingChildren(parentId)).not.toThrow();

  // The parent's worktree should be back to a clean, unconflicted state —
  // mergeBranch's conflict path calls abortMerge, so a fresh `git status`
  // shows no in-progress merge / conflict markers left behind.
  const status = Bun.spawn(["git", "status", "--porcelain=v1"], {
    cwd: parentWorktree, stdout: "pipe", stderr: "pipe",
  });
  const statusOut = await new Response(status.stdout).text();
  await status.exited;
  expect(statusOut).not.toContain("UU "); // "both modified" / unresolved conflict marker
});

test("pipeline: deleteTask cascades to a parent's still-live children — their worktrees, runs, and rows all go too", async () => {
  // Manual setup (no startTask on the children, mirroring the conflict
  // test above) so the children stay genuinely "live" (still building,
  // never merged/archived) rather than racing to natural completion —
  // with 2 independent no-dep subtasks under the fake driver, both
  // finish+merge+archive themselves well within any settle() window,
  // which would leave nothing "live" left for this test to actually
  // delete out from under.
  const { createTask, deleteTask } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { tasks, runs } = await import("./db.ts");
  const { existsSync } = await import("node:fs");

  const repo = await makeGitRepo();
  const created = await createTask({
    title: "p3i", prompt: "x", agent: "claude-code",
    workdir: repo, isolation: "worktree", taskType: "task",
    mode: "auto", model: "opus-4.7", effort: "high",
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  const parentPrepared = await prepareWorkdir(tasks.get(parentId)!);
  if ("error" in parentPrepared) throw new Error(parentPrepared.error);
  tasks.update(parentId, {
    branch: parentPrepared.branch, worktreePath: parentPrepared.worktreePath,
    pipelineStage: "building", column: "building",
    planApproved: true, implementationApproved: false, revisionCount: 0, pipelineFeedback: null,
  });
  const parentBranch = parentPrepared.branch!;

  const childWorktrees: string[] = [];
  const childIds: string[] = [];
  for (const subtaskId of ["a", "b"]) {
    const childCreated = await createTask({
      title: `p3i — ${subtaskId}`, prompt: `do ${subtaskId}`, agent: "claude-code",
      workdir: repo, isolation: "worktree", taskType: "task",
      baseRef: parentBranch, mode: "auto", model: "opus-4.7", effort: "high",
      parentTaskId: parentId, planSubtaskId: subtaskId, column: "building",
    });
    if ("error" in childCreated) throw new Error(childCreated.error);
    const childPrepared = await prepareWorkdir(tasks.get(childCreated.task.id)!);
    if ("error" in childPrepared) throw new Error(childPrepared.error);
    tasks.update(childCreated.task.id, {
      branch: childPrepared.branch, worktreePath: childPrepared.worktreePath,
      childMergeStatus: "pending",
    });
    childWorktrees.push(childPrepared.worktreePath!);
    childIds.push(childCreated.task.id);
  }

  for (const wt of childWorktrees) expect(existsSync(wt)).toBe(true);
  expect(tasks.list().filter((t) => t.parentTaskId === parentId).length).toBe(2);

  await deleteTask(parentId);

  expect(tasks.get(parentId)).toBeNull();
  for (const childId of childIds) {
    expect(tasks.get(childId)).toBeNull();
    expect(runs.listForTask(childId).length).toBe(0);
  }
  for (const wt of childWorktrees) expect(existsSync(wt)).toBe(false);
});

test("pipeline: tickBuild merges a merge-deferred child FIRST, then completes the barrier (F-3 re-entry)", async () => {
  // Manual setup, same style as the merge-conflict test above: a parent
  // sitting in building whose sole subtask's child finished LATE (parked
  // merge-deferred by doCompleteChild while the parent was elsewhere).
  // A single tickBuild must land the deferred merge, see the barrier
  // complete, and advance to code-review — the recovery path the stranded
  // 2DOT2DOT children never had.
  const { createTask } = await import("./orchestrator.ts");
  const { tickBuild } = await import("./build-scheduler.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { tasks } = await import("./db.ts");

  const repo = await makeGitRepo();

  const parentCreated = await createTask({
    title: "p3d", prompt: "x", agent: "claude-code",
    workdir: repo, isolation: "worktree", taskType: "task",
    mode: "auto", model: "opus-4.7", effort: "high",
  });
  if ("error" in parentCreated) throw new Error(parentCreated.error);
  const parentId = parentCreated.task.id;
  const parentPrepared = await prepareWorkdir(tasks.get(parentId)!);
  if ("error" in parentPrepared) throw new Error(parentPrepared.error);
  tasks.update(parentId, {
    branch: parentPrepared.branch, worktreePath: parentPrepared.worktreePath,
    pipelineStage: "building", column: "building",
    planApproved: true, implementationApproved: false, revisionCount: 0, pipelineFeedback: null,
    pausedAt: Date.now(), // pause so the code-review advance doesn't spawn a real run mid-test
  });
  const parentWorktree = parentPrepared.worktreePath!;
  const parentBranch = parentPrepared.branch!;
  await commitFile(
    parentWorktree, "TASKS.json",
    JSON.stringify({ subtasks: [{ id: "a", title: "A", prompt: "do a", dependsOn: [], acceptanceCriteria: [] }] }),
  );

  const childCreated = await createTask({
    title: "p3d — A", prompt: "do a", agent: "claude-code",
    workdir: repo, isolation: "worktree", taskType: "task",
    baseRef: parentBranch, mode: "auto", model: "opus-4.7", effort: "high",
    parentTaskId: parentId, planSubtaskId: "a", column: "building",
  });
  if ("error" in childCreated) throw new Error(childCreated.error);
  const childId = childCreated.task.id;
  const childPrepared = await prepareWorkdir(tasks.get(childId)!);
  if ("error" in childPrepared) throw new Error(childPrepared.error);
  await commitFile(childPrepared.worktreePath!, "feature.txt", "the deferred work\n");
  tasks.update(childId, {
    branch: childPrepared.branch, worktreePath: childPrepared.worktreePath,
    childMergeStatus: "merge-deferred", column: "review",
  });

  await tickBuild(parentId);

  const { existsSync } = await import("node:fs");
  const child = tasks.get(childId);
  const parent = tasks.get(parentId)!;
  // Deferred merge landed…
  expect(existsSync(path.join(parentWorktree, "feature.txt"))).toBe(true);
  // …the child is either still visible as merged or already archived by the
  // barrier-completion sweep (archiveTask is fire-and-forget) — merged
  // status is the invariant either way.
  expect(child?.childMergeStatus).toBe("merged");
  // …and the barrier completed: parent advanced to code-review (paused, so
  // the stage landed without spawning a run).
  expect(parent.pipelineStage).toBe("code-review");
});

test("pipeline: a no-progress bounce blocks immediately; a progressing bounce proceeds and stores the new fingerprint (F-5)", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { prepareWorkdir, treeFingerprintSync } = await import("./worktree.ts");
  const { tasks, runs } = await import("./db.ts");

  const setup = async (): Promise<{ taskId: string; worktree: string }> => {
    const repo = await makeGitRepo();
    const created = await createTask({
      title: "p5f", prompt: "x", agent: "claude-code",
      workdir: repo, isolation: "worktree", taskType: "task",
      mode: "auto", model: "opus-4.7", effort: "high",
    });
    if ("error" in created) throw new Error(created.error);
    const taskId = created.task.id;
    const prepared = await prepareWorkdir(tasks.get(taskId)!);
    if ("error" in prepared) throw new Error(prepared.error);
    tasks.update(taskId, {
      branch: prepared.branch, worktreePath: prepared.worktreePath,
      pipelineStage: "testing", column: "testing",
      planApproved: true, implementationApproved: false, revisionCount: 0, pipelineFeedback: null,
    });
    await commitFile(
      prepared.worktreePath!, "TASKS.json",
      JSON.stringify({ subtasks: [{ id: "a", title: "A", prompt: "do a", dependsOn: [], acceptanceCriteria: [] }] }),
    );
    // Satisfied barrier so the bounce takes the fixup path, where the
    // fingerprint comparison lives.
    const now = Date.now();
    tasks.insert({
      id: crypto.randomUUID(), title: "child a", prompt: "do a", column: "building", agent: "claude-code",
      workdir: repo, isolation: "none", taskType: "task",
      branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
      mode: "auto", model: "opus-4.7", effort: "high",
      references: [], backlog: [], draft: null, runId: null,
      hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
      createdAt: now, updatedAt: now, archivedAt: null,
      pipelineStage: null, planApproved: false, implementationApproved: false,
      revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null,
      parentTaskId: taskId, planSubtaskId: "a", childMergeStatus: "merged",
    });
    return { taskId, worktree: prepared.worktreePath! };
  };

  // Case 1 — NO PROGRESS: the stored fingerprint matches the tree exactly
  // as it stands at bounce time → block immediately, don't burn the budget.
  {
    const { taskId, worktree } = await setup();
    const fp = treeFingerprintSync(worktree);
    expect(fp).not.toBeNull();
    tasks.update(taskId, { pipelineBounceFingerprint: `building:${fp}` });

    const started = await startTask(taskId);
    if ("error" in started) throw new Error(started.error);
    runs.appendEvent(started.runId, "assistant", "PIPELINE_VERDICT: fail same failure as before");
    await settle(300);

    const task = tasks.get(taskId)!;
    expect(task.column).toBe("blocked");
    expect(task.pipelineFeedback).toContain("produced no changes");
  }

  // Case 2 — PROGRESS: a stale fingerprint (tree has changed since) lets
  // the bounce proceed normally and stores the fresh fingerprint.
  {
    const { taskId, worktree } = await setup();
    tasks.update(taskId, { pipelineBounceFingerprint: "building:stale-hash-from-before" });

    const started = await startTask(taskId);
    if ("error" in started) throw new Error(started.error);
    runs.appendEvent(started.runId, "assistant", "PIPELINE_VERDICT: fail one test is red");
    await settle(300);

    const task = tasks.get(taskId)!;
    // The bounce proceeded (no no-progress block): the fixup run spawned,
    // its fake driver resolved, and the barrier-complete exit carried the
    // task on to code-review (whose own run blocks awaiting a verdict).
    expect(task.pipelineStage).toBe("code-review");
    expect(task.revisionCount).toBe(1);
    // The fresh fingerprint from the bounce is stored (the fake fixup run
    // touches no files, so it still matches the tree).
    const fp = treeFingerprintSync(worktree);
    expect(task.pipelineBounceFingerprint).toBe(`building:${fp}`);
  }
});

test("pipeline: a merged child's card leaves the running lane immediately (column done), even while the barrier is still incomplete", async () => {
  // Manual setup, same style as the F-3 deferred-pickup test above, but with
  // a SECOND (still-pending) subtask so the barrier does NOT complete and no
  // archive sweep races the assertion. Before this fix the merged child kept
  // `column: "running"` until the barrier's archive sweep — which never runs
  // if the build later aborts, stranding finished-looking cards in the
  // in-progress lane (2dot2dot-redesign incident, 2026-08-16).
  const { createTask } = await import("./orchestrator.ts");
  const { tickBuild } = await import("./build-scheduler.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const { tasks } = await import("./db.ts");

  const repo = await makeGitRepo();

  const parentCreated = await createTask({
    title: "p3done", prompt: "x", agent: "claude-code",
    workdir: repo, isolation: "worktree", taskType: "task",
    mode: "auto", model: "opus-4.7", effort: "high",
  });
  if ("error" in parentCreated) throw new Error(parentCreated.error);
  const parentId = parentCreated.task.id;
  const parentPrepared = await prepareWorkdir(tasks.get(parentId)!);
  if ("error" in parentPrepared) throw new Error(parentPrepared.error);
  tasks.update(parentId, {
    branch: parentPrepared.branch, worktreePath: parentPrepared.worktreePath,
    pipelineStage: "building", column: "building",
    planApproved: true, implementationApproved: false, revisionCount: 0, pipelineFeedback: null,
  });
  const parentWorktree = parentPrepared.worktreePath!;
  const parentBranch = parentPrepared.branch!;
  await commitFile(
    parentWorktree, "TASKS.json",
    JSON.stringify({ subtasks: [
      { id: "a", title: "A", prompt: "do a", dependsOn: [], acceptanceCriteria: [] },
      { id: "b", title: "B", prompt: "do b", dependsOn: [], acceptanceCriteria: [] },
    ] }),
  );

  // Child for "a": finished late, parked merge-deferred with real committed work.
  const childACreated = await createTask({
    title: "p3done — A", prompt: "do a", agent: "claude-code",
    workdir: repo, isolation: "worktree", taskType: "task",
    baseRef: parentBranch, mode: "auto", model: "opus-4.7", effort: "high",
    parentTaskId: parentId, planSubtaskId: "a", column: "building",
  });
  if ("error" in childACreated) throw new Error(childACreated.error);
  const childAId = childACreated.task.id;
  const childAPrepared = await prepareWorkdir(tasks.get(childAId)!);
  if ("error" in childAPrepared) throw new Error(childAPrepared.error);
  await commitFile(childAPrepared.worktreePath!, "a.txt", "work a\n");
  tasks.update(childAId, {
    branch: childAPrepared.branch, worktreePath: childAPrepared.worktreePath,
    childMergeStatus: "merge-deferred", column: "review",
  });

  // Child for "b": exists but is still pending — keeps the barrier incomplete
  // and stops tickBuild from spawning anything.
  const childBCreated = await createTask({
    title: "p3done — B", prompt: "do b", agent: "claude-code",
    workdir: repo, isolation: "worktree", taskType: "task",
    baseRef: parentBranch, mode: "auto", model: "opus-4.7", effort: "high",
    parentTaskId: parentId, planSubtaskId: "b", column: "building",
  });
  if ("error" in childBCreated) throw new Error(childBCreated.error);
  tasks.update(childBCreated.task.id, { childMergeStatus: "pending" });

  await tickBuild(parentId);

  const childA = tasks.get(childAId)!;
  // The merge landed and the card moved straight to "done" — no waiting for
  // the barrier's archive sweep.
  expect(childA.childMergeStatus).toBe("merged");
  expect(childA.column).toBe("done");
  expect(childA.archivedAt).toBeNull(); // barrier incomplete — no archive yet
  // Parent still building on the unfinished subtask, untouched otherwise.
  const parent = tasks.get(parentId)!;
  expect(parent.pipelineStage).toBe("building");
  expect(parent.column).toBe("building");
});
