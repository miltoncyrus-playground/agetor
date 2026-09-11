import { test, expect } from "bun:test";
import type { RunUsage } from "../../shared/types.ts";
import { formatTokens, formatUsageLabel, formatUsageTitle, sumRunUsage } from "./token-format.ts";

test("formatTokens: the four spec cases", () => {
  expect(formatTokens(0)).toBe("0");
  expect(formatTokens(950)).toBe("950");
  expect(formatTokens(43_000)).toBe("43K");
  expect(formatTokens(1_234_567)).toBe("1.2M");
});

test("formatTokens: one decimal only when informative, half-up rounding, unit boundary", () => {
  expect(formatTokens(4_500)).toBe("4.5K");
  expect(formatTokens(1_000)).toBe("1K");
  expect(formatTokens(999)).toBe("999");
  expect(formatTokens(999_499)).toBe("999K");
  expect(formatTokens(999_500)).toBe("1M");
  expect(formatTokens(1_000_000)).toBe("1M");
  expect(formatTokens(456_789)).toBe("457K");
  expect(formatTokens(70_700_000)).toBe("70.7M");
  expect(formatTokens(123_456_789)).toBe("123M");
  expect(formatTokens(-5)).toBe("0");
  expect(formatTokens(Number.NaN)).toBe("0");
});

const usage = (over: Partial<RunUsage> = {}): RunUsage => ({
  runId: "r1", messages: 3, input: 1_000, cacheWrite: 50_000, cacheRead: 1_200_000,
  output: 43_000, context: 1_251_000, bootstrap: 54_500, updatedAt: 10, ...over,
});

test("formatUsageLabel renders `<ctx> ctx · <out> out`, null when nothing recorded", () => {
  expect(formatUsageLabel(usage())).toBe("1.3M ctx · 43K out");
  expect(formatUsageLabel(null)).toBeNull();
  expect(formatUsageLabel(undefined)).toBeNull();
  expect(formatUsageLabel(usage({ messages: 0, context: 0, output: 0 }))).toBeNull();
});

test("formatUsageTitle spells out every component with thousands separators", () => {
  expect(formatUsageTitle(usage())).toBe(
    "3 messages · input 1,000 · cache write 50,000 · cache read 1,200,000 · output 43,000 · bootstrap 54,500",
  );
});

test("sumRunUsage adds every field, keeps the latest updatedAt, skips runs without usage", () => {
  const a = usage({ runId: "a", updatedAt: 5 });
  const b = usage({ runId: "b", messages: 1, input: 10, cacheWrite: 20, cacheRead: 30, output: 40, context: 60, bootstrap: 60, updatedAt: 9 });
  const total = sumRunUsage([{ usage: a }, { usage: null }, { usage: b }, {}]);
  expect(total).toEqual({
    runId: "", messages: 4, input: 1_010, cacheWrite: 50_020, cacheRead: 1_200_030,
    output: 43_040, context: 1_251_060, bootstrap: 54_560, updatedAt: 9,
  });
  expect(sumRunUsage([])).toBeNull();
  expect(sumRunUsage([{ usage: null }])).toBeNull();
});
