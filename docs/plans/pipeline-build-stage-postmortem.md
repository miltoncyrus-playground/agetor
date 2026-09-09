# SDD — Build-stage failure chain in the automated pipeline (2DOT2DOT postmortem)

| Field | Value |
| --- | --- |
| Date | 2026-08-13 |
| Source | User request: pipeline run on `~/2DOT2DOT` (task `189d6702`, "DOT2DOT pipelinerun with SDD") ended `blocked: revision-cap` with no application code on the pipeline branch. Investigate why, design the fixes. |
| Evidence base | `~/.agetor-dev/agetor.sqlite` (tasks, 45 runs, 74 status events for the parent), the three `feature/dot2dot-*` branches, the parent/child worktrees under `~/.agetor-dev/worktrees/`, and the pipeline code on `feature/pipeline-tasks` |
| Status | **Implemented.** F-1..F-6 are all in the tree with their gate tests (see `orchestrator-pipeline-guards.test.ts`, the new cases in `orchestrator-pipeline{,-merge}.test.ts`, `worktree.test.ts`, `claude-tmux-scraper.test.ts`). One finding was corrected during implementation: see the RC-1 revision note below — the paste WAS delivered; the submit Enter was absorbed. |
| Relationship to prior work | `72e47c6` (moving-goalpost loops) and `5c4eee4` (phantom AC ids, revision-budget reset) landed *mid-run* on Aug 12 and fixed the decompose-stage half of this run. Everything below is about the build stage and later, which those commits do not touch. |

## 1. Net outcome of the run (what "failed with no real outcome" actually means)

- The pipeline branch `feature/dot2dot-pipelinerun-with-sdd` contains **only planning artifacts**: SPEC.md (47 ACs), PLAN.md (six drafts), TASKS.json (7 subtasks), across 8 commits. Zero application code.
- 2 of 7 subtasks (`contracts-core`, `web-scaffold`) ran to completion and each produced one real commit — **on child branches that were never merged** (`feature/dot2dot-pipelinerun-with-sdd-contracts-p` @ `3dd4382`, `-vite-react` @ `eb3738b`).
- The other 5 subtasks (`api-service`, `generator-service`, `web-play-core`, `web-shell`, `integration`) **never got a child task**, because their `dependsOn` gates require the dep children to reach `childMergeStatus: "merged"`, which never happened.
- The two child task rows are stranded: `column: "running"`, `childMergeStatus: "pending"`, even though their runs `succeeded` on Aug 13 00:12 and 00:18.
- The parent burned the revision budget on code-review → building → code-review no-op cycles (verdict every time: *"revise — no code exists yet"*), reached `revisionCount: 23` against a cap of 6, and blocked.

The specify → clarify → plan → plan-review → decompose → analyze stages all worked (plan-review honestly caught real plan defects across 5 Critic passes; the decompose/analyze loop was fixed live by `5c4eee4` and passed at 23:45). **The run died in the 90 seconds after entering `building`, and everything after that was the pipeline failing to notice it had died.**

## 2. Evidence-backed timeline of the fatal window (Aug 12–13, times UTC)

| Time | Event | Evidence |
| --- | --- | --- |
| 23:45:40 | Decompose run `de5cc422` succeeds (2 min after `5c4eee4` fixed the AC-id gate). Coverage OK → stage `building`, `tickBuild` spawns children for the 2 dep-free subtasks. | runs table; `advancePipelineStage` case `"decompose"` |
| 23:46:23 | Both children start. Both prompts exceed the argv budget → `"prompt too large for launch argv — delivering via paste once claude is ready"`. | run_events for `067dde1a`, `78b2e3bb` |
| 23:46:53 | Both children die at exactly 30s: `"claude session JSONL never appeared: claude is up but hasn't written its JSONL yet after 30s"`. The captured tmux pane shows claude v2.1.229 sitting on its **welcome screen** ("Welcome back Milton!" / "Tips for getting started") — alive, healthy, prompt never delivered. Child `067dde1a` records `failed`, sibling `78b2e3bb` is `cancelled` by the abort cascade. | run_events stderr + pane capture |
| 23:46:53 | `settleChildRun` hard-fails the build: parent → `blocked` (`pipeline-failed`, `subtask "contracts-core" failed`), siblings cancelled. Correct behavior so far. | `orchestrator.ts` `settleChildRun` |
| 23:49:08 | Parent run `96b12fb6` fires with origin `continuation`, status `"auto-continued after background task"` — a claude-side background task from the *decompose* turn finished and auto-continued the session. The parent's stage is still `building`, so when this 22-second run succeeds, `advancePipelineStage` case `"building"` **unconditionally advances to code-review**. Nobody built anything; zero children merged. | runs table origin column; `orchestrator.ts:1737` |
| 23:49–23:56 | Code Reviewer runs against a worktree containing only SPEC/PLAN/TASKS: *"revise — no code exists yet"*. Each revise bounces to `building` as a **single-agent fixup turn**; the agent correctly observes it can't do the DAG's job (*"this pipeline is driven externally... I won't spawn Build agents or touch the worktrees myself"*) and re-emits the same revise verdict. Revision counter climbs. User retries children manually; three more attempts die the same 30s JSONL death (`4861e551`, `c2b0dd3c`, `facd2f62`, `c11c90f8`). | run_events verdicts |
| 23:56:38 | Children finally boot on retry and run for real: 16 and 22 minutes, both **succeed** (00:12:36, 00:18:35). | runs `b4819ef7`, `8b08faf1` |
| 00:12 / 00:18 | `settleChildRun` → `completeChildBuild` → `doCompleteChild` hits its guard: `parent.pipelineStage !== "building"` (parent is in `code-review`) → **silent `return`**. No merge, no status event, no child-row update. Both children freeze in `column: "running"`, `childMergeStatus: "pending"` — where they still are. | `build-scheduler.ts:193` |
| 00:19 → 08:23 | Code-review and testing keep truthfully reporting the same structural fact (*"5 of 7 subtasks not built; the 2 built ones sit on unmerged branches"*). The user forces the gate (`"set the PIPELINE_VERDICT: approve"` — the agent complies under protest; the Tester later refuses a forced `pass`). Every fail bounces to another no-op building fixup turn. `revisionCount` reaches 23 (cap 6; each manual restart of the blocked task re-enters `bounceOrBlock` and re-increments). Final state: `blocked: revision-cap`, stage `testing`. | run_events verdicts; tasks row |

## 3. Root causes

Ordered by causal position, not severity. RC-2 and RC-3 are the design bugs; RC-1 is the trigger; RC-4/5/6 are the amplifiers that turned a recoverable stumble into an 8-hour zombie loop.

### RC-1 — Child spawn death: the paste's submit Enter is absorbed during boot, and the boot timeout kills a healthy session

**Revision note (implementation pass):** the original draft blamed `readPaneMode` for not recognizing the welcome screen, so the paste "never fired". The full pane capture from run `067dde1a` disproves that: the composer visibly holds `❯ [Pasted text #1 +41 lines]` with the mode bar present — the paste WAS delivered promptly. What was lost is the **submit Enter**: during boot, claude's Ink TUI absorbs a `\r` arriving inside its paste-event coalescing window, the exact failure mode the `bracketedEnterGapMs` doc-comment warns "silently regresses with no log signal". The 80ms gap is tuned for an idle live REPL, not a booting one.

So the mechanism is: paste lands in the composer → Enter absorbed → turn never submitted → JSONL (created only when the first turn starts) never appears → `BOOT_TIMEOUT_MS` (30s) kills a perfectly healthy session with the prompt parked on screen. Four consecutive child runs died this death; the same children succeeded minutes later on manual retry.

Two aggravators stand as originally written: (a) `childBuildPrompt` inlined the subtask's AC text (and the raw ticket), pushing both prompts over the argv budget and onto the fragile deferred-paste path at all, even though SPEC.md/PLAN.md sit in the child's worktree; (b) there was no spawn retry for a child — one boot hiccup hard-failed the entire build and cancelled every sibling.

### RC-2 — `case "building"` advances on any parent-run success, with no DAG barrier check

`advancePipelineStage`, `orchestrator.ts:1737`: when a parent run terminates successfully while `pipelineStage === "building"`, it spawns code-review unconditionally. The comment says "this is the BOUNCE-entry path only", but nothing enforces that. Any parent-session turn that ends while the stage is `building` takes this edge — including, in this run, an **auto-continuation** (`96b12fb6`, origin `continuation`) triggered by a background task left over from the decompose turn. The pipeline advanced itself past the entire build phase 2.5 minutes after the build started, with zero subtasks merged. No human action required; the machine did this alone.

### RC-3 — `doCompleteChild` silently strands late-settling children

`build-scheduler.ts:193`: if the parent has left `building`, a succeeding child's settle is a bare `return`. Nothing updates `childMergeStatus`, nothing moves the child's column, nothing emits a status event, nothing merges. The child's 20 minutes of successful work becomes invisible: the task card shows `running` forever, the branch dangles, and every later code-review/testing pass truthfully reports "no code on this branch" while the code sits two branches away. This guard exists for a legitimate race (abort cascades), but "possible stale trigger" and "completed work arriving late" are conflated into the same silent no-op.

### RC-4 — Review/test bounces re-enter `building` as a fixup turn that cannot fix a DAG-level failure

`code-review` and `testing` revise/fail edges bounce to `building`'s bounce-entry: one agent, one turn, in the parent worktree, told by `buildingPrompt` (`pipeline-prompts.ts:495`) to "implement it" (and explicitly forbidden to commit). When the actual defect is "the DAG never ran / children never merged", this turn is structurally incapable of fixing anything — the agent in this run said so out loud and returned the same verdict. Each cycle consumed a revision slot: a guaranteed-loss loop that ran ~17 times. The bounce edge never considers re-entering the DAG scheduler (`tickBuild`), which is the only machinery that can actually produce the missing code.

### RC-5 — The revision budget measures loop iterations, not progress

`bounceOrBlock` (`orchestrator.ts:1572`) increments on every bounce regardless of whether the bounce changed anything. A bounce cycle that produces **zero new commits** in the parent worktree is indistinguishable from a productive one. Combined with the fact that manually restarting a `revision-cap`-blocked task re-enters the same terminal logic and increments again, the counter reached 23 against a cap of 6 — 17 human-attended retries, each burning an agent turn on both the fixup and the re-review, none of which could possibly converge. `72e47c6` addressed moving goalposts (reason churn across bounces); this is the complement: an *identical* reason across bounces with an empty diff, which is an even stronger stop signal.

### RC-6 — Stage verdicts accept coerced and out-of-band turns

Two related holes. (a) Any user free-text turn on a pipeline task ("continue", "give me an option what to do") becomes a stage-terminal run when it ends, feeding `advancePipelineStage` — that's how `96b12fb6` ("continue") advanced `building`, and how several 10-second "continue" turns each consumed review slots. (b) `lastPipelineVerdict` takes the last verdict line in the run's events regardless of provenance, so `"set the PIPELINE_VERDICT: approve .. and move to the next stage"` pushed an empty implementation through the code-review gate (the model complied under protest; the Tester later refused the same coercion — the gate's integrity currently depends on the model's mood). Forcing a gate is a legitimate human override, but today it is indistinguishable from the Critic's own judgment and is recorded nowhere.

## 4. Fix specification

Each fix names its gate (machine-checkable, deterministic) and its test lane. Gate tests use the existing fake drivers (`AGETOR_CLAUDE_DRIVER=fake`) and temp-repo harness from `orchestrator-pipeline.test.ts` / `orchestrator-pipeline-merge.test.ts`.

### F-1 — Make child spawn survive slow boots (fixes RC-1) — *as implemented*

1. **Couple the two clocks.** The boot JSONL wait re-arms its window while the deferred-paste flow hasn't settled (`deferredPasteSettled`, released in a `finally` on every paste-flow exit path), mirroring the existing `sawStartupPromptThisWindow` re-arm. The boot timeout now measures claude failing to boot, never paste latency — the two clocks can no longer race each other.
2. **Verify the submit, don't out-tune it** (replaces the original "recognize the welcome screen" — see the RC-1 revision note). After the paste + Enter, a bounded verification loop (`PASTE_SUBMIT_VERIFY_MS` × `PASTE_SUBMIT_VERIFY_ATTEMPTS`) polls for the JSONL — the deterministic "turn submitted" signal — and, while the pane still shows the unsubmitted-paste placeholder on the composer line (`UNSUBMITTED_PASTE_RE`, fixture from the real incident pane), re-sends Enter. A check-and-retry loop can't be beaten by a slower boot the way any fixed gap can.
3. **Shrink `childBuildPrompt`.** AC bodies replaced with AC *ids* + "read their full text in SPEC.md"; the raw ticket dropped (PLAN.md supersedes it, same rationale `stagePrompt` documents for late stages). The fixed template is size-asserted under half the argv budget; `subtask.prompt` remains agent-authored and unbounded, so the deferred path stays hardened by 1–2 for when it's still taken.
4. **One automatic spawn retry for children.** `settleChildRun`: a hard failure whose run produced zero agent output (no assistant/tool_use event) re-`startTask`s once before escalating to the build-abort cascade.

Gate tests: unsubmitted-paste regex vs the verbatim incident pane and vs a submitted-transcript pane; `childBuildPrompt` fixed-overhead size assertion; child boot-flake retries once, real child failures (agent output present) escalate immediately.

### F-2 — Barrier-check the `building` exit (fixes RC-2, the load-bearing fix)

`advancePipelineStage` case `"building"` must consult the DAG before advancing, using exactly the state `doTick` already reads (TASKS.json + child rows):

- All subtasks `merged` → advance to code-review (today's behavior, now earned).
- Anything not merged → **do not advance.** Emit a status event naming the unmet subtasks, then `void tickBuild(taskId)` — the tick is idempotent and serialized, so this either resumes real work (spawning now-unblocked or missing children) or no-ops safely.
- TASKS.json missing/invalid → `blocked: pipeline-failed` (same as `doTick`).

This single check makes RC-2's failure mode structurally unreachable: no parent-session turn — bounce fixup, auto-continuation, or user "continue" — can skip the build barrier, because the edge out of `building` no longer trusts the caller's context, only the DAG state. The fixup-turn bounce entry still works: its success now *re-ticks* rather than *advances*, and advancing happens when the barrier is actually satisfied.

Gate tests: parent turn succeeding mid-build with 0/2 children merged stays in `building` and re-ticks; with 2/2 merged advances to code-review; auto-continuation origin run cannot advance an unmet barrier (regression test written from this incident's exact sequence).

### F-3 — Never strand a settled child (fixes RC-3)

Replace `doCompleteChild`'s silent guard with explicit outcomes:

- Parent still actively building → merge (today's path).
- Parent left `building` (any stage or blocked) → mark the child `childMergeStatus: "merge-deferred"` (new value), move it to `review`, emit a status event on the parent (`subtask "X" completed after the build phase ended — merge deferred`). The work is preserved and visible instead of invisible.
- On every `doTick` entry and on the F-2 barrier check, `merge-deferred` children are merged first — so a parent bounced back into `building` (or resumed by F-2's re-tick) picks up late-arriving work before deciding anything else.

With F-2 in place this path becomes rare (the parent can no longer wrongly leave `building`), but boot-reconciliation and abort races can still produce late settles; those must never again converge to a forever-`running` card.

Gate tests: child settling while parent is in `code-review` lands on `review`/`merge-deferred` with a parent status event; re-entering `building` merges deferred children before spawning; the existing abort-cascade test still passes (a cancelled child is not "deferred", it's blocked — unchanged).

### F-4 — Route review/test bounces through the DAG, not around it (fixes RC-4)

`bounceOrBlock("building", ...)` from code-review and testing gains the same barrier awareness as F-2: if unmerged/unbuilt subtasks exist, the bounce re-enters via `tickBuild` (fresh-entry semantics, merging any `merge-deferred` children per F-3) instead of spawning a fixup turn. The single-agent fixup remains the bounce vehicle **only** when the barrier is fully satisfied — i.e. the review found defects in code that actually exists, which is the case the fixup turn was designed for. Additionally, `buildingPrompt`'s feedback preamble hardcodes "sent back by the Tester" (`pipeline-prompts.ts:497`) even when the Code Reviewer bounced; thread the originating stage through so the Builder knows which gate it is answering.

Gate test: a testing `fail` with unmerged subtasks re-ticks the DAG and spawns no fixup run; with all subtasks merged it spawns exactly the fixup run.

### F-5 — Progress-gate the revision budget (fixes RC-5)

1. **No-diff bounce = immediate block.** Record the parent worktree HEAD (plus a dirty-tree hash) when a bounce spawns; when the bounced stage's terminal run produces the *same* revise/fail verdict reason class and the tree is unchanged, block with a new reason string in `pipelineFeedback` ("bounce produced no changes — human input needed") **without waiting for the cap**. One wasted cycle is diagnosis; seventeen is a bug.
2. **Restart of a capped task must not re-increment.** Re-running a `revision-cap`-blocked task re-enters the stage; if it bounces again, the counter is already over cap and should block again *without* incrementing (the count is a diagnostic; 23-of-6 is noise). Alternatively clamp at cap+1. Either way the invariant becomes `revisionCount <= PIPELINE_REVISION_CAP + 1`.

Gate tests: two identical-reason bounces with identical HEAD block on the second, under cap; restart-after-cap does not grow the counter.

### F-6 — Verdict provenance and honest overrides (fixes RC-6)

1. **Only stage-prompted runs settle a stage.** Stamp pipeline-stage runs at spawn (e.g. `runs.origin = "pipeline-stage"`; the column exists and is already used for `continuation`). `advancePipelineStage` ignores terminal runs without the stamp: a user free-text turn on a pipeline task is a conversation, not a gate event. (F-2 already removes the worst consequence for `building`; this closes it for the verdict stages, where a "continue" turn's stray verdict line currently counts.)
2. **Make override a real control, not a jailbreak.** The legitimate need behind "set the verdict to approve" is a human waving a gate through. Give it an explicit path — a `POST /tasks/:id/pipeline-override` route (naming matches `pipeline-pause`/`pipeline-resume`; "Override gate" button on the blocked banner) that advances exactly one stage and records a durable "pipeline gate overridden by user" status event on the run log — so the audit trail is honest and the model never has to choose between obeying the user and lying to the pipeline. With provenance from (1), a coerced in-chat verdict line in a non-stage run simply stops working.

Gate tests: user-turn verdict line does not advance a verdict stage; override route advances exactly one stage and records the feedback marker.

### Explicitly out of scope

- The 429/API-error path (`1620ece4` blocked overnight mid plan-review): behaved as designed (block for manual retry); retry-with-backoff is a separate, pre-existing discussion.
- Plan-review/decompose loop quality: already addressed by `72e47c6` + `5c4eee4`, verified live in this very run (decompose passed 2 minutes after `5c4eee4` landed).
- The UI's rendering of stranded children (forever-green `running` badge): F-3 removes the state; no separate UI fix needed.

## 5. Recovering the 2DOT2DOT run (manual, no code changes needed)

The completed work is intact and mergeable today:

```bash
cd ~/.agetor-dev/worktrees/189d6702-5a45-4369-8657-1d6a31f9e866
git merge --no-ff feature/dot2dot-pipelinerun-with-sdd-contracts-p
git merge --no-ff feature/dot2dot-pipelinerun-with-sdd-vite-react
```

That lands `contracts-core` + `web-scaffold` on the pipeline branch, which unblocks `api-service` and `generator-service` per TASKS.json's DAG. But the DB rows (`childMergeStatus: "pending"`, parent `blocked: revision-cap`, stage `testing`) won't reflect it, so the pipeline itself can't resume cleanly until F-2/F-3 exist — treat a manual merge as salvage-for-inspection, or simply re-run the pipeline fresh after the fixes land (SPEC/PLAN/TASKS survive on the branch, so specify→analyze would be fast re-validation rather than regeneration).

## 6. Measurable outcome

A re-run of the same SDD on `~/2DOT2DOT` after F-1..F-6 must produce: all 7 subtasks with `childMergeStatus: "merged"`, application code present on the pipeline branch at code-review entry, zero no-diff bounce cycles, and `revisionCount <= 7`. The regression suite gains one end-to-end fake-driver test replaying this incident's exact event order (children die at boot → auto-continuation fires → children succeed late) and asserting the pipeline ends in `building` with both children merged — the state this run should have reached at 00:19 on Aug 13.

## 7. Open questions

1. **`merge-deferred` vs. auto-resume:** when a deferred child's merge lands via F-3, should a parent sitting in `blocked` auto-resume the build, or wait for a human click? Leaning human-click (blocked means a human should look), but auto-resume is defensible when the block reason was itself the missing work.
2. **Child retry budget:** F-1.4 proposes exactly one automatic boot-flake retry. Enough? A per-child cap of 2 with exponential spacing costs little; more risks masking a real environment break across the whole fleet of children.
3. **Should `building` fixup turns be allowed to commit?** `buildingPrompt` currently forbids committing ("a later stage handles that") but no later stage commits fixup work either — a fixup turn's changes reach code-review as a dirty tree. Works, but the no-diff detection in F-5 must hash the dirty tree, not just HEAD, precisely because of this. Pinning down who commits fixup work would simplify F-5.

## 8. F-7 — Make the RC-6 gate's leftover state visible and actionable (added 2026-08-14)

The second 2DOT2DOT incident: after the F-fixes shipped, a build aborted on an
api-error (F-2's cascade worked), the children's work was then finished via
follow-up conversation turns and auto-continuations — and the RC-6 provenance
gate correctly refused to merge on those settles. Correct, but invisible: four
children sat on `column: "running"` / `childMergeStatus: "pending"` with a
green dot, the parent waited in `building` forever, and the only trace was one
status line inside each child's stream. The user's read was "everything is
done, why is it stuck". The gate needs a visible state and an explicit exit.

As-built (same day):

- **Derived `Task.awaitingHandBack`** (`isAwaitingHandBack` in
  `shared/types.ts`, computed in `db.ts`'s `toTask` off a
  `current_run_status` correlated subquery): a build child, merge `pending`,
  not archived, whose CURRENT run `succeeded`. Never persisted.
- **Card + board honesty**: the card's state reads "awaiting hand-back" (not
  the column label) and joins the amber waiting-ring; the attention strip's
  "waiting on you" count and the waiting-first column sort share one
  `isWaitingOnHuman` predicate (`board-status.ts`).
- **Explicit hand-back** (`orchestrator.ts`'s `handBackChild`, route
  `POST /tasks/:id/hand-back`, RunPanel's `HandBackBanner`): the human's
  click supplies the "this work is done" judgment RC-6 refuses to infer from
  a turn ending cleanly. Deterministic from there — park as `merge-deferred`
  (F-3's pickup state) and `tickBuild` the parent if it's actively building;
  merge, barrier, advance, and conflict-abort all reuse the scheduler's
  existing paths. No fresh agent turn needed ("Re-run build turn" stays as
  the agent-verifies-first alternative).
- **Guards mirror the flag**: only a pending child off a succeeded run;
  in-flight and failed runs are rejected with pointed reasons (409 at the
  route — the state can go stale between poll and click).

Gate tests: 4 in `orchestrator-pipeline-guards.test.ts` (flag derivation,
guards, blocked-parent parking, building-parent tick handoff incl. the
merge-failed abort path), 3 in `board-status.test.ts` (predicate, strip,
sort). Measurable outcome: the stuck state now renders as an amber
"awaiting hand-back" card with a one-click recovery instead of a permanent
green "Running".
