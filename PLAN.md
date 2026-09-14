# PLAN — Wire Project picker's "Browse for folder…" to the headless folder-picker

## Approach

Mirror `ReferencesPicker.pick()`'s existing fallback ladder inside `ProjectPicker.onBrowse`, gated strictly behind an `ApiError` with `status === 501` from the first `api.pickProject()` call. `api.pickProject()` stays the untouched first attempt (AC-6, AC-7); only on a 501 does the component reuse `api.pickRefs("folder", …)` + `FolderPickerDialog` — the exact same components/endpoints `ReferencesPicker` already uses — to resolve a path and register it via a new `api.addProject` wrapper around the already-existing `POST /projects`. No server route changes (SPEC non-goals; ticket scope item 3).

## Files to change

### 1. `src/mainview/lib/api.ts`

Add one wrapper next to `pickProject`/`cloneProject`/`renameProject` in the `api` object (around line 522-535), matching their doc-comment style:

```ts
/** Register a project by absolute path — the headless-picker-fallback
 *  equivalent of `pickProject`'s native "canceled or succeeded" round trip.
 *  Throws `ApiError` (400/404) if the path is missing/relative/non-existent. */
addProject: (path: string) =>
  j<Project>("/projects", { method: "POST", body: JSON.stringify({ path }) }),
```

`Project` is already imported at the top of the file. `POST /projects` (`server.ts:658-673`) returns the upserted `Project` object directly (not wrapped), so the return type is `Project`, unlike `pickProject`'s `{ project: Project | null }`.

### 2. `src/mainview/lib/project-browse-fallback.ts` (new)

A small pure predicate, following this codebase's established pattern of extracting a decision branch into a standalone `lib/*.ts` + `*.test.ts` pair (see `find-shortcut.ts`, `font-size.ts`, `panel-collapse.ts`) so the AC-8 branch condition is unit-testable without mounting React:

```ts
import { ApiError } from "./api";

/** True only for the exact "no native bridge in this session" signal
 *  `notAvailableHeadless` returns (`server.ts`) — never pattern-matched on
 *  message text. Any other failure (network error, non-501 ApiError, a
 *  thrown non-Error) must NOT trigger the headless-picker fallback (AC-8). */
export function shouldFallbackToHeadlessPicker(error: unknown): boolean {
  return error instanceof ApiError && error.status === 501;
}
```

### 3. `src/mainview/lib/project-browse-fallback.test.ts` (new)

Unit-test the predicate directly (this is the "extend the ProjectPicker unit test" requirement from the ticket, adapted to this codebase's convention since no `ProjectPicker.tsx` component-test file exists today — there are no `*.tsx` render tests anywhere in `src/mainview`, only pure-logic `lib/*.test.ts` files):
- `ApiError` with `status: 501` → `true`.
- `ApiError` with `status: 404` / `500` / other → `false`.
- A plain `Error`, a thrown string, `undefined` → `false`.

### 4. `src/mainview/components/kanban/ProjectPicker.tsx`

- Imports: add `FolderPickerDialog` from `"./FolderPickerDialog"`, `shouldFallbackToHeadlessPicker` from `"@/lib/project-browse-fallback"`, and `TaskReference` from `"../../../shared/types.ts"` (already how `ReferencesPicker`/`FolderPickerDialog` import it).
- Add local state, scoped to this component instance exactly like `ReferencesPicker` owns its own `dialog` state (constraint: no shared/global singleton):
  ```ts
  const [dialog, setDialog] = useState<null | { candidates: string[] }>(null);
  ```
  (No `mode` field needed — this consumer only ever picks folders, unlike `ReferencesPicker` which supports files too.)
- Factor the "register + select" success step (shared by both the direct-refs branch and the dialog's `onDone`) into a small local helper inside the component:
  ```ts
  const registerAndSelect = async (path: string) => {
    await api.addProject(path);
    await refresh();
    onChange(path);
  };
  ```
- Rewrite `onBrowse`:
  ```ts
  const onBrowse = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const { project } = await api.pickProject(value || undefined);
      if (project) {
        await refresh();
        onChange(project.path);
      }
    } catch (e) {
      if (!shouldFallbackToHeadlessPicker(e)) return; // AC-8: non-501 stays silent, no fallback
      try {
        const result = await api.pickRefs("folder", value || undefined);
        if (result.kind === "refs") {
          const path = result.refs[0]?.path;
          if (path) await registerAndSelect(path);
        } else {
          setDialog({ candidates: result.candidates });
        }
      } catch { /* fallback attempt itself failed — stay silent, matching AC-8 */ }
    } finally {
      setPicking(false);
    }
  };
  ```
  Note the `return` inside the `catch` block for the non-501 case reaches `finally` as normal (returning from inside a try/catch still runs `finally`), so `setPicking(false)` always fires — identical semantics to today's bare `catch { /* swallow */ }`.
- Render the dialog as a sibling of `CloneProjectDialog` (same reasoning already documented there — popover unmounts when a dialog takes focus):
  ```tsx
  {dialog && (
    <FolderPickerDialog
      open
      mode="folder"
      candidates={dialog.candidates}
      onDone={async (refs) => {
        setDialog(null);
        const path = refs[0]?.path;
        if (path) await registerAndSelect(path);
      }}
    />
  )}
  ```
  An empty `refs` (cancel) is a no-op, matching AC-5 and today's cancel behavior.
- Add `data-testid="project-picker-browse"` to the existing "Browse for folder…" `<button>` so the new e2e spec has a stable selector (it currently has none). This is the only markup addition beyond the dialog; no other existing attributes/behavior change.
- Do not touch `CloneProjectDialog` wiring, `SearchSelect` usage, or any other part of the file.

## Why `FolderPickerDialog`'s existing `{ open, mode, candidates, onDone }` interface is sufficient

`ProjectPicker` needs exactly the `"folder"` mode's behavior (single resolved ref, dialog closes on `onDone`), which the component already supports unmodified — same as `ReferencesPicker`'s folder-mode usage. No prop changes needed; confirmed by reading `FolderPickerDialog.tsx` before writing this plan.

## Tests

### `src/mainview/lib/project-browse-fallback.test.ts`
Covers the AC-8 branch condition in isolation (see above).

### `e2e/project-picker-browse.spec.ts` (new, follows `e2e/folder-picker-dialog.spec.ts`'s structure/helpers)

Two `describe` blocks / fixtures, mirroring how `folder-picker-dialog.spec.ts` uses `headlessPickBackend` vs. the default `backend`:

1. **`headlessPickBackend` (no native, no `AGETOR_FAKE_PICK_REFS_DIR` → `/refs/pick` returns `{ candidates }`)** — covers AC-1, AC-2, AC-3, AC-5, AC-7:
   - `gotoApp`, locate the New Task sidebar (`page.locator("aside").first()`, consistent with the existing helper comment in `folder-picker-dialog.spec.ts` about `.last()` being the run panel — the New Task form is the *first* `<aside>` mounted in `App.tsx`).
   - Open the Project `SearchSelect` trigger via `page.getByTitle("Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list.")` (the exact `title` string `NewTaskForm` already passes to `ProjectPicker`).
   - Click `[data-testid="project-picker-browse"]` ("Browse for folder…").
   - Assert `[data-testid="folder-picker-dialog"]` becomes visible with at least one `folder-picker-candidate` row (AC-1).
   - Click a candidate row; assert the dialog closes.
   - Assert the Project picker trigger's label now shows the picked folder's basename (AC-2).
   - Re-open the trigger and assert the picked path now appears as an item in the project list (AC-3) — or equivalently call `GET /projects` via `request` and assert the path is present.
   - Separately: open the picker again, click "Browse for folder…", then click `folder-picker-cancel`; assert the dialog closes and the previously-selected project is unchanged (AC-5).
   - Also cover the multi-candidate-to-dialog path is reached only because native is unavailable (AC-7 is implicitly covered since this fixture has no native bridge at all — no separate native-path e2e coverage is feasible/needed here, matching how `folder-picker-dialog.spec.ts` covers only the headless side).

2. **Default `backend` (has `AGETOR_FAKE_PICK_REFS_DIR` set → `/refs/pick` returns `{ refs }` directly)** — covers AC-4:
   - Same navigation/open steps as above.
   - After clicking "Browse for folder…", assert `[data-testid="folder-picker-dialog"]` never becomes visible (use `expect(...).not.toBeVisible()` after a short settle, or assert the Project picker's trigger label updates directly without any intermediate dialog).
   - Assert the project ends up registered and selected exactly as in the candidates-path case, with zero additional interaction.

Use the same `TaskRow`/`createTask`-style setup only if a task needs to exist first; unlike `folder-picker-dialog.spec.ts`, `ProjectPicker` lives on the always-mounted `NewTaskForm`, so no task creation is required before opening the picker — the spec can go straight to `gotoApp`.

## Explicitly out of scope / unchanged

- `src/bun/server.ts` — no route changes anywhere (`/projects/pick`, `/refs/pick`, `/refs/pick/select`, `POST /projects` all confirmed read-only for this task).
- `src/mainview/components/kanban/ReferencesPicker.tsx` — untouched.
- `src/mainview/components/kanban/FolderPickerDialog.tsx` — untouched (props/behavior unmodified; reused as-is).
- `CloneProjectDialog` and its wiring in `ProjectPicker.tsx` — untouched.

## Definition of done checklist

- `bun run typecheck` green.
- `bun test` green, including `project-browse-fallback.test.ts`.
- New `e2e/project-picker-browse.spec.ts` passes (both fixtures).
- No existing test weakened/deleted.
