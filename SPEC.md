## Summary
Pipeline and build-child sessions currently receive the full "### Orchestration flow" section of CLAUDE.md, even though most stages never touch the application source files that section describes and most turns only ever work against a narrow slice of the codebase. This feature extends the existing pipeline-turn CLAUDE.md trimming so that the "Orchestration flow" section is reduced based on two signals: which pipeline stage a turn belongs to, and — for a subset of the section's items — whether the files a turn actually touches overlap with the files an item is about. The goal is to reduce injected context size for turns where large parts of the section are demonstrably irrelevant, without ever removing content when relevance can't be confidently determined.

## User stories
- As a pipeline stage (specify, clarify, planning, plan-review, decompose) that never opens application source files, I should not receive orchestration-flow content describing application runtime behavior I have no use for, so my system prompt is smaller and more focused.
- As a code-review, testing, building, or build-child turn, I should keep the orchestration-flow content relevant to my work, and — where a reliable file-overlap signal exists for this turn — have irrelevant subsections of that content omitted so my prompt is smaller without losing anything I might need.
- As a maintainer of the pipeline, I want a single kill switch to disable this trimming behavior entirely if it misbehaves, without needing to disable other, already-shipped trimming behavior.
- As a maintainer, I want the trimming logic to fail toward keeping content whenever the signal needed to make a confident drop decision is missing, ambiguous, or fails to extract, so a turn is never silently deprived of information it needs.
- As a developer reading the codebase later, I want the testing/building stages' lack of a file-overlap signal to be documented as an intentional design boundary, not something that looks like a bug or omission.

## Acceptance criteria
AC-1: For a pipeline turn at the specify, clarify, planning, plan-review, or decompose stage, the injected orchestration-flow content omits the subsections describing runtime/application behavior, while the introductory lifecycle content at the start of that section is preserved.
AC-2: For a pipeline turn at the specify, clarify, planning, plan-review, or decompose stage, all other sections of the injected content outside "Orchestration flow" remain unchanged from what a non-pipeline session would receive.
AC-3: For a code-review, testing, building, or build-child turn, the orchestration-flow section is retained rather than dropped wholesale.
AC-4: For a build-child turn whose associated file ownership does not overlap with a given filterable subsection's described files, that subsection is omitted from the injected content for that turn.
AC-5: For a code-review turn whose changed-file summary does not overlap with a given filterable subsection's described files, that subsection is omitted from the injected content for that turn.
AC-6: For a build-child or code-review turn where at least one file in the turn's file list overlaps with a filterable subsection's described files, that subsection is retained.
AC-7: For a build-child or code-review turn where the relevant file-list signal is empty, missing, or cannot be extracted, every filterable subsection is retained.
AC-8: For a testing or building stage turn, all filterable subsections are retained regardless of what files the turn touches, since no reliable per-turn file signal exists for these stages.
AC-9: Subsections of the orchestration-flow section that are not eligible for file-overlap filtering are retained unchanged for every stage that keeps the section at all, regardless of any turn's file list.
AC-10: When the feature's kill switch is disabled, injected content is identical to today's pre-existing behavior (only the previously-shipped trimming remains active, with no additional stage-gating or file-overlap filtering applied).
AC-11: The file-overlap comparison used to decide a match treats a described-path hint and an actual file path as overlapping when one is a prefix of the other at a path-segment boundary (i.e., an exact match, or one path represents a directory containing the other).
AC-12: A subsection is only omitted when every extracted path hint for that subsection fails to overlap with every file in a non-empty turn file list; any single overlapping hint, or the absence of any extractable hint, results in the subsection being kept.
AC-13: The behavior for a given pipeline stage and turn file list is deterministic — repeated evaluation of the same inputs produces the same retain/omit decisions.

## Non-goals
- Determining or changing which pipeline stages belong to which group (the stage groupings for wholesale section removal are fixed and out of scope for renegotiation).
- Adding any new mechanism to compute a per-turn file list for the testing or building stages; these stages are explicitly expected to retain full content for the filterable subsections.
- Extending file-overlap filtering to any part of the orchestration-flow content beyond the four designated filterable subsections.
- Changing or filtering any content outside the "Orchestration flow" section.
- Introducing a second, independent toggle for this behavior; it must be controlled by the same switch that already governs the previously-shipped trimming behavior, unless a compelling reason to split it is discovered during implementation.

## Edge cases considered
- A turn's file list is present but empty — must be treated identically to a missing file list (keep everything).
- Extraction of path hints from a subsection's own descriptive text fails or yields nothing — must default to keeping that subsection.
- A path hint is a directory-level reference while the turn's actual files are full file paths (or vice versa) — must still be recognized as an overlap when one contains the other.
- A turn belongs to a stage-group that drops the whole orchestration-flow section, but also happens to be a build-child or code-review turn in some edge configuration — stage-based wholesale removal takes precedence and the file-overlap layer never runs in that case.
- A build-child turn whose file ownership is not scoped to any particular files (i.e., it owns the whole workspace / no restriction) — must be treated as an empty/no-signal case and retain everything.
- A code-review turn where the changed-file summary is truncated, capped, or otherwise incomplete — any files it does list still count as legitimate signal, but the incomplete nature must not cause an incorrect drop; if extraction from a partial summary is ambiguous, it must default to keep.
- The kill switch is toggled off mid-way through a pipeline run — turns evaluated afterward must fall back fully to prior behavior with no partial application of the new stage-gating or file-overlap logic.
- A subsection nominally eligible for filtering has no describable path hints at all in its own text — it must never be dropped, since there is nothing to compare against.

## Assumptions
No material ambiguities were found requiring a human decision — the acceptance criteria and edge cases above already resolve the scenarios this pass would normally flag. The following minor interpretive points were resolved by choosing the lowest-risk, most conventional reading:

- **Terminology (which subsections are "filterable")**: The spec deliberately doesn't hard-code which four subsections of "Orchestration flow" are filterable, describing them only functionally ("the four designated filterable subsections"). Assumption: this refers to whichever four subsections the originating engineering task identifies (currently: Task context menu, Tasks from issues, Shared task-composition modules, and `@` file references), matched by identity/content rather than by ordinal position, so the requirement still holds if the document is reordered before implementation.
- **Integration (AC-8's "building" stage)**: Assumed to mean the parent/build-stage turn (not a build-child), consistent with the four-way split already implied elsewhere in the spec (code-review / testing / building / build-child) and the non-goal that excludes testing and building from file-list computation.
- **Non-functional (kill switch)**: Non-goals states the behavior "must be controlled by the same switch that already governs the previously-shipped trimming behavior, unless a compelling reason to split it is discovered during implementation." Assumption: default to reusing the single existing switch; splitting is only a fallback if implementation surfaces a concrete conflict, not a free choice.
- **Data shape (path comparison)**: AC-11's prefix/path-segment-boundary comparison is assumed to be case-sensitive and applied to literal path strings, matching the semantics of the pre-existing overlap-check logic this feature is meant to reuse rather than redefine.
- **Non-functional (performance target)**: No numeric byte-reduction threshold is specified. Assumption: success is judged qualitatively — the filtering must be demonstrably discriminating (omits some content, retains other content based on real signal) rather than degenerating to "always keep" or "always drop," with no specific percentage or byte-count target required.
