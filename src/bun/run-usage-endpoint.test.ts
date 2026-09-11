import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Run, RunUsage } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-run-usage-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4461";

const BASE = "http://127.0.0.1:4461";

let server: { stop: () => void };
let token: string;
let createTask: typeof import("./orchestrator.ts").createTask;
let runs: typeof import("./db.ts").runs;
let runUsage: typeof import("./db.ts").runUsage;

beforeAll(async () => {
  ({ createTask } = await import("./orchestrator.ts"));
  ({ runs, runUsage } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

async function newTask(): Promise<string> {
  const created = await createTask({
    title: "run usage endpoint",
    prompt: "noop",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

let seq = 0;
function newRun(taskId: string, startedAt: number): Run {
  return runs.insert({
    id: `run-ep-${seq++}`,
    taskId,
    agent: "claude-code",
    status: "succeeded",
    startedAt,
    endedAt: startedAt + 1,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    geminiSessionId: null, cursorSessionId: null, fxSessionId: null,
  });
}

const call = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

test("GET /runs/:id/usage and /tasks/:id/usage return the recorded shape", async () => {
  const id = await newTask();
  const a = newRun(id, 1_000);
  const b = newRun(id, 2_000);
  runUsage.record(a.id, { messageId: "m1", input: 100, cacheWrite: 1_000, cacheRead: 10_000, output: 50 }, 5);
  runUsage.record(b.id, { messageId: "m2", input: 1, cacheWrite: 2, cacheRead: 3, output: 4 }, 6);
  runUsage.record(b.id, { messageId: "m3", input: 1, cacheWrite: 2, cacheRead: 3, output: 4 }, 7);

  let res = await call(`/runs/${a.id}/usage`);
  expect(res.status).toBe(200);
  const one = (await res.json()) as RunUsage;
  expect(one).toEqual({ runId: a.id, messages: 1, input: 100, cacheWrite: 1_000, cacheRead: 10_000, output: 50, context: 11_100, bootstrap: 11_100, updatedAt: 5 });

  res = await call(`/tasks/${id}/usage`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { runs: RunUsage[]; totals: RunUsage };
  expect(body.runs.map((u) => u.runId)).toEqual([b.id, a.id]); // newest first
  expect(body.totals).toEqual({ runId: id, messages: 3, input: 102, cacheWrite: 1_004, cacheRead: 10_006, output: 58, context: 11_112, bootstrap: 11_106, updatedAt: 7 });

  // The runs list carries usage inline so the RunPanel poll needs no second request.
  res = await call(`/tasks/${id}/runs`);
  const list = (await res.json()) as Run[];
  expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
  expect(list[0]!.usage?.messages).toBe(2);
  expect(list[1]!.usage?.context).toBe(11_100);
});

test("a run with nothing recorded returns null; an unknown run or task is 404", async () => {
  const id = await newTask();
  const r = newRun(id, 3_000);
  let res = await call(`/runs/${r.id}/usage`);
  expect(res.status).toBe(200);
  expect(await res.json()).toBeNull();

  res = await call(`/tasks/${id}/runs`);
  expect(((await res.json()) as Run[])[0]!.usage).toBeNull();

  res = await call(`/tasks/${id}/usage`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { runs: RunUsage[]; totals: RunUsage }).totals.messages).toBe(0);

  expect((await call(`/runs/does-not-exist/usage`)).status).toBe(404);
  expect((await call(`/tasks/does-not-exist/usage`)).status).toBe(404);
});

test("both routes sit behind the bearer-token gate", async () => {
  const id = await newTask();
  const r = newRun(id, 4_000);
  const bare = (p: string) => fetch(`${BASE}${p}`);
  expect((await bare(`/runs/${r.id}/usage`)).status).toBe(401);
  expect((await bare(`/tasks/${id}/usage`)).status).toBe(401);
  const wrong = (p: string) => fetch(`${BASE}${p}`, { headers: { authorization: "Bearer nope" } });
  expect((await wrong(`/tasks/${id}/usage`)).status).toBe(401);
});
