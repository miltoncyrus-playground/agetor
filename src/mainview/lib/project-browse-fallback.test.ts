import { describe, expect, test } from "bun:test";
import { ApiError } from "./api";
import { shouldFallbackToHeadlessPicker } from "./project-browse-fallback.ts";

describe("shouldFallbackToHeadlessPicker", () => {
  test("ApiError with status 501 returns true", () => {
    expect(shouldFallbackToHeadlessPicker(new ApiError("not available", 501, null))).toBe(true);
  });

  test("ApiError with status 404 returns false", () => {
    expect(shouldFallbackToHeadlessPicker(new ApiError("not found", 404, null))).toBe(false);
  });

  test("ApiError with status 500 returns false", () => {
    expect(shouldFallbackToHeadlessPicker(new ApiError("server error", 500, null))).toBe(false);
  });

  test("ApiError with another non-501 status returns false", () => {
    expect(shouldFallbackToHeadlessPicker(new ApiError("bad request", 400, null))).toBe(false);
  });

  test("a plain Error returns false", () => {
    expect(shouldFallbackToHeadlessPicker(new Error("boom"))).toBe(false);
  });

  test("a thrown string returns false", () => {
    expect(shouldFallbackToHeadlessPicker("boom")).toBe(false);
  });

  test("undefined returns false", () => {
    expect(shouldFallbackToHeadlessPicker(undefined)).toBe(false);
  });
});
