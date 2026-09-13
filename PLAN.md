# PLAN: headless `/refs/pick` candidate enumeration + interactive TUI picker

## Approach summary

`POST /refs/pick` currently has three branches (fake-seam / native / headless-501).
Only the headless-501 branch changes. It starts returning a bounded, prioritized,
deduped list of candidate directories instead of 501. A new sibling route,
`POST /refs/pick/select`, turns a chosen candidate (or a manually-typed path) into
the final `{ refs }` result — folder mode in one step, files mode by listing the
directory's immediate regular files. This mirrors the existing `/refs/pick` +
`/refs/resolve` split: enumeration is stateless, selection is stateless, the
interactive loop lives entirely in the caller.

The only caller that gets a real interactive UI is the CLI TUI (`src/cli/tui/`) —
that's the one headless, human-facing surface in this codebase (see "Why no
webview UI" below). A new `DirPickerOverlay` component (same layer/pattern as
`AnswerOverlay`) drives the two HTTP endpoints with keyboard navigation, and a new
Dashboard keybinding (`r`, "attach reference") activates it.

Server-side enumeration/selection logic lives in a new small module,
`src/bun/refs-pick.ts`, so it has direct, fast unit tests independent of spinning
up the HTTP server (the HTTP-level tests in `refs-endpoint.test.ts` cover the
route contract itself, per the ticket).

## Why no webview UI

`src/mainview/lib/api.ts`'s `pickRefs` is only ever called by the packaged desktop
app, which always supplies `native` to `startApiServer` (see `src/bun/index.ts`).
Structurally, the webview can never observe the `{ candidates }` shape in
production — only a headless daemon (CLI-spawned, `native` undefined) can produce
it, and the webview isn't a client of that path. Per SPEC.md's user stories,
which explicitly scope this feature to "a user running agetor headlessly
(CLI/TUI)", the interactive picker belongs in the TUI only. The webview's
`api.ts` still gets a small defensive update (see below) so it fails safe instead
of crashing if it were ever pointed at a headless core, but implements no picker
UI — that would be scope creep with no real caller.

## Server: candidate enumeration + selection

### New file: `src/bun/refs-pick.ts`

Two pure(ish) functions, unit-testable without an HTTP server:

```ts
export const MAX_PICK_CANDIDATES = 50;

export function headlessPickCandidates(): string[]
export function selectPick(
  rawPath: string,
  mode: "files" | "folder",
): { refs: TaskReference[] } | { error: string }
```

**`headlessPickCandidates()`** — priority order, exactly matching the ticket's
"Candidate generation rules" (AC-2/3/4):

1. Every task's `workdir` from `tasks.list()` (imported from `./db.ts`, already a
   server.ts dependency), sorted by `updatedAt` descending before insertion — most
   recently used first (AC-2). Do **not** filter archived tasks; AC-2 says "every
   distinct directory the user has already used", with no archived exclusion.
2. Direct subdirectories of `homedir()` (`node:os`) that are git repos: filter
   `Dirent.isDirectory() && !name.startsWith(".")`, then
   `existsSync(join(dir, ".git"))`. Sort alphabetically (`localeCompare`) for
   deterministic output — the ticket doesn't specify an order among these, and a
   stable order matters for testability. Wrap the `readdirSync(homedir())` call in
   try/catch — an unreadable `$HOME` degrades to "no git-repo candidates", not an
   error (AC-1 must still return 200).
3. `homedir()` itself, appended last, unconditionally attempted (AC-4).

Dedup + cap, applied via one `add(rawPath)` helper used by all three tiers:
- Resolve with `realpathSync`; on failure (path gone / permission denied), the
  candidate is **silently dropped** — this both implements AC-5's "same real
  location" dedup (compare/store the realpath, not the raw string — two
  different-looking inputs that share a realpath collapse to one entry) and
  guards against ever offering a workdir that no longer exists on disk.
- Skip (no-op) once `out.length >= MAX_PICK_CANDIDATES` (AC-6). Because tiers are
  processed in priority order and the cap check is a cheap early-return at the
  top of `add`, the 50 slots are naturally filled by workdirs first, then
  home-derived repos, then home itself — matching the "exceeds the cap"
  edge case's prioritization.
- **Design note for the Critic**: AC-4 ("candidate list includes home... as a
  fallback") and the cap/priority edge case are in tension in the pathological
  case where task workdirs alone already number ≥50 distinct real paths — home
  would then be dropped by the cap, not appended. I'm resolving this by treating
  the cap + priority-order edge case as controlling (home is a *fallback*,
  most meaningful when tiers 1–2 are sparse or empty, which is the only scenario
  the edge cases actually describe). Flagging this explicitly rather than
  silently picking a side.

**`selectPick(rawPath, mode)`**:
- Reject non-absolute paths: `{ error: "enter an absolute path" }`. (The TUI is
  responsible for expanding `~` and resolving relative manual entries to
  absolute *before* calling this — see the TUI section. Candidates from
  `headlessPickCandidates()` are already absolute realpaths.)
- `statSync(rawPath)`; on throw → `{ error: "path not found" }`. If not a
  directory → `{ error: "not a directory" }`. This is what backs AC-14/Q2's
  "reject and let the user retry" behavior — the caller distinguishes error vs.
  success by the shape of the return value (mirrored 1:1 onto HTTP 400 vs 200).
- `mode === "folder"` → `{ refs: [{ path: rawPath, isDirectory: true }] }` (AC-7).
  Deliberately does **not** realpath the result — matches the existing
  `refsFromPaths` behavior elsewhere in server.ts (the given path is trusted
  once it's confirmed to exist).
- `mode === "files"` → `readdirSync(rawPath, { withFileTypes: true })`, filter
  `isFile() && !name.startsWith(".")` (hidden-file exclusion per the ticket's
  Q1/AC-8 clarification), sort by `localeCompare` (matches the existing fake-seam
  ordering convention in server.ts so behavior reads as consistent even though
  it's a different code path), map to `{ path: join(rawPath, name), isDirectory:
  false }`. Zero matching files → `{ refs: [] }`, not an error (edge case:
  "directory containing only subdirectories").

### `src/bun/server.ts` changes

1. Add `import { headlessPickCandidates, selectPick } from "./refs-pick.ts";`
2. In the `/refs/pick` route, replace the line
   `if (!native) return notAvailableHeadless(req);`
   with:
   ```ts
   if (!native) {
     return json(
       { candidates: headlessPickCandidates(), refs: [] },
       { headers: corsHeaders(req) },
     );
   }
   ```
   Everything above it (fake-seam branch) and below it (native dialog branch) is
   untouched — this is the entire AC-16 guarantee: those two branches structurally
   cannot be reached differently than before, because the new code only replaces
   what used to be dead-end 501. `startingFolder` is intentionally unused by this
   new branch — candidate generation is global, not scoped to a starting folder
   (matches the ticket's candidate-generation rules, which never reference a
   starting folder).
3. Add a new route immediately after `/refs/pick`, alongside `/refs/resolve`:
   ```ts
   "/refs/pick/select": {
     POST: authed(async (req) => {
       const body = (await req.json().catch(() => ({}))) as {
         path?: unknown;
         mode?: "files" | "folder";
       };
       const rawPath = typeof body.path === "string" ? body.path : "";
       const mode = body.mode === "folder" ? "folder" : "files";
       if (!rawPath) {
         return json({ error: "path is required" }, { status: 400, headers: corsHeaders(req) });
       }
       const result = selectPick(rawPath, mode);
       return json(result, { status: "error" in result ? 400 : 200, headers: corsHeaders(req) });
     }),
   },
   ```
   No `native` dependency (deliberately, like `/refs/resolve` and `/files/index`)
   — this route only ever stats/reads a path the caller already named, so it
   works identically whether headless or packaged.

No migrations. No DB schema changes (`tasks.list()` already exists and is read
elsewhere on the hot poll path — this adds one more read-only call site, on a
route nobody polls).

## Server tests

### New file: `src/bun/refs-pick.test.ts`

Direct unit tests against the two exported functions (no HTTP server needed —
fast, and lets every edge case in SPEC.md get its own assertion without the
combinatorial blow-up of doing it all through fetch):

- `headlessPickCandidates()` includes a task's `workdir` (insert a task via
  `tasks.insert(...)`, same fixture shape as `db-openable.test.ts`'s `makeTask`,
  pointed at a real `mkdtempSync` dir) — AC-2.
- Two tasks with different `updatedAt` → the more recent one's workdir sorts
  first — AC-2.
- Two tasks whose `workdir`s are a real dir and a symlink to it (or two paths
  that `realpathSync` to the same location) → exactly one candidate — AC-5.
- `process.env.HOME` pointed at a scratch dir containing a git-repo subdir (a
  `.git` marker dir/file), a non-git subdir, and a dot-prefixed git-repo subdir
  → only the non-dot git repo appears — AC-3.
- `process.env.HOME` pointed at a scratch dir with **no** git repos and no task
  workdirs (no tasks inserted) → candidates is exactly `[realpath(HOME)]`, never
  empty — AC-4 + the "no git repos" edge case.
- Insert 60 tasks with 60 distinct real tmp-dir workdirs → result length is
  exactly 50, and every entry is one of the (realpath'd) task workdirs, in
  most-recently-updated-first order — AC-6 + the "exceeds the cap" edge case.
- A task `workdir` pointing at a path that doesn't exist on disk → it does not
  appear in candidates (dead workdir silently dropped, not surfaced as broken).
- `process.env.HOME` set/deleted per-test inside try/finally, following the
  precedent in `src/bun/login-path.test.ts`.

- `selectPick(dir, "folder")` on a real directory → `{ refs: [{ path: dir,
  isDirectory: true }] }` — AC-7.
- `selectPick(dir, "files")` on a directory containing a visible file, a hidden
  (dot-prefixed) file, and a subdirectory → refs contains only the visible file,
  as `{ path, isDirectory: false }` — AC-8 + the hidden-files edge case.
- `selectPick(dir, "files")` on a directory containing only subdirectories →
  `{ refs: [] }`, not an error — the "only subdirectories" edge case.
- `selectPick("relative/path", "folder")` → `{ error: ... }` (non-absolute
  rejected).
- `selectPick("/definitely/does/not/exist", "folder")` → `{ error: ... }` — the
  "manually entered path does not exist" edge case.
- `selectPick(<path to a regular file, not a dir>, "folder")` → `{ error: ... }`
  ("not a directory").

### Edits to existing `src/bun/refs-endpoint.test.ts`

- Import `tasks` alongside the existing `startApiServer`/`API_TOKEN` in
  `beforeAll` (via the same `await import("./db.ts")` already present at the top
  of the file — just capture the returned `tasks` binding).
- **Replace** the test `"/refs/pick is unavailable in headless mode when the
  fake-pick seam is unset"` (current lines 92–100) — this is the exact dead end
  the ticket removes, so its assertion is now wrong by design, not a regression.
  New test: `"/refs/pick returns candidates in headless mode when the fake-pick
  seam is unset"` — insert a task via `tasks.insert(...)` with `workdir` set to a
  real tmp dir (reuse the file's existing `SCRATCH`/`DIR`), call `pick("files")`,
  assert `res.status === 200`, body has no `refs` key (or `refs: []`, matching
  the route's literal response shape) and `candidates` is an array containing
  that task's workdir. This is the ticket's explicitly-requested unit test #1.
- Add: `"/refs/pick/select folder mode returns a directory reference"` — POST
  `/refs/pick/select` with `{ path: DIR, mode: "folder" }`, assert `{ refs: [{
  path: DIR, isDirectory: true }] }`. Ticket's unit test #2.
- Add: `"/refs/pick/select files mode lists immediate regular files"` — plant a
  couple of files (+ a subdirectory, + a dot-file) directly under `DIR`, POST
  `/refs/pick/select` with `{ path: DIR, mode: "files" }`, assert the visible
  files come back as `isDirectory: false` refs, sorted, excluding the dot-file
  and the subdirectory. Ticket's unit test #3.
- Add: `"/refs/pick/select rejects an invalid manual path with 400"` — POST with
  a nonexistent path, assert `res.status === 400` and body has an `error` string.
- Leave every other existing test in this file (native-panel comma-split
  fragments, `/refs/resolve` behavior, the two `AGETOR_FAKE_PICK_REFS_DIR` tests)
  completely unmodified — they exercise branches this ticket doesn't touch
  (AC-16).

## Webview: `src/mainview/lib/api.ts`

Defensive-only change, no new UI (see "Why no webview UI" above). Update
`pickRefs`'s expected response type and fallback:

```ts
pickRefs: (mode: "files" | "folder", startingFolder?: string) =>
  j<{ refs?: TaskReference[]; candidates?: string[] }>("/refs/pick", {
    method: "POST",
    body: JSON.stringify({ mode, startingFolder }),
  }).then((r) => r.refs ?? []),
```
When `refs` is present (native dialog or fake seam), behavior is byte-identical
to today (AC-15). If a `candidates` shape were ever received, this resolves to
`[]` instead of throwing on `undefined.length` — `ReferencesPicker.tsx`'s
existing `if (picked.length) append(picked)` then simply no-ops, which is exactly
"nothing selected", never a crash.

## CLI: `src/cli/api-client.ts`

Add two thin methods on `AgetorClient`, next to the other one-off route wrappers:

```ts
pickRefs(mode: "files" | "folder"): Promise<{ candidates?: string[]; refs?: TaskReference[] }> {
  return this.req("POST", "/refs/pick", { mode });
}
selectPickedRef(path: string, mode: "files" | "folder"): Promise<{ refs: TaskReference[] }> {
  return this.req("POST", "/refs/pick/select", { path, mode });
}
```
`req`'s existing non-2xx handling already throws `ApiError` with `.message` set
from the body's `error` field on a 400 from `/refs/pick/select` — `DirPickerOverlay`
catches that and shows it inline (AC-14/Q2), no new error-plumbing needed.

## TUI: new `src/cli/tui/DirPickerOverlay.tsx`

Same shape/pattern as `AnswerOverlay.tsx`: a single component with an internal
screen state machine, mounted only while active, owning `useInput` entirely
while mounted.

```ts
export function DirPickerOverlay({
  client,
  onDone,
}: {
  client: AgetorClient;
  onDone: (refs: TaskReference[]) => void;
}): JSX.Element
```

One callback, not two (`onDone` only) — every exit path (top-level cancel,
back-out at the directory list, a genuine empty files-listing) collapses to
"call `onDone` with a `TaskReference[]`, possibly `[]`". This directly matches
the user story "if I cancel out of the picker at the top level, I want the pick
to be treated as nothing selected rather than an error" and every other
back-out/cancel AC (AC-10, AC-11) — they're all "empty selection", not a distinct
error/cancel channel. This is a deliberate simplification vs. `AnswerOverlay`'s
`onDone`/`onCancel` pair (which exists there because a *pending interaction*
that's merely dismissed must stay pending server-side — there's no equivalent
server state here to preserve).

Internal state (`screen: "kind" | "loading" | "dirlist" | "manual" |
"fileslist"`), transitions:

1. **`"kind"`** (initial screen — this *is* "the very first prompt" from the
   cancel-before-typing-or-navigating edge case): two rows, "Folder" / "Files".
   ↑/↓ move a 0/1 cursor, Enter picks it and moves to `"loading"` (fires
   `client.pickRefs(kind)`), Esc calls `onDone([])`.
2. **`"loading"`**: on resolve — if the response has `refs` (native/fake-seam
   direct-result path, AC-15) call `onDone(refs)` immediately, no further screen
   is ever shown; otherwise take `candidates` (default `[]` if absent) and move
   to `"dirlist"`. On reject (network/`ApiError`), move to `"dirlist"` anyway
   with an empty candidate list and a `loadError` hint shown above the list —
   fails open to "type a path manually" rather than stranding the user.
3. **`"dirlist"`**: outer state `candidates: string[]`, `filterText: string`,
   `cursor: number` — all three persist across trips into `"manual"` /
   `"fileslist"` and back, which is what implements AC-9 ("without losing the
   ability to choose a different directory").
   - Visible rows = `candidates.filter(c => c.toLowerCase().includes(filterText.toLowerCase()))`
     (AC-12, case-insensitive substring — Q3), **plus** a trailing fixed
     `"› Enter a path manually…"` row, always rendered even when the filtered
     list is empty (the "filtering matches zero candidates" edge case: the list
     empties, manual entry stays available).
   - Printable, non-ctrl/meta input appends to `filterText` and resets `cursor`
     to 0 (mirrors `Composer.tsx`'s existing query-reset behavior); Backspace
     trims it.
   - ↑/↓ move `cursor`, clamped to `[0, rows.length - 1]` (AC-13).
   - Enter on the manual row → `screen = "manual"`, reset `manualText`/`manualError`.
   - Enter on a candidate row → `client.selectPickedRef(rows[cursor], kind)`:
     - success + `kind === "folder"` → `onDone(refs)` (AC-7, single-level).
     - success + `kind === "files"` → store `fileRefs = refs`, `screen =
       "fileslist"` (AC-8/AC-9, two-level).
     - failure (`ApiError`, e.g. the candidate vanished between listing and
       selection) → set an inline `dirError` hint, stay on `"dirlist"`.
   - Esc → `onDone([])` (AC-10 for files mode, AC-11 for folder mode — one code
     path covers both since it doesn't depend on `kind`).
4. **`"manual"`**: a single hand-rolled text field, same style as
   `AnswerOverlay`'s `custom` field / `Composer`'s own input (append printable
   chars, Backspace trims, no external deps).
   - Enter with non-empty trimmed text: resolve the typed text to an absolute
     path client-side first — expand a leading `~` to `homedir()` (Node's
     `os.homedir()`, available in the CLI process) and `path.resolve()` anything
     relative (against `process.cwd()`, same convention already used by
     `src/cli/refs.ts`'s `resolveRefs` for `--ref`). Then
     `client.selectPickedRef(resolved, kind)`:
     - success → same branching as the dirlist success case above (folder →
       `onDone`, files → `"fileslist"`).
     - failure → set `manualError` to `(e as Error).message`, **stay on
       `"manual"`** so the user can correct and resubmit in place (AC-14/Q2:
       "rejects it with an inline error and keeps the manual-entry prompt open
       for a retry").
   - Esc → back to `"dirlist"` (Q2: "or back out to the candidate list") — this
     is a screen change only; `candidates`/`filterText`/`cursor` are untouched.
5. **`"fileslist"`**: renders `fileRefs` (the immediate-files result from
   selecting a directory in files mode) as a static list — this level has no
   further per-file selection, since AC-8 defines the result as *the whole
   listing*, not a further pick; "the same navigation" language in the source
   ticket is satisfied by reusing the same visual list style, not by adding
   selection semantics that no AC actually calls for. An empty `fileRefs` renders
   a "no files here" line (the "only subdirectories" edge case) rather than
   nothing.
   - Enter → `onDone(fileRefs)` (confirms the listing as the final result).
   - Esc → `screen = "dirlist"` (AC-9 — directory list state, per above, was
     never touched).

## TUI: `src/cli/tui/Dashboard.tsx` wiring

There is currently no call site for a folder/file picker anywhere in the CLI/TUI
(the only existing reference-attach mechanism is the non-interactive `agetor add
--ref <path>` / `agetor send --ref <path>`, in `src/cli/refs.ts` +
`src/cli/commands/lifecycle.ts`). This ticket's own source doc assumed an
existing `api.pickRefs` call site to retrofit; since none exists in the TUI, a
new activation point is added — this is in scope ("the system offers... a
keyboard-driven picking flow", per SPEC.md's summary), not scope creep, but it's
a genuinely new integration decision the Critic should sanity-check.

1. `Mode` union gains `"pick"`.
2. Import `DirPickerOverlay` and `appendReferences` (from
   `../../shared/refs.ts`) and `TaskReference` (type-only, from
   `../../shared/types.ts`).
3. New keybinding in the existing nav-mode `useInput` block (alongside `m`/`g`/`c`/`s`/`x`):
   ```ts
   if (input === "r" && selected) {
     setTargetId(selected.id);
     return setMode("pick");
   }
   ```
   No gating (unlike `g`, which requires a pending interaction) — attaching a
   reference doesn't depend on run state; if the task has no run yet,
   `sendMessage` (below) already surfaces "no run yet — press s to start", the
   same as it does for any other message today.
4. New render block, next to the existing `"answer"` block:
   ```tsx
   {mode === "pick" && target ? (
     <Box borderStyle="round" borderColor="cyan" paddingX={1} overflow="hidden">
       <DirPickerOverlay
         client={client}
         onDone={(refs: TaskReference[]) => {
           setMode("nav");
           if (!refs.length) {
             setStatus("no reference selected");
             return;
           }
           const label = `→ attached ${refs.length} reference${refs.length > 1 ? "s" : ""}`;
           sendMessage(target, appendReferences("", refs), label);
         }}
       />
     </Box>
   ) : null}
   ```
   Reuses the existing `sendMessage` helper unchanged — a refs-only message
   (empty text + `appendReferences`) is already a supported shape; it's the same
   thing `agetor send --ref <path>` (no message text) produces today. This is
   also the entire reason SPEC.md's non-goal ("no change to how references,
   once picked, are subsequently used elsewhere in a task") holds: the picker
   only ever hands its result to plumbing (`appendReferences` → `sendInput`)
   that already exists and is untouched.
5. `Footer`'s `hint` ternary gains a `"pick"` branch (`"↑/↓ move · type to
   filter · enter select · esc back"`), and the default (`"nav"`) hint string
   gains `· r ref` at the end. Existing `Dashboard.test.tsx` assertions
   (`toContain("m msg")`, etc.) are substring checks and are unaffected.

## TUI test: new `src/cli/tui/DirPickerOverlay.test.tsx`

Same harness as `AnswerOverlay.test.tsx` (`ink-testing-library`'s `render` +
`stdin.write` with the file's existing `ENTER`/`ESC`/`UP`/`DOWN` byte-sequence
constants — replicate that small constants block), with a hand-built fake
`AgetorClient` exposing just `pickRefs`/`selectPickedRef`. This is the ticket's
requested e2e/component test, expanded into the several scenarios the ACs
actually require:

- Candidates path, folder mode: fake `pickRefs` resolves `{ candidates: ["/a",
  "/b"] }`; render, Enter (kind=Folder default cursor), DOWN, ENTER on `/b` →
  fake `selectPickedRef` captures `("/b", "folder")` and resolves `{ refs: [{
  path: "/b", isDirectory: true }] }`; assert `onDone` was called with that
  array. This is the ticket's literal "↑ ↓ Enter … resulting task carries the
  selected path as a reference" scenario (verified at the overlay's own
  `onDone` boundary, not by actually spinning up a task — the Dashboard-level
  wiring that turns `onDone`'s result into a sent message is simple enough
  (`appendReferences` + `sendMessage`, both already independently
  exercised/existing) that it doesn't need its own component test; keeping
  the append/`sendMessage` boundary point out of this test's mocking surface
  matches the file's existing pattern of unit-testing `AnswerOverlay` at the
  `client.answer*` boundary).
- Files mode two-level flow: candidates `["/dir"]`; DOWN into Files kind, Enter
  on `/dir` → `selectPickedRef("/dir", "files")` resolves a multi-file `refs`
  array; assert the second-level list renders those file names; Esc → assert
  the directory list reappears (dirlist row for `/dir` still visible); Enter
  again on `/dir`, then Enter at the file list → `onDone` called with the same
  `refs` array (AC-8/AC-9).
- Filter narrows the list: candidates `["/alpha", "/beta"]`; type `"be"` →
  assert only `/beta` (+ the manual row) is rendered (AC-12).
- Manual entry, invalid path retried: choose the manual row, type a bogus path,
  Enter → fake `selectPickedRef` rejects with an `ApiError`-shaped error; assert
  an inline error string renders and the text field is still present/editable;
  edit and Enter again with a path the fake resolves successfully → `onDone`
  fires (AC-14).
- Esc at the very first (`"kind"`) screen → `onDone([])` (top-level-cancel edge
  case).
- Esc at the `"dirlist"` screen (no selection made) → `onDone([])` for both
  kinds (AC-10, AC-11).
- Direct-result short-circuit: fake `pickRefs` resolves `{ refs: [{ path: "/x",
  isDirectory: true }] }` (no `candidates`) → assert `onDone` fires immediately
  with that array and no candidate-list screen is ever rendered (AC-15).

## Non-scope reaffirmed (do not implement)

- No new one-shot `agetor pick`/`agetor refs pick` CLI subcommand — only the
  interactive TUI overlay. `agetor add --ref` / `agetor send --ref` remain the
  non-interactive path, unchanged.
- No changes to `Composer.tsx`'s `@`-mention autocomplete — a completely
  separate feature (inline mention resolution vs. whole-file/folder attachment).
- No persistence of picker selections beyond the single pick (no new DB
  columns, no draft/backlog integration).
- No change to `AGETOR_FAKE_PICK_REFS_DIR` or the native `openFileDialog`
  branch — verified by construction (new code is added only inside what used to
  be the `notAvailableHeadless` branch) and by leaving every pre-existing test
  for those branches untouched.

## Definition of done (for the Builder to self-check)

- `bun run typecheck` is green.
- `bun test src/bun/refs-pick.test.ts src/bun/refs-endpoint.test.ts
  src/cli/tui/DirPickerOverlay.test.tsx` all pass, plus the full suite
  (`bun test`) to confirm no regressions in `Dashboard.test.tsx` or elsewhere.
- `POST /refs/pick` in headless mode (no `native`, no
  `AGETOR_FAKE_PICK_REFS_DIR`) returns `{ candidates, refs: [] }` with status
  200, never 501.
- `POST /refs/pick/select` resolves a candidate or manual path to `{ refs }`
  (200) or `{ error }` (400).
- `r` in the Dashboard opens `DirPickerOverlay`; a completed pick sends a
  references-only message to the selected task via the existing `sendMessage` /
  `appendReferences` plumbing.
