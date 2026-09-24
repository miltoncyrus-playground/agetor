import { test, expect } from "bun:test";
import { resolveTemplateInitialHome } from "./harness-template.ts";

/** Minimal static (non-discovered) template. */
function staticTemplate(overrides: Partial<{ id: string; home: string | null; suggestedHarnessId: string }> = {}) {
  return { id: "claude-code", home: "~/harnesses/claude-work", suggestedHarnessId: "claude-work", ...overrides };
}

/** Minimal discovered template, matching `discoveredToTemplate` in SettingsDialog. */
function discoveredTemplate(overrides: Partial<{ id: string; home: string | null; suggestedHarnessId: string }> = {}) {
  return { id: "__discovered:/home/user/claude-work", home: "/home/user/claude-work", suggestedHarnessId: "claude-work", ...overrides };
}

test("static template: no id collision leaves home untouched", () => {
  expect(resolveTemplateInitialHome(staticTemplate(), "claude-work")).toBe("~/harnesses/claude-work");
});

test("static template: id collision renames the trailing home segment to match", () => {
  expect(resolveTemplateInitialHome(staticTemplate(), "claude-work-2")).toBe("~/harnesses/claude-work-2");
});

test("static template: home not ending in the suggested id is left alone", () => {
  const t = staticTemplate({ home: "~/.some-other-dir" });
  expect(resolveTemplateInitialHome(t, "claude-work-2")).toBe("~/.some-other-dir");
});

test("static template: null home stays null", () => {
  expect(resolveTemplateInitialHome(staticTemplate({ home: null }), "claude-work-2")).toBeNull();
});

test("discovered template: id collision never rewrites home, even when the endsWith check would match", () => {
  // Regression: a non-dot-prefixed CLAUDE_CONFIG_DIR (e.g. /home/user/claude-work)
  // used to satisfy `home.endsWith('/' + orig)` on a collision, rewriting a real,
  // existing account dir into a fabricated path like /home/user/claude-work-2
  // that was never real — breaking login/account resolution silently.
  const t = discoveredTemplate();
  expect(resolveTemplateInitialHome(t, "claude-work-2")).toBe("/home/user/claude-work");
});

test("discovered template: dot-prefixed config dir also stays untouched (was already safe, still covered)", () => {
  const t = discoveredTemplate({ id: "__discovered:/home/user/.claude-work", home: "/home/user/.claude-work" });
  expect(resolveTemplateInitialHome(t, "claude-work-2")).toBe("/home/user/.claude-work");
});
