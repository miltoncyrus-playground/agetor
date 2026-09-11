import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Deterministic repo profile (plan O-4).
 *
 * The Tester spent 95 Bash calls across two runs discovering how to install
 * and run one JS project: which package manager, which script is the
 * typecheck, whether `node_modules` is there. Same-input-same-output work,
 * so it lives here in deterministic space. `detectRepoProfileFromFiles` and
 * `renderProjectCommands` are pure (fixture-testable); `readRepoProfile`
 * is the single filesystem choke point; `ensureDependenciesInstalled` is
 * the single install choke point, guarded by a lockfile-hash marker so a
 * re-run of the same worktree never installs twice.
 *
 * Only the JS/TS ecosystem is detected. Anything else yields an all-null
 * profile and `renderProjectCommands` returns "" so no block is injected.
 */
export interface RepoProfile {
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null;
  install: string | null;
  typecheck: string | null;
  lint: string | null;
  test: string | null;
  build: string | null;
  workspaces: boolean;
  lockfile: string | null;
}

/**
 * Lockfile names we recognise, in precedence order. When a repo ships more
 * than one (a migration left `package-lock.json` behind next to `bun.lock`),
 * the first match wins so the answer is stable across runs; the order puts
 * the managers whose lockfile is least likely to be an abandoned leftover
 * first.
 */
export const KNOWN_LOCKFILES: ReadonlyArray<{ name: string; manager: NonNullable<RepoProfile["packageManager"]> }> = [
  { name: "bun.lock", manager: "bun" },
  { name: "bun.lockb", manager: "bun" },
  { name: "pnpm-lock.yaml", manager: "pnpm" },
  { name: "yarn.lock", manager: "yarn" },
  { name: "package-lock.json", manager: "npm" },
];

/** Marker file written inside `node_modules` after a successful install,
 *  holding the sha256 of the lockfile the install was made from. */
export const LOCKFILE_HASH_MARKER = ".agetor-lockfile-hash";

/** Hard ceiling for one dependency install. Long enough for a cold pnpm
 *  install on a monorepo, short enough that a hung registry doesn't wedge
 *  the pipeline forever. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

const EMPTY_PROFILE: RepoProfile = {
  packageManager: null,
  install: null,
  typecheck: null,
  lint: null,
  test: null,
  build: null,
  workspaces: false,
  lockfile: null,
};

/** The `scripts` keys that count as a typecheck, in preference order. */
const TYPECHECK_SCRIPT_KEYS = ["typecheck", "tsc", "check-types"];

function runScriptCommand(manager: NonNullable<RepoProfile["packageManager"]>, script: string): string {
  // yarn (classic and berry) runs scripts without `run`; the other three
  // accept `run` uniformly and it avoids colliding with a builtin
  // subcommand of the same name (`npm test` is fine, `npm lint` is not).
  return manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;
}

function installCommand(manager: NonNullable<RepoProfile["packageManager"]>, lockfile: string | null): string {
  switch (manager) {
    case "npm":
      // `npm ci` refuses to run without a lockfile, so fall back to `install`.
      return lockfile === "package-lock.json" ? "npm ci" : "npm install";
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    case "bun":
      return "bun install --frozen-lockfile";
  }
}

/**
 * Pure detection over the raw contents of `package.json` and the set of
 * lockfile names present. Invalid JSON, a non-object root, or no
 * package.json at all → the all-null profile (the caller then injects
 * nothing rather than guessing).
 */
export function detectRepoProfileFromFiles(files: { packageJson: string | null; lockfiles: string[] }): RepoProfile {
  if (files.packageJson === null) return { ...EMPTY_PROFILE };

  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(files.packageJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY_PROFILE };
    pkg = parsed as Record<string, unknown>;
  } catch {
    return { ...EMPTY_PROFILE };
  }

  const present = new Set(files.lockfiles.map((f) => path.basename(f)));
  const matched = KNOWN_LOCKFILES.find((l) => present.has(l.name)) ?? null;
  const manager = matched?.manager ?? "npm";
  const lockfile = matched?.name ?? null;

  const scriptsRaw = pkg.scripts;
  const scripts: Record<string, unknown> =
    scriptsRaw && typeof scriptsRaw === "object" && !Array.isArray(scriptsRaw)
      ? (scriptsRaw as Record<string, unknown>)
      : {};
  const hasScript = (key: string): boolean => typeof scripts[key] === "string" && (scripts[key] as string).trim() !== "";
  const typecheckKey = TYPECHECK_SCRIPT_KEYS.find(hasScript) ?? null;

  return {
    packageManager: manager,
    install: installCommand(manager, lockfile),
    typecheck: typecheckKey ? runScriptCommand(manager, typecheckKey) : null,
    lint: hasScript("lint") ? runScriptCommand(manager, "lint") : null,
    test: hasScript("test") ? runScriptCommand(manager, "test") : null,
    build: hasScript("build") ? runScriptCommand(manager, "build") : null,
    workspaces: pkg.workspaces !== undefined && pkg.workspaces !== null,
    lockfile,
  };
}

/** The single filesystem choke point: read `<cwd>/package.json` and list the
 *  recognised lockfiles that exist, then delegate to the pure detector. */
export function readRepoProfile(cwd: string): RepoProfile {
  let packageJson: string | null = null;
  try {
    packageJson = readFileSync(path.join(cwd, "package.json"), "utf8");
  } catch {
    packageJson = null;
  }
  const lockfiles = KNOWN_LOCKFILES.map((l) => l.name).filter((name) => existsSync(path.join(cwd, name)));
  return detectRepoProfileFromFiles({ packageJson, lockfiles });
}

/** Path of the first recognised lockfile under `cwd`, or null. */
function firstLockfilePath(cwd: string): string | null {
  for (const { name } of KNOWN_LOCKFILES) {
    const p = path.join(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * sha256 hex of the first existing lockfile's bytes, null when none. This is
 * the install-idempotence key: same lockfile bytes → same dependency tree →
 * an existing `node_modules` is trusted.
 */
export function lockfileHash(cwd: string): string | null {
  const p = firstLockfilePath(cwd);
  if (!p) return null;
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Compact `## Project commands` block for prompt injection. Pure. Returns ""
 * when the profile knows no command at all, so a non-JS repo injects
 * nothing. Kept well under 400 bytes for a full profile: every byte here is
 * repeated into every stage prompt of every pipeline.
 */
export function renderProjectCommands(profile: RepoProfile, opts: { installed: boolean }): string {
  const commands: Array<[string, string | null]> = [
    ["typecheck", profile.typecheck],
    ["lint", profile.lint],
    ["test", profile.test],
    ["build", profile.build],
  ];
  const known = commands.filter((c): c is [string, string] => c[1] !== null);
  if (known.length === 0 && profile.install === null) return "";

  const lines: string[] = ["## Project commands"];
  if (opts.installed) {
    lines.push("install: dependencies already installed, do not reinstall");
  } else if (profile.install) {
    lines.push(`install: ${profile.install}`);
  }
  for (const [label, cmd] of known) lines.push(`${label}: ${cmd}`);
  if (profile.workspaces) lines.push("workspaces: yes (monorepo; run commands from the root)");
  return lines.join("\n");
}

/** Grace period after the shell exits for its pipes to drain and close.
 *  A well-behaved command's children exit with it; a daemon it left behind
 *  would otherwise hold the pipe open forever. */
const PIPE_DRAIN_GRACE_MS = 1_000;

/** Best-effort kill of `pid`'s direct children. Killing only the `sh -c`
 *  wrapper leaves the real work (`node`, `pnpm`, …) running and holding our
 *  stdout pipe; `pkill -P` reaches one level down, which covers every
 *  installer/check we drive. Deeper descendants are left to the reader
 *  cancellation in `runShell` so we never hang on them. */
function killChildren(pid: number): void {
  try {
    Bun.spawnSync(["pkill", "-KILL", "-P", String(pid)], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // pkill missing or unavailable: the wrapper kill still fires.
  }
}

/** Run `sh -c cmd` in `cwd`, collect combined stdout+stderr in arrival
 *  order, kill after `timeoutMs`. Shared by the install and check runners
 *  so both have one timeout/collection story.
 *
 *  The pipes are pumped incrementally and the readers are cancelled once
 *  the shell has exited (after a short drain grace), so an orphaned
 *  grandchild that inherited the pipe can't wedge the caller: the
 *  install/check has a bounded wall clock no matter what it spawned. The
 *  first version awaited `new Response(proc.stdout).text()`, which blocks
 *  until the LAST holder of the pipe closes it, so a killed `sh -c "sleep
 *  30"` still hung for 30 s. */
async function runShell(
  cwd: string,
  cmd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Installs and checks are non-interactive; a stray `tty` probe should
    // see a plain pipe and not wait on input.
    env: { ...process.env, CI: process.env.CI ?? "1" },
  });

  let output = "";
  const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
  const pumps = readers.map(async (reader) => {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        output += dec.decode(value, { stream: true });
      }
    } catch {
      // Cancelled after exit, or the pipe broke: whatever arrived is kept.
    }
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killChildren(proc.pid);
    proc.kill("SIGKILL");
  }, timeoutMs);

  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  // Let the pipes close naturally, then cut off anything still holding them.
  await Promise.race([
    Promise.all(pumps),
    new Promise<void>((resolve) => setTimeout(resolve, timedOut ? 0 : PIPE_DRAIN_GRACE_MS)),
  ]);
  for (const r of readers) r.cancel().catch(() => {});
  await Promise.allSettled(pumps);

  return { exitCode: timedOut ? null : exitCode, output, timedOut };
}

/** Last `n` bytes of `s` (byte-accurate on ASCII, char-approximate otherwise;
 *  good enough for a log tail). */
function tail(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n);
}

/**
 * The single install choke point. Runs `profile.install` in `cwd` only when
 * (a) the profile has an install command and (b) `node_modules` is missing
 * or its `.agetor-lockfile-hash` marker doesn't match the current lockfile
 * hash. Writes the marker on success, so the next stage (or a re-run of the
 * same worktree) is a no-op. `{ ran: false, ok: true }` when skipped.
 *
 * Security note (from the plan): this runs the repo's `postinstall` scripts
 * with the user's privileges. The agent would run the same install a turn
 * later, so this adds no exposure agetor didn't already have.
 */
export async function ensureDependenciesInstalled(
  cwd: string,
  profile: RepoProfile,
  opts: { markerDir?: string; timeoutMs?: number } = {},
): Promise<{ ran: boolean; ok: boolean; detail: string }> {
  if (!profile.install) return { ran: false, ok: true, detail: "no install command for this repo" };

  const markerDir = opts.markerDir ?? path.join(cwd, "node_modules");
  const markerPath = path.join(markerDir, LOCKFILE_HASH_MARKER);
  const currentHash = lockfileHash(cwd) ?? "";

  if (existsSync(path.join(cwd, "node_modules"))) {
    let marker: string | null = null;
    try {
      marker = readFileSync(markerPath, "utf8").trim();
    } catch {
      marker = null;
    }
    if (marker !== null && marker === currentHash) {
      return { ran: false, ok: true, detail: "node_modules present and lockfile hash matches marker" };
    }
  }

  const timeoutMs = opts.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const { exitCode, output, timedOut } = await runShell(cwd, profile.install, timeoutMs);
  const detail = tail(output, 2000);
  if (timedOut) return { ran: true, ok: false, detail: `${profile.install} timed out after ${timeoutMs}ms\n${detail}` };
  if (exitCode !== 0) return { ran: true, ok: false, detail: `${profile.install} exited ${exitCode}\n${detail}` };

  try {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(markerPath, currentHash);
  } catch {
    // The install succeeded; a missing marker only costs a redundant install
    // next time. Not worth failing the stage over.
  }
  return { ran: true, ok: true, detail };
}

/**
 * Run one check command (typecheck / lint / test) and report its exit status
 * plus the last `tailBytes` (default 8000) of combined output. The tail is
 * what gets folded into the Tester's prompt on a red check (plan O-5), so
 * it's capped here rather than at the prompt layer.
 */
export async function runCheck(
  cwd: string,
  cmd: string,
  opts: { timeoutMs?: number; tailBytes?: number } = {},
): Promise<{ ok: boolean; exitCode: number | null; tail: string }> {
  const timeoutMs = opts.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const { exitCode, output, timedOut } = await runShell(cwd, cmd, timeoutMs);
  const t = tail(output, opts.tailBytes ?? 8000);
  if (timedOut) return { ok: false, exitCode: null, tail: `${cmd} timed out after ${timeoutMs}ms\n${t}` };
  return { ok: exitCode === 0, exitCode, tail: t };
}
