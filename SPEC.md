## Summary

Pipeline stage sessions and build-child sessions currently receive the repository's entire CLAUDE.md as re-injected context on every turn, including a large section that documents every supported agent harness (when a session only ever runs under one harness) and a large section describing a fleet-coordination protocol that these sessions are already barred from using. This feature trims that re-injected context for pipeline/build-child sessions only, keeping only the harness-specific guidance relevant to the session's own agent and dropping the fleet-coordination section entirely, while leaving ordinary (non-pipeline) sessions completely unaffected. The trimming must be safe against future changes to CLAUDE.md's structure — if the expected structure can't be confidently found, the untrimmed content is kept rather than risking incorrect or destructive edits.

## User stories

- As someone operating the pipeline, I want stage and build-child sessions to consume less repeated context per turn, so token usage and cost scale down without any change in behavior.
- As someone maintaining the project's guidance document, I want ordinary (non-pipeline) sessions to keep seeing the complete, unfiltered guidance exactly as today, so I don't need to maintain two versions of the document by hand.
- As someone operating the pipeline, I want the trimming to fail safely if the guidance document's structure changes in the future, so a structural edit to the document never silently breaks or blocks a pipeline run.
- As someone operating the pipeline, I want a single toggle to disable this trimming entirely, so I can quickly restore the exact prior behavior if something looks wrong.

## Acceptance criteria

AC-1: For a pipeline stage session or a build-child session whose agent is a specific, recognized kind, the guidance content it receives includes the harness-specific guidance for that kind and excludes the harness-specific guidance for every other recognized kind.
AC-2: For a pipeline stage session or a build-child session, the guidance content it receives does not include the fleet-coordination protocol section, regardless of which agent kind the session uses.
AC-3: For an ordinary (non-pipeline, non-build-child) session, the guidance content it receives is identical, byte-for-byte, to the source guidance document — no harness-specific content and no fleet-coordination content are removed.
AC-4: If the harness-specific guidance section's boundaries, or an individual harness's entry within it, cannot be confidently identified in the source document, the guidance content delivered to a pipeline/build-child session preserves that section unchanged, while the fleet-coordination section removal (per AC-2) is still attempted independently.
AC-5: If the fleet-coordination section's boundaries cannot be confidently identified in the source document, the guidance content delivered to a pipeline/build-child session preserves that section unchanged, while the harness-specific trimming (per AC-1) is still attempted independently.
AC-6: If a pipeline stage session or build-child session's agent kind is not one of the recognized kinds, the harness-specific guidance section is preserved unchanged (no entries removed), while the fleet-coordination section removal (per AC-2) still occurs.
AC-7: When the source guidance document contains neither the harness-specific section nor the fleet-coordination section, the guidance content delivered to any session (pipeline, build-child, or ordinary) is identical, byte-for-byte, to the source document.
AC-8: A single, documented setting exists that, when set to disable trimming, causes every session type (pipeline, build-child, and ordinary) to receive the complete, unfiltered guidance document exactly as they would have before this feature existed.
AC-9: When a pipeline stage session or build-child session's working environment has no guidance document at all, that session's behavior (what context it receives, or the absence of it) is unchanged from behavior prior to this feature.
AC-10: When trimming would produce guidance content that is empty or contains only whitespace, the session's behavior falls back to whatever occurs prior to this feature under the same "no usable guidance document" circumstance, rather than delivering empty content as if it were valid.
AC-11: The trimming behavior described above never mutates the source guidance document itself; the source document remains available, complete and unaltered, for any session (including ordinary sessions and any future read of it).

## Non-goals

- Removing, condensing, or otherwise filtering any part of the guidance document other than the two sections identified above (the harness-specific guidance section and the fleet-coordination section).
- Changing what context ordinary (non-pipeline, non-build-child) sessions receive.
- Changing the content, wording, or structure of the guidance document itself.
- Introducing separate, independently toggleable settings for each of the two trims (a single combined toggle is sufficient) unless a strong reason for splitting emerges.
- Filtering guidance content differently per pipeline stage type, per build-child role, or per project beyond the single agent-kind-based distinction described here.
- Any change to which tools, harnesses, or agent kinds are supported by the pipeline.

## Edge cases considered

- The guidance document's structure is altered in the future (headings renamed, removed, or reordered) such that one or both target sections can no longer be confidently located — each of the two trims must independently degrade to "leave that section as-is" rather than error out, guess, or remove unrelated content.
- The set of recognized agent/harness kinds changes over time, or a session runs under a kind not yet known to the trimming logic — the harness-specific trim must leave that section fully intact in this case rather than removing everything or guessing which entry to keep.
- The harness-specific section's entries appear in a different order than expected, or their internal ordering changes — the trim must not depend on a fixed order.
- The fleet-coordination section is not the last section in the document (something is added after it in the future) — its removal must still stop at the correct boundary and not consume trailing content that doesn't belong to it.
- The guidance document is missing entirely from a session's working environment — this must produce the same outcome as before this feature existed, not a new error.
- Both target sections are absent from the document (e.g., an older or customized version of the document) — the content delivered must be unchanged from the source, for every session type.
- Trimming happens to remove everything meaningful from the document, leaving only whitespace — this must not be treated as valid content and must fall back to prior no-guidance behavior.
- The combined disable setting is active — both trims must be skipped for every session type, restoring prior behavior exactly, including for pipeline and build-child sessions.
- A session is both a pipeline stage and associated with a parent task (or any combination of the conditions that mark a session as pipeline/build-child) — the trimming applies whenever any qualifying condition is met, consistent with how such sessions are already distinguished from ordinary ones elsewhere.

## Assumptions

No material ambiguities were found — the ticket and the acceptance criteria above already resolve every point in the standard ambiguity taxonomy (scope, data shape, integration behavior, edge/failure handling, terminology). The following minor implementation-level judgment calls were resolved using the lowest-risk, most conventional interpretation, and do not affect any acceptance criterion above:

- **Kill-switch default state**: the single combined toggle defaults to trimming *enabled*, with an explicit value disabling it (e.g. `SOMETHING=0`) — matching this repository's existing convention for equivalent pipeline kill switches (`AGETOR_PIPELINE_LEAN_CONTEXT`, `AGETOR_PIPELINE_AUTO_INSTALL`, `AGETOR_PIPELINE_TESTER_SKIP`, `AGETOR_PIPELINE_PRECHECK`, `AGETOR_PIPELINE_EFFORT_TIERING`), which all default to "on" and use `=0` to opt out.
- **Filtered copy freshness**: the filtered guidance file is regenerated from the worktree's current source document on every session spawn rather than cached/reused across turns — this keeps the trimmed output always consistent with the (unmutated, per AC-11) source document without introducing any new caching/invalidation behavior.
- **Filtered copy location and naming**: the derived file is written to a new path under the worktree (outside the source document's own path, so the source is never touched, satisfying AC-11) rather than any existing file being overwritten; the exact name/path is an implementation detail with no externally observable behavior.
- **Set of "recognized" agent kinds**: scoped to the agent kinds already known to this codebase's existing agent-kind enumeration at implementation time; a future new kind not yet added to that enumeration is treated as "not recognized" and falls back to the AC-6 behavior (harness-specific section preserved unchanged) until the trimming logic is explicitly updated to recognize it.
- **Combined vs. split toggle**: a single toggle governs both trims together (per the ticket's explicit instruction and the Non-goals section above), rather than two independently toggleable settings.
