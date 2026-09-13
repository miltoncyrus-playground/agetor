# Plan — O-14: trimmed CLAUDE.md for pipeline/child sessions

## 0. Confirmed mechanism (read before writing code)

O-2 (`src/bun/orchestrator.ts`, `pipelineLeanContext`) already:
- returns `null` (full-context spawn, unchanged) unless `harnessKind === "claude-code"` AND (`task.pipelineStage != null || task.parentTaskId != null`) AND `leanContextEnabled()`.
- when active, resolves `appendSystemPromptFile` to `join(cwd, "CLAUDE.md")` if that file exists at the prepared worktree root, else `null`.
- `agents.ts` (`buildCommand`, ~line 551-561) only ever does `args.push("--append-system-prompt-file", opts.leanContext.appendSystemPromptFile)` plus set the two `CLAUDE_CODE_DISABLE_*` env vars — it has no opinion on the file's contents, so **agents.ts needs no changes at all** for this task.
- `pipelineLeanContext` is called inline in `startTask` (orchestrator.ts, ~line 1496) and its existing tests (`orchestrator-pipeline.test.ts` lines ~1179-1233) assert the exact literal path `path.join(withMd, "CLAUDE.md")` is returned when the fixture worktree has a `CLAUDE.md`. **`pipelineLeanContext` itself must not change** — those tests must keep passing unmodified. The filtering step is therefore a separate, new function applied to `pipelineLeanContext`'s output at the `startTask` call site, not a change inside `pipelineLeanContext`.

## 1. New pure module: `src/bun/claude-md-filter.ts`

Exports:

```ts
export function filterClaudeMdForPipeline(text: string, opts: { agentKind: string }): string
```

Also export the two heading sentinels as constants (mirrors `HANDOFF_HEADING` in `stage-handoff.ts`) so the module and its tests agree on exact strings, and so nothing else needs to hardcode them:

```ts
export const AGENT_COMMAND_SHAPE_HEADING = "### Agent command shape";
export const JUBARTEAI_HEADING = "## JubarteAI Agent Identity";
```

No filesystem or process access anywhere in this file — plain string in, string out.

### 1a. Generic heading-section bounds helper

A private helper `findHeadingSection(text, headingText)` that:
- splits `text` into lines, tracking each line's starting char offset (so we can slice back into the original string without re-joining lines and risking an off-by-one on trailing newlines).
- finds the **first** line whose trimmed content equals `headingText` exactly. Its heading level = the count of leading `#` chars (regex `/^(#{1,6})\s/`). Not found → return `null`.
- scans forward from the line after the heading for the first line that is *itself* a heading (matches the same `#{1,6}\s` pattern) whose level is `<=` the found heading's level. That line's start offset is the section end; if none found, the section runs to end-of-string.
- returns `{ headingStart, headingLineEnd, sectionEnd }` — `headingLineEnd` is the offset immediately after the heading line's own newline (start of the section body), so callers can keep the heading line untouched and only operate on the body.

This one helper serves both cuts below — "next heading of the same-or-higher level" is exactly "level `<=` the section heading's own level," which is what makes it correctly stop `### Agent command shape` at the next `###`-or-higher heading (in the live file today, `### Claude session lifecycle`) and stop `## JubarteAI Agent Identity` at end-of-file (or a future `##`-or-higher heading, per the ticket's explicit "don't assume it's always last").

### 1b. Cut 1 — Agent command shape bullets

Private `cutAgentCommandShapeSection(text, agentKind)`:
1. `findHeadingSection(text, AGENT_COMMAND_SHAPE_HEADING)` → `null` means the heading isn't there (renamed/missing) → return `text` unchanged (fail-open: this cut simply doesn't happen).
2. Take `body = text.slice(headingLineEnd, sectionEnd)`.
3. Match every bullet start in `body` with a global regex anchored to line start, e.g. `/^- \*\*`([\w.-]+)`\*\* →/gm` (confirmed live pattern in `CLAUDE.md` today: `- **\`claude-code\`** → driven through …`, one per line for `claude-code`, `codex`, `cursor`, `gemini`, `fx`, in that order — but the parser must not assume order or count, only the pattern). Collect `{ kind, index }` for every match via `matchAll`.
4. Zero matches found → return `text` unchanged (can't confidently locate any bullet; fail toward keeping everything).
5. Find the match whose captured `kind === agentKind`. Not found (unrecognized/future kind) → return `text` unchanged, per the ticket's explicit requirement.
6. Bullet boundaries: bullet `i`'s span is `[matches[i].index, matches[i+1]?.index ?? body.length)` — i.e. from its own bullet-start line up to the next bullet-start line (or end of body if last). This is what makes each bullet's full multi-line content (it runs many lines with embedded prose) travel with it regardless of length, without hardcoding a line count.
7. New body = `body.slice(0, matches[0].index)` (prose before the first bullet — currently just the intro paragraph, kept verbatim) + the one matching bullet's span. All four non-matching bullets are dropped; nothing after the last bullet inside the section is disturbed because the kept span for a non-last-bullet match already ends where the next bullet starts, and for the *last* bullet the span already runs to `body.length`, which is the trailing "Defaults preserve hands-off…" / "curated lists…" / "Override per-agent…" prose belongs to the *body*, not to any bullet span — so trailing prose after the bullets is currently swallowed into whichever bullet happens to be last in the file. **This is the one structural detail to get right**: bullets are matched in **file order**, not in `AgentKind` union order, so "the next bullet start, or `body.length` if this is the last match in the file" naturally attaches trailing section prose to whichever kind's bullet is physically last (today `fx`). To keep that trailing prose (`Defaults preserve hands-off behavior…`, `The curated lists…`, `Override per-agent…`) intact regardless of which kind is requested, compute the **true end of the kept bullet** as `matches[i+1]?.index ?? <index of the actual bullets-block end>`, where the bullets-block end is the index of whichever match is last in the array (`matches[matches.length - 1].index` marks the start of the *last* bullet, not the end of the block) — so: capture `bulletsEnd = matches[matches.length - 1].index` walked forward to the end of that last bullet's own text by finding the next non-bullet paragraph, OR — simpler and robust — treat "end of the last bullet, hence end of the bullets block" as: keep scanning past `matches[matches.length-1].index` for the next blank-line-followed-by-non-bullet-paragraph. **Simplify per the ticket's own instruction** instead of inventing a paragraph-boundary heuristic: the ticket says "take its end as the start of the next such bullet, **or the end of the section if it's the last one**" — i.e. per the ticket's own literal spec, the *last* bullet's kept span legitimately runs to `sectionEnd`, trailing prose included, when that kind is selected, and a *non-last* bullet's span stops at the next bullet start (so trailing prose is dropped when the kept bullet isn't the physically-last one in the file). This is what the ticket explicitly asks for — do not add extra logic to preserve trailing prose beyond what's specified; implement exactly: `spanEnd = matches[i+1]?.index ?? body.length`. (Net effect on the real file: selecting `fx` — today's last bullet — keeps the trailing "Defaults preserve/curated lists/Override" prose; selecting any other kind drops it along with the other four bullets. This is a known, accepted consequence of the ticket's own bullet-boundary rule, not a bug to work around.)
8. Reassemble: `text.slice(0, headingStart) + heading-line + newBody + text.slice(sectionEnd)`.

(Builder: write this straightforwardly — the paragraph above is intentionally explicit about the one subtlety (last-bullet-vs-non-last-bullet span end) so there's no ambiguity, not a request to add anything beyond the literal ticket rule.)

### 1c. Cut 2 — JubarteAI section

Private `cutJubarteSection(text)`:
1. `findHeadingSection(text, JUBARTEAI_HEADING)` → `null` → return `text` unchanged (fail-open).
2. Otherwise return `text.slice(0, headingStart) + text.slice(sectionEnd)` — the heading itself is removed too (ticket: "heading through end-of-file").

### 1d. Top-level composition

```ts
export function filterClaudeMdForPipeline(text: string, opts: { agentKind: string }): string {
  let out = text;
  out = cutAgentCommandShapeSection(out, opts.agentKind);
  out = cutJubarteSection(out);
  return out;
}
```

The two cuts are independent (disjoint sections of the file, applied to the running result in sequence) and each internally fails open to a no-op, satisfying the "independently toggleable at the granularity of each cut" requirement from the Scope section. Neither cut can throw: all string operations, no external calls; wrap the whole body of each `cut*` helper in `try { … } catch { return text; }` as a final belt-and-brace (a regex or slice bug must degrade to "no cut," never to a thrown error that blocks the pipeline turn, per the ticket).

## 2. Wiring into O-2 (orchestrator.ts)

Add, near `pipelineLeanContext` (same section of `orchestrator.ts`):

```ts
import { filterClaudeMdForPipeline } from "./claude-md-filter.ts";

/** Env kill-switch for O-14 (mirrors leanContextEnabled/autoInstallEnabled's
 *  convention): `AGETOR_PIPELINE_CLAUDE_MD_FILTER=0` restores the raw,
 *  unfiltered worktree CLAUDE.md for pipeline/child sessions — today's O-2
 *  behavior, byte for byte. */
function claudeMdFilterEnabled(): boolean {
  return process.env.AGETOR_PIPELINE_CLAUDE_MD_FILTER !== "0";
}

/**
 * O-14: narrow the CLAUDE.md O-2 re-injects for a pipeline/child claude-code
 * turn to the one matching "Agent command shape" harness bullet and drop the
 * JubarteAI section outright (see docs/plans/pipeline-token-efficiency.md
 * §7/§9 open item and CLAUDE.md's own "Agent command shape" /
 * "JubarteAI Agent Identity" sections). Writes the filtered copy to
 * `<cwd>/.agetor/CLAUDE.filtered.md` — the real `CLAUDE.md` on disk is never
 * touched. `claudeMdPath` is `pipelineLeanContext`'s own
 * `appendSystemPromptFile` (already null when the worktree has none, or when
 * O-2 itself is off/inapplicable) — this function only narrows a path that's
 * already been decided on, it never turns a null into a path or vice versa
 * except in the two fail-open cases below. Fails open at every step: any
 * error here falls back to `claudeMdPath` unchanged, so a pipeline turn is
 * never blocked by this optimisation and, at worst, sees the same
 * un-narrowed file O-2 already re-injects today.
 */
export function resolvePipelineSystemPromptFile(
  claudeMdPath: string | null,
  agentKind: AgentKind,
  cwd: string,
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
    filtered = filterClaudeMdForPipeline(original, { agentKind });
  } catch {
    return claudeMdPath;
  }
  if (filtered.trim() === "") return null; // degenerate output — same as "no CLAUDE.md" (O-2's existing null path)
  try {
    const outDir = join(cwd, ".agetor");
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, "CLAUDE.filtered.md");
    writeFileSync(outPath, filtered);
    return outPath;
  } catch {
    return claudeMdPath;
  }
}
```

All of `readFileSync`/`writeFileSync`/`mkdirSync`/`join` are already imported at the top of `orchestrator.ts` — no new imports beyond `filterClaudeMdForPipeline`.

At the `startTask` call site (~line 1496), change:

```ts
opts: { mode: task.mode, model: …, effort: …, fast: task.fast, maxMode: task.maxMode, leanContext: pipelineLeanContext(task, harness.kind, prepared.cwd) },
```

to compute the lean context once, then narrow its `appendSystemPromptFile` in place before use:

```ts
const lean = pipelineLeanContext(task, harness.kind, prepared.cwd);
const leanContext = lean
  ? { ...lean, appendSystemPromptFile: resolvePipelineSystemPromptFile(lean.appendSystemPromptFile ?? null, harness.kind, prepared.cwd) }
  : lean;
```

and pass `leanContext` in `opts` instead of the inline call. Because `pipelineLeanContext` still returns `null` for every non-pipeline task (and for codex/gemini/cursor/fx, and when `AGETOR_PIPELINE_LEAN_CONTEXT=0`), `resolvePipelineSystemPromptFile` is simply never invoked for those cases — ordinary tasks keep getting **no** `--append-system-prompt-file` at all (today's real, non-lean spawn path elsewhere in the same function, untouched), exactly preserving "ordinary tasks are completely unaffected."

This keeps `pipelineLeanContext`'s own signature, behavior, and existing tests (`orchestrator-pipeline.test.ts` ~1179-1233) untouched — it still returns the raw worktree `CLAUDE.md` path in its `appendSystemPromptFile` field, and the narrowing to a filtered copy happens one step later, only at the actual spawn call site.

## 3. Tests

### 3a. `src/bun/claude-md-filter.test.ts` (new)

Build one fixture string containing, at minimum:
- a `## Stack and architecture` heading
- a `### Agent command shape` heading followed by an intro paragraph, then five bullets in some order (not necessarily claude-code/codex/cursor/gemini/fx file order — pick a different order than the real file to prove the parser doesn't assume the real file's ordering) each shaped `- **\`<kind>\`** →` followed by a line or two of filler prose, then a trailing paragraph after the bullets (to exercise "last bullet's span runs to section end")
- a `### Claude session lifecycle` heading (or any distinct `###`/`##` heading) marking the end of the Agent command shape section
- some other markdown in between
- a `## JubarteAI Agent Identity` heading with a few paragraphs running to end of file

Cases:
1. For each of the five `AgentKind` values: `filterClaudeMdForPipeline(fixture, { agentKind: kind })` keeps exactly that kind's bullet text, removes the other four bullets' text, and always removes the whole JubarteAI section (heading + body) — assert via `.toContain`/`.not.toContain` on distinctive strings per bullet plus the JubarteAI heading string.
2. A fixture where `### Agent command shape` is renamed (e.g. `### Agent invocation shape`) or missing entirely: assert the Agent-command-shape content passes through untouched (all five bullets still present) while the JubarteAI section is still removed.
3. The mirror case: a fixture where `## JubarteAI Agent Identity` is renamed/missing: assert the JubarteAI content passes through untouched while the Agent-command-shape narrowing still happens correctly.
4. A fixture with neither section present at all: assert `filterClaudeMdForPipeline(text, { agentKind: "claude-code" })` is byte-identical (`===`) to the input.
5. An unrecognized `agentKind` (e.g. `"made-up-kind"`) against the full fixture: assert the Agent-command-shape section is untouched (all five bullets still present) while the JubarteAI section is still removed (the two cuts are independent — an unrecognized kind only defeats cut 1).

### 3b. Orchestrator-level test (extend `src/bun/orchestrator-pipeline.test.ts`)

Add a new `describe`/test block near the existing "lean-context selection (O-1/O-2)" tests (~line 1177) covering `resolvePipelineSystemPromptFile` directly (import it alongside `pipelineLeanContext`):
- given a worktree with a real `CLAUDE.md` containing the five bullets + JubarteAI section (reuse the module-level fixture or a trimmed version), `resolvePipelineSystemPromptFile(claudeMdPath, "claude-code", cwd)` returns a path **different from** `claudeMdPath`, that path exists on disk under `<cwd>/.agetor/`, and its content contains the `claude-code` bullet but not the other four kinds' bullets nor the JubarteAI heading.
- `resolvePipelineSystemPromptFile(null, "claude-code", cwd)` returns `null` (no CLAUDE.md to filter).
- with `AGETOR_PIPELINE_CLAUDE_MD_FILTER=0`, `resolvePipelineSystemPromptFile(claudeMdPath, "claude-code", cwd)` returns `claudeMdPath` unchanged (restores today's O-2 path byte for byte).

Then a `startTask`-level assertion that a **pipeline** task's spawn (mock/spy on `spawnAgent`/`buildCommand`, following whatever pattern the existing O-1/O-2 spawn tests in this file or `agents.test.ts` already use to inspect the built argv) receives `--append-system-prompt-file <the filtered .agetor path>`, not the raw worktree `CLAUDE.md` path, while a matching **non-pipeline** task's spawn is unaffected (no `--append-system-prompt-file` flag at all, or the raw file if some other unrelated path already adds it — confirm by reading how `startTask` invokes non-pipeline claude-code spawns today before asserting). Do not touch or weaken the existing `pipelineLeanContext` unit tests at lines ~1179-1233 — they must keep passing exactly as written, proving `pipelineLeanContext` itself is unchanged.

## 4. Manual live-probe step (Definition of done, not a `bun test`)

After the above lands, run one real pipeline stage turn (claude-code) the same way O-1/O-2's original `prompt_snapshot` JSONL check was done (docs/plans/pipeline-token-efficiency.md §8) and confirm the `--append-system-prompt-file` target under `<worktree>/.agetor/CLAUDE.filtered.md` contains exactly one harness bullet (the task's own agent kind) and no `## JubarteAI Agent Identity` heading. This is a manual verification step for whoever executes the plan, not new automated test code beyond §3.

## 5. Docs: `docs/plans/pipeline-token-efficiency.md`

Append (do not edit any existing row, sentence, or measured number):
- A new row to the existing `| Item | Where | Verified by | Kill switch |` table under "## 9. Follow-up (2026-09-13): cutting redundant checks and unbounded child debugging":

  `| O-14 Trimmed CLAUDE.md for pipeline/child sessions | \`claude-md-filter.ts\`; wired into \`orchestrator.ts\`'s O-2 call site (\`resolvePipelineSystemPromptFile\`) | \`claude-md-filter.test.ts\`, orchestrator-level spawn test | \`AGETOR_PIPELINE_CLAUDE_MD_FILTER=0\` restores O-2's unfiltered file byte for byte |`

- A new paragraph immediately after the table (after the existing "Re-run instructions" / "Still open" lines, appended below them, leaving those sentences as written) recording what shipped and the measured saving, e.g.:

  "**O-14 shipped (2026-09-13)**: this repo's own `CLAUDE.md` (146,326 bytes measured on this date) narrows to ~89,500 bytes (~39% smaller) when appended to a pipeline/child claude-code session's system prompt — the "Agent command shape" section (53,273 bytes, five per-harness bullets) drops to the one bullet matching the task's own agent kind (15,900 to 26,211 bytes depending on which kind), and the trailing "JubarteAI Agent Identity" section (19,461 bytes) is dropped entirely. Kill switch: `AGETOR_PIPELINE_CLAUDE_MD_FILTER=0` restores today's unfiltered file for every pipeline/child session. This closes the "trimmed pipeline-specific CLAUDE.md" item left open in §9's closing note above."

## 6. Files touched (summary)

- New: `src/bun/claude-md-filter.ts`, `src/bun/claude-md-filter.test.ts`
- Edited: `src/bun/orchestrator.ts` (new `claudeMdFilterEnabled`, `resolvePipelineSystemPromptFile`, one new import, one call-site change in `startTask`)
- Edited: `src/bun/orchestrator-pipeline.test.ts` (new tests only, additive)
- Edited: `docs/plans/pipeline-token-efficiency.md` (append-only, per §5 above)
- Not touched: `src/bun/agents.ts` (already generic over whatever path it's given), `CLAUDE.md` itself, any O-1 through O-13 mechanism.
