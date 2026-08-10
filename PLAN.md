# PLAN — Project management sidebar (create / edit / delete projects)

## Ticket
In the GUI, let the user create / edit / delete projects. Add a new sidebar that
handles project settings and that also auto-hides (collapses to a thin rail like
the existing New Task sidebar).

## Outcome this moves (measurable)
Today a "project" (a registered working directory) can only be **added**
(implicitly via task creation, or the native folder picker inside the New Task
`ProjectPicker`) and its branch nomenclature edited via `BranchNamingDialog`.
There is **no UI to rename a project or remove it** — `api.deleteProject` exists
but nothing calls it, and rename isn't supported by the server at all.

After this change: a dedicated, collapsible **Projects sidebar** on the right of
the board lets the user add a project (native folder dialog), rename it, edit its
branch naming, and delete it. Visible behavior: the sidebar's `w-72 ⇄ w-11`
collapse persists across launches (localStorage), and the board's `<main>`
reclaims/yields the space in the same frame (mirrors the New Task sidebar).

## Background — what already exists (do not rebuild)

Backend is almost complete already:
- `projects` table: `path` (PK), `name`, `added_at`, `branch_config`
  (migrations `005_projects.sql`, `026_project_branch_config.sql`).
- `src/bun/db.ts` `projects` module (line ~427): `list()`, `get(path)`,
  `upsert(path, name)` (⚠️ `ON CONFLICT DO UPDATE SET added_at` only — **name is
  NOT updated on conflict**, so upsert cannot rename), `setBranchConfig`,
  `delete(path)`.
- `src/bun/server.ts` `/projects` route object (line ~494): `GET` (list),
  `POST` (add by path), `DELETE` (remove by path). `/projects/pick` (native
  folder dialog → upsert), `/projects/settings` GET/PUT (branch config).
- `src/mainview/lib/api.ts` (line ~381): `listProjects`, `pickProject`,
  `deleteProject`, `getProjectBranchConfig`, `setProjectBranchConfig`.
- `src/mainview/components/settings/BranchNamingDialog.tsx` — the per-project
  branch-naming editor. **Reuse it as-is** (it takes `projectPath`,
  `projectName`, `onSaved`, `open`, `onClose`). Do not duplicate branch-config UI.
- Collapse plumbing: `src/mainview/lib/panel-collapse.ts`
  (`readCollapsed`/`writeCollapsed` + `NEW_TASK_PANEL_COLLAPSED_KEY`), used by
  `NewTaskForm.tsx` (lines 93–102, 543–594) — the exact pattern to mirror.
- Confirm dialog: `useConfirm()` from `src/mainview/components/ui/confirm.tsx`
  (already mounted in `main.tsx`; already used in `App.tsx` line 175). Use it for
  destructive delete.
- `App.tsx` owns `projects` state (line 147), loads it once (line 227), and
  passes it to `KanbanFilters` (repo filter) and swimlane grouping (lines
  547–591). The new sidebar must keep this state fresh so filters/swimlanes
  reflect adds/renames/deletes.

Missing pieces: **(1)** a server/db way to rename, **(2)** the client
`renameProject`, **(3)** the sidebar component, **(4)** App wiring, **(5)** a
persisted collapse key. That is the whole scope.

## Design decisions
- **Placement: right side of the board.** The New Task sidebar is on the left;
  put the Projects sidebar on the right so the layout reads add-task-left,
  manage-projects-right. It goes inside the existing
  `<div className="flex min-h-0 flex-1">` row in `App.tsx`, **after** `</main>`
  (App.tsx line 951) and before that row's closing `</div>` (line 952).
  `<main>` is `flex-1`, so it reclaims the freed width automatically — same
  mechanism the New Task sidebar relies on. RunPanel (line 953+) is an overlay
  rendered after the row and is unaffected.
- **"Auto-hides" = collapse-to-rail**, matching the New Task sidebar (the "also"
  in the ticket references that sidebar). Mirror it: `w-72` expanded / `w-11`
  collapsed rail, `transition-[width] duration-200`, a round straddle toggle
  button on the panel's **left** edge (`-left-2.5`, since border is on the left),
  state persisted via `panel-collapse.ts`.
- **Add** = native folder dialog via `api.pickProject()` (same call the
  `ProjectPicker` "Browse for folder…" uses). No free-text path entry — matches
  existing UX and avoids the absolute-path validation dance.
- **Edit** = two things: inline **rename** of the display name, and a
  **Branch naming** button that opens the existing `BranchNamingDialog`.
- **Delete** = `useConfirm({ variant: "destructive" })` then
  `api.deleteProject(path)`. Confirm copy must state it only removes the list
  entry: **tasks and worktrees are not touched** (there is no FK from `tasks`
  to `projects`; delete is a `DELETE FROM projects WHERE path=?` only). Note the
  existing auto-upsert on task creation means a deleted project reappears if a
  task with that workdir is later created — acceptable, existing behavior.

## Changes

### 1. `src/bun/db.ts` — add `projects.rename`
In the `projects` object (after `setBranchConfig`, before `delete`), add:
```ts
/**
 * Update a project's display name. Returns the refreshed row, or null if the
 * project isn't registered. `upsert` can't do this — it only refreshes
 * added_at on conflict, deliberately, so re-picking a project never clobbers
 * its name/config.
 */
rename(path: string, name: string): Project | null {
  db.run(`UPDATE projects SET name = ? WHERE path = ?`, [name, path]);
  return this.get(path);
},
```
No migration needed (column exists). `db.run` on a non-existent path is a no-op;
`get` then returns null → caller 404s.

### 2. `src/bun/server.ts` — add `PATCH` to the `/projects` route object
Inside the existing `"/projects": { GET, POST, DELETE }` object (line ~494), add
a `PATCH` sibling:
```ts
PATCH: authed(async (req) => {
  const body = (await req.json().catch(() => ({}))) as { path?: unknown; name?: unknown };
  const p = typeof body.path === "string" ? body.path.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!p) return json({ error: "path required" }, { status: 400, headers: corsHeaders(req) });
  if (!name) return json({ error: "name required" }, { status: 400, headers: corsHeaders(req) });
  const updated = projects.rename(p, name);
  if (!updated) return json({ error: "project not found" }, { status: 404, headers: corsHeaders(req) });
  return json(updated, { headers: corsHeaders(req) });
}),
```
Mirror the existing POST/DELETE style in that block (`authed`, `corsHeaders(req)`,
`json(...)`). `projects` is already imported (server.ts line 14).

### 3. `src/mainview/lib/api.ts` — add `renameProject`
After `deleteProject` (line ~388):
```ts
renameProject: (p: string, name: string) =>
  j<Project>("/projects", { method: "PATCH", body: JSON.stringify({ path: p, name }) }),
```
`Project` is already imported. `j<void>` for delete already sets method/body the
same way — follow that shape.

### 4. `src/mainview/lib/panel-collapse.ts` — add the collapse key
Add next to `NEW_TASK_PANEL_COLLAPSED_KEY` (line 17):
```ts
/** Storage key for the Projects sidebar's collapsed flag. */
export const PROJECTS_PANEL_COLLAPSED_KEY = "agetor:projectsPanelCollapsed";
```
No other change — `readCollapsed`/`writeCollapsed` are already key-parameterized.

### 5. NEW `src/mainview/components/kanban/ProjectsSidebar.tsx`
Mirror `NewTaskForm.tsx`'s collapse structure (lines 543–594), border on the
**left** (`border-l`), toggle button at `-left-2.5` with `ChevronLeft`/
`ChevronRight` swapped for the right-side edge (collapsed → `ChevronLeft` to
expand-leftward; expanded → `ChevronRight` to collapse-rightward).

Props:
```ts
interface Props {
  projects: Project[];       // from App (source of truth for the list)
  onChanged: () => void;     // App refreshes its projects state after any mutation
}
```

State: `collapsed` (lazy init from `readCollapsed(PROJECTS_PANEL_COLLAPSED_KEY)`,
`useEffect` → `writeCollapsed` on change, same as NewTaskForm lines 97–102);
`renamingPath: string | null` + `renameText: string` for inline rename;
`branchProjectPath: string | null` to drive one shared `BranchNamingDialog`;
`busy` guard for the add/pick call.

Expanded body (`w-72`):
- Header row: `"Projects"` label + an **Add** button (`Plus` icon) →
  `const { project } = await api.pickProject(); if (project) onChanged();`
  (guard with `busy`; on failure no-op, matches ProjectPicker).
- Scrollable list of `projects` (already sorted `added_at DESC`). Each row:
  - When `renamingPath === p.path`: an `Input` bound to `renameText`, save on
    Enter or blur → `await api.renameProject(p.path, renameText.trim()); onChanged();`
    then clear renaming state; Escape cancels. Empty/whitespace name → cancel
    (no call).
  - Otherwise: the name (click / a `Pencil`-style edit button starts rename),
    the path shown small + truncated (`title={p.path}`), and two actions:
    - **Branch naming** button → `setBranchProjectPath(p.path)`.
    - **Delete** button (`Trash2`) → `if (await confirm({ title: "Remove project?",
      description: "Removes it from the project list. Tasks and worktrees are not
      affected.", confirmLabel: "Remove", variant: "destructive" })) { await
      api.deleteProject(p.path); onChanged(); }`.
  - Empty state when `projects.length === 0`: a short muted line + the Add button.
- Reuse `basename(p.path)` helper (copy the 3-line helper from `ProjectPicker.tsx`
  lines 26–30) for the fallback label.

Collapsed rail (`w-11`): vertical `"Projects"` label button (`[writing-mode:vertical-rl]`)
that expands on click — copy NewTaskForm lines 585–594.

Shared dialog at the bottom of the component (rendered once):
```tsx
<BranchNamingDialog
  open={branchProjectPath !== null}
  projectPath={branchProjectPath ?? ""}
  projectName={projects.find((p) => p.path === branchProjectPath)?.name}
  onClose={() => setBranchProjectPath(null)}
  onSaved={() => { setBranchProjectPath(null); onChanged(); }}
/>
```

Use `useConfirm()` from `@/components/ui/confirm`, `cn` from `@/lib/utils`,
`Button`/`Input` from `@/components/ui/*`, icons from `lucide-react`
(`Plus`, `Pencil`, `Trash2`, `Settings2`/`GitBranch`, `ChevronLeft`,
`ChevronRight`). Import `Project` type from `../../../shared/types.ts` (match
ProjectPicker's relative import).

### 6. `src/mainview/App.tsx` — mount the sidebar
- Import: `import { ProjectsSidebar } from "@/components/kanban/ProjectsSidebar";`
  (near the other kanban imports, line ~13).
- Inside `<div className="flex min-h-0 flex-1">`, after `</main>` (line 951),
  add:
```tsx
<ProjectsSidebar
  projects={projects}
  onChanged={() => { void api.listProjects().then(setProjects).catch(() => {}); }}
/>
```
`projects`/`setProjects` already exist (App.tsx line 147). This keeps the repo
filter and swimlane grouping in sync after any project mutation.

## Tests (gate tests — deterministic, in the same commit)

### A. NEW `src/bun/projects-crud-endpoint.test.ts`
Model it on `project-settings-endpoint.test.ts` (temp `AGETOR_DATA_DIR`, a fixed
`AGETOR_API_PORT` **distinct from 4401** — use `4402`; boot server; `Bearer`
auth). Cover:
- `POST /projects` with an absolute existing path (use the temp `DATA_DIR`
  itself, which exists) → 200, body `{ path, name }`; `projects.get` returns it.
- `POST /projects` with a relative path → 400; with a non-existent path → 404.
- `PATCH /projects` renames → 200, `projects.get(path).name` updated + response
  body reflects new name.
- `PATCH /projects` with empty `name` → 400.
- `PATCH /projects` for an unregistered path → 404.
- `DELETE /projects` → 204 and `projects.get(path)` is null.

### B. NEW `src/bun/projects-db.test.ts` (or extend if a projects db test exists — none does)
Temp `AGETOR_DATA_DIR`, import `projects` from `./db.ts`:
- `upsert` then `rename` changes `name`, leaves `branchConfig` untouched
  (set a config first via `setBranchConfig`, rename, assert config survives).
- `rename` on an unknown path returns `null`.
- `upsert` re-call keeps the original name (documents why `rename` is needed —
  upsert's ON CONFLICT only bumps `added_at`).

### C. `src/mainview/lib/panel-collapse.test.ts` — extend
Add a test importing `PROJECTS_PANEL_COLLAPSED_KEY`: it is a non-empty string,
distinct from `NEW_TASK_PANEL_COLLAPSED_KEY`, and round-trips through
`writeCollapsed`/`readCollapsed` with a `fakeStorage` (independent of the New
Task key — writing one doesn't affect the other).

## Evals
N/A — this is pure deterministic-space work (CRUD + UI chrome), no LLM /
latent-space component to evaluate. Gate tests above are the full verification
surface. (Stated explicitly per CLAUDE.md's latent-vs-deterministic rule.)

## Verification checklist (for Builder)
- `bun run typecheck` green (watch the `Project` import path in the new
  component; `@/`-alias vs relative — ProjectPicker uses the relative
  `../../../shared/types.ts`).
- `bun test src/bun/projects-crud-endpoint.test.ts src/bun/projects-db.test.ts`
  green.
- `bun test src/mainview/lib/panel-collapse.test.ts` green.
- Manual (dev app, `scripts/dev-headless.sh` per memory — the normal
  `dev:hmr` GUI crashes on this host): sidebar collapses/expands and remembers
  state across reload; Add opens the folder dialog and the project appears in
  both the sidebar and the repo filter; rename updates the swimlane header and
  filter; delete removes it after confirm; Branch naming opens the existing
  dialog and saves.

## Files touched
- `src/bun/db.ts` (add `projects.rename`)
- `src/bun/server.ts` (add `PATCH /projects`)
- `src/mainview/lib/api.ts` (add `renameProject`)
- `src/mainview/lib/panel-collapse.ts` (add `PROJECTS_PANEL_COLLAPSED_KEY`)
- `src/mainview/components/kanban/ProjectsSidebar.tsx` (NEW)
- `src/mainview/App.tsx` (import + mount sidebar)
- `src/bun/projects-crud-endpoint.test.ts` (NEW)
- `src/bun/projects-db.test.ts` (NEW)
- `src/mainview/lib/panel-collapse.test.ts` (extend)

## Restart after build
Main-process files changed (`db.ts`, `server.ts`) → the Builder/human must
restart `bun run dev` (or `scripts/dev-headless.sh`); those do not HMR. Webview
files (`App.tsx`, sidebar, api, panel-collapse) HMR under `dev:hmr`.
