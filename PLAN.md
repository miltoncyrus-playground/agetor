# Plan — cut redundant full-suite checks and unbounded child debugging

Extends `docs/plans/pipeline-token-efficiency.md` (O-1…O-11, already shipped). This plan
adds two new numbered entries there — **O-12** (Tester precheck → `## Project commands`
handoff) and **O-13** (scoped/fast check preference + child-build debugging bound) — and
touches exactly three production files plus `package.json`/a new script plus the doc:

- `src/bun/repo-profile.ts` — scoped-command detection, `renderProjectCommands` skip-set param
- `src/bun/pipeline-precheck.ts` — small pure helper to derive the skip set
- `src/bun/orchestrator.ts` — `pipelinePromptExtras` reordering to wire the skip set through
- `src/bun/pipeline-prompts.ts` — `childBuildPrompt` debugging-discipline paragraph
- `package.json` + new `scripts/test-changed.ts` — this repo's own scoped test check (AC-7)
- `docs/plans/pipeline-token-efficiency.md` — appended O-12/O-13 entries (AC-14)

No changes to `precheckPasses`, `testerSkipEnabled`, `precheckEnabled`, or any of O-1…O-11's
mechanisms (AC-12). Every new code path is fail-open per AC-13: an exception or "nothing
detected" falls through to exactly today's rendering.

## 1. Finding 1 — omit an already-green check's runnable command from `## Project commands`

### 1a. `src/bun/repo-profile.ts`

Add an exported check-name type and thread an optional skip set through
`renderProjectCommands`:

```ts
export type CheckName = "typecheck" | "lint" | "test" | "build";
```

```ts
export function renderProjectCommands(
  profile: RepoProfile,
  opts: { installed: boolean; skipChecks?: ReadonlySet<CheckName> },
): string
```

In the loop that builds `known` / pushes `${label}: ${cmd}` lines, when `opts.skipChecks?.has(label)`
is true, drop that line entirely (no replacement text — this is the "dropped from the block
entirely" behavior the ticket asks for, distinct from the `install` line's replacement-prose
pattern, because `renderPrecheck`'s own "## Pre-run checks" block — see §3 below — already
narrates the pass/fail status; duplicating that narration here is exactly the redundant
friction Finding 1 identifies). `known.length === 0` after filtering must still correctly
report `""` only when there is *also* no install line to show — i.e. the existing "no known
commands at all → empty string" early-return should be evaluated on the *unfiltered* `known`
list (a profile with commands that are all skipped this turn should still render an empty
`## Project commands` block only if `profile.install` is also null and nothing else remains;
otherwise it should render just `install: …` with no check lines). Concretely: keep the
existing `known.length === 0 && profile.install === null` early return as-is (based on the
full/unscoped commands the profile detected — a profile with real commands is never treated
as "no known commands" just because this turn happens to skip all of them), and instead apply
`skipChecks` only when deciding whether to push each individual `${label}: ${cmd}` line.

No other caller passes `skipChecks` (`opts.skipChecks` defaults to absent → identical output
to today, satisfying AC-3/AC-5's "unchanged" requirement structurally, not just as an
assertion).

### 1b. `src/bun/pipeline-precheck.ts`

Add a small pure helper next to `precheckPasses`:

```ts
/** Which of a precheck's commands passed — the skip-set `renderProjectCommands` uses to
 *  drop an already-confirmed-green check's runnable line for this Tester turn (Finding 1 /
 *  O-12). Import `CheckName` from repo-profile.ts so the return type lines up with
 *  `renderProjectCommands`'s param without relying on structural bivariance. */
export function precheckPassedChecks(summary: PrecheckSummary): Set<CheckName> {
  return new Set(summary.results.filter((r) => r.ok).map((r) => r.name));
}
```

(`import type { CheckName } from "./repo-profile.ts";` at the top — pipeline-precheck.ts
already imports `RepoProfile` from there, so this doesn't add a new dependency edge.)

### 1c. `src/bun/orchestrator.ts` — `pipelinePromptExtras`

Reorder so the O-5 precheck read happens *before* the O-4 project-commands block (today it's
after), and feed its result into `renderProjectCommands`:

```ts
async function pipelinePromptExtras(task, cwd, log): Promise<StageExtras> {
  const extras: StageExtras = {};
  const isChild = task.parentTaskId != null;
  const stage = task.pipelineStage;

  // O-5/O-12: read the precheck FIRST so the testing stage's own
  // ## Project commands block (below) can omit an already-green check's
  // runnable line instead of just narrating it — Finding 1. Read failure
  // degrades to "no precheck" here, which also disables the omission; it
  // never blocks the run.
  let precheckSummary: PrecheckSummary | null = null;
  if (stage === "testing") {
    try {
      precheckSummary = pipelineState.getPrecheck(task.id);
      extras.precheck = precheckSummary;
    } catch (err) {
      console.error(`[agetor] precheck read failed for task ${task.id}:`, err);
    }
  }

  if (isChild || (stage != null && COMMAND_RUNNING_STAGES.has(stage))) {
    try {
      const profile = readRepoProfile(cwd);
      let installed = existsSync(join(cwd, "node_modules"));
      if (profile.install && autoInstallEnabled()) { /* unchanged */ }
      const skipChecks = precheckSummary ? precheckPassedChecks(precheckSummary) : undefined;
      extras.projectCommands = renderProjectCommands(profile, { installed, skipChecks }) || null;
    } catch (err) {
      console.error(`[agetor] repo profile failed for task ${task.id}:`, err);
    }
  }

  // O-11 handoff, O-6 review diff: unchanged, in place.
  // (the old standalone "O-5" block at the bottom is deleted — folded into the top of this
  // function above.)
  return extras;
}
```

Add `precheckPassedChecks` to the existing `import { runPipelinePrecheck, precheckPasses,
precheckEnabled, testerSkipEnabled } from "./pipeline-precheck.ts"`.

`precheckSummary` is `null` for every non-testing stage and for a testing turn with no stored
precheck (fresh pass, AC-3) — `skipChecks` stays `undefined` in both cases, so
`renderProjectCommands` behaves exactly as before. This satisfies AC-1 (green check's command
omitted), AC-2 (a failed or never-run check's command still shown — it's simply absent from
`skipChecks`), and AC-3 (no precheck at all → unchanged).

## 2. Finding 2 — prefer a diff-scoped check over the full one when the project exposes one

### 2a. `RepoProfile` shape (`src/bun/repo-profile.ts`)

Add four new nullable fields, one per check, holding the *scoped* command when detected:

```ts
export interface RepoProfile {
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null;
  install: string | null;
  typecheck: string | null;
  lint: string | null;
  test: string | null;
  build: string | null;
  /** Fast, change-scoped variant of each check above, when the project exposes one under
   *  the `<check>:changed` script-name convention (O-13) — e.g. `test:changed` alongside
   *  `test`. Independent per check (AC-6): a project may have `test:changed` and no
   *  `lint:changed`. Only ever set when the FULL command for that same check also exists —
   *  a scoped variant is a fast alternative for an existing check, not a way to invent one.
   *  `renderProjectCommands` prefers this over the full command when rendering; nothing
   *  else (in particular `runPipelinePrecheck`, the deterministic Tester-skip gate) reads
   *  these fields — the pipeline's own correctness gate always uses the full command, so a
   *  diff-scoped check can never weaken what "green" means for skipping the Tester. */
  typecheckScoped: string | null;
  lintScoped: string | null;
  testScoped: string | null;
  buildScoped: string | null;
  workspaces: boolean;
  lockfile: string | null;
}
```

Update `EMPTY_PROFILE` with the four new `null`s.

### 2b. Detection (`detectRepoProfileFromFiles`)

Add a `hasScoped(label)` check (`hasScript(\`${label}:changed\`)`) alongside the existing
`hasScript`, and populate the four new fields, each gated on the corresponding full command
existing:

```ts
typecheck: typecheckKey ? runScriptCommand(manager, typecheckKey) : null,
typecheckScoped: typecheckKey && hasScript("typecheck:changed") ? runScriptCommand(manager, "typecheck:changed") : null,
lint: hasScript("lint") ? runScriptCommand(manager, "lint") : null,
lintScoped: hasScript("lint") && hasScript("lint:changed") ? runScriptCommand(manager, "lint:changed") : null,
test: hasScript("test") ? runScriptCommand(manager, "test") : null,
testScoped: hasScript("test") && hasScript("test:changed") ? runScriptCommand(manager, "test:changed") : null,
build: hasScript("build") ? runScriptCommand(manager, "build") : null,
buildScoped: hasScript("build") && hasScript("build:changed") ? runScriptCommand(manager, "build:changed") : null,
```

Document the convention inline: the scoped script is always looked up under the **canonical
label** (`typecheck:changed`, not e.g. `tsc:changed`), regardless of which alias
(`TYPECHECK_SCRIPT_KEYS`) satisfied the full command — so a project whose typecheck runs via
a `tsc` script still exposes its fast path as `typecheck:changed`. This is the "recognized
naming convention" AC-4 through AC-7 refer to; document it in this same comment since it's
the concrete answer to the SPEC's open judgment call.

### 2c. `renderProjectCommands` prefers the scoped command

Change the `commands` tuple list to carry both variants and pick per line:

```ts
const commands: Array<[CheckName, string | null, string | null]> = [
  ["typecheck", profile.typecheck, profile.typecheckScoped],
  ["lint", profile.lint, profile.lintScoped],
  ["test", profile.test, profile.testScoped],
  ["build", profile.build, profile.buildScoped],
];
const known = commands.filter((c): c is [CheckName, string, string | null] => c[1] !== null);
...
for (const [label, cmd, scopedCmd] of known) {
  if (opts.skipChecks?.has(label)) continue;
  lines.push(`${label}: ${scopedCmd ?? cmd}`);
}
```

`known`'s existence check (whether a check is "known" at all) stays keyed on the *full*
command per §1a's note — a scoped-only script with no full script is never surfaced (a
scoped variant is defined relative to an existing check, not a way to introduce a new one).
The rendered line shows only one command (whichever is preferred), so the ~400-byte budget
noted in the module doc comment doesn't grow — this is a substitution, not an addition. This
independently applies to every `COMMAND_RUNNING_STAGES` stage (building, code-review,
testing) and to build children (`isChild` branch in `pipelinePromptExtras`), since they all
go through the same `renderProjectCommands` call — Finding 2's own example (the 136-message
child) is itself a `renderProjectCommands` consumer via the `isChild` branch, so fixing the
one function fixes all of them.

### 2d. This repo's own scoped test check (AC-7)

Add to `package.json`'s `scripts`:

```json
"test:changed": "bun scripts/test-changed.ts"
```

New file `scripts/test-changed.ts` (Bun script, no new dependency):

1. Determine a base ref: `process.env.AGETOR_TEST_CHANGED_BASE`, else `git merge-base HEAD
   main` (fall back to `origin/main` if plain `main` doesn't resolve), else `HEAD~1` if
   neither resolves (a shallow clone / detached first commit).
2. Collect changed paths: `git diff --name-only <base>...HEAD` plus `git diff --name-only
   HEAD` (uncommitted working-tree changes too — a build child's Tester precheck already
   requires a commit before this stage runs, but running this script by hand mid-edit should
   still be useful).
3. From the changed paths, compute the test files to run:
   - any changed path that already matches this repo's test-file convention
     (`*.test.ts(x)` — see `TEST_PATH_PATTERNS` in `pipeline-precheck.ts` for the existing
     convention list this repo already relies on) is included directly;
   - any other changed `*.ts`/`*.tsx` file is checked for a sibling `<basename>.test.ts` (or
     `.test.tsx`) in the same directory, included if it exists.
4. Dedupe the resulting file list. If it's empty, print a one-line note ("no test files
   affected by this diff") and exit 0 — a deliberately unconcerning outcome, since AC-6/the
   unreferenced-AC check in `pipeline-precheck.ts` is the mechanism that catches a diff with
   no test coverage at all; this script's job is only to be a faster stand-in for `bun test`
   when there *are* affected tests, never an authority on "nothing needs testing."
5. Otherwise run `bun test <files...>` (`Bun.spawn`, inherit stdio, propagate its exit code
   via `process.exit`).

This script is a convenience the pipeline's `renderProjectCommands` prefers per §2c; it is
**never** what `runPipelinePrecheck` (the deterministic Tester-skip gate) runs — that
continues to call `profile.test` (the full `bun test`), unchanged, so the skip-Tester
decision's correctness bar doesn't shrink (AC-12, and the constraint against changing
`precheckPasses`/`testerSkipEnabled`).

### 2e. Typecheck: stays full-project, documented (AC-8)

Decision: **no `typecheck:changed` script for this repo.** Rationale to record verbatim in
the docs update (§4 below):

- `tsc --noEmit` in this repo's non-project-references config type-checks the whole program
  as one unit — a changed file's type can affect callers anywhere in the tree, so a
  file-scoped subset of `tsc` invocations would under-report errors the diff actually
  introduces (the same risk the ticket itself calls out).
- Getting genuine per-file/per-package scoping would mean splitting the codebase into
  TypeScript project references (`tsc -b`), which is a real architectural change with its own
  maintenance cost (separate `tsconfig.json` per boundary, `references` graph upkeep) —
  disproportionate to this ticket's scope.
- A lower-risk partial win — turning on `--incremental` (a cached `.tsbuildinfo`, still a
  full-project check, just faster on repeat invocations within the same worktree) — is
  deliberately **not** included in this change either, to keep this ticket's blast radius to
  what Finding 2 asks for; note it in the doc as a considered-but-deferred follow-up.

No code change for this decision beyond the documentation entry — `profile.typecheckScoped`
simply stays `null` for this repo since no `typecheck:changed` script exists, which is
exactly the fallback path AC-5 requires.

## 3. Finding 3 — bound a build child's debugging effort (prompt-only, no enforcement)

`src/bun/pipeline-prompts.ts`, `childBuildPrompt`:

Add one constant near the other sizing knobs (`DECOMPOSE_SINGLE_SUBTASK_MAX_FILES` etc.):

```ts
/** Rough tool-call count past which a build child should stop iterating and consolidate
 *  (Finding 3 / O-13): commit what's working and report what's unresolved instead of
 *  open-ended debugging. Picked well above what a normally-scoped single/few-file slice
 *  needs for a couple of edit-and-verify cycles, and far below the 95-Bash-call runaway
 *  session that motivated this — a guideline, not a hard trigger, so a slice that's
 *  genuinely proceeding normally is never made to feel urgency it doesn't need (SPEC edge
 *  case). Prose-only: there is no counter enforcing this (no sandboxing changes, per SPEC's
 *  non-goals) — it only shapes what the prompt says.  */
export const CHILD_DEBUG_CONSOLIDATE_TOOL_CALLS = 40;
```

Insert a new paragraph into `childBuildPrompt`'s `body`, between `${subtask.prompt}` and the
existing "When you're done, commit…" paragraph:

```ts
const verificationBlock =
  `\n\nVerify your work with what's already available (this repo's own typecheck/lint/test ` +
  `commands, and any relevant e2e specs) instead of starting a second, separate long-running ` +
  `process of your own (e.g. another dev server). If you truly cannot verify without a ` +
  `running instance of the app, say so as a limitation in your final message instead of ` +
  `improvising one.\n\n` +
  `If you're well past what a change this size should normally take (rough guide: more than ` +
  `about ${CHILD_DEBUG_CONSOLIDATE_TOOL_CALLS} tool calls, or repeated failed attempts at the ` +
  `same fix), stop: commit what's working and state plainly in your final message what ` +
  `remains unresolved, rather than iterating indefinitely.`;
```

and splice it in: `...${acBlock}${filesBlock}\n\n${subtask.prompt}${verificationBlock}\n\n` +
`When you're done, commit...`. This satisfies AC-9 (verify with existing tooling, not a
duplicate process), AC-10 (report the limitation instead of improvising one), and AC-11 (a
soft consolidation checkpoint). Measured addition is ≈650 bytes; combined with the existing
fixed-overhead budget test's ~1092-byte baseline this stays comfortably under that test's
existing 2048-byte ceiling (verify after wording is finalized — do not raise the 2048 ceiling
to make room; keep the added text tight instead, since the ceiling exists to keep the
fast-argv-launch path available per the function's own doc comment).

This block is added to `childBuildPrompt` only, not `buildingPrompt` (the non-decomposed
single-Builder-stage path) — the ticket scopes Finding 3's evidence and fix specifically to
the build-child path, and `buildingPrompt` is out of scope for this change.

## 4. `docs/plans/pipeline-token-efficiency.md` (AC-14)

Append a new `## 9. Follow-up (2026-09-13): cutting redundant checks and unbounded child
debugging` section after the existing `## 8. As built` section (do not edit §1–§8's existing
numbers/findings). Content:

- One paragraph recapping the two confirmed root causes from the live 38.8M-token run
  (linking back to this ticket's Finding 1/2/3, and to §2.3's "quadratic in message count"
  factor this addendum specifically targets).
- A table in the same style as §8's, with two new rows:

  | Item | Where | Verified by | Kill switch |
  | --- | --- | --- | --- |
  | O-12 Tester precheck → project-commands handoff | `repo-profile.ts` `renderProjectCommands` skip-set param; `pipeline-precheck.ts` `precheckPassedChecks`; `pipelinePromptExtras` in `orchestrator.ts` | `repo-profile.test.ts`, `pipeline-precheck.test.ts`, token test file | none (falls back to unfiltered rendering on any error) |
  | O-13 scoped/fast check preference + child debugging bound | `repo-profile.ts` (`*Scoped` fields, `<check>:changed` convention); `package.json` `test:changed` + `scripts/test-changed.ts`; `pipeline-prompts.ts` `childBuildPrompt` | `repo-profile.test.ts`, `pipeline-prompts.test.ts` | none (falls back to the full command when no scoped script exists) |

- The AC-8 typecheck decision and rationale from §2e above, stated plainly (so it's
  discoverable from the doc, not just this now-deleted PLAN.md/SPEC.md).
- Re-run instructions: `bun run eval:pipeline:tokens` against a fresh pipeline run whose
  Tester stage actually spawns (i.e. a run with an unreferenced AC, so the Tester isn't
  skipped outright) and confirm its transcript no longer re-runs a check the precheck already
  reported green.
- Note the ticket's explicit non-goal (a trimmed pipeline-specific CLAUDE.md variant for when
  the pipeline targets this repo itself) as still open, cross-referencing the existing §7
  open-questions list rather than duplicating it.

Do not alter any previously recorded measurement, table, or "As built" entry — this is an
append-only addition per AC-14 and the ticket's explicit instruction.

## 5. Tests

- **`src/bun/repo-profile.test.ts`**
  - Update the handful of exact `RepoProfile` object literals (`toEqual`) to include the four
    new `*Scoped: null` fields (the "npm with package-lock" test, the "no package.json" test,
    the "invalid JSON" test's `empty` literal).
  - New: a fixture with `scripts: { test: "vitest run", "test:changed": "vitest related" }`
    (etc. for typecheck) asserts `profile.testScoped === "npm run test:changed"` (or the
    manager-appropriate form) and that `renderProjectCommands` renders `test: npm run
    test:changed` (scoped preferred).
  - New: a fixture with only `test:changed` and no `test` script asserts `testScoped` stays
    `null` (full command must exist first).
  - New: a fixture with `test:changed` but not `lint:changed` asserts `test` is scoped and
    `lint` (if present) still renders its full command (AC-6, independence).
  - New: `renderProjectCommands` with a `skipChecks` set containing one known check name
    asserts that check's line is entirely absent and the others are unaffected; called with
    no `skipChecks` at all asserts byte-identical output to before this change (reuse the
    existing "full profile … under 400 bytes" fixture verbatim).
  - New: `renderProjectCommands` with `skipChecks` covering *every* known check but
    `profile.install` non-null still renders the block (just the install line) — the "no
    known commands" early return must stay keyed on the unfiltered command set, not the
    post-skip one.

- **`src/bun/pipeline-precheck.test.ts`**
  - New: `precheckPassedChecks` returns the `ok:true` result names only, from a summary with
    a mix of passing/failing results; empty summary → empty set.

- **`src/bun/orchestrator-pipeline-token.test.ts`**
  - New: seed `pipeline_stage_state.precheck` (or drive it the same way the existing "a
    failing command spawns the Tester…" test does — via a real `runTesterGate` pass with one
    command green and one red/unreferenced) and assert the resulting Tester prompt's `##
    Project commands` block contains the failed/unreferenced check's runnable line but *not*
    the green one's (AC-1/AC-2). Pair it with a same-shape assertion that when nothing has
    been precomputed (fresh testing-stage entry, no precheck stored) the block is unchanged
    from today (AC-3) — this can extend the existing "no package.json → the Tester is spawned
    exactly as before" test or sit alongside it with a package.json present.
  - Do not weaken or remove any of the existing 5 tester-gate tests (lines ~209–292 as they
    stand today) — they continue to pass unmodified since `skipChecks` is only populated when
    a precheck summary is actually stored for that turn, and those tests' assertions on `##
    Pre-run checks` (a different block, from `renderPrecheck`) are untouched by this change.

- **`src/bun/pipeline-prompts.test.ts`**
  - New: `childBuildPrompt` output contains the new fixed-string guidance (assert on stable
    substrings like `"do not improvise one"`, `"say so as a limitation"`, `"stop: commit
    what's working"` — match whatever exact wording lands in §3, the point is a fixed-string
    presence check per the ticket's own guidance for this AC, matching how O-9's existing
    bound instructions are tested).
  - Update the existing "fixed overhead stays well inside the claude argv budget" test only if
    the byte math requires it — per §3 above, the wording is sized to keep this test's
    existing `toBeLessThan(2048)` assertion passing unmodified; do not raise the ceiling to
    accommodate the new text.

## 6. Definition of done checklist (for Build/Test stages)

- `bun run typecheck` and `bun test` green, including every new/updated test above.
- A fresh `bun run eval:pipeline:tokens` run (per §4) shows the Tester no longer re-running a
  precheck-confirmed-green check.
- `docs/plans/pipeline-token-efficiency.md` has the new appended section; nothing above it
  changed.
- Every new mechanism verified fail-open: a thrown error inside the new `skipChecks`
  derivation, or a profile with no `:changed` scripts anywhere, renders prompts byte-identical
  to pre-change behavior (AC-13).
