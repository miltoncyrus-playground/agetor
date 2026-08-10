import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Project } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-projects-crud-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Distinct from project-settings-endpoint.test.ts's 4401 so a parallel run
// of the two suites never collides on the port.
process.env.AGETOR_API_PORT = "4402";

let server: { stop: () => void; port: number };
let token: string;
let projects: typeof import("./db.ts").projects;

beforeAll(async () => {
  ({ projects } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const url = (p: string) => `http://127.0.0.1:4402${p}`;
const auth = () => ({ authorization: `Bearer ${token}` });
const jsonHeaders = () => ({ ...auth(), "content-type": "application/json" });

test("POST /projects with an absolute existing path registers it", async () => {
  // DATA_DIR itself exists on disk, so it passes the existsSync gate.
  const res = await fetch(url("/projects"), {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ path: DATA_DIR, name: "crud-project" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Project;
  expect(body.path).toBe(DATA_DIR);
  expect(body.name).toBe("crud-project");
  expect(projects.get(DATA_DIR)?.name).toBe("crud-project");
});

test("POST /projects with a relative path is 400", async () => {
  const res = await fetch(url("/projects"), {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ path: "relative/path" }),
  });
  expect(res.status).toBe(400);
});

test("POST /projects with a non-existent path is 404", async () => {
  const res = await fetch(url("/projects"), {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ path: "/definitely/not/on/disk/agetor-xyz" }),
  });
  expect(res.status).toBe(404);
});

test("PATCH /projects renames a registered project", async () => {
  const res = await fetch(url("/projects"), {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify({ path: DATA_DIR, name: "renamed-crud" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Project;
  expect(body.name).toBe("renamed-crud");
  expect(projects.get(DATA_DIR)?.name).toBe("renamed-crud");
});

test("PATCH /projects with an empty name is 400", async () => {
  const res = await fetch(url("/projects"), {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify({ path: DATA_DIR, name: "   " }),
  });
  expect(res.status).toBe(400);
});

test("PATCH /projects for an unregistered path is 404", async () => {
  const res = await fetch(url("/projects"), {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify({ path: "/not/registered/at/all", name: "x" }),
  });
  expect(res.status).toBe(404);
});

test("DELETE /projects removes the project", async () => {
  const res = await fetch(url("/projects"), {
    method: "DELETE",
    headers: jsonHeaders(),
    body: JSON.stringify({ path: DATA_DIR }),
  });
  expect(res.status).toBe(204);
  expect(projects.get(DATA_DIR)).toBeNull();
});
