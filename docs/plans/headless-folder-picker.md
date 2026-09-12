# Headless refs/pick — enumerate candidates and select via TUI

## Goal

When running in headless mode (CLI daemon / agetor TUI), `POST /refs/pick` currently
returns 501 "not available". The fix: enumerate accessible directories from the
host filesystem and return them as candidates. The TUI (and any future CLI path)
presents the list for keyboard selection.

## Background

`POST /refs/pick` has three branches today:
1. `AGETOR_FAKE_PICK_REFS_DIR` set → test seam (returns files/dir from a fixture folder)
2. `native` present (Electrobun desktop) → OS open-panel dialog
3. `native` absent (headless/CLI) → `notAvailableHeadless()` — dead end

The webview's `ReferencesPicker` calls `api.pickRefs(mode, startingFolder)`, gets an
error, and silently drops the pick. In the CLI there is no UI path at all for folder
picking.

## Scope

### Server side — `src/bun/server.ts` (`/refs/pick` route)

When `native` is null (headless) AND `AGETOR_FAKE_PICK_REFS_DIR` is unset, instead of
calling `notAvailableHeadless`, enumerate candidates:

**Candidate generation rules (priority order):**
1. Every unique `workdir` currently in the `tasks` table (directories the user has
   already pointed agetor at — highest relevance). Sort by most-recently used first
   (join against `tasks.updatedAt`).
2. Direct subdirectories of `$HOME` that are git repos (`existsSync(join(dir, ".git"))`).
   Walk only one level deep; ignore dotdirs.
3. `$HOME` itself as a fallback entry.

**Constraints:**
- Dedup by `realpathSync`.
- Cap at 50 entries total.

**Response shape:**

For `mode = "folder"` or `mode = "files"`:
```json
{ "candidates": ["<abs-path>", ...], "refs": [] }
```
`refs` stays empty because no selection has been made yet. The caller signals a
selection with a second request (see `/refs/pick/select` below).

**New sibling route — `POST /refs/pick/select`:**

Accepts `{ path: string, mode: "files" | "folder" }` and applies the existing
`refsFromPaths` / file-listing logic to produce the final `{ refs }` response.

- `mode = "folder"`: returns `{ refs: [{ path, isDirectory: true }] }`.
- `mode = "files"`: lists immediate regular files under `path`, returns
  `{ refs: [{ path: "<file>", isDirectory: false }, ...] }`.

This two-step design keeps the interactive selection loop in the TUI, not the server,
and keeps the server stateless.

No new migrations. No new DB columns.

### API client — `src/mainview/lib/api.ts`

`pickRefs(mode, startingFolder)` currently calls the route and expects `{ refs }`.
Update it to:

- If the response contains `candidates` → enter the interactive-selection flow
  (invoke the overlay depending on context).
- If the response contains `refs` directly (desktop native path or fake seam) →
  pass through unchanged. No regression.

### TUI side — `src/cli/tui/`

Introduce a `DirPickerOverlay` component (same layer as `AnswerOverlay`):

**Activation:** Any code path that previously called `api.pickRefs` detects a
`{ candidates }` response and resolves the Promise only after a selection is made.

**Navigation:**
- Renders the candidate list with arrow-key navigation.
- Live filter input: typing narrows candidates by substring match on the path.
- Enter confirms the highlighted entry.
- A manual-entry row ("Enter a path…") opens a bare text input; on submit it calls
  `POST /refs/pick/select` directly.

**`mode = "files"` two-level flow:**
1. User selects a directory → overlay calls `POST /refs/pick/select { path, mode: "files" }`.
2. A second-level file list is shown with the same navigation.
3. Esc at the file level returns to the directory list.
4. Esc at the directory level cancels (returns `refs: []`).

**`mode = "folder"` single-level flow:**
1. Enter on a candidate calls `POST /refs/pick/select { path, mode: "folder" }` and
   exits the overlay.

### Tests

**Unit tests (`src/bun/refs-endpoint.test.ts`):**
- Assert that `POST /refs/pick` in headless mode (`native = null`, `FAKE_PICK` unset)
  returns `{ candidates: [...] }` containing at least the task workdirs present in the DB.
- Assert `POST /refs/pick/select { path: <existing dir>, mode: "folder" }` returns
  `{ refs: [{ path, isDirectory: true }] }`.
- Assert `POST /refs/pick/select { path: <existing dir>, mode: "files" }` returns
  `{ refs }` listing the directory's immediate regular files.

**e2e test (`src/cli/tui/`):**
- Drive the `DirPickerOverlay` with synthetic keystrokes (↑ ↓ Enter) and assert the
  resulting task carries the selected path as a reference.

## Out of scope

- Recursive file browser (one directory level is enough).
- Desktop path — zero changes to the `native.openFileDialog` branch.
- `AGETOR_FAKE_PICK_REFS_DIR` test seam — leave it exactly as is.

## Definition of done

- `POST /refs/pick` in headless mode returns `{ candidates }` (not 501).
- `POST /refs/pick/select` resolves the pick to a `{ refs }` response.
- `DirPickerOverlay` in the TUI lets a user navigate and confirm a folder or files.
- All existing headless-routes tests still pass.
- The three new unit tests and one new e2e test pass.
- `bun run typecheck` is green.
