## Summary

In a headless session (no native OS bridge, e.g. the headless dev server or CLI daemon), clicking "Browse for folder…" in the Project picker on the New Task form currently does nothing visible: the underlying request fails and the failure is silently swallowed. This spec covers wiring that "Browse for folder…" action to the same interactive folder-picking experience already available for task references, so that headless users can register and select a new project. The native desktop experience for the same action must remain fully unchanged.

## User stories

- As a user running the app in a headless session, when I click "Browse for folder…" in the Project picker, I want to see an interactive folder picker so I can choose a project folder, just as I can already do when attaching task references.
- As a user running the app in a headless session, after selecting a folder in the picker, I want that folder registered as a project and automatically selected in the Project picker.
- As a user with a native desktop environment, I want "Browse for folder…" to continue behaving exactly as it does today, with no change in behavior, requests, or timing.
- As a user who cancels the folder picker, I want the Project picker to remain unchanged, with no project registered and no error shown.

## Acceptance criteria

AC-1: In a headless session, clicking "Browse for folder…" in the Project picker opens an interactive folder-selection experience instead of silently doing nothing.
AC-2: In a headless session, after choosing a folder in that interactive experience, the chosen folder becomes a registered project and is shown as the selected project in the Project picker.
AC-3: In a headless session, the newly registered project subsequently appears in the list of available projects.
AC-4: In a headless session where a directly-resolvable folder result is available (no interactive selection needed), "Browse for folder…" registers and selects that folder as a project without requiring any additional user interaction to choose among candidates.
AC-5: In a headless session, cancelling the interactive folder-selection experience without picking anything leaves the Project picker's current selection unchanged and does not register any new project.
AC-6: On a native desktop environment, clicking "Browse for folder…" continues to use the existing native folder-selection experience, and its successful outcome (project registered and selected) is identical to current behavior.
AC-7: On a native desktop environment, the interactive folder-selection experience used for headless sessions is never shown when the native folder-selection succeeds.
AC-8: If "Browse for folder…" fails for a reason other than the headless-unavailability condition, the Project picker's current behavior is preserved: the failure is not surfaced as a visible error and no project is registered or selected.

## Non-goals

- Changing how folder/file picking works for task references.
- Adding, removing, or modifying any server-side routes or their request/response contracts.
- Changing how projects are listed, renamed, deleted, or cloned.
- Adding database schema changes.
- Changing the native desktop picking experience in any way.
- General error surfacing or notification UI for project-picking failures beyond what already exists today.

## Edge cases considered

- The interactive folder-selection experience is cancelled without a selection: no project should be registered, and the picker should return to its prior state silently, matching today's cancel behavior.
- The headless environment resolves a folder directly (without presenting a list of candidates to choose from): the project should be registered and selected without an extra selection step.
- The headless environment presents multiple candidate folders: the user selects one, and only that one folder is registered as a project.
- A failure occurs that is unrelated to headless-mode unavailability (e.g., a different server error): the existing silent-failure behavior must be preserved exactly, with no new fallback triggered.
- The user opens the Project picker's browse action multiple times in a row, including after a successful registration: each attempt should behave independently and consistently for both native and headless environments.

## Assumptions

- **Duplicate project (functional scope / edge handling):** If the folder chosen via the interactive experience is already a registered project, the same registration call is issued as it would be for any other folder, and whatever behavior the existing (unmodified) registration endpoint already has for a duplicate path applies unchanged. Resolved this way because the spec makes no backend changes, so duplicate handling is inherently owned by existing, untouched server behavior, not by this feature.
- **Registration failure after a successful interactive pick (edge/failure handling):** If registering the chosen folder as a project fails even though the interactive folder-selection succeeded, this is treated the same as today's baseline "Browse for folder…" failure behavior: not surfaced as a new visible error, and no project is registered or selected. Resolved this way because the spec's non-goals already rule out adding new error surfacing or notification UI beyond what exists today, and AC-8 establishes silent preservation of current behavior as the baseline for browse failures generally.
- **Repeated/concurrent browsing (UX flow):** Clicking "Browse for folder…" again while a previous browse attempt is still in progress is handled the same way it is today (the action is not re-entrant mid-attempt); this spec does not introduce new concurrency behavior. Resolved this way because the ticket's scope is limited to adding a fallback path when the first call fails, not to changing the picker's existing in-progress handling.
- **Terminology — "interactive folder-selection experience" (terminology):** This refers to the same picker UI already used for task references: a dialog presenting a list of candidate folders when more than one candidate exists, or immediate resolution with no dialog when a single, unambiguous folder result is available (AC-4). No new UI component or interaction pattern is introduced for this feature.
