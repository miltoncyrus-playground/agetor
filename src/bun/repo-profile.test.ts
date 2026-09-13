import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  detectRepoProfileFromFiles,
  readRepoProfile,
  lockfileHash,
  renderProjectCommands,
  ensureDependenciesInstalled,
  runCheck,
  LOCKFILE_HASH_MARKER,
  type RepoProfile,
  type CheckName,
} from "./repo-profile.ts";

const FULL_PKG = JSON.stringify({
  name: "fixture",
  scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run", build: "vite build" },
});

const dirs: string[] = [];
function tmp(prefix = "agetor-repo-profile-"): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// --- detectRepoProfileFromFiles ---------------------------------------------

test("npm with package-lock: ci install, `npm run` syntax", () => {
  const p = detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: ["package-lock.json"] });
  expect(p).toEqual({
    packageManager: "npm",
    install: "npm ci",
    typecheck: "npm run typecheck",
    lint: "npm run lint",
    test: "npm run test",
    build: "npm run build",
    typecheckScoped: null,
    lintScoped: null,
    testScoped: null,
    buildScoped: null,
    workspaces: false,
    lockfile: "package-lock.json",
  });
});

test("package.json but no lockfile: npm with plain install (npm ci needs a lockfile)", () => {
  const p = detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: [] });
  expect(p.packageManager).toBe("npm");
  expect(p.install).toBe("npm install");
  expect(p.lockfile).toBeNull();
});

test("bun.lock → bun; bun.lockb also → bun", () => {
  expect(detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: ["bun.lock"] })).toMatchObject({
    packageManager: "bun",
    install: "bun install --frozen-lockfile",
    typecheck: "bun run typecheck",
    test: "bun run test",
    lockfile: "bun.lock",
  });
  expect(detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: ["bun.lockb"] }).packageManager).toBe("bun");
});

test("pnpm-lock.yaml → pnpm", () => {
  expect(detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: ["pnpm-lock.yaml"] })).toMatchObject({
    packageManager: "pnpm",
    install: "pnpm install --frozen-lockfile",
    lint: "pnpm run lint",
    lockfile: "pnpm-lock.yaml",
  });
});

test("yarn.lock → yarn, scripts run without `run`", () => {
  expect(detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: ["yarn.lock"] })).toMatchObject({
    packageManager: "yarn",
    install: "yarn install --frozen-lockfile",
    typecheck: "yarn typecheck",
    build: "yarn build",
  });
});

test("lockfile names may arrive as paths; basename is what matters", () => {
  const p = detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: ["/repo/pnpm-lock.yaml"] });
  expect(p.packageManager).toBe("pnpm");
});

test("two lockfiles: precedence is stable (bun beats a leftover package-lock)", () => {
  const a = detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: ["package-lock.json", "bun.lock"] });
  const b = detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: ["bun.lock", "package-lock.json"] });
  expect(a.packageManager).toBe("bun");
  expect(b).toEqual(a);
});

test("typecheck aliases: tsc and check-types, in preference order", () => {
  const tsc = detectRepoProfileFromFiles({
    packageJson: JSON.stringify({ scripts: { tsc: "tsc" } }),
    lockfiles: ["package-lock.json"],
  });
  expect(tsc.typecheck).toBe("npm run tsc");
  const ct = detectRepoProfileFromFiles({
    packageJson: JSON.stringify({ scripts: { "check-types": "tsc", tsc: "tsc" } }),
    lockfiles: [],
  });
  // `tsc` precedes `check-types` in TYPECHECK_SCRIPT_KEYS.
  expect(ct.typecheck).toBe("npm run tsc");
  const both = detectRepoProfileFromFiles({
    packageJson: JSON.stringify({ scripts: { typecheck: "x", tsc: "y" } }),
    lockfiles: [],
  });
  expect(both.typecheck).toBe("npm run typecheck");
});

test("missing scripts are null; empty-string scripts count as missing", () => {
  const p = detectRepoProfileFromFiles({
    packageJson: JSON.stringify({ scripts: { test: "", build: "vite build" } }),
    lockfiles: ["package-lock.json"],
  });
  expect(p.typecheck).toBeNull();
  expect(p.lint).toBeNull();
  expect(p.test).toBeNull();
  expect(p.build).toBe("npm run build");
});

test("no scripts field at all still yields an install command", () => {
  const p = detectRepoProfileFromFiles({ packageJson: JSON.stringify({ name: "x" }), lockfiles: ["yarn.lock"] });
  expect(p.install).toBe("yarn install --frozen-lockfile");
  expect(p.test).toBeNull();
});

test("workspaces detected for array and object forms", () => {
  expect(
    detectRepoProfileFromFiles({ packageJson: JSON.stringify({ workspaces: ["packages/*"] }), lockfiles: [] }).workspaces,
  ).toBe(true);
  expect(
    detectRepoProfileFromFiles({ packageJson: JSON.stringify({ workspaces: { packages: ["a"] } }), lockfiles: [] }).workspaces,
  ).toBe(true);
  expect(detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: [] }).workspaces).toBe(false);
});

test("no package.json → all nulls, even with a stray lockfile", () => {
  const p = detectRepoProfileFromFiles({ packageJson: null, lockfiles: ["yarn.lock"] });
  expect(p).toEqual({
    packageManager: null, install: null, typecheck: null, lint: null, test: null, build: null,
    typecheckScoped: null, lintScoped: null, testScoped: null, buildScoped: null,
    workspaces: false, lockfile: null,
  });
});

test("invalid JSON / non-object root → all nulls", () => {
  const empty: RepoProfile = {
    packageManager: null, install: null, typecheck: null, lint: null, test: null, build: null,
    typecheckScoped: null, lintScoped: null, testScoped: null, buildScoped: null,
    workspaces: false, lockfile: null,
  };
  expect(detectRepoProfileFromFiles({ packageJson: "{ not json", lockfiles: ["bun.lock"] })).toEqual(empty);
  expect(detectRepoProfileFromFiles({ packageJson: "[1,2]", lockfiles: [] })).toEqual(empty);
  expect(detectRepoProfileFromFiles({ packageJson: "null", lockfiles: [] })).toEqual(empty);
});

test("scripts that is not an object is ignored, not fatal", () => {
  const p = detectRepoProfileFromFiles({ packageJson: JSON.stringify({ scripts: "nope" }), lockfiles: [] });
  expect(p.packageManager).toBe("npm");
  expect(p.test).toBeNull();
});

// --- readRepoProfile / lockfileHash ------------------------------------------

test("readRepoProfile reads package.json and the lockfiles that exist", () => {
  const d = tmp();
  writeFileSync(path.join(d, "package.json"), FULL_PKG);
  writeFileSync(path.join(d, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const p = readRepoProfile(d);
  expect(p.packageManager).toBe("pnpm");
  expect(p.test).toBe("pnpm run test");
});

test("readRepoProfile on an empty dir (non-JS repo) → all nulls", () => {
  const d = tmp();
  const p = readRepoProfile(d);
  expect(p.packageManager).toBeNull();
  expect(renderProjectCommands(p, { installed: false })).toBe("");
});

test("lockfileHash is sha256 hex of the lockfile bytes; null with no lockfile", () => {
  const d = tmp();
  expect(lockfileHash(d)).toBeNull();
  const bytes = "lockfileVersion: 3\n";
  writeFileSync(path.join(d, "package-lock.json"), bytes);
  expect(lockfileHash(d)).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(lockfileHash(d)).toMatch(/^[0-9a-f]{64}$/);
});

// --- renderProjectCommands ---------------------------------------------------

test("renderProjectCommands: full profile, not installed, under 400 bytes", () => {
  const p = detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: ["package-lock.json"] });
  const block = renderProjectCommands(p, { installed: false });
  expect(block.startsWith("## Project commands\n")).toBe(true);
  expect(block).toContain("install: npm ci");
  expect(block).toContain("typecheck: npm run typecheck");
  expect(block).toContain("lint: npm run lint");
  expect(block).toContain("test: npm run test");
  expect(block).toContain("build: npm run build");
  expect(Buffer.byteLength(block, "utf8")).toBeLessThan(400);
});

test("renderProjectCommands: installed flag replaces the install command; workspaces noted", () => {
  const p = detectRepoProfileFromFiles({
    packageJson: JSON.stringify({ workspaces: ["packages/*"], scripts: { test: "vitest", typecheck: "tsc -b", lint: "eslint", build: "turbo build" } }),
    lockfiles: ["pnpm-lock.yaml"],
  });
  const block = renderProjectCommands(p, { installed: true });
  expect(block).toContain("dependencies already installed");
  expect(block).not.toContain("pnpm install");
  expect(block).toContain("workspaces:");
  expect(Buffer.byteLength(block, "utf8")).toBeLessThan(400);
});

test("renderProjectCommands: empty profile → empty string", () => {
  expect(renderProjectCommands(detectRepoProfileFromFiles({ packageJson: null, lockfiles: [] }), { installed: false })).toBe("");
});

test("renderProjectCommands: only known lines are emitted", () => {
  const p = detectRepoProfileFromFiles({ packageJson: JSON.stringify({ scripts: { test: "bun test" } }), lockfiles: ["bun.lock"] });
  const block = renderProjectCommands(p, { installed: true });
  expect(block.split("\n")).toEqual([
    "## Project commands",
    "install: dependencies already installed, do not reinstall",
    "test: bun run test",
  ]);
});

// --- scoped/fast check preference (O-13) -------------------------------------

test("scoped variant detected under the `<check>:changed` convention and preferred when rendering", () => {
  const p = detectRepoProfileFromFiles({
    packageJson: JSON.stringify({ scripts: { test: "vitest run", "test:changed": "vitest related" } }),
    lockfiles: ["package-lock.json"],
  });
  expect(p.test).toBe("npm run test");
  expect(p.testScoped).toBe("npm run test:changed");
  const block = renderProjectCommands(p, { installed: true });
  expect(block).toContain("test: npm run test:changed");
  expect(block).not.toContain("test: npm run test\n");
});

test("scoped-only script with no full command never sets the scoped field", () => {
  const p = detectRepoProfileFromFiles({
    packageJson: JSON.stringify({ scripts: { "test:changed": "vitest related" } }),
    lockfiles: [],
  });
  expect(p.test).toBeNull();
  expect(p.testScoped).toBeNull();
});

test("scoped variants are independent per check", () => {
  const p = detectRepoProfileFromFiles({
    packageJson: JSON.stringify({ scripts: { test: "vitest run", "test:changed": "vitest related", lint: "eslint ." } }),
    lockfiles: [],
  });
  expect(p.testScoped).toBe("npm run test:changed");
  expect(p.lintScoped).toBeNull();
  const block = renderProjectCommands(p, { installed: true });
  expect(block).toContain("test: npm run test:changed");
  expect(block).toContain("lint: npm run lint");
});

test("scoped lookup uses the canonical label, not the alias that satisfied the full command", () => {
  const p = detectRepoProfileFromFiles({
    packageJson: JSON.stringify({ scripts: { tsc: "tsc", "typecheck:changed": "tsc --incremental" } }),
    lockfiles: [],
  });
  expect(p.typecheck).toBe("npm run tsc");
  expect(p.typecheckScoped).toBe("npm run typecheck:changed");
});

test("renderProjectCommands: skipChecks drops that check's line entirely, others unaffected", () => {
  const p = detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: ["package-lock.json"] });
  const skip: ReadonlySet<CheckName> = new Set(["test"]);
  const block = renderProjectCommands(p, { installed: true, skipChecks: skip });
  expect(block).not.toContain("test:");
  expect(block).toContain("typecheck: npm run typecheck");
  expect(block).toContain("lint: npm run lint");
  expect(block).toContain("build: npm run build");
});

test("renderProjectCommands: no skipChecks at all → byte-identical to before this change", () => {
  const p = detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: ["package-lock.json"] });
  const block = renderProjectCommands(p, { installed: false });
  expect(block.startsWith("## Project commands\n")).toBe(true);
  expect(block).toContain("install: npm ci");
  expect(block).toContain("typecheck: npm run typecheck");
  expect(block).toContain("lint: npm run lint");
  expect(block).toContain("test: npm run test");
  expect(block).toContain("build: npm run build");
  expect(Buffer.byteLength(block, "utf8")).toBeLessThan(400);
});

test("renderProjectCommands: skipChecks covering every known check still renders the install line", () => {
  const p = detectRepoProfileFromFiles({ packageJson: FULL_PKG, lockfiles: ["package-lock.json"] });
  const skip: ReadonlySet<CheckName> = new Set(["typecheck", "lint", "test", "build"]);
  const block = renderProjectCommands(p, { installed: false, skipChecks: skip });
  expect(block).toBe("## Project commands\ninstall: npm ci");
});

// --- ensureDependenciesInstalled ---------------------------------------------

function fakeProfile(install: string | null): RepoProfile {
  return {
    packageManager: "npm", install, typecheck: null, lint: null, test: null, build: null,
    typecheckScoped: null, lintScoped: null, testScoped: null, buildScoped: null,
    workspaces: false, lockfile: "package-lock.json",
  };
}

test("install runs when node_modules is missing, then writes the marker", async () => {
  const d = tmp();
  writeFileSync(path.join(d, "package-lock.json"), "v1\n");
  const r = await ensureDependenciesInstalled(d, fakeProfile("mkdir -p node_modules && echo installed"));
  expect(r).toMatchObject({ ran: true, ok: true });
  expect(r.detail).toContain("installed");
  expect(readFileSync(path.join(d, "node_modules", LOCKFILE_HASH_MARKER), "utf8")).toBe(lockfileHash(d)!);
});

test("install is a no-op when node_modules exists and the marker matches", async () => {
  const d = tmp();
  writeFileSync(path.join(d, "package-lock.json"), "v1\n");
  mkdirSync(path.join(d, "node_modules"));
  writeFileSync(path.join(d, "node_modules", LOCKFILE_HASH_MARKER), lockfileHash(d)!);
  const r = await ensureDependenciesInstalled(d, fakeProfile("touch RAN"));
  expect(r).toEqual({ ran: false, ok: true, detail: expect.stringContaining("matches") });
  expect(existsSync(path.join(d, "RAN"))).toBe(false);
});

test("install re-runs when the lockfile changed since the marker", async () => {
  const d = tmp();
  writeFileSync(path.join(d, "package-lock.json"), "v1\n");
  mkdirSync(path.join(d, "node_modules"));
  writeFileSync(path.join(d, "node_modules", LOCKFILE_HASH_MARKER), lockfileHash(d)!);
  writeFileSync(path.join(d, "package-lock.json"), "v2\n");
  const r = await ensureDependenciesInstalled(d, fakeProfile("touch RAN"));
  expect(r.ran).toBe(true);
  expect(r.ok).toBe(true);
  expect(existsSync(path.join(d, "RAN"))).toBe(true);
  expect(readFileSync(path.join(d, "node_modules", LOCKFILE_HASH_MARKER), "utf8")).toBe(lockfileHash(d)!);
});

test("install re-runs when node_modules exists but has no marker", async () => {
  const d = tmp();
  mkdirSync(path.join(d, "node_modules"));
  const r = await ensureDependenciesInstalled(d, fakeProfile("touch RAN"));
  expect(r.ran).toBe(true);
  expect(existsSync(path.join(d, "RAN"))).toBe(true);
  // No lockfile → marker holds the empty hash, and a follow-up is a no-op.
  expect(readFileSync(path.join(d, "node_modules", LOCKFILE_HASH_MARKER), "utf8")).toBe("");
  rmSync(path.join(d, "RAN"));
  const again = await ensureDependenciesInstalled(d, fakeProfile("touch RAN"));
  expect(again.ran).toBe(false);
  expect(existsSync(path.join(d, "RAN"))).toBe(false);
});

test("install skipped when the profile has no install command", async () => {
  const d = tmp();
  const r = await ensureDependenciesInstalled(d, fakeProfile(null));
  expect(r).toMatchObject({ ran: false, ok: true });
  expect(existsSync(path.join(d, "node_modules"))).toBe(false);
});

test("failed install: ok=false, exit code in detail, no marker written", async () => {
  const d = tmp();
  const r = await ensureDependenciesInstalled(d, fakeProfile("echo boom >&2; exit 3"));
  expect(r.ran).toBe(true);
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("exited 3");
  expect(r.detail).toContain("boom");
  expect(existsSync(path.join(d, "node_modules", LOCKFILE_HASH_MARKER))).toBe(false);
});

test("install detail is capped at the last 2000 bytes", async () => {
  const d = tmp();
  const r = await ensureDependenciesInstalled(d, fakeProfile("mkdir -p node_modules; head -c 5000 /dev/zero | tr '\\0' 'x'; echo END"));
  expect(r.ok).toBe(true);
  expect(r.detail.length).toBeLessThanOrEqual(2000);
  expect(r.detail.endsWith("END\n")).toBe(true);
});

test("install timeout kills the process and reports ok=false", async () => {
  const d = tmp();
  const r = await ensureDependenciesInstalled(d, fakeProfile("sleep 30"), { timeoutMs: 200 });
  expect(r.ran).toBe(true);
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("timed out");
}, 10_000);

test("markerDir override relocates the marker", async () => {
  const d = tmp();
  const markerDir = path.join(d, "elsewhere");
  const r = await ensureDependenciesInstalled(d, fakeProfile("mkdir -p node_modules"), { markerDir });
  expect(r.ok).toBe(true);
  expect(existsSync(path.join(markerDir, LOCKFILE_HASH_MARKER))).toBe(true);
});

// --- runCheck -------------------------------------------------------------

test("runCheck: `true` is ok with exit 0", async () => {
  const d = tmp();
  const r = await runCheck(d, "true");
  expect(r).toEqual({ ok: true, exitCode: 0, tail: "" });
});

test("runCheck: `false` is not ok with exit 1", async () => {
  const d = tmp();
  const r = await runCheck(d, "false");
  expect(r).toEqual({ ok: false, exitCode: 1, tail: "" });
});

test("runCheck: captures combined stdout+stderr and runs in cwd", async () => {
  const d = tmp();
  const r = await runCheck(d, "echo out; echo err >&2; pwd");
  expect(r.ok).toBe(true);
  expect(r.tail).toContain("out\n");
  expect(r.tail).toContain("err\n");
  expect(r.tail).toContain(path.basename(d));
});

test("runCheck: tail is capped at tailBytes (default 8000)", async () => {
  const d = tmp();
  const big = await runCheck(d, "head -c 20000 /dev/zero | tr '\\0' 'y'; echo TAIL");
  expect(big.tail.length).toBeLessThanOrEqual(8000);
  expect(big.tail.endsWith("TAIL\n")).toBe(true);
  const small = await runCheck(d, "echo abcdefghij", { tailBytes: 4 });
  expect(small.tail).toBe("hij\n");
});

test("runCheck: timeout → ok=false, exitCode null", async () => {
  const d = tmp();
  const r = await runCheck(d, "sleep 30", { timeoutMs: 200 });
  expect(r.ok).toBe(false);
  expect(r.exitCode).toBeNull();
  expect(r.tail).toContain("timed out");
}, 10_000);
