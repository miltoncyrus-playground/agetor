import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BranchNamingConfig } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-projects-db-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let projects: typeof import("./db.ts").projects;

beforeAll(async () => {
  ({ projects } = await import("./db.ts"));
});

test("rename changes the name and leaves branchConfig untouched", () => {
  const p = "/tmp/agetor-projects-db-rename";
  projects.upsert(p, "original");
  const config: BranchNamingConfig = {
    includeSlug: false,
    rules: { task: { prefix: "features/" }, bug: { prefix: "hotfix/" }, spike: { prefix: "poc/" } },
  };
  projects.setBranchConfig(p, config);

  const updated = projects.rename(p, "renamed");
  expect(updated).not.toBeNull();
  expect(updated!.name).toBe("renamed");
  // Config survives the rename — UPDATE only touches the name column.
  expect(updated!.branchConfig?.rules.task.prefix).toBe("features/");
  expect(projects.get(p)?.name).toBe("renamed");
  expect(projects.get(p)?.branchConfig?.includeSlug).toBe(false);
});

test("rename on an unknown path returns null", () => {
  expect(projects.rename("/definitely/not/registered", "x")).toBeNull();
});

test("upsert re-call keeps the original name (why rename is needed)", () => {
  const p = "/tmp/agetor-projects-db-upsert";
  projects.upsert(p, "first");
  // ON CONFLICT only bumps added_at — the name arg is ignored on re-upsert.
  projects.upsert(p, "second");
  expect(projects.get(p)?.name).toBe("first");
});
