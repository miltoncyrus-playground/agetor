# PLAN — Webview folder/file picker for headless mode

## Confirmed contract (read before coding)

`src/bun/refs-pick.ts` + the two routes in `src/bun/server.ts` (already merged, untouched by this task):

- `POST /refs/pick { mode, startingFolder }`:
  - Native-dialog path or `AGETOR_FAKE_PICK_REFS_DIR` set → `{ refs: TaskReference[] }` (refs may be `[]` on cancel).
  - Headless, no fixture → `{ candidates: string[], refs: [] }`. `candidates` is a flat list of absolute directory paths (`headlessPickCandidates()`, capped at `MAX_PICK_CANDIDATES = 50`), already ordered/deduped server-side (AC-2) — the client must not re-sort or re-dedupe it, only filter it live by substring (AC-6).
- `POST /refs/pick/select { path, mode }` (no `native` dependency — works headless):
  - `mode: "folder"` → `{ refs: [{ path, isDirectory: true }] }` for a valid directory, else `{ error: string }` (400) with one of `"enter an absolute path"`, `"path not found"`, `"not a directory"`.
  - `mode: "files"` → `{ refs: [...] }` listing **every** immediate regular file in that directory (each `{ path, isDirectory: false }`, dotfiles excluded, name-sorted), or the same `{ error }` shapes on an invalid path.
  - Key implication: in files mode, the second-level "listing" the browser needs to show is exactly the `refs` array this endpoint already returns — no separate listing call. The single-file-click-confirms behavior (Q1) is a **client-side** narrowing of that already-fetched array to one element; it does not require a new request.

This confirms the CLI's `AgentClient.pickRefs`/`selectPickedRef` (`src/cli/api-client.ts:328-345`) and `DirPickerOverlay.tsx`'s `startPick`/`selectDir`/`submitManual` are the exact reference flow to mirror in the webview, with one deliberate divergence: `DirPickerOverlay`'s `fileslist` screen bulk-confirms all files on Enter; the webview's second-level list must instead resolve on a single row click (per SPEC.md's Q1/A and AC-4).

## 1. `src/mainview/lib/api.ts` — stop collapsing `candidates` into `[]`

Current (line ~542-546):
```ts
pickRefs: (mode, startingFolder) =>
  j<{ refs?: TaskReference[]; candidates?: string[] }>("/refs/pick", {...})
    .then((r) => r.refs ?? []),
```

Change `pickRefs`'s return type to a discriminated result so callers can't accidentally treat "show me a candidate list" as "nothing selected":

```ts
export type PickRefsResult =
  | { kind: "refs"; refs: TaskReference[] }
  | { kind: "candidates"; candidates: string[] };

pickRefs: (mode: "files" | "folder", startingFolder?: string): Promise<PickRefsResult> =>
  j<{ refs?: TaskReference[]; candidates?: string[] }>("/refs/pick", {
    method: "POST",
    body: JSON.stringify({ mode, startingFolder }),
  }).then((r) =>
    r.candidates !== undefined
      ? { kind: "candidates", candidates: r.candidates }
      : { kind: "refs", refs: r.refs ?? [] },
  ),
```

Branching on `r.candidates !== undefined` (not `r.refs`) matters: the native/fixture path always sends `{ refs: [...] }` with no `candidates` key at all (confirmed above), and the headless path always sends `candidates` alongside a `refs: []` filler — so checking for `candidates` presence is the one unambiguous discriminator; checking falsy-`refs` would also misfire on a native cancel (`{ refs: [] }`, no `candidates`), which must stay in the `"refs"` branch.

Add `selectPickedRef`, mirroring `AgentClient.selectPickedRef`:

```ts
selectPickedRef: (path: string, mode: "files" | "folder") =>
  j<{ refs: TaskReference[] }>("/refs/pick/select", {
    method: "POST",
    body: JSON.stringify({ path, mode }),
  }),
```

`j` already throws `ApiError` (message = body's `error` string) on the 400 responses `selectPick` returns — `FolderPickerDialog` catches that and shows `e.message` inline (AC-8), no extra parsing needed.

Export `PickRefsResult` alongside the existing exported types near the top of the file (or inline next to the `api` object — match whatever the file's existing convention is for one-off response shapes, e.g. how `GitHubIssueThreadResult` etc. are imported from `shared/types.ts` vs declared locally; since this type has no server-side twin in `shared/types.ts`, declare it locally in `api.ts` and import it from `ReferencesPicker.tsx`/`FolderPickerDialog.tsx`).

## 2. New file — `src/mainview/components/kanban/FolderPickerDialog.tsx`

Props:
```ts
interface Props {
  open: boolean;
  mode: "files" | "folder";
  candidates: string[];
  onDone: (refs: TaskReference[]) => void; // called with [] on cancel at any level — caller closes on any call
}
```

State machine, mirroring `DirPickerOverlay` minus its `"kind"`/`"loading"` screens (mode and the initial candidate fetch are owned by `ReferencesPicker`, not this dialog):

- `screen: "list" | "fileslist"` (starts at `"list"`; no `"manual"` sub-screen — the manual-entry input is always visible at the top of the `"list"` screen per the spec's UI description, not a separate step, unlike the TUI's cursor-driven `"manual"` screen which exists only because ink has no simultaneous multi-widget focus).
- `filterText: string` — narrows `candidates` via `candidates.filter(c => c.toLowerCase().includes(filterText.toLowerCase()))` (AC-6), recomputed with `useMemo`.
- `manualPath: string`, `manualError: string | null`.
- `fileRefs: TaskReference[]` — populated by a `mode: "files"` select call, rendered as the second-level list.
- `busy: boolean` — true only during the `/refs/pick/select` round-trip (mirrors `picking`'s Q2 semantics but scoped to this dialog).
- `rowError: string | null` — inline error surfaced next to a candidate-row click failure (same `{error}` shapes as manual entry can hit, e.g. a stale candidate that's since been deleted).

Behavior:
- **Row click** (`selectPath(rawPath)`): set `busy`, call `api.selectPickedRef(rawPath, mode)`. On success: `mode === "folder"` → `onDone(result.refs)` (closes). `mode === "files"` → `setFileRefs(result.refs); setScreen("fileslist")` (AC-4/AC-5 — does not close). On failure: set `busy = false` and surface `e.message` (`rowError` for a candidate-row failure, `manualError` for the manual-entry submit) inline; dialog stays open (AC-8, AC-9's "no error state visible… rather it stays open and correctable" reading, matches DirPickerOverlay's `dirError`/`manualError` split).
- **Manual submit** (Enter in the input, or a small "Use this path" button next to it): resolve `~`/`~/` and relative paths the same way `resolveManualPath` does in `DirPickerOverlay.tsx` (copy that ~15-line helper verbatim into this file or a tiny shared spot — see "shared helper" note below), then call `selectPath(resolved)`. Route failures to `manualError`, not `rowError`, so a stale candidate error and a manual-path error never bleed into each other's slot.
- **Second-level file row click**: no network call — `onDone([fileRefs[i]])` directly (this is the client-side narrowing described in the contract section; `fileRefs` already holds one `TaskReference` per immediate file).
- **Back button** on the `"fileslist"` screen: `setScreen("list")` (does not clear `filterText` or `manualPath` — matches "return to the list… and can then choose a different directory" in AC-5 without losing the user's filter).
- **Cancel** (Escape via `Dialog`'s own handling, or an explicit "Cancel" button in the header): `onDone([])` from whichever screen is active (AC-9). Wire this through the `Dialog`'s `onClose` prop directly — `<Dialog open={open} onClose={() => onDone([])}>` — so Escape-at-any-level and the close button share one code path.
- **Reopen with clean state** (edge case: "rapidly cancels and reopens… no stale error"): since `ReferencesPicker` unmounts `FolderPickerDialog` when not open (conditionally rendered, not just hidden — see §3), a fresh mount naturally resets all local `useState` to initial values; no explicit reset effect needed. Confirm this by actually conditionally rendering (`{dialogOpen && <FolderPickerDialog .../>}`), not `<FolderPickerDialog open={dialogOpen} .../>` with an always-mounted component.

Rendering:
- Use `Dialog` from `@/components/ui/dialog` exactly as `ResolveConflictsDialog`/other kanban dialogs do — pass `labelledBy`/`describedBy` ids on a title `<h2>`/description `<p>` rendered inside, and `initialFocusRef` pointed at the filter/manual-path input so typing works immediately on open.
- Header: "Pick a folder" / "Pick a directory to list files from" (mirrors `DirPickerOverlay`'s title text, parameterized on `mode`), a Cancel/close (`X`) button.
- Manual-path input: a single `<input>` (or reuse `@/components/ui/input`'s `Input`) with a placeholder like `/absolute/path` and `IDENTIFIER_INPUT_PROPS`-style spellcheck-off attributes if that convention exists (check `Input`'s usage in `search-select.tsx` for the pattern) — typing into it **also drives `filterText`** is NOT correct per spec (filter and manual-entry are two distinct affordances per the ticket: "a text input up top for typing an arbitrary path" is separate from candidate filtering, and DirPickerOverlay itself keeps `filterText` and `manualText` as two different pieces of state reached via two different screens). Render them as two visually distinct controls: a filter input directly above the candidate list (placeholder "Filter…"), and the manual-entry input+submit as its own row (placeholder "Or type an absolute path…", with a "Use path" button or Enter-to-submit). `manualError` renders directly under the manual input; it does not touch the candidate list itself.
- Candidate rows: `<button type="button">` per row (real buttons, not `<div onClick>`, so Tab-focus + native Enter/Space activation gives AC-12 for free with zero extra key handling) showing a folder icon (`Folder` from `lucide-react`, matching `FolderPlus`'s import style already in `ReferencesPicker.tsx`) + the path text (`truncate` + `title={c}` for overflow, matching the chip pattern already used for `refs-chip`). List container is a `<div role="listbox">` / each row `role="option"` for consistency with the a11y pattern CLAUDE.md documents elsewhere (`AtFileAutocomplete`), though a simple native-button Tab chain already satisfies AC-12's literal requirement ("move between candidate rows and confirm a highlighted one without a pointing device") since Tab + Enter/Space works without any custom key handling — do not over-build a roving-tabindex arrow-key scheme unless reusing an existing helper costs nothing; native tab order is sufficient and simpler to keep correct.
- Empty filtered list: render "No matches — try a different filter or type a path above." (edge case: filtered-to-empty stays usable via manual entry).
- Zero candidates from the server: same empty-state copy renders (edge case in SPEC.md — "the picker still opens and allows the user to type a manual path").
- `"fileslist"` screen: header "Files in `<dir>`" + a `← Back` button (`onClick={() => setScreen("list")}`) + the `fileRefs` list rendered the same way (button rows, `iconForRef({ path, isDirectory: false })` icon from `@/lib/file-icons` for consistency with how refs are iconified elsewhere) + empty-state "No files in this directory." (edge case) + a `rowError`-equivalent slot only if a stat race causes a click to fail — not expected per the confirmed contract (the refs are already resolved paths from the same `readdirSync` call), so no error state is needed here; omit it.
- No nested popover is introduced (no `SearchSelect`/`ExtensionPicker`/autocomplete inside this dialog), so no `data-popover-open` marker is needed — `Dialog`'s own Escape handling is sufficient as-is.

Test ids (new, all scoped to this dialog so they can't collide with the two `refs-pick-*` mount points):
- `folder-picker-dialog` (root, or reuse `Dialog`'s own `role="dialog"` query if the e2e convention prefers role-based selectors — check an existing dialog spec for the house style before picking).
- `folder-picker-filter` (filter input), `folder-picker-manual-input` / `folder-picker-manual-submit`, `folder-picker-manual-error`.
- `folder-picker-candidate` (repeated — use `.nth()`/`.filter({ hasText })` in specs, or add `data-path={c}` for exact targeting — prefer `data-path` since candidate text itself may need substring assertions separately).
- `folder-picker-back`, `folder-picker-cancel`, `folder-picker-file` (repeated, `data-path={r.path}`).

Shared helper note: `resolveManualPath` (tilde/relative resolution) exists today only in `src/cli/tui/DirPickerOverlay.tsx`, which is Node/CLI code (`node:os`, `node:path`) — those same built-ins are available in the Bun-bundled webview too (Vite polyfills or Bun's own `node:path`/`node:os` work fine in this codebase's other webview files that already import `path` from `"node:path"` — verify by grepping `from "node:path"` under `src/mainview` before assuming; if the webview bundle can't resolve `node:os`'s `homedir()` in-browser, drop the `~` expansion for the webview version and only keep `path.resolve()` against a hardcoded fallback, since there is no reliable client-side "home directory" without a server round trip — document this as a minor, deliberate divergence from the TUI if `homedir()` isn't available client-side). Do not create a new `src/shared/` module for a 10-line helper used by exactly one new file; a local copy in `FolderPickerDialog.tsx` is fine and keeps this task's diff contained to the webview as scoped.

## 3. `src/mainview/components/kanban/ReferencesPicker.tsx` — wire the dialog in

Add local state:
```ts
const [dialog, setDialog] = useState<
  | null
  | { mode: "files" | "folder"; candidates: string[] }
>(null);
```

Change `pick` (line ~98-110):
```ts
const pick = async (mode: "files" | "folder") => {
  if (picking) return;
  setHint(null);
  setPicking(true);
  try {
    const result = await api.pickRefs(mode, startingFolder);
    if (result.kind === "refs") {
      if (result.refs.length) append(result.refs);
    } else {
      setDialog({ mode, candidates: result.candidates });
    }
  } catch (e) {
    setHint(`Couldn't open the picker: ${(e as Error).message}`);
  } finally {
    setPicking(false);
  }
};
```

Per Q2's clarification, `setPicking(false)` in `finally` already fires as soon as the initial `/refs/pick` call resolves — including when it resolves to the `"candidates"` case — so the trigger button returns to normal the instant the dialog opens, exactly as specified. No change needed to make that true; it falls out of moving the dialog-open decision into the existing `try` block instead of adding a second async step before `finally`.

Render, right after the existing `dropOverlay` conditional (both variants return early, so add it to each return's JSX, or factor a shared trailing fragment — check whether `inline`/expandable returns can both append one extra sibling cheaply):
```tsx
{dialog && (
  <FolderPickerDialog
    open
    mode={dialog.mode}
    candidates={dialog.candidates}
    onDone={(picked) => {
      setDialog(null);
      if (picked.length) append(picked);
    }}
  />
)}
```
Conditionally rendering on `dialog &&` (rather than always rendering with `open={dialog !== null}`) is what gives the dialog a clean mount per open, per the "reopen with no stale state" requirement in §2.

No change to `picking`/`hint` state shape, no change to `buttons`/`chips`/drag-drop code, no change to either `variant` branch's outer structure beyond adding this one sibling — satisfies the ticket's "no change to loading/error surface for the desktop path" constraint.

## 4. No changes needed at call sites

`NewTaskForm` and `RunPanel` both render `<ReferencesPicker variant=... />` already; since the dialog is fully internal to `ReferencesPicker`, neither needs to change. Confirms scope item 4 from the ticket — verify by grepping both files for `<ReferencesPicker` to confirm no props need to flow through (e.g. neither currently passes anything the dialog would need beyond what `ReferencesPicker` already has: `startingFolder`, `mode` is per-button not per-component).

## 5. e2e tests — `e2e/` (new specs + fixture support)

**Fixture gap**: every existing `E2EBackend` (`backend` and `freshBackend` in `e2e/fixtures.ts`) unconditionally sets `AGETOR_FAKE_PICK_REFS_DIR`, which makes `/refs/pick` always return `{ refs }` — never `{ candidates }`. The new specs need a backend where that env var is **not** set so the real headless `candidates` branch in `server.ts` fires.

Add a minimal, additive change to `e2e/fixtures.ts` (allowed — it's test harness code, not the `src/bun/server.ts`/`refs-pick.ts` logic the ticket says not to touch):
- Give `provisionBackend` an optional 6th parameter, e.g. `options?: { fakePickRefsDir?: boolean }` (default `true`, preserving every existing call site's behavior byte-for-byte), and only include `AGETOR_FAKE_PICK_REFS_DIR` in the spawned child's `env` when that option is `true`.
- Add a new test-scoped fixture, e.g. `headlessPickBackend`, structurally identical to `freshBackend` (own port range — pick the next disjoint block after `FRESH_GITHUB_STUB_BASE_PORT = 4900`, e.g. `HEADLESS_PICK_BASE_API_PORT = 5000` / `HEADLESS_PICK_GITHUB_STUB_BASE_PORT = 5100`) but calling `provisionBackend(..., { fakePickRefsDir: false })`. Test-scoped (not worker-scoped) is appropriate here since only a couple of specs need it and it keeps the "no native, no fixture" backend's task list empty/predictable (no risk of another spec's leftover tasks polluting `headlessPickCandidates()`'s task-workdir candidates, since it's a fresh `dataDir`/SQLite file per test like `freshBackend`).
- `headlessPickCandidates()` always includes `$HOME` itself as a final fallback (`add(home)` in `refs-pick.ts`), so this backend's candidate list is guaranteed non-empty even with zero tasks and no matching `~`-level git repos — the "assert at least one candidate row" requirement in the ticket's test plan is satisfied without needing to seed any task or directory structure.

New spec file `e2e/folder-picker-dialog.spec.ts` using `headlessPickBackend`, three cases (`test.describe` per the ticket's three-spec breakdown):
1. **Candidate click**: open a task form (or whichever surface is fastest to reach `refs-pick-folder`/`refs-pick-files` — check an existing `refs-pick-*` spec, e.g. in `issue-task.spec.ts`, for the minimal page setup used today), click `refs-pick-folder`, assert the dialog opens with ≥1 candidate row (`folder-picker-candidate` count ≥ 1), click the first row, assert it closes and a `refs-chip` appears with `title` equal to that row's `data-path`.
2. **Manual entry**: open the folder picker, type a known-good absolute path (e.g. `backend.dataDir` itself, which definitely exists) into `folder-picker-manual-input`, submit, assert the same `refs-chip` contract. Also assert the invalid-path branch inline (AC-8): submit a non-existent path first, assert `folder-picker-manual-error` renders and the dialog stays open, then correct it and assert success — covers "user submits… repeatedly after correcting it" from SPEC.md's edge cases in the same spec rather than a fourth file.
3. **Files-mode drill-in**: click `refs-pick-files`, click a candidate directory known to contain files (e.g. plant a couple of files under `backend.dataDir` via `writeFile` before the test, then pick `backend.dataDir` as the candidate/manual path so the files-mode listing is deterministic rather than depending on real `$HOME` contents), assert the `"fileslist"` screen renders those files (`folder-picker-file` rows), click one, assert a `refs-chip` for that single file appears (and, per AC-4, that ONLY one chip appears — not one per file in the directory). Also assert the back-button path (AC-5): drill in, click `folder-picker-back`, assert the candidate list reappears, then cancel and assert no chip was added (AC-9).

**Regression guard**: no changes to the existing `plantPicks`-based specs (`issue-task.spec.ts` and any other `AGETOR_FAKE_PICK_REFS_DIR`-flow spec) — they keep using `backend`/`freshBackend` unmodified, which still set the fixture env var by default (`fakePickRefsDir` defaults to `true`). Run the full existing suite to confirm zero behavior change there.

## 6. Verification

- `bun run typecheck` — must stay green; the new `PickRefsResult` type and `FolderPickerDialog` props need to typecheck cleanly against `ReferencesPicker.tsx`'s existing usage.
- `bun test` — no `src/bun/*` files change, so the existing unit test suite (including `refs-pick.test.ts` and any `headless-routes` test covering `/refs/pick`) should be unaffected; run it to confirm.
- New Playwright specs (`e2e/folder-picker-dialog.spec.ts`) pass; existing `AGETOR_FAKE_PICK_REFS_DIR`-driven specs pass unmodified.
- Manual smoke (optional but cheap): `scripts/dev-headless.sh` + a browser, click the folder picker on a task with no `AGETOR_FAKE_PICK_REFS_DIR` set, confirm the dialog behavior end-to-end matches the ACs.

## Files touched

- `src/mainview/lib/api.ts` — `pickRefs` return type change, new `selectPickedRef`, new exported `PickRefsResult` type.
- `src/mainview/components/kanban/FolderPickerDialog.tsx` — new file.
- `src/mainview/components/kanban/ReferencesPicker.tsx` — `pick()` branch + dialog state + render.
- `e2e/fixtures.ts` — additive `provisionBackend` options param + new `headlessPickBackend` fixture.
- `e2e/folder-picker-dialog.spec.ts` — new file.

Not touched: `src/bun/refs-pick.ts`, `src/bun/server.ts`, `src/cli/**`, `NewTaskForm.tsx`, `RunPanel.tsx`.
