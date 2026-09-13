import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findUnreferencedAcs, isTestPath, readTestFiles, precheckPasses, renderPrecheck,
  runPipelinePrecheck, testerSkipEnabled, precheckEnabled, precheckPassedChecks,
} from "./pipeline-precheck.ts";
import type { RepoProfile } from "./repo-profile.ts";

const profile = (over: Partial<RepoProfile>): RepoProfile => ({
  packageManager: "npm", install: "npm ci", typecheck: null, lint: null, test: null, build: null,
  typecheckScoped: null, lintScoped: null, testScoped: null, buildScoped: null,
  workspaces: false, lockfile: null, ...over,
});

test("findUnreferencedAcs is literal and word-bounded (AC-1 does not match AC-10)", () => {
  expect(findUnreferencedAcs(["AC-1", "AC-2", "AC-10"], ["test('AC-10 lists things')", "// covers AC-2"])).toEqual(["AC-1"]);
  expect(findUnreferencedAcs([], ["anything"])).toEqual([]);
  expect(findUnreferencedAcs(["AC-3"], [])).toEqual(["AC-3"]);
});

test("isTestPath recognises the common layouts and nothing else", () => {
  for (const p of ["src/a.test.ts", "src/b.spec.tsx", "lib/c.test.mjs", "__tests__/d.js", "tests/e.py", "test/f.rb", "pkg/g_test.go", "app/test_h.py"]) {
    expect(isTestPath(p)).toBe(true);
  }
  for (const p of ["src/a.ts", "src/testing-utils.ts", "contest/x.ts", "latest/y.js"]) {
    expect(isTestPath(p)).toBe(false);
  }
});

test("readTestFiles walks the tree, skips node_modules, returns contents", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-precheck-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.test.ts"), "it('AC-1 works')");
  writeFileSync(path.join(dir, "src", "a.ts"), "AC-2 should not count");
  writeFileSync(path.join(dir, "node_modules", "x", "z.test.js"), "AC-3 in a dependency");
  const contents = readTestFiles(dir);
  expect(contents).toEqual(["it('AC-1 works')"]);
  expect(findUnreferencedAcs(["AC-1", "AC-2", "AC-3"], contents)).toEqual(["AC-2", "AC-3"]);
});

test("precheckPasses: needs at least one command, all ok, no unreferenced ACs", () => {
  const ok = { name: "test" as const, cmd: "x", ok: true, exitCode: 0, tail: "" };
  expect(precheckPasses({ results: [ok], unreferencedAcs: [], ranAt: 0 })).toBe(true);
  expect(precheckPasses({ results: [], unreferencedAcs: [], ranAt: 0 })).toBe(false);
  expect(precheckPasses({ results: [ok], unreferencedAcs: ["AC-1"], ranAt: 0 })).toBe(false);
  expect(precheckPasses({ results: [ok, { ...ok, name: "lint", ok: false, exitCode: 1 }], unreferencedAcs: [], ranAt: 0 })).toBe(false);
});

test("precheckPassedChecks returns only the ok:true result names", () => {
  const ok = { name: "test" as const, cmd: "x", ok: true, exitCode: 0, tail: "" };
  const failed = { name: "lint" as const, cmd: "y", ok: false, exitCode: 1, tail: "boom" };
  expect(precheckPassedChecks({ results: [ok, failed], unreferencedAcs: [], ranAt: 0 })).toEqual(new Set(["test"]));
});

test("precheckPassedChecks: empty summary → empty set", () => {
  expect(precheckPassedChecks({ results: [], unreferencedAcs: [], ranAt: 0 })).toEqual(new Set());
});

test("runPipelinePrecheck runs only the known commands, keeps tails for failures only, scans ACs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-precheck-run-"));
  writeFileSync(path.join(dir, "a.test.js"), "AC-1");
  const progress: string[] = [];
  const s = await runPipelinePrecheck({
    cwd: dir,
    profile: profile({ typecheck: "echo tc-ok", test: "echo boom >&2; exit 3" }),
    specAcIds: ["AC-1", "AC-2"],
    onProgress: (l) => progress.push(l),
  });
  expect(s.results.map((r) => [r.name, r.ok, r.exitCode])).toEqual([["typecheck", true, 0], ["test", false, 3]]);
  expect(s.results[0]!.tail).toBe("");
  expect(s.results[1]!.tail).toContain("boom");
  expect(s.unreferencedAcs).toEqual(["AC-2"]);
  expect(precheckPasses(s)).toBe(false);
  expect(progress.some((l) => l.includes("test FAILED (exit 3)"))).toBe(true);
  expect(progress.some((l) => l.includes("lint"))).toBe(false);
});

test("renderPrecheck: passing commands are one line, failures carry their tail, unreferenced ACs are listed", () => {
  const block = renderPrecheck({
    results: [
      { name: "typecheck", cmd: "npm run typecheck", ok: true, exitCode: 0, tail: "" },
      { name: "test", cmd: "npm test", ok: false, exitCode: 1, tail: "1 failing\n  expected 2 got 3" },
    ],
    unreferencedAcs: ["AC-4"],
    ranAt: 0,
  });
  expect(block.startsWith("## Pre-run checks")).toBe(true);
  expect(block).toContain("- typecheck: ok (`npm run typecheck`)");
  expect(block).toContain("- test: FAILED (exit 1)");
  expect(block).toContain("expected 2 got 3");
  expect(block).toContain("AC-4");
  const green = renderPrecheck({ results: [{ name: "test", cmd: "x", ok: true, exitCode: 0, tail: "" }], unreferencedAcs: [], ranAt: 0 });
  expect(green).toContain("Every AC-N id is referenced");
});

test("kill switches read the env per call", () => {
  const a = process.env.AGETOR_PIPELINE_TESTER_SKIP, b = process.env.AGETOR_PIPELINE_PRECHECK;
  try {
    delete process.env.AGETOR_PIPELINE_TESTER_SKIP; delete process.env.AGETOR_PIPELINE_PRECHECK;
    expect(testerSkipEnabled()).toBe(true); expect(precheckEnabled()).toBe(true);
    process.env.AGETOR_PIPELINE_TESTER_SKIP = "0"; process.env.AGETOR_PIPELINE_PRECHECK = "0";
    expect(testerSkipEnabled()).toBe(false); expect(precheckEnabled()).toBe(false);
  } finally {
    if (a === undefined) delete process.env.AGETOR_PIPELINE_TESTER_SKIP; else process.env.AGETOR_PIPELINE_TESTER_SKIP = a;
    if (b === undefined) delete process.env.AGETOR_PIPELINE_PRECHECK; else process.env.AGETOR_PIPELINE_PRECHECK = b;
  }
});
