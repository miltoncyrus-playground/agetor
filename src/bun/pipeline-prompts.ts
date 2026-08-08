import { branchCommitType, type Task } from "../shared/types.ts";

/**
 * Fixed filename the Planner writes its plan to, at the worktree root. New
 * convention introduced by pipeline tasks — nothing like it exists
 * elsewhere in agetor. Plain markdown, overwritten on every planning pass
 * (including a revision), no fixed internal schema — just "a human/agent
 * can read what to build and why."
 */
export const PIPELINE_PLAN_FILE = "PLAN.md";

/**
 * Single line prefix both verdict-bearing stages (plan-review, testing) are
 * instructed to end their final message with, followed by a keyword and
 * (on a send-back) a free-text reason:
 *   PIPELINE_VERDICT: approve
 *   PIPELINE_VERDICT: revise <reason...>
 *   PIPELINE_VERDICT: pass
 *   PIPELINE_VERDICT: fail <reason...>
 * One shared prefix rather than stage-specific sentinels — the caller
 * already knows which stage it's parsing for (task.pipelineStage), so the
 * stage disambiguates approve/revise from pass/fail. Line-anchored,
 * fixed-keyword format so parsing is a simple regex, not prose matching.
 */
export const PIPELINE_VERDICT_PREFIX = "PIPELINE_VERDICT:";

/** Result of parsing the Critic's (plan-review) or Code Reviewer's
 *  (code-review) verdict — both use the same approve/revise keywords. */
export type PlanReviewVerdict =
  | { ok: true; kind: "approve" }
  | { ok: true; kind: "revise"; reason: string }
  | { ok: false };

/** Result of parsing the Tester's (testing) verdict. */
export type TestingVerdict =
  | { ok: true; kind: "pass" }
  | { ok: true; kind: "fail"; reason: string }
  | { ok: false };

const APPROVE_KEYWORDS: Record<"plan-review" | "testing" | "code-review", { ok: string; bounce: string }> = {
  "plan-review": { ok: "approve", bounce: "revise" },
  "testing": { ok: "pass", bounce: "fail" },
  "code-review": { ok: "approve", bounce: "revise" },
};

/**
 * Parse a verdict-bearing stage's final assistant message for the
 * PIPELINE_VERDICT sentinel. Pure — no DB/IO — so it's directly
 * unit-testable. Scans all lines (not just the very last one) so a trailing
 * blank line or closing remark after the sentinel doesn't break the match;
 * if the sentinel appears more than once, the LAST occurrence wins (an
 * agent correcting itself mid-message should have the final word).
 *
 * Overloaded per stage so a caller that already knows `stage` gets a
 * verdict type narrowed to that stage's own keywords (`approve`/`revise` vs
 * `pass`/`fail`) — accessing `.reason` on the bounce branch doesn't need a
 * runtime `"reason" in verdict` guard at the call site. code-review reuses
 * plan-review's approve/revise keywords and result type — both are the
 * same shape of gate (a Critic-style reviewer, sending back with a reason
 * or waving it through), just reviewing different artifacts (the plan vs.
 * the actual merged diff).
 */
export function parsePipelineVerdict(stage: "plan-review", text: string): PlanReviewVerdict;
export function parsePipelineVerdict(stage: "testing", text: string): TestingVerdict;
export function parsePipelineVerdict(stage: "code-review", text: string): PlanReviewVerdict;
export function parsePipelineVerdict(
  stage: "plan-review" | "testing" | "code-review",
  text: string,
): PlanReviewVerdict | TestingVerdict {
  const { ok, bounce } = APPROVE_KEYWORDS[stage];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith(PIPELINE_VERDICT_PREFIX)) continue;
    const rest = line.slice(PIPELINE_VERDICT_PREFIX.length).trim();
    const lower = rest.toLowerCase();
    if (lower === ok) return { ok: true, kind: ok } as PlanReviewVerdict | TestingVerdict;
    if (lower === bounce || lower.startsWith(`${bounce} `)) {
      const reason = rest.slice(bounce.length).trim();
      return {
        ok: true,
        kind: bounce,
        reason: reason || "(no reason given)",
      } as PlanReviewVerdict | TestingVerdict;
    }
    // Prefix matched but the keyword didn't — malformed sentinel, not a
    // silent miss. Treat as unparseable rather than guessing which way.
    return { ok: false };
  }
  return { ok: false };
}

/**
 * Fixed filename the pre-builder writes its decomposition to, at the
 * worktree root. Unlike PLAN.md (prose, for a human/agent to read),
 * BUILD_PLAN.json is machine-parseable — build-scheduler.ts's `tickBuild`
 * walks it to create and start child tasks per {@link parseBuildPlan}.
 */
export const PIPELINE_BUILD_PLAN_FILE = "BUILD_PLAN.json";

/** One independently-buildable unit of work declared in BUILD_PLAN.json. */
export interface BuildSubtask {
  /** Local id, unique within this plan — referenced by other subtasks'
   *  `dependsOn` and persisted on the resulting child task as
   *  `Task.planSubtaskId`. Not a Task id. */
  id: string;
  title: string;
  /** Concrete instructions for this slice, folded into the child's actual
   *  agent prompt by {@link childBuildPrompt}. */
  prompt: string;
  /** Local ids of other subtasks in this same plan that must be merged
   *  into the parent branch before this one can start. Empty = startable
   *  immediately. */
  dependsOn: string[];
}

export interface BuildPlan {
  subtasks: BuildSubtask[];
}

/**
 * Parse and validate a pre-builder's BUILD_PLAN.json. Pure — no DB/IO, the
 * caller reads the file — so it's directly unit-testable, same convention
 * as {@link parsePipelineVerdict}. Validates: valid JSON, an object with a
 * non-empty `subtasks` array, every subtask has a non-empty `id`/`prompt`,
 * ids are unique, every `dependsOn` entry resolves to another declared id
 * (not itself), and the resulting dependency graph is acyclic (DFS-based
 * cycle check). `dependsOn` may be omitted on a subtask (treated as `[]`)
 * but if present must be an array of strings.
 */
export function parseBuildPlan(raw: string): { ok: true; plan: BuildPlan } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, reason: "expected a JSON object with a \"subtasks\" array" };
  }
  const rawSubtasks = (json as { subtasks?: unknown }).subtasks;
  if (!Array.isArray(rawSubtasks) || rawSubtasks.length === 0) {
    return { ok: false, reason: "\"subtasks\" must be a non-empty array" };
  }

  const subtasks: BuildSubtask[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawSubtasks.length; i++) {
    const raw = rawSubtasks[i];
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, reason: `subtasks[${i}] is not an object` };
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id.trim()) {
      return { ok: false, reason: `subtasks[${i}].id must be a non-empty string` };
    }
    if (seenIds.has(r.id)) {
      return { ok: false, reason: `duplicate subtask id "${r.id}"` };
    }
    seenIds.add(r.id);
    if (typeof r.prompt !== "string" || !r.prompt.trim()) {
      return { ok: false, reason: `subtasks[${i}] ("${r.id}").prompt must be a non-empty string` };
    }
    const title = typeof r.title === "string" && r.title.trim() ? r.title : r.id;
    let dependsOn: string[] = [];
    if (r.dependsOn !== undefined) {
      if (!Array.isArray(r.dependsOn) || r.dependsOn.some((d) => typeof d !== "string")) {
        return { ok: false, reason: `subtasks[${i}] ("${r.id}").dependsOn must be an array of strings` };
      }
      dependsOn = r.dependsOn as string[];
    }
    if (dependsOn.includes(r.id)) {
      return { ok: false, reason: `subtask "${r.id}" cannot depend on itself` };
    }
    subtasks.push({ id: r.id, title, prompt: r.prompt, dependsOn });
  }

  for (const s of subtasks) {
    for (const dep of s.dependsOn) {
      if (!seenIds.has(dep)) {
        return { ok: false, reason: `subtask "${s.id}" depends on undeclared subtask "${dep}"` };
      }
    }
  }

  // DFS cycle detection over the dependsOn edges.
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(subtasks.map((s) => [s.id, WHITE]));
  const stack: string[] = [];
  const visit = (id: string): string | null => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of byId.get(id)!.dependsOn) {
      const c = color.get(dep);
      if (c === GRAY) return [...stack, dep].join(" -> ");
      if (c === WHITE) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };
  for (const s of subtasks) {
    if (color.get(s.id) === WHITE) {
      const cycle = visit(s.id);
      if (cycle) return { ok: false, reason: `dependency cycle: ${cycle}` };
    }
  }

  return { ok: true, plan: { subtasks } };
}

const TICKET_HEADER = "## Original ticket";

function ticketBlock(task: Task): string {
  return `${TICKET_HEADER}\n\n${task.prompt}`;
}

/** Planner stage — not verdict-bearing. Success is just "the run finished". */
function planningPrompt(task: Task): string {
  const feedback = task.pipelineFeedback
    ? `\n\nThe previous plan was sent back for revision. Reviewer feedback to address:\n\n${task.pipelineFeedback}`
    : "";
  return (
    `You are the Planner in an automated pipeline: Planner → Critic → Pre-Builder → Builder → Code Reviewer → Tester. ` +
    `Investigate this codebase enough to design a concrete implementation plan for the ` +
    `ticket below, then write that plan to ${PIPELINE_PLAN_FILE} at the repository root ` +
    `(overwrite it if it already exists). The plan should name the files/areas that need ` +
    `to change and the approach — a Critic agent will review it next, and a Builder agent ` +
    `will implement it from the file alone, so it needs to be concrete enough to act on ` +
    `without further clarification from you. Do not write or change any other files, and ` +
    `do not run any commands beyond what's needed to investigate the codebase. When ` +
    `${PIPELINE_PLAN_FILE} is written, stop — do not ask a question, do not wait for ` +
    `confirmation.${feedback}\n\n${ticketBlock(task)}`
  );
}

/** Critic stage — must end with PIPELINE_VERDICT: approve|revise <reason>. */
function planReviewPrompt(task: Task): string {
  return (
    `You are the Critic in an automated pipeline: Planner → Critic → Pre-Builder → Builder → Code Reviewer → Tester. ` +
    `Read ${PIPELINE_PLAN_FILE} at the repository root (written by the Planner) and check ` +
    `it against the actual codebase — does it name real files/patterns, is the approach ` +
    `sound, does it fully address the ticket below, is anything it proposes likely to break ` +
    `something else? Do not write or change any files yourself; this is a review, not an ` +
    `implementation pass.\n\n` +
    `End your final message with exactly one line, in exactly this form:\n` +
    `${PIPELINE_VERDICT_PREFIX} approve\n` +
    `— if the plan is ready to build — or:\n` +
    `${PIPELINE_VERDICT_PREFIX} revise <one-paragraph reason>\n` +
    `— if it needs another pass, explaining concretely what's wrong or missing so the ` +
    `Planner can fix it. Nothing else you write is parsed — only this line decides what ` +
    `happens next, so make sure it's the literal last line of your message.\n\n${ticketBlock(task)}`
  );
}

/** Pre-Builder stage — not verdict-bearing (validity of the file it writes
 *  IS the gate, checked by orchestrator.ts's advancePipelineStage). Reads
 *  the approved PLAN.md and decomposes it into independently-buildable
 *  subtasks, declaring which depend on which — build-scheduler.ts's
 *  tickBuild then runs each subtask as a REAL concurrent child task
 *  (own worktree/branch/agent session), starting the independent ones in
 *  parallel and holding dependents until their deps are merged back. */
function preBuilderPrompt(task: Task): string {
  return (
    `You are the Pre-Builder in an automated pipeline: Planner → Critic → Pre-Builder → ` +
    `Builder → Code Reviewer → Tester. Read ${PIPELINE_PLAN_FILE} at the repository root ` +
    `(already reviewed and approved) and decompose it into independently-buildable ` +
    `subtasks — units of work that can be implemented in isolation, in their OWN git ` +
    `worktree, without needing to see another subtask's in-progress changes. Declare a ` +
    `dependency only when one subtask's code genuinely can't be written without another's ` +
    `already existing (e.g. a route that imports a middleware module another subtask adds) ` +
    `— everything else should be independent, since independent subtasks run in parallel. ` +
    `If the plan doesn't decompose naturally, that's fine: emit exactly one subtask ` +
    `covering the whole implementation.\n\n` +
    `Write your decomposition to ${PIPELINE_BUILD_PLAN_FILE} at the repository root, as ` +
    `JSON in exactly this shape:\n` +
    `{\n` +
    `  "subtasks": [\n` +
    `    { "id": "short-unique-id", "title": "short title", "prompt": "concrete, ` +
    `self-contained instructions for exactly this slice — the agent that implements it ` +
    `will see ONLY this text plus ${PIPELINE_PLAN_FILE} itself, not your reasoning here", ` +
    `"dependsOn": [] },\n` +
    `    { "id": "another-id", "title": "...", "prompt": "...", "dependsOn": ["short-unique-id"] }\n` +
    `  ]\n` +
    `}\n\n` +
    `Every "id" must be unique within the file; every "dependsOn" entry must name another ` +
    `declared "id" (never itself); the resulting dependency graph must be acyclic. Each ` +
    `subtask's "prompt" must be concrete enough to implement without further clarification ` +
    `— the agent implementing it works from that text and ${PIPELINE_PLAN_FILE} alone.\n\n` +
    `Then commit BOTH ${PIPELINE_PLAN_FILE} and ${PIPELINE_BUILD_PLAN_FILE} to this branch ` +
    `(they may already be committed from an earlier pass — commit again only if you changed ` +
    `something). Do NOT push, do not open a pull request — this stays local. The commit is ` +
    `required: each subtask's own agent will work in a separate git worktree branched off ` +
    `this branch, and can only see files that have actually been committed here, not ones ` +
    `left as uncommitted working-tree edits.\n\n` +
    `When done, stop — do not ask a question, do not wait for confirmation.\n\n${ticketBlock(task)}`
  );
}

/** Builder stage — not verdict-bearing. Success is just "the run finished". */
function buildingPrompt(task: Task): string {
  const feedback = task.pipelineFeedback
    ? `\n\nThe previous implementation was sent back by the Tester. What it found:\n\n${task.pipelineFeedback}`
    : "";
  return (
    `You are the Builder in an automated pipeline: Planner → Critic → Pre-Builder → Builder → Code Reviewer → Tester. ` +
    `${PIPELINE_PLAN_FILE} at the repository root (already reviewed and approved) describes ` +
    `what to build. Implement it. Follow the plan; if you need to deviate in a small way to ` +
    `make it actually work, that's fine, but stay within its intent — don't redesign the ` +
    `approach. A Tester agent will run linters/typecheck/tests against your changes next. ` +
    `When you're done, stop — do not ask a question, do not wait for confirmation, do not ` +
    `commit anything (a later stage handles that).${feedback}\n\n${ticketBlock(task)}`
  );
}

/**
 * The actual prompt a CHILD task's agent runs (build-scheduler.ts's
 * tickBuild sets this as the child's `task.prompt` verbatim at creation
 * time — a child has `pipelineStage: null`, so `startTask` uses
 * `task.prompt` directly rather than routing through `stagePrompt`). Pure,
 * same convention as every other prompt builder here. Folds in the
 * subtask's own instructions, points the child at PLAN.md for full context
 * (a terse subtask prompt alone may not carry the plan's rationale), and —
 * critically — an explicit local-commit instruction: without it, a child
 * that finishes without committing leaves nothing for the merge-back step
 * (worktree.mergeBranch) to merge.
 */
export function childBuildPrompt(parentTask: Task, subtask: BuildSubtask): string {
  const ccType = branchCommitType(parentTask.branch, parentTask.taskType);
  return (
    `You are one of several agents implementing independent slices of a larger plan in ` +
    `parallel, each in your own git worktree branched off the same commit. Your slice: ` +
    `"${subtask.title}".\n\n` +
    `${PIPELINE_PLAN_FILE} at the repository root has the full plan for context — read it ` +
    `if you need to understand how your slice fits in, but implement ONLY what's described ` +
    `below; the other slices are being built separately and will be merged in alongside ` +
    `yours.\n\n${subtask.prompt}\n\n` +
    `When you're done, commit your changes locally with a clear commit message (prefix the ` +
    `subject with "${ccType}:", e.g. "${ccType}: ..."). This step is required — your work ` +
    `is only picked up by the rest of the pipeline once it's committed. Do NOT push, do not ` +
    `open a pull request, do not run any git command that touches a remote — this commit ` +
    `stays local and gets merged into the parent branch by the pipeline itself. Do not ` +
    `include any AI attribution in the commit message. Then stop — do not ask a question, ` +
    `do not wait for confirmation.\n\n${TICKET_HEADER}\n\n${parentTask.prompt}`
  );
}

/**
 * Code Reviewer stage — must end with PIPELINE_VERDICT: approve|revise
 * <reason>, same sentinel shape plan-review uses (a Critic-style gate,
 * just reviewing the actual merged diff instead of the plan). Reached only
 * after every building sub-task has merged into this branch, so `git diff`
 * against the branch's own base captures the FULL implementation —
 * whether that came from one plain building turn (a revision bounce) or
 * several parallel child tasks merged in (a fresh pre-builder-driven
 * build) is invisible from here, and doesn't need to be: this stage
 * reviews the resulting code, not how it was produced.
 */
function codeReviewPrompt(task: Task): string {
  const base = task.baseRef ?? "the branch's base commit";
  return (
    `You are the Code Reviewer in an automated pipeline: Planner → Critic → Pre-Builder → ` +
    `Builder → Code Reviewer → Tester. Review the actual code changes on this branch — run ` +
    `\`git diff ${base}\` (or \`git log -p ${base}..HEAD\`) to see everything that's landed ` +
    `since this branch started. Check correctness, whether it actually implements ` +
    `${PIPELINE_PLAN_FILE} (at the repository root) as intended, code quality, and whether ` +
    `anything looks likely to break something else. Do not write or change any files ` +
    `yourself, and do not run the test suite or linters — a Tester agent does that next; ` +
    `this is a read of the code itself, not its behavior.\n\n` +
    `End your final message with exactly one line, in exactly this form:\n` +
    `${PIPELINE_VERDICT_PREFIX} approve\n` +
    `— if the implementation is ready to test — or:\n` +
    `${PIPELINE_VERDICT_PREFIX} revise <one-paragraph reason>\n` +
    `— if something needs to change first, explaining concretely what and why so the ` +
    `Builder can fix it. Nothing else you write is parsed — only this line decides what ` +
    `happens next, so make sure it's the literal last line of your message.\n\n${ticketBlock(task)}`
  );
}

/** Tester stage — must end with PIPELINE_VERDICT: pass|fail <reason>. Local
 *  commit only, reusing commitPushPrompt's commit-type derivation — every
 *  push/PR-drafting instruction is deliberately absent; this must never
 *  leave the local branch. */
function testingPrompt(task: Task): string {
  const ccType = branchCommitType(task.branch, task.taskType);
  return (
    `You are the Tester in an automated pipeline: Planner → Critic → Pre-Builder → Builder → Code Reviewer → Tester. ` +
    `Run this project's linters, type-checker, and test suite. If something fails and the ` +
    `fix is small and obviously correct, fix it directly; for anything larger, leave it and ` +
    `report it in your verdict instead of guessing at a bigger change.\n\n` +
    `If you changed anything, commit it locally with a clear commit message (prefix the ` +
    `subject with "${ccType}:", e.g. "${ccType}: ..."). Do NOT push, do not open a pull ` +
    `request, do not run any git command that touches a remote — this commit stays local, ` +
    `a human reviews and pushes it later. Do not include any AI attribution in the commit ` +
    `message.\n\n` +
    `End your final message with exactly one line, in exactly this form:\n` +
    `${PIPELINE_VERDICT_PREFIX} pass\n` +
    `— if everything is clean — or:\n` +
    `${PIPELINE_VERDICT_PREFIX} fail <one-paragraph reason>\n` +
    `— if something is still broken, explaining concretely what so the Builder can fix it. ` +
    `Nothing else you write is parsed — only this line decides what happens next, so make ` +
    `sure it's the literal last line of your message.\n\n${ticketBlock(task)}`
  );
}

/** Dispatch to the right stage's prompt builder. The returned string
 *  *replaces* the raw ticket prompt as the turn's text in startTask —
 *  nothing is lost, since every builder above folds task.prompt back in
 *  via ticketBlock(). */
export function stagePrompt(
  task: Task,
  stage: NonNullable<Task["pipelineStage"]>,
): string {
  switch (stage) {
    case "planning": return planningPrompt(task);
    case "plan-review": return planReviewPrompt(task);
    case "pre-builder": return preBuilderPrompt(task);
    case "building": return buildingPrompt(task);
    case "code-review": return codeReviewPrompt(task);
    case "testing": return testingPrompt(task);
  }
}
