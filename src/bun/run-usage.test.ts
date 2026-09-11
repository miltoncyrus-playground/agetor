import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Run } from "../shared/types.ts";

// Top-level so db.ts captures our throwaway dir on first import (see the note
// in db.ts about the beforeAll race).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-run-usage-"));

let createTask: typeof import("./orchestrator.ts").createTask;
let runUsage: typeof import("./db.ts").runUsage;
let runs: typeof import("./db.ts").runs;
let tasks: typeof import("./db.ts").tasks;
let db: typeof import("./db.ts").db;
let recordRunUsageFromEvent: typeof import("./run-usage-hook.ts").recordRunUsageFromEvent;

beforeAll(async () => {
  ({ createTask } = await import("./orchestrator.ts"));
  ({ runUsage, runs, tasks, db } = await import("./db.ts"));
  ({ recordRunUsageFromEvent } = await import("./run-usage-hook.ts"));
});

async function newTask(): Promise<string> {
  const created = await createTask({
    title: "run usage test",
    prompt: "noop",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none", // don't materialize a worktree off the live repo
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

let seq = 0;
function newRun(taskId: string, startedAt?: number): Run {
  seq++;
  return runs.insert({
    id: `run-${taskId.slice(0, 8)}-${seq}`,
    startedAt: startedAt ?? Date.now() + seq,
    taskId,
    agent: "claude-code",
    status: "running",
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    geminiSessionId: null, cursorSessionId: null, fxSessionId: null,
  });
}

/** A claude JSONL assistant line as `dispatchLine` would have parsed it. */
function assistantEvent(id: string, u: { input?: number; cw?: number; cr?: number; out?: number } = {}) {
  return {
    type: "assistant",
    uuid: `uuid-${id}-${Math.random()}`,
    timestamp: "2026-09-11T10:00:00.000Z",
    requestId: `req-${id}`,
    message: {
      id,
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: u.input ?? 10,
        output_tokens: u.out ?? 20,
        cache_creation_input_tokens: u.cw ?? 5,
        cache_read_input_tokens: u.cr ?? 100,
      },
    },
  };
}

test("migration 058 creates run_usage and run_usage_seen on a fresh DB", () => {
  const names = db
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('run_usage', 'run_usage_seen') ORDER BY name`)
    .all()
    .map((r) => r.name);
  expect(names).toEqual(["run_usage", "run_usage_seen"]);
  const applied = db.query<{ id: string }, []>(`SELECT id FROM _migrations WHERE id = '058_run_usage'`).get();
  expect(applied?.id).toBe("058_run_usage");
});

test("record sums per message, is idempotent on message id, and fixes bootstrap once", async () => {
  const taskId = await newTask();
  const run = newRun(taskId);

  expect(runUsage.get(run.id)).toBeNull();

  expect(runUsage.record(run.id, { messageId: "m1", input: 100, cacheWrite: 2000, cacheRead: 50_000, output: 30 }, 1000)).toBe(true);
  // claude re-writes the same message.id once per content block — same usage.
  expect(runUsage.record(run.id, { messageId: "m1", input: 100, cacheWrite: 2000, cacheRead: 50_000, output: 30 }, 1001)).toBe(false);
  expect(runUsage.record(run.id, { messageId: "m2", input: 10, cacheWrite: 0, cacheRead: 52_000, output: 400 }, 2000)).toBe(true);

  const u = runUsage.get(run.id);
  expect(u).toEqual({
    runId: run.id,
    messages: 2,
    input: 110,
    cacheWrite: 2000,
    cacheRead: 102_000,
    output: 430,
    context: 104_110,
    bootstrap: 52_100, // first message only: 100 + 2000 + 50_000
    updatedAt: 2000,
  });
});

test("record refuses an empty message id and an unknown run without throwing", async () => {
  const taskId = await newTask();
  const run = newRun(taskId);
  expect(runUsage.record(run.id, { messageId: "", input: 1, cacheWrite: 1, cacheRead: 1, output: 1 })).toBe(false);
  expect(runUsage.record("no-such-run", { messageId: "m", input: 1, cacheWrite: 1, cacheRead: 1, output: 1 })).toBe(false);
  expect(runUsage.get(run.id)).toBeNull();
  expect(runUsage.get("no-such-run")).toBeNull();
});

test("forTask lists newest run first and totalsForTask sums every field", async () => {
  const taskId = await newTask();
  const older = newRun(taskId, 1_000);
  const newer = newRun(taskId, 2_000);
  runUsage.record(older.id, { messageId: "a", input: 1, cacheWrite: 2, cacheRead: 3, output: 4 }, 10);
  runUsage.record(newer.id, { messageId: "b", input: 10, cacheWrite: 20, cacheRead: 30, output: 40 }, 20);
  runUsage.record(newer.id, { messageId: "c", input: 100, cacheWrite: 200, cacheRead: 300, output: 400 }, 30);

  const list = runUsage.forTask(taskId);
  expect(list.map((u) => u.runId)).toEqual([newer.id, older.id]);

  expect(runUsage.totalsForTask(taskId)).toEqual({
    runId: taskId,
    messages: 3,
    input: 111,
    cacheWrite: 222,
    cacheRead: 333,
    output: 444,
    context: 666,
    bootstrap: 66, // 6 (older's first) + 60 (newer's first)
    updatedAt: 30,
  });

  // Empty task: all zeros, never null — callers render "0" without a branch.
  const empty = await newTask();
  expect(runUsage.totalsForTask(empty).messages).toBe(0);
  expect(runUsage.forTask(empty)).toEqual([]);
});

test("runs.listForTask carries each run's usage (null when unrecorded)", async () => {
  const taskId = await newTask();
  const a = newRun(taskId, 1_000);
  const b = newRun(taskId, 2_000);
  runUsage.record(b.id, { messageId: "x", input: 5, cacheWrite: 5, cacheRead: 5, output: 5 }, 1);
  const list = runs.listForTask(taskId);
  expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
  expect(list[0]!.usage?.context).toBe(15);
  expect(list[1]!.usage).toBeNull();
});

test("deleting a run cascades its usage rows", async () => {
  const taskId = await newTask();
  const run = newRun(taskId);
  runUsage.record(run.id, { messageId: "z", input: 1, cacheWrite: 1, cacheRead: 1, output: 1 });
  db.run(`DELETE FROM runs WHERE id = ?`, [run.id]);
  expect(runUsage.get(run.id)).toBeNull();
  expect(db.query<{ n: number }, [string]>(`SELECT COUNT(*) n FROM run_usage_seen WHERE run_id = ?`).get(run.id)?.n).toBe(1);
  // run_usage_seen has no FK by design (cheap inserts on the hot tail path);
  // the run_usage row itself is gone, which is what every reader consults.
});

test("hook: attributes an assistant line to task.runId, ignores non-usage lines, never throws", async () => {
  const taskId = await newTask();
  const run = newRun(taskId);
  tasks.update(taskId, { runId: run.id });

  expect(recordRunUsageFromEvent(taskId, assistantEvent("m1", { input: 7, cw: 8, cr: 9, out: 10 }))).toBe(true);
  // Replay of the same message (second content block / reattach) is a no-op.
  expect(recordRunUsageFromEvent(taskId, assistantEvent("m1"))).toBe(false);
  // user / system / summary lines carry no usage.
  expect(recordRunUsageFromEvent(taskId, { type: "user", message: { role: "user", content: "hi" } })).toBe(false);
  expect(recordRunUsageFromEvent(taskId, { type: "summary", summary: "x" })).toBe(false);
  // Assistant line with a usage block but no message.id can't be deduped — skipped.
  expect(recordRunUsageFromEvent(taskId, { type: "assistant", message: { usage: { input_tokens: 1 } } })).toBe(false);
  // Garbage never escapes.
  expect(recordRunUsageFromEvent(taskId, null)).toBe(false);
  expect(recordRunUsageFromEvent(taskId, "not an object")).toBe(false);
  // Unknown task (the `__rebuild__` synthetic state) → nothing recorded.
  expect(recordRunUsageFromEvent("__rebuild__", assistantEvent("m9"))).toBe(false);

  expect(runUsage.get(run.id)).toMatchObject({ messages: 1, input: 7, cacheWrite: 8, cacheRead: 9, output: 10, context: 24, bootstrap: 24 });
});

test("hook: a task with no active run records nothing", async () => {
  const taskId = await newTask();
  expect(tasks.get(taskId)?.runId ?? null).toBeNull();
  expect(recordRunUsageFromEvent(taskId, assistantEvent("m1"))).toBe(false);
  expect(runUsage.forTask(taskId)).toEqual([]);
});

test("hook: a second run on the same task gets its own row and bootstrap", async () => {
  const taskId = await newTask();
  const first = newRun(taskId, 1_000);
  tasks.update(taskId, { runId: first.id });
  recordRunUsageFromEvent(taskId, assistantEvent("m1", { input: 1, cw: 1, cr: 1, out: 1 }));
  recordRunUsageFromEvent(taskId, assistantEvent("m2", { input: 2, cw: 2, cr: 2, out: 2 }));

  const second = newRun(taskId, 2_000);
  tasks.update(taskId, { runId: second.id });
  recordRunUsageFromEvent(taskId, assistantEvent("m3", { input: 30, cw: 30, cr: 30, out: 30 }));

  expect(runUsage.get(first.id)).toMatchObject({ messages: 2, context: 9, bootstrap: 3 });
  expect(runUsage.get(second.id)).toMatchObject({ messages: 1, context: 90, bootstrap: 90 });
  expect(runUsage.totalsForTask(taskId)).toMatchObject({ messages: 3, context: 99, bootstrap: 93 });
});
