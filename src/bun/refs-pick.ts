// Headless (no native open-panel) candidate enumeration + selection for the
// folder/file picker. `headlessPickCandidates()` builds a bounded, prioritized,
// deduped list of directories worth offering; `selectPick()` turns one chosen
// candidate (or a manually-typed absolute path) into the final `{ refs }`
// result. Both are pure enough to unit-test directly, without spinning up the
// HTTP server — see refs-pick.test.ts.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { tasks } from "./db.ts";
import type { TaskReference } from "../shared/types.ts";

export const MAX_PICK_CANDIDATES = 50;

export function headlessPickCandidates(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (rawPath: string) => {
    if (out.length >= MAX_PICK_CANDIDATES) return;
    let real: string;
    try {
      real = realpathSync(rawPath);
    } catch {
      return; // gone / unreadable — silently dropped
    }
    if (seen.has(real)) return;
    seen.add(real);
    out.push(real);
  };

  // 1. Every task's workdir, most-recently-updated first (AC-2).
  const sortedTasks = [...tasks.list()].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const task of sortedTasks) add(task.workdir);

  // 2. Non-dot git-repo subdirectories of $HOME, alphabetical (AC-3).
  // `process.env.HOME` (not `homedir()` directly) so tests can override it —
  // Bun's `os.homedir()` caches the OS-reported value at process start and
  // doesn't observe later writes to `process.env.HOME` (unlike Node's).
  const home = process.env.HOME ?? homedir();
  try {
    const entries = readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const dir = path.join(home, entry.name);
      if (existsSync(path.join(dir, ".git"))) add(dir);
    }
  } catch {
    // Unreadable $HOME degrades to "no git-repo candidates", not an error.
  }

  // 3. $HOME itself, as a fallback (AC-4).
  add(home);

  return out;
}

export function selectPick(
  rawPath: string,
  mode: "files" | "folder",
): { refs: TaskReference[] } | { error: string } {
  if (!path.isAbsolute(rawPath)) return { error: "enter an absolute path" };
  let stat;
  try {
    stat = statSync(rawPath);
  } catch {
    return { error: "path not found" };
  }
  if (!stat.isDirectory()) return { error: "not a directory" };

  if (mode === "folder") {
    return { refs: [{ path: rawPath, isDirectory: true }] };
  }

  const entries = readdirSync(rawPath, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    refs: entries.map((e) => ({ path: path.join(rawPath, e.name), isDirectory: false })),
  };
}
