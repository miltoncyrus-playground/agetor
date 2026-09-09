# Plan — Spec-Driven Development (SDD) rework of the automated pipeline

| Field | Value |
| --- | --- |
| Date | 2026-08-11 |
| Source | User request: "make the pipeline work in an SDD way" — planning only, this document is the deliverable |
| Scope decision | Replace the existing 6-stage pipeline in place (not a second opt-in flavor) |
| Fidelity decision | Follow the canonical Spec-Driven Development chain closely (GitHub `spec-kit`-style: constitution → specify → clarify → plan → tasks → analyze → implement) |
| Status | **Design only. No code, no migration, no prompt file has been written yet.** |

## 1. Objective & success criteria

Today's pipeline task (`Task.pipelineStage`) automates Planner → Critic → Pre-Builder → Builder → Code Reviewer → Tester. It already has real rigor (a plan-review gate, a code-review gate, a test gate, a shared revision-cap loop-breaker, parallel task decomposition with a merge DAG) — but it is **plan-driven, not spec-driven**: there is no artifact that states *what "done" means* independently of *how it gets built*, no acceptance criteria, no ambiguity-resolution pass, and no traceability from a requirement to the code that satisfies it or the test that proves it.

This plan inserts the missing spec layer without discarding any of the existing machinery (worktree isolation, tmux drivers, the merge DAG, pause/resume, the blocked-recovery banner, the revision-cap breaker) — those all stay exactly as they are today.

Success criteria for the *design* (this document): every current pipeline behavior has a stated successor; every new stage has a concrete prompt contract and a concrete machine-checkable gate (file-existence, schema-validity, or a deterministic cross-file check — never "vibes"); every schema/migration/UI change needed is enumerated; nothing is left as "TBD, figure it out during implementation" without being flagged explicitly as an open question.

Success criteria for the *eventual implementation* (out of scope for this pass, listed here so the plan is checkable later): `bun run typecheck` and `bun test` green, including new unit tests for every new pure parser and an end-to-end fake-driver walk of all 9 stages; a pipeline task run against a real repo produces a `SPEC.md` with numbered, testable acceptance criteria that `TASKS.json`, the Code Reviewer, and the Tester all reference by id.

## 2. Current state (as-built)

Confirmed by reading `src/shared/types.ts`, `src/bun/orchestrator.ts` (`advancePipelineStage`), `src/bun/pipeline-prompts.ts`, and `src/bun/build-scheduler.ts`:

- **6 stages**, one `ColumnId`/`pipelineStage` value each: `planning → plan-review → pre-builder → building → code-review → testing → ready`.
- `planning` (Planner) reads the raw ticket and writes **`PLAN.md`** — a single prose file that conflates *what* (interpreting the ticket) and *how* (files, approach) in one pass. Gate: file must exist.
- `plan-review` (Critic) reviews `PLAN.md` against the codebase. Verdict-bearing (`PIPELINE_VERDICT: approve|revise <reason>`, parsed by `parsePipelineVerdict`). Approve sets `planApproved=true`; revise bounces to `planning`, incrementing the **shared** `revisionCount` (cap `PIPELINE_REVISION_CAP = 4`, then → `blocked` reason `"revision-cap"`).
- `pre-builder` decomposes the approved `PLAN.md` into **`BUILD_PLAN.json`** (`{ subtasks: [{ id, title, prompt, dependsOn }] }`), validated by the pure, unit-tested `parseBuildPlan` (schema, unique ids, resolvable deps, acyclic). Not verdict-bearing — file validity IS the gate.
- `building` has two distinct entries: **fresh** (from `pre-builder` success — spawns a real child `Task` per subtask via `build-scheduler.ts`'s `tickBuild`, each in its own worktree/branch, merged back with `worktree.mergeBranch`, barrier-complete once every subtask is `childMergeStatus:"merged"`) and **bounce** (from `code-review`/`testing` failure — a plain single-agent fixup turn, no re-decomposition).
- `code-review` reviews the branch's full diff (`git diff <baseRef>`) against `PLAN.md`. Same verdict shape as `plan-review`; revise bounces to `building` (bounce mode), same shared `revisionCount`.
- `testing` runs lint/typecheck/tests, verdict `pass|fail`. Pass sets `implementationApproved=true` → `ready` (an explicit AND-gate with `planApproved`, both required). Fail bounces to `building`, same shared counter.
- The UI never grew per-stage kanban columns for this — `display-columns.ts` already collapses all `PIPELINE_STAGE_COLUMNS` into one `"in-progress"` display bucket; the specific stage shows only via the card's state text (`COLUMNS.find(...).label`) and dot color. **This means adding stages is cheap on the UI side** — no new kanban lanes, just new label/id entries.
- `blockReason` is a closed enum (`api-error | session-died | unknown-command | revision-cap | pipeline-failed`) with UI copy in `BLOCK_REASON_COPY` — generic enough that no new reason values are needed for this rework.
- Nothing today asks the human anything mid-pipeline. The 6 stages run "with no human click between them" by design (per the field doc-comment on `Task.pipelineStage`).

## 3. Target state — the SDD stage chain

Adopting the terminology of GitHub's `spec-kit` (the closest tried-and-true reference implementation of this methodology — Layer 1 of "search before building," not a from-scratch invention) and mapping it onto agetor's existing per-task pipeline architecture:

```
(one-off, per repo, NOT part of the per-task chain)
  Constitution  ──writes──▶  .specify/memory/constitution.md

(per pipeline task, fully automated except one bounded human touchpoint)
  Specify  ──▶  Clarify  ──▶  Plan  ──▶  Plan Review  ──▶  Tasks  ──▶  Analyze
                                              │                          │
                                     revise ──┘                 gap ─────┤
                                                                         ▼
                                                                     Building
                                                                    (unchanged DAG)
                                                                         │
                                                                    Code Review
                                                              revise ────┤
                                                                         ▼
                                                                     Testing
                                                              fail ──────┤
                                                                         ▼
                                                                       Ready
```

9 per-task stages (up from 6), plus one repo-level bootstrap flow that is **not** a `pipelineStage` value at all (see §3.6 for why).

### 3.1 `specify` (new) — writes `SPEC.md`

Replaces the requirements-interpreting half of today's `planning` stage. Reads the raw ticket (and the constitution file, if present in the worktree) and writes **`SPEC.md`**: feature summary, user stories, numbered functional requirements, a **fixed-format numbered acceptance-criteria list** (`AC-1: ...`, `AC-2: ...` — same "rigid, example-driven, regex-parseable" convention `PIPELINE_VERDICT:` already proves works reliably for these agents), explicit non-goals, and edge cases considered. Deliberately forbidden from naming files, frameworks, or implementation approach — that's `plan`'s job now. Not verdict-bearing; gate is file-existence, same pattern as today's `planning` gate.

### 3.2 `clarify` (new) — resolves ambiguity before a single line of design work happens

Reads `SPEC.md`, scans it against a fixed ambiguity taxonomy (functional scope, data shape, UX flow, non-functional/perf/security, integration behavior, edge-case/failure handling, terminology) — the same taxonomy `spec-kit`'s own `/clarify` uses. For **claude-code** tasks specifically: the prompt instructs the agent to use the `ask_user` MCP tool (already wired for every claude-code agent session per `.claude/CLAUDE.md`, already the documented way this codebase wants an agent to surface a clarifying question) for up to ~5 material ambiguities, then append a `## Clarifications` section to `SPEC.md` recording each Q/A and folding the answer into the relevant requirement/AC. For **codex/gemini** tasks (no equivalent interactive tool available today): self-resolve each ambiguity by picking the lowest-risk conventional interpretation and record it under `## Assumptions` instead — same file, same downstream contract, so nothing later needs agent-kind-specific branching. This is a real, documented capability gap between agent kinds, in the same spirit as the already-documented "gemini has no `thinking` stream" gap — not a blocker, just asymmetric.

This is the **one deliberate exception** to "the pipeline never waits on a human click": a claude-code Clarify stage can genuinely pause on `ask_user`. It should surface through the same `modalPending`/pending-interaction UI machinery the composer already gates on (§7, T4) — it must never look like a hang.

Not verdict-bearing; gate is `SPEC.md` still present, same pattern.

### 3.3 `planning` (kept, narrowed) — writes `PLAN.md`

Same stage id, deliberately narrower prompt: reads `SPEC.md` (authoritative for *what*) instead of the raw ticket, and is explicitly told not to restate requirements — reference `AC-n` ids instead of repeating their text. Everything else (file-existence gate, revision-feedback folding) unchanged.

### 3.4 `plan-review` (kept) — Critic

Same verdict shape and bounce target (`planning`). Review scope grows: does `PLAN.md`'s approach cover every `AC-n` in `SPEC.md` at a design level, does it violate anything in the constitution (if present), plus the existing "is this sound / will it break something" check.

### 3.5 `pre-builder` → renamed `decompose` — writes `TASKS.json`

Same DAG-decomposition mechanics as today's `pre-builder`/`BUILD_PLAN.json`/`parseBuildPlan`/`build-scheduler.ts` — **zero scheduler logic changes**. Two additions: (1) the JSON filename becomes **`TASKS.json`** (agent-facing rename only — cheap, since agents read prompts, not source; internal TS symbol names like `BuildPlan`/`tickBuild` are the implementer's call, not part of this design), and (2) every subtask gains an `acceptanceCriteria: string[]` field naming which `AC-n` id(s) it's responsible for (empty array allowed for a purely mechanical/plumbing subtask with no user-facing AC). `parseBuildPlan`'s schema validation extends to check this field's *shape* only (array of strings) — cross-checking that the ids actually exist in `SPEC.md` is deliberately **not** this stage's job; that's `analyze`'s, next.

Renamed from `pre-builder` (not just relabeled) specifically to avoid the id colliding, in every log line and status string, with the ubiquitous `tasks.` DB-module prefix already used everywhere in `orchestrator.ts` — a readability call, not a functional one.

### 3.6 `analyze` (new) — deterministic coverage check, **not an agent turn**

This is the one stage that should **not** spend an LLM turn at all. Per this project's own latent-vs-deterministic-space rule: "is every acceptance criterion claimed by at least one task, and does every task's claimed criterion actually exist" is a same-input-same-output structural comparison between two already-parsed files — a script, not a prompt.

Concretely: a pure `parseSpecAcceptanceCriteria(raw: string): string[]` extracts every `AC-n` id from `SPEC.md` (same "pure, unit-testable, no IO" convention as `parseBuildPlan`/`parsePipelineVerdict`), and a pure `analyzeCoverage(specAcIds, plan): { ok: true } | { ok: false; reason: string }` diffs it against every subtask's `acceptanceCriteria`. Runs **inline inside `advancePipelineStage`'s `decompose` case**, the moment `TASKS.json` is validated — exactly the same place today's `pre-builder` case already reads and validates `BUILD_PLAN.json` before deciding what's next. `analyze` still gets its own `pipelineStage`/`ColumnId` value purely so the UI can show "Analyzing…" for the (instant) duration and so a bounce from it is visible in the stage history — but no `startTask`/agent-run round-trip happens for it.

- **Coverage complete** → immediately advances to `building` fresh-entry (the exact `tickBuild` call `pre-builder` success makes today, just relocated one case later).
- **Gap found** (an AC with no owning subtask, or a subtask claiming an AC id that doesn't exist in `SPEC.md`) → bounces to `decompose` via the same `bounceOrBlock` helper every other revise/fail edge already uses, with `pipelineFeedback` set to the specific gap list (e.g. `"AC-3, AC-5 have no owning subtask; AC-9 referenced by subtask 'wire-config' does not exist in SPEC.md"`). Reuses the existing shared `revisionCount`/`PIPELINE_REVISION_CAP` breaker and the existing `"pipeline-failed"`/`"revision-cap"` block reasons — **no new `BlockReason` value needed.**

### 3.7 `building`, `code-review`, `testing` (kept, scope grows)

- `building`: unchanged mechanics. The child-task prompt (today's `childBuildPrompt`) additionally folds in each subtask's assigned `AC-n` id **and its literal text** (looked up from `SPEC.md`), not just a pointer to the file — a concrete, testable target per child agent instead of prose-only context.
- `code-review`: unchanged verdict shape and bounce target (`building`). Review scope grows: check off each `AC-n` the diff's subtasks claimed, not just "does this match `PLAN.md`."
- `testing`: unchanged verdict shape and bounce target (`building`). The Tester is now handed the AC checklist in scope for this branch and instructed to verify each is actually exercised (by an assertion, or a manual check it performs itself) before passing, not just "lint/typecheck/tests are green."

### 3.8 The constitution — deliberately **not** a `pipelineStage`

A committed project-principles file only helps if every future pipeline task's worktree can actually see it — and a pipeline task's worktree branches off the **source repo's HEAD**, not off some prior pipeline task's throwaway branch. Making "write the constitution" a per-task pipeline stage would mean it lives on a branch nobody's merged yet, invisible to the next task, which would then bootstrap it again. Two ways out are discussed in §11 (open question 2); the one this plan recommends: constitution generation is a **separate, explicitly user-triggered, one-off flow** — an ordinary `isolation:"none"` task run directly against the user's actual `workdir` checkout (not a worktree), so the agent's local commit lands exactly where Milton can review and push it like any other file. It writes `.specify/memory/constitution.md` — adopting `spec-kit`'s own on-disk convention verbatim, so a repo already using the real `specify` CLI interoperates for free, and a repo that isn't just gets a normal markdown file.

Every `specify` stage prompt checks for this file (present in its worktree once it's been committed to the branch it forked from) and folds it in if found; if absent, it proceeds without one and says so in `SPEC.md` rather than blocking — preserving the "never stalls waiting for infrastructure that doesn't exist yet" property the rest of the pipeline already has.

## 4. Removed / Changed / Added — inventory

**Removed:** effectively nothing at the capability level — this is an insertion (3 new stages) plus a scope-narrowing (2 existing stages split their old mixed responsibility), not a subtraction. The closest thing to a removal: today's single `planning` prompt that both interprets the ticket *and* designs the implementation is retired in favor of two narrower prompts (`specify` + the trimmed `planning`). `BUILD_PLAN.json` as a filename is retired in favor of `TASKS.json` (same shape, plus one field).

**Changed:**
- `pipelineStage` union: `pre-builder` renamed to `decompose`.
- `planning`'s prompt narrows scope (reads `SPEC.md`, not the raw ticket).
- `plan-review`'s review scope grows (AC coverage + constitution check).
- `decompose`'s output schema grows one field (`acceptanceCriteria: string[]` per subtask).
- `building`'s child prompt grows (AC text inline).
- `code-review` / `testing`'s review scope grows (AC checklist), verdict shape and bounce targets unchanged.
- `PIPELINE_REVISION_CAP`: recommend bumping `4 → 6` since one more edge (`analyze → decompose`) now shares the same counter (see §11.1).
- `COLUMNS` / `PIPELINE_STAGE_COLUMNS` (`shared/types.ts`): grow from 6 to 9 entries.
- `NewTaskForm`'s "Run as pipeline" checkbox copy/tooltip: should mention the spec-driven stages so the affordance's name matches what it now does.

**Added:**
- Stages: `specify`, `clarify`, `analyze` (3 new `pipelineStage`/`ColumnId` values).
- Files: `SPEC.md` (per pipeline-task worktree, spec-kit-style), `TASKS.json` (rename+extend of `BUILD_PLAN.json`), `.specify/memory/constitution.md` (per repo, optional).
- Pure functions: `parseSpecAcceptanceCriteria`, `analyzeCoverage` — same "no IO, directly unit-testable" convention as every existing pipeline parser.
- Prompts: `specifyPrompt`, `clarifyPrompt`, `constitutionPrompt`.
- A standalone constitution-generation flow: one new orchestrator function, one new route, one small UI trigger — independent of and non-blocking for the rest of this rework (§7, T5).
- One deliberate human-in-the-loop touchpoint (`ask_user` inside `clarify`, claude-code only) — the first of its kind in the automated pipeline; needs explicit UI visibility (reuse `modalPending`), not new plumbing.

## 5. Data model & migration

No new `Task` columns are needed — `planApproved`, `implementationApproved`, `revisionCount`, `pipelineFeedback`, `pausedAt`, and `blockReason` are all generic enough to be reused as-is by the 3 new stages and the new bounce edge. The only DB-facing change is a one-line **data** migration to keep any pipeline task currently sitting in `pipeline_stage = 'pre-builder'` from desyncing against the renamed enum:

```sql
-- 038_sdd_pipeline_stages.sql
UPDATE tasks SET pipeline_stage = 'decompose' WHERE pipeline_stage = 'pre-builder';
```

Registered in `migrations/index.ts` per the usual append-only convention. No `ALTER TABLE` needed — this is the smallest possible migration, which is itself a signal the rework is additive to the schema, not a schema overhaul.

## 6. Work breakdown — implementation tasks

| ID | Goal | Files owned | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Extend `ColumnId`/`COLUMNS`/`PIPELINE_STAGE_COLUMNS` with `specify`/`clarify`/`decompose`(rename)/`analyze`; bump `PIPELINE_REVISION_CAP` 4→6; add `PIPELINE_SPEC_FILE`("SPEC.md"), rename `PIPELINE_BUILD_PLAN_FILE` value to "TASKS.json", add `PIPELINE_CONSTITUTION_FILE`(".specify/memory/constitution.md") | `src/shared/types.ts` | — | Typecheck green; every existing `pipelineStage` switch in the codebase is a compile error until updated (deliberate — the type system finds every call site) |
| T2 | Data migration renaming any in-flight `pre-builder` rows to `decompose` | `src/bun/migrations/038_sdd_pipeline_stages.sql`, `migrations/index.ts` | T1 (naming) | `bun run` against a DB with a pre-existing `pre-builder` row lands it on `decompose` |
| T3 | New/rewritten prompts (`specifyPrompt`, `clarifyPrompt`, narrowed `planningPrompt`, grown `planReviewPrompt`, renamed+grown `decomposePrompt`, grown `childBuildPrompt`/`codeReviewPrompt`/`testingPrompt`); pure `parseSpecAcceptanceCriteria` + `analyzeCoverage`; `parseBuildPlan` schema grows `acceptanceCriteria` field | `src/bun/pipeline-prompts.ts` | T1 | Every prompt builder is a pure function returning a string, same convention as today; new parsers have zero IO |
| T4 | `advancePipelineStage` switch grows `specify`→`clarify`→`planning` cases (file-existence gate, same pattern as today); `decompose` case now also runs `analyzeCoverage` before deciding `building` fresh-entry vs. bounce-to-`decompose`; `stagePrompt` dispatch extended. `build-scheduler.ts` itself needs **no functional change** — same `tickBuild`/`completeChildBuild`, just fed by the renamed stage id | `src/bun/orchestrator.ts` | T3 | Full 9-stage fake-driver walk reaches `ready`; an injected AC-coverage gap bounces to `decompose` and is recoverable |
| T5 | Standalone constitution flow: `generateConstitution(workdir, agent, model, effort)` runs an ordinary `isolation:"none"` task directly against `workdir`, writes+commits `.specify/memory/constitution.md`; one route; a small trigger (repo-settings menu or NewTaskForm affordance — exact placement is the implementer's call) | `src/bun/orchestrator.ts`, `src/bun/server.ts`, `src/bun/pipeline-prompts.ts`, one `mainview` component | T1 | Running it against a temp repo produces a committed file; independent of and non-blocking for T1–T4 |
| T6 | UI: labels for the 4 new/renamed stage ids (mostly covered by T1's `COLUMNS` entries); confirm `TaskCard.tsx`/`display-columns.ts` need zero further changes (they're already generic over `PIPELINE_STAGE_COLUMNS`); update `NewTaskForm`'s "Run as pipeline" checkbox copy | `src/mainview/components/kanban/NewTaskForm.tsx` | T1 | New stages render with correct labels and still collapse into the single "In Progress" display bucket, no new kanban lane appears |
| T7 | Surface `clarify`'s `ask_user` pause through the existing `modalPending`/pending-interaction indicator so it reads as "waiting on you," not "stuck" | `src/mainview/components/kanban/RunPanel.tsx` (or wherever `modalPending` is currently keyed) | T4 | Manually run a claude-code pipeline task through `clarify`; the pending state is visually distinguishable from a hang before the fix, distinguishable after |

## 7. Work breakdown — test tasks

| ID | Goal | Files owned | Covers |
| --- | --- | --- | --- |
| TT1 | Unit tests: `parseSpecAcceptanceCriteria` (valid/malformed `AC-n:` lines, duplicates); `analyzeCoverage` (full coverage → ok; missing-owner gap; phantom-reference gap; empty-`acceptanceCriteria` subtask allowed); extended `parseBuildPlan` schema (`acceptanceCriteria` field validation); new prompt builders produce the expected fixed strings/filenames | `src/bun/pipeline-prompts.test.ts` | T3 |
| TT2 | Extend the existing pipeline orchestrator suite: full happy-path walk through all 9 stages with the fake driver; an injected `analyze` coverage gap bounces to `decompose`, re-decomposes, re-analyzes, passes; the shared revision cap still trips correctly with the new edge counted in; pause/resume exercised at each new stage | `src/bun/orchestrator-pipeline.test.ts` | T4 |
| TT3 | Extend the merge-DAG suite under the renamed `decompose` id — confirms `build-scheduler.ts` needed zero logic changes, only the caller's stage vocabulary | `src/bun/orchestrator-pipeline-merge.test.ts` | T4 |
| TT4 | `generateConstitution`: writes+commits the file in a temp repo; idempotent re-run (already exists → no duplicate commit or is a deliberate no-op, implementer's call which — but must be tested either way); never touches worktree/pipeline machinery | new `src/bun/constitution.test.ts` | T5 |
| TT5 | Extend `display-columns.test.ts`'s pipeline-stage collapse test with the 3 new ids folding into `"in-progress"` — should require zero new *logic*, this test is the proof | `src/mainview/lib/display-columns.test.ts` | T1, T6 |

## 8. Execution waves

- **Wave 1**: T1 (types/constants) + T2 (migration) — T2 needs T1's final stage-id names, effectively sequential within the wave.
- **Wave 2**: T3 (prompts + pure parsers) and T6 (UI labels) in parallel — both only depend on T1.
- **Wave 3**: T4 (orchestrator wiring) — depends on T3's new pure functions and T1's ids.
- **Wave 4**: T5 (constitution flow) — fully independent of T3/T4, can land any time after T1; does not block shipping the rest.
- **Wave 5**: T7 (UI pending-state visibility) — depends on T4 existing so there's a real `clarify` pause to surface.
- **Wave 6**: TT1–TT5, each gated on its corresponding implementation task.

## 9. Blast radius & risks

- **Existing non-pipeline tasks**: zero behavior change — none of this touches a task with `pipelineStage: null`.
- **In-flight pipeline tasks at deploy time**: any task sitting in `pipeline_stage = 'pre-builder'` must be caught by T2's migration or it desyncs against the renamed TS union (the `stagePrompt`/`advancePipelineStage` switches are exhaustively typed, so a stale DB value would need a runtime fallback or the migration — the migration is simpler and is what's planned).
- **Revision-cap bump (4→6)**: an intentional behavior change for every pipeline task, not a bug — flagged so it isn't mistaken for scope creep during review.
- **The `ask_user` pause in `clarify`**: the single biggest UX-risk item. It's the first genuinely human-blocking point inside a subsystem whose entire pitch is "no click needed." Must be manually verified end-to-end (T7's acceptance criterion) before this ships, not just unit-tested.
- **Codex/gemini pipeline tasks** never get interactive clarification — an accepted, documented parity gap, not a blocker (mirrors the already-accepted gemini "no thinking stream" gap).
- **Constitution propagation lag**: until someone merges a `generateConstitution` commit to the repo's default branch, every subsequent pipeline task's `specify` stage will report "no constitution found" and proceed anyway — self-correcting, not a failure mode, but worth a one-line first-run callout in the app (nice-to-have, not required for v1).

## 10. Measurable outcomes

Tying this back to a concrete "what gets measurably better," per this project's own standard:

1. **Traceability**: today, 0% of pipeline-task diffs are checked against anything more specific than "matches `PLAN.md`." After this rework, 100% of pipeline-task `SPEC.md` files carry a numbered, testable AC list that `Code Review` and `Testing` explicitly check off by id — visible in the run transcript, not just asserted.
2. **Cheap gap-catching**: `analyze`'s deterministic bounce count (visible via `revisionCount` deltas attributable to that specific edge) is a free signal for "how often does decomposition miss something" — should be non-zero early (proving the gate does something) and trend down as the decompose stage's prompt improves.
3. **Where rework friction moves to**: comparing `plan-review`/`code-review`/`testing` bounce rates before and after rollout should show ambiguity-driven bounces shifting earlier (into the now-free `clarify` stage) and out of the expensive, agent-hour-costly `code-review`/`testing` bounces — the whole point of doing clarification before building instead of after.

## 11. Open questions / assumptions

1. **Revision-cap sharing**: recommend one shared 6-count budget across all 4 bounce edges (`plan-review→planning`, `analyze→decompose`, `code-review→building`, `testing→building`) for v1 simplicity, even though `analyze`'s bounce costs zero agent-turns and the other three cost a full turn each. A separate, larger budget just for the free `analyze` edge is straightforward to add later if the shared cap turns out to starve the "real" bounces — not worth building preemptively.
2. **Constitution lifecycle**: recommend a real committed file at `.specify/memory/constitution.md` (spec-kit-idiomatic, human-editable like any other repo doc) accepting the "must be merged to propagate" lag described in §9, over an app-level setting stored outside git (which would propagate instantly but stop being "just a markdown file you can edit"). Flagging because it's a genuine trade-off, not an obvious call.
3. **`clarify`'s question budget**: recommend a soft cap (an instruction in the prompt, e.g. "ask at most 5 questions") rather than a mechanically enforced one — agetor has no visibility into MCP tool-call counts today, so hard enforcement is out of scope for this pass.
4. **`AC-n` id format rigidity**: recommend one fixed regex-friendly format (`AC-<n>: <text>`) stated with an example in `specifyPrompt`, mirroring how `PIPELINE_VERDICT:` already proves a rigid, example-driven sentinel is reliably followed by these agents — not a lenient/fuzzy matcher.
5. **Internal symbol renames** (`BuildPlan`→`TaskPlan`, `tickBuild`→`tickTasks`, etc.): only the **agent-facing filename** (`BUILD_PLAN.json`→`TASKS.json`) is part of this design: agents read prompts, not source, so that rename is user-visible and cheap. Renaming the internal TypeScript symbols is pure implementation-time judgment, not a design decision — left to whoever picks up T3/T4.
