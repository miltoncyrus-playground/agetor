## Summary
When agetor's browser-based interface is used against a headless backend (no native desktop shell available), a user who clicks the folder/file picker control currently gets no usable outcome — the pick silently resolves to nothing selected. This feature adds a visual, in-browser picking experience for that case: the user is shown a bounded, relevant list of candidate directories to choose from, can filter that list by typing, can type an arbitrary path directly, and — when picking files rather than a whole folder — can drill into a chosen directory to select from its immediate files. The outcome of a successful pick appears in the browser interface exactly the way a desktop-native pick already does today. The existing desktop (native dialog) picking experience, and any existing automated-testing picking shortcut, are unaffected by this change.

## User stories
- As a user of the browser-based interface running against a headless backend, when I click the button to pick a folder for a task, I want to see a list of relevant candidate directories in the browser and choose one, instead of the action silently doing nothing.
- As a user browsing that candidate list in the browser, I want to narrow it by typing part of a path, so I can find the directory I want among many candidates.
- As a user who doesn't see the directory I want in the candidate list, I want to type the exact path myself directly in the browser, so I'm never limited to only the suggested candidates.
- As a user picking "files" rather than a whole folder in the browser, I want to first choose a directory and then choose which of its immediate files to attach, with the ability to back out to the directory list if I picked the wrong directory.
- As a user picking a whole "folder" in the browser, I want a single selection step that immediately confirms my choice, with no extra step.
- As a user, if I close or cancel the picker at any point without completing a selection, I want nothing to be added to the task, rather than an error or a broken partial selection.
- As a user of a desktop (non-headless) installation, I want this feature to have zero visible effect on my existing native file/folder picker experience.

## Acceptance criteria
AC-1: When the folder/file picker is used in a browser session connected to a headless backend (no native picking available and no automated-testing picking shortcut active), the picker presents a visual list of candidate directories to the user instead of silently completing with nothing selected.
AC-2: The candidate directories shown to the user in the browser are exactly those the backend already determines are relevant, presented in the order the backend returns them.
AC-3: Selecting a candidate directory in "folder" pick mode immediately produces a single selected folder result, visible in the task's reference list, with no further steps required.
AC-4: Selecting a candidate directory in "files" pick mode does not immediately produce a result; instead it shows the user the immediate files contained directly within that directory. The user then clicks a single file row to select it, which immediately produces that one file as the result (mirroring "folder" mode's single-click-confirms pattern) — there is no multi-select or bulk-add-all step at this level (see Clarifications).
AC-5: In "files" pick mode, after viewing a directory's files, the user can return to the candidate directory list without the picker closing or an error occurring, and can then choose a different directory.
AC-6: A user can narrow the visible candidate directories by typing text, and the visible list updates to show only candidates whose path contains that text, matched without regard to letter case.
AC-7: A user can type an arbitrary path directly instead of choosing from the candidate list, and submitting that path is treated the same as selecting a matching candidate would be, producing a folder result (in "folder" mode) or a listing of that directory's immediate files to choose from (in "files" mode).
AC-8: If the manually typed path does not resolve to a usable directory, the picker shows an inline error next to the input and remains open for the user to correct the path or use the candidate list instead, rather than closing or losing the user's progress.
AC-9: Closing or cancelling the picker before completing a selection — whether at the initial candidate list, while browsing a directory's files, or after typing an invalid manual path — results in no reference being added to the task, and does not produce an error state visible to the user.
AC-10: Completing a pick (via a candidate, manual path, or a file chosen during files-mode browsing) adds the resulting reference(s) to the task's reference list in the same visible form the browser interface already uses for references added through the desktop-native picker.
AC-11: When the folder/file picker is used in a browser session connected to a desktop (native-dialog-capable) backend, or one where the automated-testing picking shortcut is active, the picking experience and outcome are unchanged from before this feature — no candidate list or in-browser directory browsing is shown.
AC-12: The picker remains usable via the keyboard: a user can move between candidate rows and confirm a highlighted one without using a pointing device.

## Non-goals
- Any change to the desktop native picking dialog's behavior or appearance.
- Any change to the existing automated-testing picking shortcut's behavior.
- Browsing into subdirectories beyond the single level of files shown for a chosen directory in "files" mode (no recursive/nested directory browser).
- Any change to how the candidate list of directories is computed, ordered, deduplicated, or capped — that logic is out of scope for this feature.
- Any change to how references, once picked, are subsequently displayed, stored, or used elsewhere in a task beyond appearing in the reference list.
- Persisting or remembering the user's in-browser picker selections beyond the single pick in progress.

## Edge cases considered
- The backend returns zero candidate directories: the picker still opens and allows the user to type a manual path rather than presenting an unusable empty screen.
- The candidate list, after filtering, matches no entries: the visible list becomes empty, but the manual-entry option remains usable.
- The user types a manual path that exists but is not a directory, or does not exist at all: the inline error is shown and the picker stays open, matching the behavior for an unreachable/invalid path.
- In "files" mode, the chosen directory contains no eligible files: the user sees an empty file listing rather than an error, and can still back out to the candidate list.
- The user rapidly cancels and reopens the picker: no stale selection or leftover error state from a previous attempt is shown when the picker is reopened.
- The pick is initiated from either of the two places in the interface where the picker control appears: the outcome and interaction are identical regardless of which one triggered it.
- A user submits the manual-entry path repeatedly after correcting it: each submission is evaluated independently, and a previously shown inline error clears once a valid path is submitted.

## Clarifications

**Q1 (UX flow / terminology — "files" mode selection granularity):** The reference CLI/TUI implementation (`DirPickerOverlay`) does not let a user pick an individual file in "files" mode — confirming the file listing bulk-adds every immediate file in the chosen directory as refs in one action, with no per-row selection. However, this feature's own test plan describes selecting a single file and seeing a single reference appear. Which behavior should the browser picker's second-level (files) listing implement?
**A:** Clicking a single file row immediately selects and confirms just that one file as the pick result (closing the picker), mirroring "folder" mode's single-click-confirms pattern. There is no multi-select or "add all" step. To attach more than one file from the same directory, the user reopens the picker and repeats. This has been folded into AC-4 above.

**Q2 (Integration behaviour — trigger button loading state during headless picking):** The existing `picking` boolean on the picker trigger button is explicitly unchanged for the desktop (native-dialog) path. For the new browser-hosted picker (`FolderPickerDialog`), should the trigger button's loading/disabled state remain active for the entire time the dialog is open (which may be a while, since the user is browsing/typing), or reset back to normal as soon as the dialog appears?
**A:** `picking` is true only for the initial async fetch of the candidate list (the `POST /refs/pick` call). Once `FolderPickerDialog` is shown, the trigger button returns to its normal, non-loading state — the dialog itself is the indicator that a pick is in progress, not the trigger button behind it. `picking` becomes true again only for the brief `POST /refs/pick/select` round-trip triggered by a candidate click, manual-path submission, or file-row click, matching the equivalent short-lived busy state the desktop path already has. This does not change any AC text (it governs `ReferencesPicker.tsx` internal state, not user-visible acceptance criteria), and does not alter AC-11's zero-effect-on-desktop-path guarantee.
