# Plan — Token efficiency of the SDD pipeline

| Field | Value |
| --- | --- |
| Date | 2026-09-11 |
| Source | User request: "the development pipeline uses a lot of tokens, what optimisations can be made; evaluate what shared memory across agents would bring" |
| Evidence base | The two complete pipeline runs in `~/.agetor-dev` (tasks `acb8dbf7` "shortlist" and `154f4379` "change background to grey", same target repo): 41 claude sessions, 809 API messages, `message.usage` summed from each session's JSONL transcript |
| Measurement | `bun run eval:pipeline:tokens` (`evals/pipeline/token-report.ts`, deterministic, free, gate-tested). Every optimisation below is judged by re-running it |
| Branch | `feature/pipeline-token-efficiency` — optimisations are tried here and pulled into `main` individually once the numbers hold |
| Status | **Implemented on the branch (O-1 … O-11), gate-tested; awaiting the before/after re-run of the two baseline tickets.** See §8 for what shipped where and the kill switch per item |

## 1. Where the tokens go (as measured)

| Metric | Value |
| --- | --- |
| Context tokens processed (input + cache write + cache read) | 70.7M |
| Of which cache reads | 68.5M (97%) |
| Output tokens | 0.5M |
| API messages / fresh claude sessions | 809 / 41 |
| Fixed bootstrap per session (first message's context) | 51K to 58K, mean 54.5K |
| Mean context per API message | 87K |
| Bootstrap re-read across all messages | ≈ 44.1M (62% of all context) |

Per stage:

| Stage | Runs | Messages | Context | Share |
| --- | --- | --- | --- | --- |
| child-build | 19 | 437 | 38.0M | 53.7% |
| testing | 2 | 123 | 12.3M | 17.4% |
| planning | 2 | 50 | 5.9M | 8.3% |
| code-review | 4 | 50 | 4.1M | 5.8% |
| building (fixup) | 2 | 46 | 3.2M | 4.5% |
| continuation (non-stage) | 2 | 34 | 2.3M | 3.2% |
| decompose | 3 | 24 | 2.1M | 2.9% |
| clarify | 3 | 28 | 1.8M | 2.5% |
| plan-review | 2 | 10 | 0.7M | 1.0% |
| specify | 2 | 7 | 0.4M | 0.6% |

Redundancy, same runs:

- "shortlist": 142 Read calls over 58 distinct files; **35 files were read by two or more different stage-agents**. SPEC.md read 8 times, `contracts/store/src/state.ts` 7 times, PLAN.md 5 times.
- "change background to grey": 16 of 24 distinct files read by two or more agents; SPEC.md 8 times, PLAN.md 7 times. Decomposed into **10 children** for a colour change.
- `git diff <base>` run 17 times in one pipeline. `npm install` 9 times, `ls node_modules/vitest` 7 times: worktrees start without `node_modules`, and every agent rediscovers that.
- Tool results fed back into context: 1.0 to 1.2MB per pipeline; Read is 63 to 72% of it, Bash 25 to 35%.
- One failed `testing` run alone: 75 messages, 8.5M context. Both testing runs together issued 95 Bash calls.
- One child prompt was 10KB (over `CLAUDE_PROMPT_ARGV_MAX_BYTES`, so it took the deferred-paste path) and ran 54 messages / 7.6M.
- Both pipelines ran sonnet-5 at effort `high` for every stage and every child. `resolveRunModel`'s verdict-stage tiering (`orchestrator.ts:898`) had no effect because the task model was already Sonnet.

## 2. Why: three multiplying factors

1. **Every stage is a fresh session.** `startTask` never passes a resume id, and `spawnClaudeViaTmux` kills the previous same-named session (`claude-tmux.ts:4444`). Nothing accumulates across stages (good), but every stage and every child pays the bootstrap again (41 times here).
2. **The bootstrap is large.** From the JSONL `prompt_snapshot` attachment of a real code-review session: 156KB of tool schemas for 13 tools (Artifact, Agent, AskUserQuestion, Bash, Edit, ListAgents, Read, ReportFindings, ScheduleWakeup, SendFeedback, Skill, ToolSearch, Write), a 28KB system prompt, `/home/mcyrus/CLAUDE.md` (15KB, loaded because `~/.agetor-dev/worktrees/*` sits under `/home/mcyrus`), and an 11KB skill listing. Roughly 42.6K tokens come back as cache reads, 12.4K as cache writes, per session.
3. **Context cost is quadratic in message count.** Each API message re-reads everything before it. 809 messages × 54.5K bootstrap ≈ 44M tokens, before a single file read. A file read at message 5 of a 30-message session is re-read 25 more times.

So the levers, in order: shrink what every message carries (bootstrap), cut the number of sessions (decomposition width, non-stage turns), cut the number of messages per session (discovery and rediscovery), and only then cut bytes per tool result.

Cache reads are billed at a fraction of input price on the API. Under the interactive subscription quota agetor uses, the accounting is opaque, so the report tracks both `context` and `cacheRead` and the plan optimises `context` and `messages`, which move every accounting the same direction.

## 3. Optimisations

Each entry names the change, the files, the gate test (deterministic, `bun test`), the eval (paid lane, `evals/pipeline/run-evals.ts`) where behaviour could regress, the expected saving on the measured baseline, and the risk. Expected savings are against the 70.7M baseline and are not additive across entries.

### O-1 — Restrict the tool set for pipeline sessions (est. 25 to 35%)

Pipeline stage agents and build children need Read, Edit, Write, Bash, Grep, Glob, and (clarify only, claude-code only) AskUserQuestion. They do not need Artifact, Agent, ListAgents, ReportFindings, ScheduleWakeup, SendFeedback, Skill, or ToolSearch. The Artifact schema alone is the bulk of the 156KB.

- **Change**: `buildCommand` in `agents.ts` gains a `toolAllowlist?: string[]` option; for claude-code it emits `--allowedTools`/`--disallowedTools` (whichever the installed CLI honours for removing schemas from the prompt; verify against the JSONL `prompt_snapshot.tools` array before trusting either flag). `startTask` passes the pipeline set when `task.pipelineStage != null || task.parentTaskId != null`. Also verify whether the skill listing attachment can be suppressed for these sessions; if not, note it as a residual.
- **Files**: `src/bun/agents.ts`, `src/bun/orchestrator.ts` (`startTask` opts).
- **Gate**: `agents.test.ts` — pipeline opts produce the flag with exactly the allowlist; plain tasks produce no flag; clarify keeps AskUserQuestion.
- **Eval**: existing `decompose-files`, `builder-commit`, `merge-resolution` must still pass with the restricted set.
- **Proof**: bootstrap/run column in the token report drops from ~54K towards ~25K.
- **Risk**: an agent that wanted `Agent` (subagents) for exploration loses it; children in these runs used Agent twice in 437 messages. Acceptable.

### O-2 — Keep the operator's home CLAUDE.md out of pipeline sessions (est. 4 to 6%)

`/home/mcyrus/CLAUDE.md` is a personal working-style file. It is injected into every pipeline session as a 15KB `instructions` attachment only because the worktree root is under `$HOME`.

- **Change**: two options, pick one after checking the CLI: (a) make the worktree root configurable (`AGETOR_WORKTREE_ROOT`, default unchanged) and document pointing it outside `$HOME` for pipeline-heavy use; (b) if the CLI offers a settings key to disable ancestor CLAUDE.md loading, write it into the worktree's `.claude/settings.local.json` via `hook-installer.ts` for pipeline tasks only. (b) is preferred because it needs no user action; (a) is the fallback.
- **Files**: `src/bun/worktree.ts` or `src/bun/hook-installer.ts`.
- **Gate**: worktree path test, or settings-writer test asserting the key lands only for pipeline tasks.
- **Proof**: `instructions` attachment absent from pipeline JSONLs; bootstrap/run drops ~4K.
- **Risk**: a repo-level CLAUDE.md inside the worktree must keep loading. Test that explicitly.

### O-3 — Right-size decomposition (est. 20 to 30% on small tickets)

Ten children for a background-colour change is `decomposePrompt`'s "everything else should be independent" instruction working exactly as written. Each child costs one bootstrap plus rereading SPEC, PLAN, and the touched files.

- **Change**: `decomposePrompt` gains sizing rules: one subtask when the plan touches fewer than N files (N=6 to start) or one component area; otherwise 2 to 4 slices sized by files touched, never one slice per file. Add a soft upper bound (8) that `parseBuildPlan` reports as a warning status event, not a rejection.
- **Files**: `src/bun/pipeline-prompts.ts`.
- **Gate**: `pipeline-prompts.test.ts` fixed-string check for the sizing paragraph.
- **Eval**: `decompose-files` currently asserts `subtasks.length >= 3` for a 5-AC plan spanning 7 files; keep that fixture, add a second fixture (2 files, 2 ACs) asserting exactly 1 subtask.
- **Proof**: children per pipeline and child-build share in the report.
- **Risk**: less parallelism on medium tickets. Wall-clock is not the metric here; tokens are.

### O-4 — Deterministic repo profile and dependency install before agent turns (est. 10 to 15%)

The Tester spent 95 Bash calls across two runs discovering how to install and run the project. Same-input-same-output work.

- **Change**: after `prepareWorkdir`, for pipeline tasks and children, agetor (a) detects the package manager and scripts from `package.json` (`typecheck`, `lint`, `test`, `build`), (b) runs the install once per worktree (or links `node_modules` from the source repo when the lockfile matches), and (c) injects a compact `## Project commands` block into `testingPrompt`, `codeReviewPrompt`, and `childBuildPrompt` ("install: done; typecheck: `npm run typecheck`; test: `npx vitest run`"). Unknown ecosystems inject nothing.
- **Files**: new `src/bun/repo-profile.ts` (pure detection + one install choke point), `src/bun/orchestrator.ts` (`startTask` injection), `src/bun/pipeline-prompts.ts`.
- **Gate**: `repo-profile.test.ts` — detection over fixture `package.json`s (npm/bun/pnpm, workspaces, missing scripts); install is a no-op when `node_modules` exists and the lockfile hash matches; empty block for non-JS repos.
- **Eval**: none needed for detection; the Tester eval (O-5) covers behaviour.
- **Proof**: `npm install` / `ls node_modules` counts in the report's Bash histogram go to zero; testing-stage messages drop.
- **Risk**: install runs untrusted `postinstall` scripts. The agent would run the same install anyway, so no new exposure, but say so in the docs.

### O-5 — Run the deterministic checks first; hand the Tester only failures (est. 5 to 10%)

- **Change**: `advancePipelineStage`'s `code-review` approve path runs the repo profile's typecheck/lint/test itself before spawning the Tester. All green and the spec has no ACs marked manual: skip the Tester turn, record a status event with the command outputs' tails, set `implementationApproved`. Anything red: spawn the Tester with the failing command and the last 200 lines of its output in the prompt, and the instruction not to rerun what already passed.
- **Files**: `src/bun/orchestrator.ts`, `src/bun/pipeline-prompts.ts` (`testingPrompt` gains a `precheck` block), `src/bun/repo-profile.ts`.
- **Gate**: `orchestrator-pipeline.test.ts` with the fake driver — green precheck skips the Tester and lands `done`; red precheck spawns the Tester with the failure folded into the prompt; no profile falls back to today's path.
- **Eval**: new `tester-precheck` eval: a fixture with one failing test and the precheck output in the prompt; score = the Tester fixes only that test and does not reinstall or rerun the full discovery.
- **Risk**: "green" is not "ACs verified". Keep the Tester turn whenever SPEC.md has ACs that no test name references; make that check deterministic (AC id grep over the test files) rather than skipping blindly.

### O-6 — Precompute the review diff once (est. 3 to 5%)

`git diff <base>` ran 17 times in one pipeline, and the reviewer reread whole files afterwards.

- **Change**: `codeReviewPrompt` receives a diffstat and a path to `.agetor/review.diff` written by agetor (via `git-diff.ts`) at spawn, capped at N KB with a "truncated, run `git diff` for more" note. On revision passes (`revisionCount > 0`), the diff is only what changed since the previous review's HEAD (record the sha on the task row alongside `pipelineBounceFingerprint`).
- **Files**: `src/bun/orchestrator.ts`, `src/bun/pipeline-prompts.ts`, `src/bun/git-diff.ts`.
- **Gate**: diff file written and referenced; revision pass uses the delta range; cap honoured.
- **Proof**: `git diff` count in the Bash histogram; code-review messages per run.

### O-7 — Kill the stage session at settle (est. 3%, plus 300 to 500MB RAM per stage)

Auto-continuation turns spent 2.3M tokens on runs RC-6 already refuses to act on. A settled stage session has no future.

- **Change**: in `advancePipelineStage`, after the outcome is recorded and before `spawnStage`, call `dropSession(taskId)` for the finished stage. Not for children mid-build (their session is what settles), and not on `blocked` (the human may want to talk to it).
- **Files**: `src/bun/orchestrator.ts`.
- **Gate**: fake-driver walk asserts `dropSession` was called once per advanced stage and never on `blocked`.
- **Proof**: `continuation` row disappears from the report.
- **Risk**: none on correctness; the next stage is a fresh session regardless.

### O-8 — Effort tiering next to model tiering (est. 5 to 10%)

Effort drives thinking tokens and tool-call count. Children and verdict stages inherit the parent's `high`.

- **Change**: rename `resolveRunModel` to `resolveRunOptions` returning `{ model, effort }`: verdict stages `low`, children `medium`, everything else unchanged. Keep the model tier as is.
- **Files**: `src/bun/orchestrator.ts`, `src/bun/build-scheduler.ts` (children currently copy `parent.effort`).
- **Gate**: existing `resolveRunModel` tests extended.
- **Eval**: all three existing evals run at the tiered effort and must hold the 0.8 threshold; add `--effort` to `run-evals.ts`.
- **Risk**: quality. This is the one entry that trades output quality for tokens; it ships only if the eval lane holds.

### O-9 — Bound child prompts and tool results (est. 2 to 4%)

- **Change**: `parseBuildPlan` warns (status event) when `subtask.prompt` exceeds 2KB and `decomposePrompt` states the budget; reviewer and tester prompts instruct Read with `offset`/`limit` for files over 300 lines and `| tail -200` on test output.
- **Files**: `src/bun/pipeline-prompts.ts`.
- **Gate**: fixed-string checks; size assertion on `childBuildPrompt`'s overhead already exists.
- **Proof**: Read/Bash `resultBytes` per pipeline in the report.

### O-10 — Per-run token accounting in the product (instrumentation, no saving by itself)

`account-usage.ts` rolls up per day and per model only. Nobody can see that one testing run cost 8.5M.

- **Change**: persist `input/cacheWrite/cacheRead/output/messages` per run (new `run_usage` table, next free migration number), fed from the same JSONL tail the drivers already read; show tokens per run in the RunPanel's runs list and a per-stage total on pipeline cards. `token-report.ts` becomes a reader of that table, with the JSONL walk kept as a fallback for old runs.
- **Files**: `src/bun/migrations/0NN_run_usage.sql`, `src/bun/db.ts`, `src/bun/claude-tmux.ts` (usage extraction is `parseUsageLine` in `account-usage.ts`, already pure), `src/mainview/components/kanban/RunPanel.tsx`.
- **Gate**: migration + insert/upsert idempotence on `message.id`; API shape test.

## 4. Shared memory across agents: what it would and would not save

Two design documents already exist: `docs/plans/pipeline-shared-memory.md` (durable repo-scoped knowledge, BM25 recall injected at spawn, deterministic bounce harvest) and `docs/plans/agent-shared-memory-coordination.md` (peer awareness, conflict notices, checkpoints). Judged against the measurements above:

| Mechanism | Token effect | Why |
| --- | --- | --- |
| Durable knowledge recall (`## Relevant memories` at spawn) | **Saves 10 to 20%, mostly from the second pipeline onward on a repo** | Targets rediscovery: the `npm install` trap, where vitest lives, which env flags tests need, recurring bounce reasons. Both measured pipelines ran on the same repo and both rediscovered the same setup facts. Injection cost is about 500 tokens per prompt, under 1% of context. It does nothing for the bootstrap (62%), test output volume, or decomposition width. |
| Checkpoints and resume | **Near zero** | Saves work only after an orphan, reap, or pause. Rare inside a pipeline whose stages are fresh sessions by design. |
| Peer awareness block, conflict notices | **Neutral to slightly negative** | Adds prompt bytes. Saves tokens only indirectly by avoiding merge-resolution turns; the two measured runs had none. Its value is correctness, not tokens. |

The measured redundancy (35 files read by 2+ agents, SPEC.md read 8 times) is mostly **within one pipeline, on one commit**, which a knowledge store answers poorly: BM25 over prose does not know which files the Planner consulted. A cheaper mechanism answers it exactly:

### O-11 — Deterministic stage handoff pack (est. 8 to 15%)

At stage settle, extract from the settled run's JSONL (already tailed) the files it Read (paths + line ranges) and the commands it ran that exited 0, and inject a compact `## From the previous stage` block into the next stage prompt and into `childBuildPrompt`: "The Planner consulted: `src/…` (lines 1-120), … Commands that worked: `npm run typecheck`." Zero LLM calls, no staleness (same branch, same commit), and it directly targets the duplicated reads. Children get the Planner's and Decomposer's lists filtered to their `files` ownership.

- **Files**: new `src/bun/stage-handoff.ts` (pure extraction over run events + render with a char budget), `src/bun/orchestrator.ts` (`startTask` injection beside the constitution block, the same injection point the memory designs use), `src/bun/pipeline-prompts.ts`.
- **Gate**: extraction over a fixture event stream; budget truncation drops whole entries; empty block omitted; children see only in-lane paths.
- **Eval**: fixture pipeline where PLAN.md names three files; score = the child's Read set overlaps the handoff list and the child does not re-Read files outside its lane.
- **Proof**: `read-by-2+agents` count in the report.

The durable store from `pipeline-shared-memory.md` then becomes the cross-task tier on top of O-11 and O-4, which is where its real value is (the second and later pipelines on a repo). It should still ship behind the eval that document specifies, because a wrong memory degrades quality silently.

## 5. Execution order on this branch

Each wave is one or more commits, each with a before/after run of `bun run eval:pipeline:tokens` recorded in the commit message. Pull into `main` per commit, not as one merge.

| Wave | Items | Why this order |
| --- | --- | --- |
| 0 | Measurement (`token-report.ts`, this doc) | Shipped. Baseline: 70.7M context, 809 messages, 54.5K bootstrap |
| 1 | O-1, O-2, O-7 | Pure subtraction: no prompt semantics change, no eval risk, largest saving |
| 2 | O-3, O-9 | Prompt-only changes, covered by the existing eval lane plus one new fixture |
| 3 | O-4, O-6, O-11 | Deterministic injection; reuse the constitution injection point; needs the new `repo-profile.ts` and `stage-handoff.ts` modules |
| 4 | O-5, O-8 | Behaviour changes gated on evals: Tester skip and effort tiering |
| 5 | O-10 | Product instrumentation; makes every earlier saving visible in the UI |
| later | `pipeline-shared-memory.md` Phase 4 | Cross-task tier, once O-4/O-11 have removed the within-pipeline redundancy so its marginal value is measurable |

## 6. Measurable outcome

Re-run the same two tickets ("shortlist", "change background to grey") against the same repo after each wave and compare with the baseline in §1. Targets after wave 3:

| Metric | Baseline | Target |
| --- | --- | --- |
| Context per pipeline | ~35M | under 15M |
| Bootstrap per session | 54.5K | under 25K |
| Children for the colour-change ticket | 10 | 1 to 3 |
| Files read by 2+ agents ("shortlist") | 35 | under 12 |
| `npm install` calls per pipeline | 9 | 0 |
| Non-stage (continuation) runs | 2 | 0 |

Quality gate for every wave: `bun test` green, `bun run eval:pipeline` at or above 0.8 on every eval, and the two re-run pipelines reach `done` with `revisionCount` no higher than the baseline runs.

## 7. Open questions

1. **Which CLI flag actually removes tool schemas from the prompt** (O-1)? `--disallowedTools` may only block calls while leaving the schema in the prompt. Settle by reading `prompt_snapshot.tools` in the JSONL of one spawned session. If neither flag removes schemas, O-1's saving shrinks to whatever the skill listing and instructions attachments allow, and the design falls back to O-2 plus a smaller system prompt via `AGETOR_CLAUDE_ARGS`.
2. **Subscription accounting of cache reads.** If the interactive quota discounts cache reads the way the API does, message count matters less and bootstrap cache writes matter more. The report prints both; decide once Anthropic's usage endpoint (already polled by `account-usage.ts`) is compared against the report over a week.
3. **Tester skip threshold** (O-5): skip only when every AC id appears in a test file name or body, or also when the Code Reviewer's approve message ticks every AC? The first is deterministic and conservative; start there.
4. **Effort for children** (O-8): `medium` is a guess. Run the builder eval at `low`, `medium`, `high` three times each and pick the cheapest that holds 0.8.

## 8. As built (2026-09-11)

Everything below is on `feature/pipeline-token-efficiency`, typechecked and covered by `bun test`. The measurement in §1 is the baseline; §6's targets are checked by re-running the same two tickets against the same repo with `bun run eval:pipeline:tokens`.

| Item | Where | Verified by | Kill switch |
| --- | --- | --- | --- |
| O-1 tool set | `agents.ts` `leanContext` / `pipelineToolset`; `orchestrator.ts` `pipelineLeanContext` | live interactive probe: tool schemas 156KB → 43KB, first message 54.5K → 14.3K tokens; `agents.test.ts`, `orchestrator-pipeline.test.ts` | `AGETOR_PIPELINE_LEAN_CONTEXT=0` |
| O-2 CLAUDE.md ancestry | same launch: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` + `--append-system-prompt-file <worktree>/CLAUDE.md` | probe: repo marker present, `$HOME/CLAUDE.md` text absent | same |
| O-3 decomposition sizing | `pipeline-prompts.ts` `decomposePrompt`, `buildPlanWarnings` → status events at decompose settle | `pipeline-prompts.test.ts`, `orchestrator-pipeline-token.test.ts`; eval `decompose-single` (paid, not yet run) | none (prompt text) |
| O-4 repo profile + install + `## Project commands` | `repo-profile.ts`; `pipelinePromptExtras` in `orchestrator.ts` | `repo-profile.test.ts`, token test file | `AGETOR_PIPELINE_AUTO_INSTALL=0` |
| O-5 tester precheck / skip | `pipeline-precheck.ts`; `runTesterGate` in `orchestrator.ts`; `testingPrompt(task, precheck)` | `pipeline-precheck.test.ts`, 5 gate scenarios in the token test file; eval `tester-precheck` (paid, not yet run) | `AGETOR_PIPELINE_PRECHECK=0`, `AGETOR_PIPELINE_TESTER_SKIP=0` |
| O-6 precomputed review diff | `review-diff.ts`; `codeReviewPrompt(task, reviewDiff)`; `pipeline_stage_state.review_sha` | `review-diff.test.ts`, token test file (base pass + revision delta) | none (falls back when git fails) |
| O-7 close settled session | `dropSettledStageSession` in `orchestrator.ts` | `orchestrator-pipeline.test.ts` | none |
| O-8 effort tiering | `resolveRunEffort` in `orchestrator.ts` | token test file; `run-evals.ts --effort` (paid) | `AGETOR_PIPELINE_EFFORT_TIERING=0` |
| O-9 prompt / result bounds | `pipeline-prompts.ts` (2KB subtask prompt budget, offset/limit + tail instructions) | `pipeline-prompts.test.ts` | none |
| O-10 per-run token usage | migration 058, `run-usage-hook.ts`, `db.ts` `runUsage`, `GET /runs/:id/usage`, `GET /tasks/:id/usage`, RunPanel labels; `token-report.ts` prefers the table | `run-usage.test.ts`, `run-usage-endpoint.test.ts`, `token-format.test.ts` | none |
| O-11 stage handoff pack | `stage-handoff.ts`; capture in `advancePipelineStage`, render in `pipelinePromptExtras` and `build-scheduler.ts` (children, lane-filtered, 700-char budget) | `stage-handoff.test.ts`, token test file | none (empty block when nothing to say) |

Open question 1 is settled: `--tools <csv>` removes unlisted schemas from the prompt snapshot (verified in both `-p` and interactive tmux sessions); `CLAUDE_CODE_DISABLE_CLAUDE_MDS` removes every CLAUDE.md, so the worktree's own is re-injected via `--append-system-prompt-file`. One side finding while probing: a claude launched in a never-seen directory shows two trust dialogs before its first turn (folder trust, then bypass-permissions), which agetor's pane scraper already drives.

Paid evals run so far (claude-opus-5, effort high, 1 run each): `decompose-single` PASS 100% (exactly 1 subtask for a 2-file plan, AC coverage clean, committed) and `tester-precheck` PASS 100% (the Tester fixed the failing test it was handed, in lib.js not the test, committed, verdict pass). Not yet done, in order: (1) `bun run eval:pipeline` for the three pre-existing evals under the new prompts, and `bun evals/pipeline/run-evals.ts --effort low` to confirm O-8's tiering holds 0.8; (2) re-run the two baseline tickets and fill in §6's target column with measured values; (3) pull the branch into `main` commit by commit.
