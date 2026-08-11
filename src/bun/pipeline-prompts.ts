import { branchCommitType, type Task } from "../shared/types.ts";

/**
 * Fixed filename the Specify stage writes its spec to, at the worktree root.
 * Machine-checkable: must contain at least one `AC-N:` acceptance criterion.
 */
export const PIPELINE_SPEC_FILE = "SPEC.md";

/**
 * Fixed filename the Decompose stage writes its task breakdown to, at the
 * worktree root. Renamed from BUILD_PLAN.json to signal the SDD change —
 * agents see the new name in every prompt.
 */
export const PIPELINE_TASKS_FILE = "TASKS.json";

/**
 * Back-compat alias for PIPELINE_TASKS_FILE — used by any call site that
 * hasn't been updated yet.
 * @deprecated use PIPELINE_TASKS_FILE
 */
export const PIPELINE_BUILD_PLAN_FILE = PIPELINE_TASKS_FILE;

/**
 * Fixed filename the Planner writes its plan to, at the worktree root.
 */
export const PIPELINE_PLAN_FILE = "PLAN.md";

/**
 * Optional repo-level constitution file that every Specify prompt looks for.
 * Written once (by the standalone constitution flow) and committed to the
 * default branch so all subsequent pipeline tasks' worktrees can see it.
 */
export const PIPELINE_CONSTITUTION_FILE = ".specify/memory/constitution.md";

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

// ─── Acceptance-criteria parsing ─────────────────────────────────────────────

/**
 * Extract every `AC-N:` acceptance-criterion id from a SPEC.md body.
 * Pure — no IO. Returns a sorted, deduplicated list of id strings
 * (e.g. `["AC-1", "AC-2", "AC-3"]`). An empty list means the spec has
 * no parseable acceptance criteria.
 *
 * The format is deliberately rigid: `AC-<digits>:` at the start of a
 * line (after optional leading whitespace), mirroring how
 * `PIPELINE_VERDICT:` works — a fixed regex-parseable sentinel that
 * these agents reliably follow when given an example.
 */
export function parseSpecAcceptanceCriteria(raw: string): string[] {
  const pattern = /^\s*(AC-\d+):/gm;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    seen.add(match[1]!);
  }
  return Array.from(seen).sort((a, b) => {
    const na = parseInt(a.slice(3), 10);
    const nb = parseInt(b.slice(3), 10);
    return na - nb;
  });
}

/**
 * Cross-check a task plan's `acceptanceCriteria` arrays against the spec's
 * declared AC ids. Pure — no IO — so it's directly unit-testable.
 *
 * Checks two failure modes:
 *  1. A spec AC id that no subtask claims (`gap` — likely forgotten).
 *  2. A subtask `acceptanceCriteria` entry that doesn't appear in SPEC.md
 *     (`phantom` — a typo or stale reference).
 *
 * Subtasks with `acceptanceCriteria: []` are allowed — some plumbing
 * subtasks have no user-visible AC to own.
 */
export function analyzeCoverage(
  specAcIds: string[],
  plan: BuildPlan,
): { ok: true } | { ok: false; reason: string } {
  const specSet = new Set(specAcIds);
  const claimed = new Set<string>();
  const phantoms: string[] = [];

  for (const subtask of plan.subtasks) {
    for (const acId of subtask.acceptanceCriteria) {
      if (!specSet.has(acId)) {
        phantoms.push(`"${acId}" (subtask "${subtask.id}")`);
      } else {
        claimed.add(acId);
      }
    }
  }

  const gaps = specAcIds.filter((id) => !claimed.has(id));
  const parts: string[] = [];
  if (gaps.length > 0) parts.push(`${gaps.join(", ")} ${gaps.length === 1 ? "has" : "have"} no owning subtask`);
  if (phantoms.length > 0) parts.push(`${phantoms.join(", ")} ${phantoms.length === 1 ? "does" : "do"} not exist in ${PIPELINE_SPEC_FILE}`);

  if (parts.length === 0) return { ok: true };
  return { ok: false, reason: parts.join("; ") };
}

// ─── Build plan ──────────────────────────────────────────────────────────────

/** One independently-buildable unit of work declared in TASKS.json. */
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
  /** Which `AC-N` ids from SPEC.md this subtask is responsible for satisfying.
   *  Empty array is allowed for purely mechanical/plumbing subtasks with no
   *  user-visible acceptance criterion. Shape-validated by parseBuildPlan;
   *  cross-checked against SPEC.md's actual AC list by analyzeCoverage. */
  acceptanceCriteria: string[];
}

export interface BuildPlan {
  subtasks: BuildSubtask[];
}

/**
 * Parse and validate a decompose stage's TASKS.json. Pure — no DB/IO, the
 * caller reads the file — so it's directly unit-testable, same convention
 * as {@link parsePipelineVerdict}. Validates: valid JSON, an object with a
 * non-empty `subtasks` array, every subtask has a non-empty `id`/`prompt`,
 * ids are unique, every `dependsOn` entry resolves to another declared id
 * (not itself), and the resulting dependency graph is acyclic (DFS-based
 * cycle check). `dependsOn` may be omitted on a subtask (treated as `[]`)
 * but if present must be an array of strings. `acceptanceCriteria` may be
 * omitted (treated as `[]`) but if present must be an array of strings.
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
    let acceptanceCriteria: string[] = [];
    if (r.acceptanceCriteria !== undefined) {
      if (!Array.isArray(r.acceptanceCriteria) || r.acceptanceCriteria.some((a) => typeof a !== "string")) {
        return { ok: false, reason: `subtasks[${i}] ("${r.id}").acceptanceCriteria must be an array of strings` };
      }
      acceptanceCriteria = r.acceptanceCriteria as string[];
    }
    subtasks.push({ id: r.id, title, prompt: r.prompt, dependsOn, acceptanceCriteria });
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

// ─── Prompt builders ──────────────────────────────────────────────────────────

const TICKET_HEADER = "## Original ticket";

function ticketBlock(task: Task): string {
  return `${TICKET_HEADER}\n\n${task.prompt}`;
}

/** Specify stage — writes SPEC.md. Not verdict-bearing; gate is file-existence. */
function specifyPrompt(task: Task, constitutionRaw: string | null): string {
  const constitution = constitutionRaw
    ? `\n\nThe following project constitution (from ${PIPELINE_CONSTITUTION_FILE}) ` +
      `describes project principles and constraints that apply to all work here. ` +
      `Respect every principle it states when writing the spec:\n\n${constitutionRaw}`
    : `\n\n(No project constitution found at ${PIPELINE_CONSTITUTION_FILE} — proceed without one.)`;
  return (
    `You are the Spec Author in an automated spec-driven pipeline: ` +
    `Specify → Clarify → Plan → Plan Review → Decompose → Analyze → Build → Code Review → Test. ` +
    `Your job is to write a clear, testable specification for the ticket below — NOT to design ` +
    `the implementation. Do NOT name files, frameworks, or approach; those are the Planner's job.\n\n` +
    `Write ${PIPELINE_SPEC_FILE} at the repository root with exactly this structure:\n` +
    `## Summary\n<one paragraph>\n\n` +
    `## User stories\n<bulleted list>\n\n` +
    `## Acceptance criteria\n` +
    `AC-1: <first criterion, testable, behavioural>\n` +
    `AC-2: <second criterion>\n` +
    `<…more AC-N: lines as needed>\n\n` +
    `## Non-goals\n<what is explicitly out of scope>\n\n` +
    `## Edge cases considered\n<notable edge/failure cases the implementation must handle>\n\n` +
    `Rules for acceptance criteria:\n` +
    `- Each must be independently testable — a pass/fail check, not a quality hope.\n` +
    `- Use the exact format "AC-N: <text>" (e.g. "AC-1: The settings toggle persists across reloads.").\n` +
    `- Number them sequentially from 1 with no gaps.\n` +
    `- Do NOT mention file names, function names, or implementation details.\n\n` +
    `When ${PIPELINE_SPEC_FILE} is written, stop — do not ask a question, do not wait for ` +
    `confirmation.${constitution}\n\n${ticketBlock(task)}`
  );
}

/** Clarify stage — resolves ambiguity in SPEC.md before design begins.
 *  Not verdict-bearing; gate is SPEC.md still present. For claude-code
 *  tasks this stage may pause on `ask_user`; for codex/gemini it
 *  self-resolves by picking the lowest-risk interpretation. */
function clarifyPrompt(task: Task): string {
  return (
    `You are the Clarifier in an automated spec-driven pipeline: ` +
    `Specify → Clarify → Plan → Plan Review → Decompose → Analyze → Build → Code Review → Test. ` +
    `Read ${PIPELINE_SPEC_FILE} at the repository root (written by the Specify stage) and scan ` +
    `it against this ambiguity taxonomy:\n` +
    `1. Functional scope — is it clear what features are IN vs OUT?\n` +
    `2. Data shape — are inputs/outputs/state clearly defined?\n` +
    `3. UX flow — are the interaction steps clear?\n` +
    `4. Non-functional (perf/security/a11y) — any implicit requirements?\n` +
    `5. Integration behaviour — how does this interact with existing features?\n` +
    `6. Edge/failure handling — are error cases specified?\n` +
    `7. Terminology — are any domain terms ambiguous?\n\n` +
    `If you find up to 5 material ambiguities, use the \`ask_user\` tool to ask the human ` +
    `(one question at a time, or grouped if closely related). Then append a ` +
    `\`## Clarifications\` section to ${PIPELINE_SPEC_FILE} recording each Q and the answer, ` +
    `and fold the answer into the relevant AC or requirement inline.\n\n` +
    `If no material ambiguities exist, or if you cannot use \`ask_user\` (e.g. you are a ` +
    `codex/gemini agent), instead append an \`## Assumptions\` section to ${PIPELINE_SPEC_FILE} ` +
    `recording each ambiguity and how you resolved it (always by choosing the lowest-risk ` +
    `conventional interpretation).\n\n` +
    `Do NOT rewrite or remove any existing content from ${PIPELINE_SPEC_FILE} — only append. ` +
    `Do not write or change any other files. When done, stop — do not ask a question beyond ` +
    `the \`ask_user\` calls above, do not wait for confirmation.\n\n${ticketBlock(task)}`
  );
}

/** Planner stage — reads SPEC.md (authoritative for *what*), writes PLAN.md
 *  (authoritative for *how*). Not verdict-bearing. */
function planningPrompt(task: Task): string {
  const feedback = task.pipelineFeedback
    ? `\n\nThe previous plan was sent back for revision. Reviewer feedback to address:\n\n${task.pipelineFeedback}`
    : "";
  return (
    `You are the Planner in an automated spec-driven pipeline: ` +
    `Specify → Clarify → Plan → Plan Review → Decompose → Analyze → Build → Code Review → Test. ` +
    `${PIPELINE_SPEC_FILE} at the repository root (already written and clarified) defines WHAT ` +
    `to build — read it first. Your job is to design HOW to build it: name the files/areas ` +
    `that need to change, the approach, and reference each acceptance criterion by its ` +
    `AC-N id (e.g. "AC-1 is satisfied by…") rather than repeating its text. ` +
    `Do NOT restate the requirements — ${PIPELINE_SPEC_FILE} owns those. ` +
    `A Critic agent will review your plan next, and a Builder will implement it from the file ` +
    `alone, so it needs to be concrete enough to act on without further clarification from you.\n\n` +
    `Write ${PIPELINE_PLAN_FILE} at the repository root (overwrite it if it already exists). ` +
    `Do not write or change any other files, and do not run any commands beyond what's needed ` +
    `to investigate the codebase. When ${PIPELINE_PLAN_FILE} is written, stop — do not ask a ` +
    `question, do not wait for confirmation.${feedback}\n\n${ticketBlock(task)}`
  );
}

/** Critic stage — must end with PIPELINE_VERDICT: approve|revise <reason>.
 *  Review scope includes AC coverage and constitution (if present). */
function planReviewPrompt(task: Task): string {
  return (
    `You are the Critic in an automated spec-driven pipeline: ` +
    `Specify → Clarify → Plan → Plan Review → Decompose → Analyze → Build → Code Review → Test. ` +
    `Read ${PIPELINE_SPEC_FILE} (the acceptance criteria are the source of truth for "done") ` +
    `and ${PIPELINE_PLAN_FILE} (what the Planner proposes) at the repository root. ` +
    `Check the plan against the actual codebase and ask:\n` +
    `- Does ${PIPELINE_PLAN_FILE}'s approach address EVERY AC-N in ${PIPELINE_SPEC_FILE} at a design level?\n` +
    `- Does it name real files/patterns, is the approach sound?\n` +
    `- Is anything it proposes likely to break something else?\n` +
    `- If ${PIPELINE_CONSTITUTION_FILE} exists, does it violate any project principles?\n\n` +
    `Do not write or change any files yourself; this is a review, not an implementation pass.\n\n` +
    `End your final message with exactly one line, in exactly this form:\n` +
    `${PIPELINE_VERDICT_PREFIX} approve\n` +
    `— if the plan is ready to build — or:\n` +
    `${PIPELINE_VERDICT_PREFIX} revise <one-paragraph reason>\n` +
    `— if it needs another pass, explaining concretely what's wrong or missing so the ` +
    `Planner can fix it. Nothing else you write is parsed — only this line decides what ` +
    `happens next, so make sure it's the literal last line of your message.\n\n${ticketBlock(task)}`
  );
}

/** Decompose stage (renamed from pre-builder) — reads PLAN.md, writes TASKS.json.
 *  Not verdict-bearing; validity of the file IS the gate.
 *  Every subtask now carries an `acceptanceCriteria` array. */
function decomposePrompt(task: Task): string {
  return (
    `You are the Decomposer in an automated spec-driven pipeline: ` +
    `Specify → Clarify → Plan → Plan Review → Decompose → Analyze → Build → Code Review → Test. ` +
    `Read ${PIPELINE_PLAN_FILE} at the repository root (already reviewed and approved) and ` +
    `decompose it into independently-buildable subtasks — units of work that can be ` +
    `implemented in isolation, in their OWN git worktree, without needing to see another ` +
    `subtask's in-progress changes. Declare a dependency only when one subtask's code ` +
    `genuinely can't be written without another's already existing — everything else should ` +
    `be independent, since independent subtasks run in parallel. ` +
    `If the plan doesn't decompose naturally, that's fine: emit exactly one subtask ` +
    `covering the whole implementation.\n\n` +
    `Also read ${PIPELINE_SPEC_FILE} (at the repository root) to understand the acceptance ` +
    `criteria (AC-N: lines). For each subtask, declare which AC-N ids it is responsible for ` +
    `satisfying in its \`acceptanceCriteria\` array. A subtask with no user-visible AC ` +
    `(e.g. a pure plumbing change) may have \`"acceptanceCriteria": []\`.\n\n` +
    `Write your decomposition to ${PIPELINE_TASKS_FILE} at the repository root, as ` +
    `JSON in exactly this shape:\n` +
    `{\n` +
    `  "subtasks": [\n` +
    `    { "id": "short-unique-id", "title": "short title", "prompt": "concrete, ` +
    `self-contained instructions for exactly this slice — the agent that implements it ` +
    `will see ONLY this text plus ${PIPELINE_PLAN_FILE} itself, not your reasoning here", ` +
    `"dependsOn": [], "acceptanceCriteria": ["AC-1", "AC-2"] },\n` +
    `    { "id": "another-id", "title": "...", "prompt": "...", "dependsOn": ["short-unique-id"], "acceptanceCriteria": [] }\n` +
    `  ]\n` +
    `}\n\n` +
    `Every "id" must be unique within the file; every "dependsOn" entry must name another ` +
    `declared "id" (never itself); the resulting dependency graph must be acyclic. Each ` +
    `subtask's "prompt" must be concrete enough to implement without further clarification ` +
    `— the agent implementing it works from that text and ${PIPELINE_PLAN_FILE} alone.\n\n` +
    `Then commit ${PIPELINE_SPEC_FILE}, ${PIPELINE_PLAN_FILE}, and ${PIPELINE_TASKS_FILE} ` +
    `to this branch (they may already be committed from an earlier pass — commit again only ` +
    `if you changed something). Do NOT push, do not open a pull request — this stays local. ` +
    `The commit is required: each subtask's own agent will work in a separate git worktree ` +
    `branched off this branch, and can only see files that have actually been committed ` +
    `here, not ones left as uncommitted working-tree edits.\n\n` +
    `When done, stop — do not ask a question, do not wait for confirmation.\n\n${ticketBlock(task)}`
  );
}

/** Builder stage — not verdict-bearing. Success is just "the run finished". */
function buildingPrompt(task: Task): string {
  const feedback = task.pipelineFeedback
    ? `\n\nThe previous implementation was sent back by the Tester. What it found:\n\n${task.pipelineFeedback}`
    : "";
  return (
    `You are the Builder in an automated spec-driven pipeline: ` +
    `Specify → Clarify → Plan → Plan Review → Decompose → Analyze → Build → Code Review → Test. ` +
    `${PIPELINE_PLAN_FILE} at the repository root (already reviewed and approved) describes ` +
    `what to build. Implement it. The acceptance criteria in ${PIPELINE_SPEC_FILE} are the ` +
    `testable definition of done — implement towards those. Follow the plan; if you need to ` +
    `deviate in a small way to make it actually work, that's fine, but stay within its ` +
    `intent — don't redesign the approach. A Tester agent will run linters/typecheck/tests ` +
    `against your changes next. ` +
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
 * subtask's own instructions, points the child at PLAN.md for full context,
 * AND inlines the subtask's assigned acceptance-criteria text from SPEC.md
 * so each child agent has a concrete, testable target rather than just a
 * prose-only directive.
 */
export function childBuildPrompt(
  parentTask: Task,
  subtask: BuildSubtask,
  specAcMap: Record<string, string> = {},
): string {
  const ccType = branchCommitType(parentTask.branch, parentTask.taskType);
  const acLines = subtask.acceptanceCriteria
    .map((id) => specAcMap[id] ? `  ${id}: ${specAcMap[id]}` : `  ${id}`)
    .join("\n");
  const acBlock = subtask.acceptanceCriteria.length > 0
    ? `\n\nYour slice must satisfy these acceptance criteria from ${PIPELINE_SPEC_FILE}:\n${acLines}`
    : "";
  return (
    `You are one of several agents implementing independent slices of a larger plan in ` +
    `parallel, each in your own git worktree branched off the same commit. Your slice: ` +
    `"${subtask.title}".\n\n` +
    `${PIPELINE_PLAN_FILE} at the repository root has the full plan for context — read it ` +
    `if you need to understand how your slice fits in, but implement ONLY what's described ` +
    `below; the other slices are being built separately and will be merged in alongside ` +
    `yours.${acBlock}\n\n${subtask.prompt}\n\n` +
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
 * <reason>. Review scope grows: check off each AC-N the diff's subtasks
 * claimed, not just "does this match PLAN.md."
 */
function codeReviewPrompt(task: Task): string {
  const base = task.baseRef ?? "the branch's base commit";
  return (
    `You are the Code Reviewer in an automated spec-driven pipeline: ` +
    `Specify → Clarify → Plan → Plan Review → Decompose → Analyze → Build → Code Review → Test. ` +
    `Review the actual code changes on this branch — run ` +
    `\`git diff ${base}\` (or \`git log -p ${base}..HEAD\`) to see everything that's landed ` +
    `since this branch started. Read ${PIPELINE_SPEC_FILE} for the acceptance criteria, and ` +
    `check: (1) does the diff correctly implement ${PIPELINE_PLAN_FILE}? (2) does it satisfy ` +
    `every AC-N in ${PIPELINE_SPEC_FILE} at a code level? (3) code quality — correctness, ` +
    `no obvious regressions. Do not write or change any files yourself, and do not run the ` +
    `test suite or linters — a Tester agent does that next.\n\n` +
    `End your final message with exactly one line, in exactly this form:\n` +
    `${PIPELINE_VERDICT_PREFIX} approve\n` +
    `— if the implementation is ready to test — or:\n` +
    `${PIPELINE_VERDICT_PREFIX} revise <one-paragraph reason>\n` +
    `— if something needs to change first, explaining concretely what and why so the ` +
    `Builder can fix it. Nothing else you write is parsed — only this line decides what ` +
    `happens next, so make sure it's the literal last line of your message.\n\n${ticketBlock(task)}`
  );
}

/** Tester stage — must end with PIPELINE_VERDICT: pass|fail <reason>. Hands
 *  the Tester the full AC checklist so it verifies each criterion is actually
 *  exercised, not just that lint/typecheck pass. */
function testingPrompt(task: Task): string {
  const ccType = branchCommitType(task.branch, task.taskType);
  return (
    `You are the Tester in an automated spec-driven pipeline: ` +
    `Specify → Clarify → Plan → Plan Review → Decompose → Analyze → Build → Code Review → Test. ` +
    `Run this project's linters, type-checker, and test suite. Also read ${PIPELINE_SPEC_FILE} ` +
    `and verify that every AC-N in its acceptance-criteria list is actually exercised — by an ` +
    `assertion in the test suite, or by a manual check you perform yourself. If something ` +
    `fails and the fix is small and obviously correct, fix it directly; for anything larger, ` +
    `leave it and report it in your verdict instead of guessing at a bigger change.\n\n` +
    `If you changed anything, commit it locally with a clear commit message (prefix the ` +
    `subject with "${ccType}:", e.g. "${ccType}: ..."). Do NOT push, do not open a pull ` +
    `request, do not run any git command that touches a remote — this commit stays local, ` +
    `a human reviews and pushes it later. Do not include any AI attribution in the commit ` +
    `message.\n\n` +
    `End your final message with exactly one line, in exactly this form:\n` +
    `${PIPELINE_VERDICT_PREFIX} pass\n` +
    `— if everything is clean and every AC is verified — or:\n` +
    `${PIPELINE_VERDICT_PREFIX} fail <one-paragraph reason>\n` +
    `— if something is still broken or an AC is unverified, explaining concretely what so ` +
    `the Builder can fix it. Nothing else you write is parsed — only this line decides what ` +
    `happens next, so make sure it's the literal last line of your message.\n\n${ticketBlock(task)}`
  );
}

/** Dispatch to the right stage's prompt builder. The returned string
 *  *replaces* the raw ticket prompt as the turn's text in startTask —
 *  nothing is lost, since every builder above folds task.prompt back in
 *  via ticketBlock(). The `constitutionRaw` param is only used by `specify`
 *  (other stages ignore it). */
export function stagePrompt(
  task: Task,
  stage: NonNullable<Task["pipelineStage"]>,
  constitutionRaw?: string | null,
): string {
  switch (stage) {
    case "specify": return specifyPrompt(task, constitutionRaw ?? null);
    case "clarify": return clarifyPrompt(task);
    case "planning": return planningPrompt(task);
    case "plan-review": return planReviewPrompt(task);
    case "decompose": return decomposePrompt(task);
    case "analyze":
      // analyze is handled inline in advancePipelineStage (no agent turn) —
      // this branch is unreachable in production but must not be a compile
      // error in the switch.
      return "";
    case "building": return buildingPrompt(task);
    case "code-review": return codeReviewPrompt(task);
    case "testing": return testingPrompt(task);
  }
}
