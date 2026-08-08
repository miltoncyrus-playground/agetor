import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// POST /tasks allow-list: parentTaskId/planSubtaskId/childMergeStatus are
// real Task fields (unlike `pipeline`), so an external caller could
// otherwise fabricate a parent/child link through the public create route.
// server.ts strips them from the request body before calling createTask —
// this is the only thing standing between "child linking is orchestrator-
// only" and "any API caller can forge it".
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-prebuilder-server-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4468";
const PORT = 4468;

let server: { stop: () => void };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => server?.stop?.());

const auth = () => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});
const u = (p: string) => `http://127.0.0.1:${PORT}${p}`;

test("POST /tasks silently strips parentTaskId/planSubtaskId/childMergeStatus from the body", async () => {
  const res = await fetch(u("/tasks"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      title: "forged child",
      prompt: "x",
      workdir: "/tmp",
      isolation: "none",
      parentTaskId: "some-other-task-id",
      planSubtaskId: "fake-subtask",
      childMergeStatus: "merged",
    }),
  });
  expect(res.status).toBe(200);
  const task = await res.json();
  expect(task.parentTaskId).toBeNull();
  expect(task.planSubtaskId).toBeNull();
  expect(task.childMergeStatus).toBeNull();
});
