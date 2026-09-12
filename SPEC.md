## Summary
When agetor runs headlessly (no native desktop shell available — e.g. the CLI daemon or the terminal UI), a user currently cannot pick a folder or set of files to attach as a task reference: the pick request dead-ends with an "unavailable" response. This feature replaces that dead end with a working, keyboard-driven picking flow: the system offers a relevant, bounded list of candidate directories, and the user can browse, filter, and either select from that list or type a path manually. Selecting a directory yields either a folder reference or a listing of that directory's immediate files, depending on the type of pick requested. The existing desktop (native dialog) picking experience and any existing test-only picking shortcut are unaffected.

## User stories
- As a user running agetor headlessly (CLI/TUI), when I try to pick a folder for a task, I want to see a list of directories I'm likely to want (places I've already worked in, plus git repositories under my home directory) instead of an error.
- As a user browsing that candidate list, I want to narrow it by typing part of a path, and to move through it with the keyboard.
- As a user who doesn't see the directory I want in the list, I want to type the exact path myself instead of being stuck with only the suggested candidates.
- As a user picking "files" rather than a whole folder, I want to first choose a directory and then choose which of its immediate files to attach, with the ability to back out to the directory list if I change my mind.
- As a user picking a whole "folder", I want a single selection step that immediately confirms my choice without a second-level listing.
- As a user, if I cancel out of the picker at the top level, I want the pick to be treated as "nothing selected" rather than an error.
- As a developer/administrator of a desktop (non-headless) installation, I want this feature to have zero effect on the existing native file/folder picker behavior.

## Acceptance criteria
AC-1: When picking in headless mode without the test-only picking shortcut active, requesting a pick returns a non-error, bounded list of candidate directories instead of an "unavailable" response.
AC-2: The candidate list includes every distinct directory the user has already used as a task's working directory, and among those, more recently used directories are ordered ahead of less recently used ones.
AC-3: The candidate list includes git-repository directories found one level under the user's home directory, excluding hidden (dot-prefixed) directories.
AC-4: The candidate list includes the user's home directory itself as a fallback entry.
AC-5: The candidate list never contains duplicate entries, even when two different-looking paths refer to the same real location on disk.
AC-6: The candidate list never contains more than 50 entries in total.
AC-7: Selecting a candidate (or a manually typed path) in "folder" pick mode produces a final result representing that single path as a directory reference, with no further steps required.
AC-8: Selecting a candidate (or a manually typed path) in "files" pick mode produces a final result listing the immediate regular files contained directly within that directory (not files in subdirectories), each represented as a non-directory reference.
AC-9: In "files" pick mode, after a directory has been chosen and its files are being browsed, the user can back out to the directory-candidate list without losing the ability to choose a different directory.
AC-10: In "files" pick mode, backing out of the directory-candidate list entirely (without ever selecting a directory) results in an empty selection, not an error.
AC-11: In "folder" pick mode, backing out of the directory-candidate list results in an empty selection, not an error.
AC-12: A user can narrow the visible candidates by typing text that is matched against candidate paths as a substring, and the visible list updates to reflect only matching candidates.
AC-13: A user can navigate the candidate list using the keyboard (moving the highlighted selection up and down) and confirm the currently highlighted candidate.
AC-14: A user can bypass the candidate list entirely by entering a path manually, and that manually entered path is resolved the same way a selected candidate would be (per AC-7/AC-8 depending on pick mode).
AC-15: When a pick request returns a direct final result (as in the existing native-dialog or test-shortcut paths) rather than a candidate list, the caller receives that result unchanged, with no interactive selection step introduced.
AC-16: The existing native (desktop) picking path and the existing test-only picking shortcut behave exactly as they did before this feature, for both "folder" and "files" pick modes.

## Non-goals
- Browsing into subdirectories beyond the single level of files shown for a chosen directory (no recursive/nested file browser).
- Any change to the desktop native picking dialog behavior.
- Any change to the existing test-only picking shortcut/fixture behavior.
- Persisting or remembering the user's picker selections beyond the single pick in progress.
- Any change to how references, once picked, are subsequently used elsewhere in a task.

## Edge cases considered
- The user's home directory contains no git repositories one level down: the candidate list still includes the home directory itself as a fallback, so the list is never empty.
- No tasks have ever been created (no known working directories): candidate generation falls back to home-directory-derived entries only.
- Two known working directories resolve to the same real path (e.g. via a symlink): they must be deduplicated into a single candidate.
- The number of eligible candidates (task working directories plus home-derived git repos) exceeds the cap: only the highest-priority 50 are returned, prioritizing known task working directories (most recently used first) over home-derived entries.
- A manually entered path does not exist, is not a directory, or is otherwise inaccessible: the selection must not silently succeed with a broken reference.
- "Files" mode on a directory containing only subdirectories and no regular files: the result is an empty file listing rather than an error.
- "Files" mode on a directory containing hidden files: behavior with respect to hidden regular files must be consistent and well-defined (not selectively broken).
- The user cancels at the very first prompt of the picker (before any typing or navigation): this must resolve to an empty selection rather than hanging or erroring.
- Filtering text that matches zero candidates: the list becomes empty but the manual-entry option remains available.

## Clarifications

**Q1: In "files" pick mode, should hidden (dot-prefixed) regular files be included in the immediate-file listing?**
A: Exclude hidden files — dot-prefixed regular files are filtered out of the listing, mirroring the dotdir exclusion already used for git-repo candidate enumeration (AC-3).

*Folded into AC-8: Selecting a candidate (or a manually typed path) in "files" pick mode produces a final result listing the immediate regular files contained directly within that directory (not files in subdirectories, and not hidden/dot-prefixed files), each represented as a non-directory reference.*

*Folded into the edge case: "Files" mode on a directory containing hidden files: hidden (dot-prefixed) regular files are excluded from the listing, consistent with the dotdir exclusion applied elsewhere in candidate generation.*

**Q2: When a manually typed path is invalid (doesn't exist, isn't a directory, or is inaccessible), what should the picker do?**
A: Reject and let the user retry — the picker shows an inline error at the manual-entry prompt and remains open, so the user can type a corrected path or go back to the candidate list, rather than aborting the whole pick.

*Folded into AC-14: A user can bypass the candidate list entirely by entering a path manually, and that manually entered path is resolved the same way a selected candidate would be (per AC-7/AC-8 depending on pick mode). If the manually entered path does not exist, is not a directory, or is otherwise inaccessible, the picker rejects it with an inline error and keeps the manual-entry prompt open for a retry, rather than ending the pick.*

*Folded into the edge case: A manually entered path does not exist, is not a directory, or is otherwise inaccessible: the selection must not silently succeed with a broken reference — instead the picker surfaces an inline error and lets the user retry the manual entry (or back out to the candidate list).*

**Q3: Should substring filtering of the candidate list be case-sensitive or case-insensitive?**
A: Case-insensitive — typing "src" matches a candidate path containing "Src" or "SRC" as well.

*Folded into AC-12: A user can narrow the visible candidates by typing text that is matched against candidate paths as a case-insensitive substring, and the visible list updates to reflect only matching candidates.*
