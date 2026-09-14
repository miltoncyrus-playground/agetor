# PLAN — O-15: stage-gated + files-scoped trimming of "Orchestration flow"

## Approach summary

Extend the existing O-14 module (`src/bun/claude-md-filter.ts`) and its one
call site (`resolvePipelineSystemPromptFile` in `src/bun/orchestrator.ts`)
with two more pure cuts against the `"### Orchestration flow"` heading,
applied in the same `filterClaudeMdForPipeline` entry point that already
narrows `"### Agent command shape"` and drops `"## JubarteAI Agent
Identity"`. No new top-level filter function, no new kill switch — both
layers ride the existing `AGETOR_PIPELINE_CLAUDE_MD_FILTER` gate in
`resolvePipelineSystemPromptFile`, which already returns the raw path
*before* `filterClaudeMdForPipeline` is ever called when the flag is `"0"`
(AC-10 is satisfied for free, no extra code).

Both new cuts key off the section's numbered-item structure (`N. **Title**`
at the start of a line, exactly like the existing per-agent-kind bullets
O-14 already parses) rather than sub-heading text, because the section has
no sub-headings — the items *are* the structure.

- **Layer 1** (stage gate, whole section): for the five stages that never
  touch application source (`specify`, `clarify`, `planning`, `plan-review`,
  `decompose`), cut the body from the start of item 5's marker to the end of
  the section, keeping items 1–4 verbatim. AC-1, AC-2.
- **Layer 2** (files-overlap, four items only): for every other in-scope
  turn (code-review, testing, building, or a build child), keep the section
  and — only for the four items titled "Task context menu", "Tasks from
  issues", "Shared task-composition modules", "`@` file references" — drop
  an item when it has at least one backtick-quoted `/`-containing hint in
  its own text, the turn has a non-empty file list, and every hint fails to
  overlap every file (directory-prefix semantics, both directions). AC-4
  through AC-9, AC-11, AC-12.

Title-matching (not just ordinal position) is used to pick *which* items are
eligible for Layer 2, per SPEC.md's own assumption that filterable-item
identity should survive document reordering; ordinal numbers are still what
delimits each item's span (there's no other delimiter available), and
Layer 1's cut point is still literally "the item numbered 5" per the
ticket's fixed 1–4 / 5–13 split.

## 1. `src/bun/stage-handoff.ts`

Export the existing private `inLane` (line ~283) unchanged — add the
`export` keyword and extend its doc comment to note it is now shared with
`claude-md-filter.ts` (O-15) so the directory-prefix semantics used for
child-handoff lane filtering and for the orchestration-flow overlap check
can never drift apart. No behavior change; `renderHandoff`'s existing call
site keeps working as-is.

## 2. `src/bun/build-scheduler.ts`

Extract the subtask-files lookup already inlined at the `onlyPaths:
subtask.files.length > 0 ? subtask.files : undefined` computation (current
line ~280, inside the DAG-scheduler loop over `parsed.plan.subtasks`) into a
new exported pure function, and have that call site use it too, so there is
exactly one place this resolution happens (the ticket's "don't re-derive it
a second way" instruction):

```ts
/** A subtask's own `files` ownership list — the same scoping already used
 *  for the child's stage-handoff `onlyPaths`, reused unchanged by O-15's
 *  orchestration-flow overlap filter. `null` when the parent's TASKS.json
 *  can't be read/parsed, the subtask isn't declared, or it declares no file
 *  ownership (owns the whole workspace) — callers must treat `null` as "no
 *  signal", not "no files". Never throws. */
export function subtaskFilesForChild(parent: Task, subtaskId: string): string[] | null {
  try {
    const planPath = join(parent.worktreePath ?? parent.workdir, PIPELINE_BUILD_PLAN_FILE);
    if (!existsSync(planPath)) return null;
    const parsed = parseBuildPlan(readFileSync(planPath, "utf8"));
    if (!parsed.ok) return null;
    const subtask = parsed.plan.subtasks.find((s) => s.id === subtaskId);
    if (!subtask) return null;
    return subtask.files.length > 0 ? subtask.files : null;
  } catch {
    return null;
  }
}
```

Update the existing `onlyPaths` line in the scheduler loop to
`subtaskFilesForChild(parent, subtask.id) ?? undefined` — same result as
today (the loop already has `parent` and `subtask` in scope), now backed by
the shared function instead of a private inline ternary.

## 3. `src/bun/claude-md-filter.ts`

Add, alongside the existing `AGENT_COMMAND_SHAPE_HEADING` /
`JUBARTEAI_HEADING`:

```ts
import { inLane } from "./stage-handoff.ts";

export const ORCHESTRATION_FLOW_HEADING = "### Orchestration flow";
```

**Item parsing** (shared by both layers): a numbered item starts a line as
`N. **Title**` (mirrors `BULLET_START_RE`'s existing style); reuse
`findHeadingSection` to bound the section body first.

```ts
const ITEM_MARKER_RE = /^(\d+)\.\s+\*\*([^*]+)\*\*/gm;

interface OrchestrationItem { num: number; title: string; start: number; end: number }

function locateOrchestrationItems(body: string): OrchestrationItem[] {
  const matches = Array.from(body.matchAll(ITEM_MARKER_RE));
  return matches.map((m, i) => ({
    num: parseInt(m[1]!, 10),
    title: m[2]!.trim(),
    start: m.index!,
    end: matches[i + 1]?.index ?? body.length,
  }));
}
```

**Layer 1** — wholesale drop of items 5–13, fail-open if item 5's marker
can't be found (e.g. the section's been restructured since):

```ts
const ORCHESTRATION_DROP_FROM_ITEM = 5;

function cutOrchestrationFlowStageGate(text: string): string {
  try {
    const section = findHeadingSection(text, ORCHESTRATION_FLOW_HEADING);
    if (section == null) return text;
    const { headingLineEnd, sectionEnd } = section;
    const body = text.slice(headingLineEnd, sectionEnd);
    const items = locateOrchestrationItems(body);
    const firstDrop = items.find((it) => it.num === ORCHESTRATION_DROP_FROM_ITEM);
    if (!firstDrop) return text;
    const newBody = body.slice(0, firstDrop.start);
    return text.slice(0, headingLineEnd) + newBody + text.slice(sectionEnd);
  } catch {
    return text;
  }
}
```

**Layer 2** — files-overlap filter, scoped to the four titles:

```ts
const FILTERABLE_ITEM_TITLES = new Set([
  "Task context menu",
  "Tasks from issues",
  "Shared task-composition modules",
  "`@` file references",
]);

const HINT_RE = /`([^`\n]+)`/g;

function extractPathHints(itemText: string): string[] {
  const hints = new Set<string>();
  for (const m of itemText.matchAll(HINT_RE)) {
    const v = m[1]!.trim();
    if (v.includes("/")) hints.add(v);
  }
  return [...hints];
}

function pathsOverlap(a: string, b: string): boolean {
  return inLane(a, b) || inLane(b, a);
}

function cutOrchestrationFlowOverlap(text: string, files: string[] | null | undefined): string {
  if (!files || files.length === 0) return text; // AC-7: no signal -> keep everything
  try {
    const section = findHeadingSection(text, ORCHESTRATION_FLOW_HEADING);
    if (section == null) return text;
    const { headingLineEnd, sectionEnd } = section;
    const body = text.slice(headingLineEnd, sectionEnd);
    const items = locateOrchestrationItems(body);
    const drops: OrchestrationItem[] = [];
    for (const item of items) {
      if (!FILTERABLE_ITEM_TITLES.has(item.title)) continue; // AC-9
      const hints = extractPathHints(body.slice(item.start, item.end));
      if (hints.length === 0) continue; // AC-12: no hints -> keep
      const overlaps = hints.some((h) => files.some((f) => pathsOverlap(f, h)));
      if (!overlaps) drops.push(item); // AC-4/AC-5
    }
    if (drops.length === 0) return text;
    let newBody = "";
    let cursor = 0;
    for (const d of drops) {
      newBody += body.slice(cursor, d.start);
      cursor = d.end;
    }
    newBody += body.slice(cursor);
    return text.slice(0, headingLineEnd) + newBody + text.slice(sectionEnd);
  } catch {
    return text;
  }
}
```

**Entry point** — extend `filterClaudeMdForPipeline`'s options (one entry
point, per the ticket's constraint) with optional fields defaulting to
"no-op", so every existing 2-arg call (`{ agentKind }`) keeps behaving
exactly as before:

```ts
export interface FilterPipelineContext {
  agentKind: string;
  /** Pipeline stage of this turn; null/undefined for a build child (whose
   *  own `Task.pipelineStage` is always null) or any non-pipeline call. */
  pipelineStage?: string | null;
  /** True for a build child (`task.parentTaskId != null`). Always keeps the
   *  section (Layer 1 never drops it) and goes straight to Layer 2. */
  isChild?: boolean;
  /** Stage-appropriate file list for Layer 2. Missing/empty = no signal,
   *  keep every filterable item (AC-7). */
  files?: string[] | null;
}

const ORCHESTRATION_DROP_STAGES = new Set(["specify", "clarify", "planning", "plan-review", "decompose"]);

function shouldDropOrchestrationFlowSection(opts: FilterPipelineContext): boolean {
  if (opts.isChild) return false;
  return opts.pipelineStage != null && ORCHESTRATION_DROP_STAGES.has(opts.pipelineStage);
}

export function filterClaudeMdForPipeline(text: string, opts: FilterPipelineContext): string {
  let out = text;
  out = cutAgentCommandShapeSection(out, opts.agentKind);
  out = cutJubarteSection(out);
  if (shouldDropOrchestrationFlowSection(opts)) {
    out = cutOrchestrationFlowStageGate(out);
  } else {
    out = cutOrchestrationFlowOverlap(out, opts.files);
  }
  return out;
}
```

Every new function follows the module's existing convention: pure,
try/catch-wrapped, returns the input unchanged on any failure to locate what
it's looking for.

## 4. `src/bun/orchestrator.ts`

**Resolve the stage-appropriate file list.** Add a pure(ish) helper next to
`resolvePipelineSystemPromptFile` (uses only `tasks.get`, no process/IO of
its own beyond what its callee already does):

```ts
/** `git diff --stat` line shape: `<path> | <n> <bar>` or a rename
 *  (`old => new` or `dir/{old => new}/file`). Parses whichever leading
 *  path(s) each line names; unparseable lines are skipped (fewer files in
 *  the signal only makes Layer 2 more conservative, never less). */
export function parseReviewDiffStatPaths(stat: string): string[] {
  const out: string[] = [];
  for (const line of stat.split("\n")) {
    const m = /^\s*(.+?)\s+\|\s+\d+/.exec(line);
    if (!m) continue;
    const p = m[1]!.trim();
    if (!p) continue;
    const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
    if (brace) {
      out.push(`${brace[1]}${brace[2]}${brace[4]}`.trim(), `${brace[1]}${brace[3]}${brace[4]}`.trim());
      continue;
    }
    const arrow = /^(.*) => (.*)$/.exec(p);
    if (arrow) {
      out.push(arrow[1]!.trim(), arrow[2]!.trim());
      continue;
    }
    out.push(p);
  }
  return out.filter(Boolean);
}

/**
 * O-15 Layer 2 signal: the stage-appropriate file list for a pipeline turn,
 * or `null` when none exists for this stage (testing/building, by design —
 * no new git call is added for them) or resolution fails for any reason.
 * Exported for direct unit tests.
 */
export function pipelineOverlapFiles(task: Task, extras: StageExtras | null): string[] | null {
  if (task.parentTaskId != null && task.planSubtaskId != null) {
    const parent = tasks.get(task.parentTaskId);
    if (!parent) return null;
    return subtaskFilesForChild(parent, task.planSubtaskId);
  }
  if (task.pipelineStage === "code-review") {
    const stat = extras?.reviewDiff?.stat;
    if (!stat) return null;
    const paths = parseReviewDiffStatPaths(stat);
    return paths.length > 0 ? paths : null;
  }
  return null;
}
```

Import `subtaskFilesForChild` alongside the existing
`tickBuild, completeChildBuild, buildBarrierState` import from
`./build-scheduler.ts` (line ~145).

**Extend `resolvePipelineSystemPromptFile`** with an optional 4th
parameter, so every existing 3-arg call site/test keeps compiling and
behaving identically (defaults are exactly "no Layer 1/2 effect"):

```ts
export function resolvePipelineSystemPromptFile(
  claudeMdPath: string | null,
  agentKind: AgentKind,
  cwd: string,
  ctx: { pipelineStage?: Task["pipelineStage"]; isChild?: boolean; files?: string[] | null } = {},
): string | null {
  if (claudeMdPath == null) return null;
  if (!claudeMdFilterEnabled()) return claudeMdPath;
  let original: string;
  try {
    original = readFileSync(claudeMdPath, "utf8");
  } catch {
    return claudeMdPath;
  }
  let filtered: string;
  try {
    filtered = filterClaudeMdForPipeline(original, {
      agentKind,
      pipelineStage: ctx.pipelineStage ?? null,
      isChild: ctx.isChild ?? false,
      files: ctx.files ?? null,
    });
  } catch {
    return claudeMdPath;
  }
  // ...unchanged from here (degenerate-output / write-to-.agetor logic)
}
```

**Wire it at the call site** (currently ~line 1534–1537, inside
`startTaskInner`, where `task` and `extras` are both already in scope):

```ts
const lean = pipelineLeanContext(task, harness.kind, prepared.cwd);
const leanContext = lean
  ? {
      ...lean,
      appendSystemPromptFile: resolvePipelineSystemPromptFile(
        lean.appendSystemPromptFile ?? null,
        harness.kind,
        prepared.cwd,
        {
          pipelineStage: task.pipelineStage,
          isChild: task.parentTaskId != null,
          files: pipelineOverlapFiles(task, extras),
        },
      ),
    }
  : lean;
```

`extras` is the `StageExtras | null` already computed earlier in
`startTaskInner` (current line ~1404) — no new computation is added for
testing/building (per the ticket's explicit non-goal), and `extras` is
`null` for those stages' `pipelinePromptExtras` calls only in the sense that
`extras.reviewDiff` is simply never populated outside `code-review`, so
`pipelineOverlapFiles` returns `null` for them without any special-casing
beyond the `task.pipelineStage === "code-review"` check.

## 5. Tests

### `src/bun/claude-md-filter.test.ts`

- Add a second fixture with a synthetic `"### Orchestration flow"` section:
  items 1–4 (short, always-kept, no path hints needed), items 5–8 and 13
  (short filler, never eligible for Layer 2), and items 9–12 using the exact
  four titles, each with one or two distinctive backtick `/`-paths (e.g.
  item 9 → `` `src/mainview/lib/context-menu.ts` ``, item 10 →
  `` `src/bun/issue-task.ts` ``, etc.), followed by a sibling heading (mirrors
  the real file's `### Agent command shape` immediately after).
- Layer 1: for each of the five drop-stages, `filterClaudeMdForPipeline`
  with `{ agentKind: "claude-code", pipelineStage }` drops items 5–13
  (assert absence of each item's distinctive text) and keeps items 1–4 and
  everything outside the section (AC-1/AC-2). For the four keep-stages
  (`code-review`, `testing`, `building`, and `isChild: true` with
  `pipelineStage: null`), items 5–13 survive (AC-3) when no `files` are
  given.
- Layer 2, given a fixture `files` list:
  - drops an item only when every extracted hint fails to overlap (AC-4/
    AC-5/AC-12) — construct a `files` list that overlaps none of item 9–12's
    hints and assert all four are dropped, items 1–8/13 untouched.
  - keeps every item when `files` is `[]`/`undefined` (AC-7).
  - keeps an item when at least one hint overlaps — a `files` entry equal to
    (or nested under, or a parent directory of) one of item 11's hints, with
    the others still non-overlapping; assert item 11 survives while 9/10/12
    (non-overlapping) are dropped — proves the filter discriminates rather
    than being all-or-nothing (AC-6).
  - a fixture item titled one of the four names but with NO backtick `/`
    hints in its body is always kept regardless of `files` (edge case from
    SPEC.md).
  - items 1–8 and 13 are never affected by any `files` value, including one
    that would "match" text that happens to appear in them (construct such a
    case) — proves Layer 2 never touches non-filterable items even under a
    coincidental textual match (AC-9).
- A direct-import parity check: `import { inLane } from "./stage-handoff.ts"`
  and assert its documented cases (`inLane("a/b.ts", "a")` → true,
  `inLane("a.ts", "b")` → false, `inLane("a", "a")` → true) — since
  `claude-md-filter.ts` imports this exact function rather than a second
  copy, this is sufficient to guarantee identical behavior in both call
  sites; note that in a comment rather than re-deriving the same assertions
  against a private copy.
- Keep every existing test in the file unmodified.

### `src/bun/orchestrator-pipeline.test.ts` (build-scheduler has no
   dedicated test file — its coverage already lives alongside the
   orchestrator pipeline tests, e.g. `orchestrator-pipeline-guards.test.ts`/
   `orchestrator-pipeline-merge.test.ts`; add this next to the existing
   `onlyPaths`/handoff-for-children coverage, wherever that is)

- Add a focused test for `subtaskFilesForChild` (imported from
  `./build-scheduler.ts`): a parent with a written
  `TASKS.json` containing a subtask with a non-empty `files` array returns
  it; a subtask with `files: []` (or omitted) returns `null`; an unknown
  `subtaskId` returns `null`; a missing/invalid `TASKS.json` returns `null`.
  Confirm the existing DAG-scheduler test(s) covering the `onlyPaths`
  handoff behavior still pass unmodified (the refactor must not change
  `renderHandoff`'s observed input).

### `src/bun/orchestrator-pipeline.test.ts`

Add near the existing `─── trimmed CLAUDE.md for pipeline/child sessions
(O-14) ───` section (do not modify any existing test there):

- `parseReviewDiffStatPaths`: a plain stat line, a rename (`old => new`),
  a brace-rename (`dir/{old => new}/file.ts`), and a malformed line (no
  `|`) — the malformed line is skipped, not thrown.
- `pipelineOverlapFiles`: a child task (`parentTaskId`/`planSubtaskId` set,
  a real worktree with `TASKS.json` written) resolves via
  `subtaskFilesForChild` — assert it returns exactly the subtask's `files`;
  a `code-review` task with `extras.reviewDiff.stat` set resolves the parsed
  paths; a `testing`/`building` task (or any task with no matching branch)
  returns `null` with no `extras` access beyond the `code-review` check.
- `resolvePipelineSystemPromptFile` 4-arg form: build a fixture CLAUDE.md
  with a full-shaped `"### Orchestration flow"` section (items 1–13,
  filterable four titled correctly with distinctive hints) plus the O-14
  fixture's existing `"### Agent command shape"`/JubarteAI content, and
  assert: a `specify`-stage call drops items 5–13 entirely; a `code-review`
  call with a non-overlapping `files` list drops the four filterable items
  but keeps 1–8/13; a `testing`/`building` call with no `files` keeps
  everything; a `building`+`isChild:true` call with a `files` list
  overlapping exactly one of the four keeps that one and drops the other
  three (discriminating, not blanket).
- End-to-end spawn test extending the existing
  `"pipeline: startTask on a pipeline claude-code task writes a filtered
  CLAUDE.md for spawn"` pattern: create a parent pipeline task, seed
  `TASKS.json` with one subtask whose `files` list overlaps none of
  `src/mainview/**` (real repo paths, or synthetic ones matching the test's
  own CLAUDE.md fixture), start the child task directly (mirroring how
  `build-scheduler.ts` creates it — `parentTaskId`/`planSubtaskId` set), and
  assert the written `.agetor/CLAUDE.filtered.md` lacks the non-overlapping
  filterable items while keeping the overlapping one (if the fixture is
  built to have exactly one overlap) — this is the unit-test-level analogue
  of the Definition of done's live probe. Also assert a `testing`-stage spawn
  (no subtask, no reviewDiff) keeps all four filterable items present in the
  filtered file.
- Do not weaken or delete any O-14 test in this file.

## 6. Docs — `docs/plans/pipeline-token-efficiency.md`

Append (do not edit existing content) a new `## 10.` section, following the
`## 9.` follow-up's style:

- What shipped: Layer 1 stage gate (five stages drop items 5–13 wholesale)
  + Layer 2 files-overlap filter (items 9/10/11/12 only), both in
  `claude-md-filter.ts`, wired through the same
  `resolvePipelineSystemPromptFile` call site as O-14, gated by the same
  `AGETOR_PIPELINE_CLAUDE_MD_FILTER` switch (no new switch — state that the
  existing kill switch already gates `filterClaudeMdForPipeline` entirely,
  so no additional wiring was needed to cover the new layers).
- The five-stage / four-stage split, spelled out.
- The testing/building asymmetry, called out explicitly as intentional scope
  (no per-turn file signal exists for those two stages today; items 9–12
  stay unfiltered there by design, not by oversight) — cross-reference this
  plan document.
- Measured byte saving on a representative child-build turn (fill in from
  the live probe/end-to-end test's actual output — e.g. "`### Orchestration
  flow`'s N bytes narrow to M bytes (X%) when items 9/11/12 are dropped for
  a child whose subtask.files don't touch src/mainview/**").
- Kill switch: `AGETOR_PIPELINE_CLAUDE_MD_FILTER=0` (same as O-14, unchanged
  behavior when off).

## AC / non-goal traceability

- AC-1, AC-2 → Layer 1 (`cutOrchestrationFlowStageGate`), §3.
- AC-3 → `shouldDropOrchestrationFlowSection` false for the four keep-groups
  (code-review/testing/building/child), §3.
- AC-4, AC-5, AC-6, AC-12 → `cutOrchestrationFlowOverlap`'s per-item hint/
  overlap decision, §3.
- AC-7 → the `!files || files.length === 0` early return, §3; and
  `pipelineOverlapFiles` returning `null` for testing/building, §4.
- AC-8 → testing/building always resolve `files: null` in
  `pipelineOverlapFiles`, §4 (no new git call, per the ticket's non-goal).
- AC-9 → `FILTERABLE_ITEM_TITLES` gate inside the Layer 2 loop, §3.
- AC-10 → free, via the pre-existing `claudeMdFilterEnabled()` early return
  in `resolvePipelineSystemPromptFile`, unchanged.
- AC-11 → reuse of `inLane` (both directions via `pathsOverlap`), §1/§3.
- AC-13 → every new function is a pure string/array transform with no
  external state.
- Non-goals respected: stage groupings are hardcoded as given (no
  renegotiation); no new git/diff call added for testing/building; Layer 2
  touches only the four named items; nothing outside `"### Orchestration
  flow"` is touched; one switch, reused, not split (no compelling reason to
  split surfaced — the switch already fully gates the new code path before
  it runs).
