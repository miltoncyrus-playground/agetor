import type { HarnessTemplate } from "../../shared/types.ts";

/**
 * Resolve a new harness's initial `home` when its suggested id collided with
 * an existing harness and got bumped to `uniqId`.
 *
 * For a *static* template (the curated `HARNESS_TEMPLATES` list), `home`
 * frequently embeds the suggested id as its trailing path segment (e.g.
 * `~/.claude-work`), so the rename must follow: `home` gets its trailing
 * segment swapped from the original suggested id to the bumped one.
 *
 * For a *discovered* template (`discoveredToTemplate` in SettingsDialog,
 * `id` prefixed `"__discovered:"`), `home` is instead the real, already-
 * existing config dir a live Claude account was found in — it has no
 * structural relationship to `suggestedHarnessId` at all. A dot-prefixed
 * discovered dir (`~/.claude-work2`) never matches the `endsWith` check, so
 * this was silent there, but a non-dot-prefixed one from a custom
 * `CLAUDE_CONFIG_DIR` (e.g. `/home/user/claude-work`) could match and get
 * rewritten into a fabricated path that was never real — the saved harness
 * would then point nowhere, and login/account resolution would fail with no
 * clear error. Discovered templates must never have `home` rewritten.
 */
export function resolveTemplateInitialHome(
  template: Pick<HarnessTemplate, "id" | "home" | "suggestedHarnessId">,
  uniqId: string,
): string | null {
  const home = template.home;
  const orig = template.suggestedHarnessId;
  const isDiscovered = template.id.startsWith("__discovered:");
  if (isDiscovered || !home || !orig || uniqId === orig || !home.endsWith(`/${orig}`)) {
    return home;
  }
  return `${home.slice(0, -orig.length)}${uniqId}`;
}
