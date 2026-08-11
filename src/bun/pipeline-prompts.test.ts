import { test, expect } from "bun:test";
import {
  parsePipelineVerdict,
  parseBuildPlan,
  parseSpecAcceptanceCriteria,
  analyzeCoverage,
  childBuildPrompt,
  stagePrompt,
  PIPELINE_PLAN_FILE,
  PIPELINE_TASKS_FILE,
  PIPELINE_SPEC_FILE,
  PIPELINE_VERDICT_PREFIX,
} from "./pipeline-prompts.ts";
import type { Task } from "../shared/types.ts";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1", title: "Add dark mode", prompt: "Add a dark mode toggle to settings.",
    column: "planning", agent: "claude-code", workdir: "/tmp/wd", isolation: "worktree",
    taskType: "task", branch: "agetor/t1-add-dark-mode", branchSource: "created",
    worktreePath: "/tmp/wt", baseRef: "abc123", prUrl: null,
    mode: null, model: null, effort: null,
    references: [], backlog: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: 0, updatedAt: 0, archivedAt: null,
    pipelineStage: "planning", planApproved: false, implementationApproved: false,
    revisionCount: 0, pipelineFeedback: null, pausedAt: null, blockReason: null, parentTaskId: null, planSubtaskId: null, childMergeStatus: null,
    ...overrides,
  };
}

// --- parsePipelineVerdict: plan-review -------------------------------------

test("plan-review: approve, as the sole final line", () => {
  const v = parsePipelineVerdict("plan-review", "Looks solid.\n\nPIPELINE_VERDICT: approve");
  expect(v).toEqual({ ok: true, kind: "approve" });
});

test("plan-review: revise with a multi-word reason", () => {
  const v = parsePipelineVerdict(
    "plan-review",
    "Missing test coverage.\n\nPIPELINE_VERDICT: revise the plan omits how theme state persists across restarts",
  );
  expect(v).toEqual({
    ok: true,
    kind: "revise",
    reason: "the plan omits how theme state persists across restarts",
  });
});

test("plan-review: revise with no reason text still parses, placeholder reason", () => {
  const v = parsePipelineVerdict("plan-review", "PIPELINE_VERDICT: revise");
  expect(v).toEqual({ ok: true, kind: "revise", reason: "(no reason given)" });
});

test("plan-review: trailing blank lines after the sentinel don't break the match", () => {
  const v = parsePipelineVerdict("plan-review", "PIPELINE_VERDICT: approve\n\n\n");
  expect(v).toEqual({ ok: true, kind: "approve" });
});

test("plan-review: no sentinel at all -> unparseable", () => {
  const v = parsePipelineVerdict("plan-review", "This plan looks good to me!");
  expect(v).toEqual({ ok: false });
});

test("plan-review: sentinel prefix present but wrong keyword for this stage -> unparseable, not misread as pass/fail", () => {
  const v = parsePipelineVerdict("plan-review", "PIPELINE_VERDICT: pass");
  expect(v).toEqual({ ok: false });
});

test("plan-review: sentinel mentioned mid-message (not the true final line) is still honored if it's the LAST occurrence", () => {
  const v = parsePipelineVerdict(
    "plan-review",
    "I was going to write PIPELINE_VERDICT: revise but changed my mind.\nPIPELINE_VERDICT: approve",
  );
  expect(v).toEqual({ ok: true, kind: "approve" });
});

test("plan-review: earlier sentinel is superseded by a later one in the same message", () => {
  const v = parsePipelineVerdict(
    "plan-review",
    "PIPELINE_VERDICT: approve\nWait, actually on reflection:\nPIPELINE_VERDICT: revise reconsidered after re-reading the plan",
  );
  expect(v.ok && v.kind).toBe("revise");
});

// --- parsePipelineVerdict: testing ------------------------------------------

test("testing: pass", () => {
  expect(parsePipelineVerdict("testing", "All green.\nPIPELINE_VERDICT: pass"))
    .toEqual({ ok: true, kind: "pass" });
});

test("testing: fail with reason", () => {
  const v = parsePipelineVerdict("testing", "PIPELINE_VERDICT: fail 3 type errors in settings.ts");
  expect(v).toEqual({ ok: true, kind: "fail", reason: "3 type errors in settings.ts" });
});

test("testing: 'approve'/'revise' keywords (the other stage's) don't parse for testing", () => {
  expect(parsePipelineVerdict("testing", "PIPELINE_VERDICT: approve")).toEqual({ ok: false });
  expect(parsePipelineVerdict("testing", "PIPELINE_VERDICT: revise something")).toEqual({ ok: false });
});

test("testing: case-insensitive keyword match", () => {
  expect(parsePipelineVerdict("testing", "PIPELINE_VERDICT: PASS")).toEqual({ ok: true, kind: "pass" });
});

// --- parsePipelineVerdict: code-review --------------------------------------

test("code-review: approve", () => {
  expect(parsePipelineVerdict("code-review", "LGTM.\nPIPELINE_VERDICT: approve"))
    .toEqual({ ok: true, kind: "approve" });
});

test("code-review: revise with reason", () => {
  const v = parsePipelineVerdict("code-review", "PIPELINE_VERDICT: revise the error path swallows the exception");
  expect(v).toEqual({ ok: true, kind: "revise", reason: "the error path swallows the exception" });
});

test("code-review: testing's keywords ('pass'/'fail') don't parse for code-review", () => {
  expect(parsePipelineVerdict("code-review", "PIPELINE_VERDICT: pass")).toEqual({ ok: false });
  expect(parsePipelineVerdict("code-review", "PIPELINE_VERDICT: fail something")).toEqual({ ok: false });
});

// --- stagePrompt -------------------------------------------------------------

test("stagePrompt: planning embeds the ticket and PLAN.md filename, no verdict instruction", () => {
  const p = stagePrompt(task({ pipelineStage: "planning" }), "planning");
  expect(p).toContain("Add a dark mode toggle to settings.");
  expect(p).toContain(PIPELINE_PLAN_FILE);
  expect(p).not.toContain(PIPELINE_VERDICT_PREFIX);
});

test("stagePrompt: planning folds in prior feedback when present", () => {
  const p = stagePrompt(
    task({ pipelineStage: "planning", pipelineFeedback: "needs a rollback plan" }),
    "planning",
  );
  expect(p).toContain("needs a rollback plan");
});

test("stagePrompt: plan-review instructs the verdict sentinel format for both outcomes", () => {
  const p = stagePrompt(task({ pipelineStage: "plan-review" }), "plan-review");
  expect(p).toContain(`${PIPELINE_VERDICT_PREFIX} approve`);
  expect(p).toContain(`${PIPELINE_VERDICT_PREFIX} revise`);
});

test("stagePrompt: building references PLAN.md and folds in tester feedback", () => {
  const p = stagePrompt(
    task({ pipelineStage: "building", pipelineFeedback: "off-by-one in the pagination" }),
    "building",
  );
  expect(p).toContain(PIPELINE_PLAN_FILE);
  expect(p).toContain("off-by-one in the pagination");
});

test("stagePrompt: testing explicitly forbids push/PR (never silently omits it), and derives the commit-type prefix from the branch", () => {
  const p = stagePrompt(task({ pipelineStage: "testing", branch: "feature/dark-mode" }), "testing");
  expect(p.toLowerCase()).toContain("do not push");
  expect(p.toLowerCase()).toContain("do not open a pull request");
  expect(p.toLowerCase()).not.toContain("push it"); // no instruction to actually push
  expect(p).toContain('"feature:');
  expect(p).toContain(`${PIPELINE_VERDICT_PREFIX} pass`);
  expect(p).toContain(`${PIPELINE_VERDICT_PREFIX} fail`);
});

test("stagePrompt: testing falls back to task-type commit prefix when the branch has no slash", () => {
  const p = stagePrompt(
    task({ pipelineStage: "testing", branch: null, taskType: "bug" }),
    "testing",
  );
  expect(p).toContain('"fix:');
});

test("stagePrompt: code-review instructs reviewing the actual diff against baseRef and the verdict sentinel format", () => {
  const p = stagePrompt(task({ pipelineStage: "code-review", baseRef: "abc123" }), "code-review");
  expect(p).toContain("git diff abc123");
  expect(p).toContain(PIPELINE_PLAN_FILE);
  expect(p).toContain(`${PIPELINE_VERDICT_PREFIX} approve`);
  expect(p).toContain(`${PIPELINE_VERDICT_PREFIX} revise`);
  // Reviews code, not behavior — doesn't run tests/linters (that's testing's job).
  expect(p.toLowerCase()).toContain("do not run the test suite");
});

test("stagePrompt: decompose shows the TASKS.json schema and instructs a commit, no verdict instruction", () => {
  const p = stagePrompt(task({ pipelineStage: "decompose" }), "decompose");
  expect(p).toContain(PIPELINE_PLAN_FILE);
  expect(p).toContain(PIPELINE_TASKS_FILE);
  expect(p).toContain("\"subtasks\"");
  expect(p).toContain("\"dependsOn\"");
  expect(p.toLowerCase()).toContain("commit");
  expect(p.toLowerCase()).toContain("do not push");
  expect(p).not.toContain(PIPELINE_VERDICT_PREFIX);
});

// --- parseBuildPlan -----------------------------------------------------------

test("parseBuildPlan: valid plan with independent and dependent subtasks", () => {
  const result = parseBuildPlan(JSON.stringify({
    subtasks: [
      { id: "a", title: "A", prompt: "do a", dependsOn: [] },
      { id: "b", title: "B", prompt: "do b", dependsOn: ["a"] },
    ],
  }));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.plan.subtasks.map((s) => s.id)).toEqual(["a", "b"]);
    expect(result.plan.subtasks[1]!.dependsOn).toEqual(["a"]);
  }
});

test("parseBuildPlan: dependsOn may be omitted, defaults to empty", () => {
  const result = parseBuildPlan(JSON.stringify({ subtasks: [{ id: "a", title: "A", prompt: "do a" }] }));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.plan.subtasks[0]!.dependsOn).toEqual([]);
});

test("parseBuildPlan: invalid JSON", () => {
  const result = parseBuildPlan("{not json");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("invalid JSON");
});

test("parseBuildPlan: empty subtasks array is rejected", () => {
  const result = parseBuildPlan(JSON.stringify({ subtasks: [] }));
  expect(result.ok).toBe(false);
});

test("parseBuildPlan: missing subtasks key is rejected", () => {
  const result = parseBuildPlan(JSON.stringify({ foo: "bar" }));
  expect(result.ok).toBe(false);
});

test("parseBuildPlan: dependsOn referencing an undeclared id is rejected", () => {
  const result = parseBuildPlan(JSON.stringify({
    subtasks: [{ id: "a", title: "A", prompt: "do a", dependsOn: ["ghost"] }],
  }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("undeclared subtask");
});

test("parseBuildPlan: a subtask depending on itself is rejected", () => {
  const result = parseBuildPlan(JSON.stringify({
    subtasks: [{ id: "a", title: "A", prompt: "do a", dependsOn: ["a"] }],
  }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("cannot depend on itself");
});

test("parseBuildPlan: duplicate ids are rejected", () => {
  const result = parseBuildPlan(JSON.stringify({
    subtasks: [
      { id: "a", title: "A1", prompt: "1", dependsOn: [] },
      { id: "a", title: "A2", prompt: "2", dependsOn: [] },
    ],
  }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("duplicate");
});

test("parseBuildPlan: a 3-cycle (a->b->c->a) is rejected", () => {
  const result = parseBuildPlan(JSON.stringify({
    subtasks: [
      { id: "a", title: "A", prompt: "1", dependsOn: ["c"] },
      { id: "b", title: "B", prompt: "2", dependsOn: ["a"] },
      { id: "c", title: "C", prompt: "3", dependsOn: ["b"] },
    ],
  }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("cycle");
});

test("parseBuildPlan: a subtask missing a prompt is rejected", () => {
  const result = parseBuildPlan(JSON.stringify({ subtasks: [{ id: "a", title: "A" }] }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("prompt");
});

// --- childBuildPrompt ----------------------------------------------------------

test("childBuildPrompt: folds in the subtask's own prompt, points at PLAN.md, requires a local commit, forbids push", () => {
  const p = childBuildPrompt(
    task({ pipelineStage: "building", branch: "feature/dark-mode", prompt: "Add dark mode" }),
    { id: "toggle", title: "Add the toggle", prompt: "Add a toggle component to settings.", dependsOn: [], acceptanceCriteria: [] },
  );
  expect(p).toContain("Add a toggle component to settings.");
  expect(p).toContain(PIPELINE_PLAN_FILE);
  expect(p).toContain("Add dark mode"); // parent ticket folded in for context
  expect(p.toLowerCase()).toContain("commit");
  expect(p.toLowerCase()).toContain("do not push");
  expect(p.toLowerCase()).toContain("do not open a pull request");
  expect(p).toContain('"feature:');
});

test("childBuildPrompt: inlines AC text from specAcMap when the subtask owns ACs", () => {
  const p = childBuildPrompt(
    task({ pipelineStage: "building", branch: "feature/dark-mode", prompt: "Add dark mode" }),
    { id: "toggle", title: "Add the toggle", prompt: "Do the thing.", dependsOn: [], acceptanceCriteria: ["AC-1", "AC-2"] },
    { "AC-1": "The toggle persists across reloads.", "AC-2": "The toggle is accessible." },
  );
  expect(p).toContain("AC-1: The toggle persists across reloads.");
  expect(p).toContain("AC-2: The toggle is accessible.");
  expect(p).toContain(PIPELINE_SPEC_FILE);
});

// --- parseSpecAcceptanceCriteria -----------------------------------------------

test("parseSpecAcceptanceCriteria: extracts AC ids in order, deduplicating", () => {
  const raw = "## Acceptance criteria\nAC-1: It works.\nAC-2: It's fast.\nAC-1: (duplicate — ignored)";
  expect(parseSpecAcceptanceCriteria(raw)).toEqual(["AC-1", "AC-2"]);
});

test("parseSpecAcceptanceCriteria: returns empty array when no AC-N lines are present", () => {
  expect(parseSpecAcceptanceCriteria("# Spec\n\nNo criteria here.")).toEqual([]);
});

test("parseSpecAcceptanceCriteria: sorts numerically (AC-10 after AC-9, not after AC-1)", () => {
  const raw = "AC-10: x\nAC-2: y\nAC-1: z";
  expect(parseSpecAcceptanceCriteria(raw)).toEqual(["AC-1", "AC-2", "AC-10"]);
});

test("parseSpecAcceptanceCriteria: leading whitespace is tolerated", () => {
  expect(parseSpecAcceptanceCriteria("  AC-3: indented")).toEqual(["AC-3"]);
});

// --- analyzeCoverage -----------------------------------------------------------

test("analyzeCoverage: all ACs covered returns ok", () => {
  const plan = {
    subtasks: [
      { id: "a", title: "A", prompt: "do a", dependsOn: [], acceptanceCriteria: ["AC-1"] },
      { id: "b", title: "B", prompt: "do b", dependsOn: [], acceptanceCriteria: ["AC-2", "AC-3"] },
    ],
  };
  expect(analyzeCoverage(["AC-1", "AC-2", "AC-3"], plan)).toEqual({ ok: true });
});

test("analyzeCoverage: an unclaimed AC id returns a gap error", () => {
  const plan = {
    subtasks: [{ id: "a", title: "A", prompt: "p", dependsOn: [], acceptanceCriteria: ["AC-1"] }],
  };
  const result = analyzeCoverage(["AC-1", "AC-2"], plan);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("AC-2");
});

test("analyzeCoverage: a phantom AC id (in subtask but not in spec) returns a phantom error", () => {
  const plan = {
    subtasks: [{ id: "a", title: "A", prompt: "p", dependsOn: [], acceptanceCriteria: ["AC-99"] }],
  };
  const result = analyzeCoverage(["AC-1"], plan);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toContain("AC-99");
    expect(result.reason).toContain("AC-1"); // also a gap
  }
});

test("analyzeCoverage: empty spec ACs with empty subtask ACs returns ok", () => {
  const plan = { subtasks: [{ id: "a", title: "A", prompt: "p", dependsOn: [], acceptanceCriteria: [] }] };
  expect(analyzeCoverage([], plan)).toEqual({ ok: true });
});

// --- stagePrompt: new SDD stages -----------------------------------------------

test("stagePrompt: specify mentions SPEC.md, AC format, and the ticket title", () => {
  const p = stagePrompt(task({ pipelineStage: "specify" }), "specify");
  expect(p).toContain(PIPELINE_SPEC_FILE);
  expect(p).toContain("AC-1:");
  expect(p).toContain("Add a dark mode toggle to settings."); // ticket prompt appears in the block
  expect(p).not.toContain(PIPELINE_VERDICT_PREFIX);
});

test("stagePrompt: specify folds in the constitution when provided", () => {
  const p = stagePrompt(task({ pipelineStage: "specify" }), "specify", "## Project principles\nAlways write tests.");
  expect(p).toContain("Always write tests.");
});

test("stagePrompt: clarify mentions SPEC.md and the ask_user tool", () => {
  const p = stagePrompt(task({ pipelineStage: "clarify" }), "clarify");
  expect(p).toContain(PIPELINE_SPEC_FILE);
  expect(p).toContain("ask_user");
  expect(p).not.toContain(PIPELINE_VERDICT_PREFIX);
});

test("stagePrompt: analyze returns empty string (no agent turn)", () => {
  const p = stagePrompt(task({ pipelineStage: "analyze" }), "analyze");
  expect(p).toBe("");
});
