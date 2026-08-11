# PLAN — Move the Projects sidebar to the left side (coexist with New Task)

## Ticket interpretation

"Move protect tab to the left side. It needs to coexist with the new Task tab."

`protect` is a mis-transcription of **projects**. The **Projects sidebar** (`ProjectsSidebar`) currently renders on the **right** edge of the board. The **New Task** sidebar (`NewTaskForm`) renders on the **left**. The ticket asks to relocate the Projects sidebar to the left so it sits alongside the New Task sidebar, with the kanban board taking the remaining width to the right.

No other reading fits: `grep -rniE "protect" src/mainview` returns nothing, and the only two collapsible edge "tabs" in the layout are New Task (left) and Projects (right). The branch name `feature/move-protect-tab-to-the-left-side` confirms it.

## Current layout (App.tsx)

`src/mainview/App.tsx:859-957` renders a horizontal flex row:

```
<div className="flex min-h-0 flex-1">
  <NewTaskForm ... />          // left sidebar,  border-r, w-80/w-11
  <main className="flex min-w-0 flex-1 flex-col"> ... board ... </main>
  <ProjectsSidebar ... />      // right sidebar, border-l, w-72/w-11
</div>
```

Both sidebars are `shrink-0` collapsible rails driven by `localStorage` collapse flags (`src/mainview/lib/panel-collapse.ts`): `NEW_TASK_PANEL_COLLAPSED_KEY` and `PROJECTS_PANEL_COLLAPSED_KEY`. `main` is `flex-1`, so it reclaims freed width automatically when either sidebar collapses.

`NewTaskForm` (`src/mainview/components/kanban/NewTaskForm.tsx`) is the reference left-side chrome:
- outer `<aside>` uses `border-r border-border/60` (`NewTaskForm.tsx:547`)
- collapse toggle straddles the **right** edge: `absolute -right-2.5 …` (`NewTaskForm.tsx:566`)
- toggle icons: `collapsed ? <ChevronRight/> : <ChevronLeft/>` (`NewTaskForm.tsx:568-570`)
- widths `collapsed ? "w-11" : "w-80"` (`NewTaskForm.tsx:549`)
- collapsed rail label uses `[writing-mode:vertical-rl]` (`NewTaskForm.tsx:590`)

`ProjectsSidebar` (`src/mainview/components/kanban/ProjectsSidebar.tsx`) is currently built as **right-side** chrome (mirror image of the above):
- outer `<aside>` uses `border-l border-border/60` (`ProjectsSidebar.tsx:104`)
- collapse toggle straddles the **left** edge: `absolute -left-2.5 …` (`ProjectsSidebar.tsx:118`)
- toggle icons: `collapsed ? <ChevronLeft/> : <ChevronRight/>` (`ProjectsSidebar.tsx:120-122`)
- widths `collapsed ? "w-11" : "w-72"` (`ProjectsSidebar.tsx:106`)
- JSDoc + inline comments describe it as the "Right-side Projects sidebar" with the border/toggle on the LEFT (`ProjectsSidebar.tsx:31-36`, `109-111`)

## Target layout

Order left→right: **Projects sidebar, New Task sidebar, board.**

```
<div className="flex min-h-0 flex-1">
  <ProjectsSidebar ... />      // leftmost, now left-side chrome (border-r, toggle on right edge)
  <NewTaskForm ... />          // UNCHANGED
  <main className="flex min-w-0 flex-1 flex-col"> ... board ... </main>
</div>
```

### Why Projects goes leftmost (not between New Task and the board)

Putting Projects as the first child leaves `NewTaskForm` **completely untouched** — its right-edge toggle keeps overhanging into `main`'s `p-4` gutter exactly as today. Only two files change: `App.tsx` (reorder) and `ProjectsSidebar.tsx` (flip chrome to left-side). Projects' collapse toggle then straddles the gutter **between the two sidebars**, which reads as a natural VS Code-style panel divider. `main` stays `flex-1` and reclaims all freed width; nothing on the board side needs to change.

(Alternative considered and rejected: order `[NewTaskForm][ProjectsSidebar][main]`. That would force edits to `NewTaskForm` too — its toggle would then overhang into Projects instead of the board — for no benefit. Keep Projects leftmost.)

## Changes

### 1. `src/mainview/App.tsx` — reorder the flex children

Move the `<ProjectsSidebar … />` element from **after** `</main>` to **before** `<NewTaskForm … />`, inside the same `<div className="flex min-h-0 flex-1">`.

- Cut the block at `App.tsx:953-956`:
  ```tsx
  <ProjectsSidebar
    projects={projects}
    onChanged={() => { void api.listProjects().then(setProjects).catch(() => {}); }}
  />
  ```
- Paste it as the **first** child of the flex row, immediately after the opening `<div className="flex min-h-0 flex-1">` at `App.tsx:859` and before `<NewTaskForm` at `App.tsx:860`.

The resulting child order inside that div must be: `ProjectsSidebar`, then `NewTaskForm`, then `<main>`. Leave the `<NewTaskForm …>` and `<main …>` blocks otherwise unchanged. Props to `ProjectsSidebar` are unchanged. No import changes (both components already imported at `App.tsx:13-14`).

### 2. `src/mainview/components/kanban/ProjectsSidebar.tsx` — flip to left-side chrome

Convert the panel from right-edge to left-edge (matching `NewTaskForm`). Four edits:

a. **Border side** — `ProjectsSidebar.tsx:104`, in the outer `<aside>` `cn(...)`:
   - change `border-l border-border/60` → `border-r border-border/60`

b. **Toggle position** — `ProjectsSidebar.tsx:118`, the collapse `<button>` className:
   - change `absolute -left-2.5 top-1/2 …` → `absolute -right-2.5 top-1/2 …`
   - (keep the rest of the class list identical)

c. **Toggle chevron icons** — `ProjectsSidebar.tsx:120-122`, swap the two icons so the panel expands rightward / collapses leftward like New Task:
   ```tsx
   {collapsed
     ? <ChevronRight className="size-3.5" />
     : <ChevronLeft className="size-3.5" />}
   ```
   Both `ChevronLeft` and `ChevronRight` are already imported (`ProjectsSidebar.tsx:2`) — no import change.

d. **Doc/inline comments** — update to reflect the new side so the source doesn't lie:
   - `ProjectsSidebar.tsx:31-36` JSDoc: change "Right-side Projects sidebar … border on the LEFT edge and the straddle toggle overhanging into the board's left gutter" to describe a **left-side** panel with the border on the **right** edge and the toggle straddling the **right** edge (into the gutter between it and the New Task sidebar). Keep the "Mirrors the New Task sidebar's collapse-to-rail chrome" line.
   - `ProjectsSidebar.tsx:109-111` inline comment: change "straddling the LEFT border … Collapsed → ChevronLeft to expand leftward; expanded → ChevronRight to collapse rightward." to the right-edge equivalent: "straddling the RIGHT border … Collapsed → ChevronRight to expand rightward; expanded → ChevronLeft to collapse leftward."

Do **not** change the widths (`w-11`/`w-72`), the clip-layer `overflow-hidden` div, the collapsed rail `[writing-mode:vertical-rl]` label, the `PROJECTS_PANEL_COLLAPSED_KEY` persistence, or any of the project add/rename/delete/branch-naming logic. Those are side-agnostic and stay as-is.

### No other files

- `src/mainview/components/kanban/NewTaskForm.tsx` — **no change** (stays the left-of-board sidebar, chrome already correct).
- `src/mainview/lib/panel-collapse.ts` — no change (collapse key already exists and is reused).
- No new imports, no API/server/shared-types changes. This is a pure webview layout relocation.

## Verification

1. `bun run typecheck` must be green (only JSX reorder + className/comment edits; no type surface touched).
2. `bun test src/mainview/lib/panel-collapse.test.ts` still passes (untouched logic; the Projects collapse flag continues to round-trip through the same key).
3. Manual/visual check via `bun run dev:hmr` (headless: `scripts/dev-headless.sh` per repo memory):
   - Projects sidebar renders on the **far left**, New Task sidebar to its right, board fills the rest.
   - Projects collapse toggle sits on the panel's **right** edge; clicking it collapses the panel leftward to the `w-11` rail and the board widens; chevron shows `ChevronRight` when collapsed, `ChevronLeft` when expanded.
   - New Task sidebar is visually unchanged and still collapses independently.
   - Collapse state for both panels survives a reload (localStorage), and the two flags are independent.
   - Add / rename / delete / branch-naming actions in the Projects panel still work from the new position.

### On tests

There is **no unit-testable pure logic** introduced by this change — it is entirely JSX ordering and Tailwind class/comment edits, and the codebase has no React-render/DOM test harness (all `src/mainview/**/*.test.ts` are pure-function tests; no testing-library). The collapse-persistence behavior that *could* regress is already covered by `panel-collapse.test.ts`, which this change does not touch. Adding a render test would require standing up a new DOM-testing dependency for a one-time layout move — out of scope and not the repo's convention. Verification is therefore typecheck + the existing panel-collapse test + the manual visual pass above. Call this out to the Tester so a missing new test file isn't flagged as an omission.

## Risk / edge cases

- **Toggle overhang between the two sidebars**: Projects' `-right-2.5` toggle (z-20, absolutely positioned on its own `<aside>`) overhangs ~10px onto the New Task sidebar's left edge. It is not clipped (it lives outside its own aside's box and New Task's `overflow-hidden` only clips New Task's own children) and z-20 keeps it clickable above the neighbor's non-positioned content. This mirrors how each toggle currently overhangs the board's `p-4` gutter — acceptable and consistent.
- **Two expanded sidebars = up to ~152px** (`w-80` + `w-72`) of fixed left chrome. `main` is `flex-1 min-w-0`, so it simply narrows; no horizontal page scroll is introduced. Users who want more board width collapse either rail.
- **No data/state migration**: the Projects collapse flag key is unchanged, so a user's previously-persisted collapse state carries over verbatim.
