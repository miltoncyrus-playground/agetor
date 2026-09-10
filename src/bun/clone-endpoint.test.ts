import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Project, Task } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-clone-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Distinct from other server-test ports so parallel test runs don't fight.
process.env.AGETOR_API_PORT = "4437";
// The auto-created ELI5 task is started for real — route it into the fake
// claude driver so no tmux session or claude binary is involved.
process.env.AGETOR_CLAUDE_DRIVER = "fake";

const BASE = "http://127.0.0.1:4437";

const WORK_DIR = mkdtempSync(path.join(tmpdir(), "agetor-clone-endpoint-work-"));

let server: { stop: () => void };
let token: string;
let tasks: typeof import("./db.ts").tasks;

beforeAll(async () => {
  ({ tasks } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;

  // Local fixture repo standing in for GitHub via AGETOR_CLONE_SOURCE_OVERRIDE.
  const source = path.join(WORK_DIR, "source");
  mkdirSync(source);
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: source, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  };
  git("init", "-q");
  git("config", "user.email", "test@test");
  git("config", "user.name", "test");
  writeFileSync(path.join(source, "README.md"), "# fixture\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  process.env.AGETOR_CLONE_SOURCE_OVERRIDE = source;
});

afterAll(() => {
  delete process.env.AGETOR_CLONE_SOURCE_OVERRIDE;
  server?.stop?.();
  rmSync(WORK_DIR, { recursive: true, force: true });
});

const call = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

test("POST /projects/clone without url returns 400", async () => {
  const res = await call("/projects/clone", { method: "POST", body: "{}" });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("url required");
});

test("POST /projects/clone rejects a non-GitHub url", async () => {
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "https://gitlab.com/foo/bar" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("GitHub");
});

test("POST /projects/clone rejects a relative dest", async () => {
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "foo/bar", dest: "relative/path" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("absolute");
});

test("clone + register + ELI5 task, end to end", async () => {
  const dest = path.join(WORK_DIR, "clone-with-eli5");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/somerepo", dest }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    project: Project;
    eli5TaskId: string | null;
    eli5Error: string | null;
  };

  // The clone really happened.
  expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  expect(existsSync(path.join(dest, ".git"))).toBe(true);

  // The destination is registered as a project, named after the repo.
  expect(body.project.path).toBe(dest);
  expect(body.project.name).toBe("somerepo");
  const listed = (await (await call("/projects")).json()) as Project[];
  expect(listed.some((p) => p.path === dest)).toBe(true);

  // The explainer task exists, targets the clone directly (no worktree), and
  // was started without error.
  expect(body.eli5Error).toBeNull();
  expect(body.eli5TaskId).not.toBeNull();
  const task = tasks.get(body.eli5TaskId!);
  expect(task).not.toBeNull();
  expect(task!.title).toBe("ELI5: somerepo");
  expect(task!.workdir).toBe(dest);
  expect(task!.isolation).toBe("none");
  expect(task!.prompt).toContain("ELI5.md");
  expect(task!.runId).not.toBeNull();
});

test("eli5:false clones and registers without creating a task", async () => {
  const before = tasks.list().length;
  const dest = path.join(WORK_DIR, "clone-no-eli5");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/plainrepo", dest, eli5: false }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    project: Project;
    eli5TaskId: string | null;
    eli5Error: string | null;
  };
  expect(body.eli5TaskId).toBeNull();
  expect(body.eli5Error).toBeNull();
  expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  expect(tasks.list().length).toBe(before);
});

test("a failing clone returns 502 and registers nothing", async () => {
  const dest = path.join(WORK_DIR, "clone-fails");
  // Point the seam at a nonexistent source so git clone fails.
  const prev = process.env.AGETOR_CLONE_SOURCE_OVERRIDE;
  process.env.AGETOR_CLONE_SOURCE_OVERRIDE = path.join(WORK_DIR, "no-such-source");
  try {
    const res = await call("/projects/clone", {
      method: "POST",
      body: JSON.stringify({ url: "someowner/deadrepo", dest }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("clone failed");
    const listed = (await (await call("/projects")).json()) as Project[];
    expect(listed.some((p) => p.path === dest)).toBe(false);
  } finally {
    process.env.AGETOR_CLONE_SOURCE_OVERRIDE = prev;
  }
});

test("route requires auth like every other project route", async () => {
  const res = await fetch(`${BASE}/projects/clone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "foo/bar" }),
  });
  expect(res.status).toBe(401);
});
