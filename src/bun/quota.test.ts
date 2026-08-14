import { beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set AGETOR_DATA_DIR BEFORE importing anything that reaches db.ts (the
// setQuotaEnabled tests below import the harness store).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-quota-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let mod: typeof import("./quota.ts");
let dbMod: typeof import("./db.ts");
beforeAll(async () => {
  mod = await import("./quota.ts");
  dbMod = await import("./db.ts");
});
beforeEach(() => mod._resetQuotaCache());

const NOW = 1_700_000_000_000;

/** Recorded from the real endpoint on 2026-08-14 (trimmed to the fields the
 *  parser reads plus representative noise it must ignore). */
const REAL_RESPONSE = {
  five_hour: { utilization: 100.0, resets_at: "2026-08-14T23:00:00.371765+00:00", limit_dollars: null },
  seven_day: { utilization: 49.0, resets_at: "2026-08-18T02:00:00.371783+00:00", limit_dollars: null },
  seven_day_opus: null,
  nimbus_quill: { utilization: 0.0, resets_at: null },
  extra_usage: { is_enabled: true, used_credits: 18134.0 },
  limits: [{ kind: "session", percent: 100, severity: "critical" }],
};

function makeConfigDir(creds?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-quota-cfg-"));
  if (creds !== undefined) {
    writeFileSync(path.join(dir, ".credentials.json"), typeof creds === "string" ? creds : JSON.stringify(creds));
  }
  return dir;
}

const VALID_CREDS = { claudeAiOauth: { accessToken: "sk-ant-oat-TEST", expiresAt: NOW + 3_600_000 } };

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: any, init?: any) => Promise.resolve(handler(String(url), init))) as typeof fetch;
}

// --- parseQuotaResponse ---------------------------------------------------------

test("parseQuotaResponse extracts the two windows from the real recorded shape", () => {
  expect(mod.parseQuotaResponse(REAL_RESPONSE)).toEqual({
    fiveHourPct: 100,
    weeklyPct: 49,
    resetsAt: "2026-08-14T23:00:00.371765+00:00",
  });
});

test("parseQuotaResponse rejects shape drift instead of guessing", () => {
  expect(mod.parseQuotaResponse(null)).toBeNull();
  expect(mod.parseQuotaResponse("nope")).toBeNull();
  expect(mod.parseQuotaResponse({})).toBeNull();
  expect(mod.parseQuotaResponse({ five_hour: { utilization: 10 } })).toBeNull(); // seven_day missing
  expect(mod.parseQuotaResponse({ five_hour: { utilization: "10" }, seven_day: { utilization: 5 } })).toBeNull();
  expect(mod.parseQuotaResponse({ five_hour: { utilization: NaN }, seven_day: { utilization: 5 } })).toBeNull();
});

// --- readAccessToken ------------------------------------------------------------

test("readAccessToken distinguishes missing, malformed, expired, and valid credentials", () => {
  expect(mod.readAccessToken(makeConfigDir(), NOW)).toEqual({
    token: null,
    reason: "no credentials — run /login for this account",
  });
  expect(mod.readAccessToken(makeConfigDir("{broken"), NOW).token).toBeNull();
  const expired = makeConfigDir({ claudeAiOauth: { accessToken: "sk-ant-oat-OLD", expiresAt: NOW - 1 } });
  expect(mod.readAccessToken(expired, NOW).reason).toContain("login expired");
  const ok = makeConfigDir(VALID_CREDS);
  expect(mod.readAccessToken(ok, NOW)).toEqual({ token: "sk-ant-oat-TEST", reason: null });
});

// --- fetchQuota -----------------------------------------------------------------

test("fetchQuota happy path: bearer auth + beta header, parsed quota, no reason", async () => {
  const dir = makeConfigDir(VALID_CREDS);
  let seenAuth: string | undefined, seenBeta: string | undefined;
  const result = await mod.fetchQuota(dir, fakeFetch((_url, init) => {
    const h = init?.headers as Record<string, string>;
    seenAuth = h["Authorization"];
    seenBeta = h["anthropic-beta"];
    return new Response(JSON.stringify(REAL_RESPONSE), { status: 200 });
  }), NOW);
  expect(seenAuth).toBe("Bearer sk-ant-oat-TEST");
  expect(seenBeta).toBe("oauth-2025-04-20");
  expect(result.quota?.fiveHourPct).toBe(100);
  expect(result.reason).toBeNull();
});

test("fetchQuota degrades: 401 → re-login, 500 → unavailable, drift → unavailable, throw → network", async () => {
  const dir = makeConfigDir(VALID_CREDS);
  const cases: [typeof fetch, string][] = [
    [fakeFetch(() => new Response("", { status: 401 })), "re-login needed"],
    [fakeFetch(() => new Response("", { status: 500 })), "HTTP 500"],
    [fakeFetch(() => new Response(JSON.stringify({ surprise: true }), { status: 200 })), "unexpected response shape"],
    [(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch, "network"],
  ];
  for (const [impl, expected] of cases) {
    mod._resetQuotaCache();
    const r = await mod.fetchQuota(dir, impl, NOW);
    expect(r.quota).toBeNull();
    expect(r.reason).toContain(expected);
  }
});

test("fetchQuota maps an enterprise account's null windows to an honest reason", async () => {
  // Recorded from a real enterprise-plan account on 2026-08-14: 200 with no
  // rate-limit windows at all. Must NOT be reported as shape drift.
  const dir = makeConfigDir(VALID_CREDS);
  const r = await mod.fetchQuota(dir, fakeFetch(() =>
    new Response(JSON.stringify({ five_hour: null, seven_day: null, seven_day_opus: null, limits: [] }), { status: 200 }),
  ), NOW);
  expect(r.quota).toBeNull();
  expect(r.reason).toContain("no usage limits");
});

test("fetchQuota reason strings never leak the token", async () => {
  const dir = makeConfigDir(VALID_CREDS);
  for (const impl of [
    fakeFetch(() => new Response("", { status: 401 })),
    (() => Promise.reject(new Error("boom sk-ant-oat-TEST"))) as unknown as typeof fetch,
  ]) {
    mod._resetQuotaCache();
    const r = await mod.fetchQuota(dir, impl, NOW);
    expect(JSON.stringify(r)).not.toContain("sk-ant-oat-TEST");
  }
});

test("fetchQuota caches successes for 60s and failures for 30s", async () => {
  const dir = makeConfigDir(VALID_CREDS);
  let calls = 0;
  const ok = fakeFetch(() => { calls++; return new Response(JSON.stringify(REAL_RESPONSE), { status: 200 }); });
  await mod.fetchQuota(dir, ok, NOW);
  await mod.fetchQuota(dir, ok, NOW + 59_000);
  expect(calls).toBe(1);
  await mod.fetchQuota(dir, ok, NOW + 61_000);
  expect(calls).toBe(2);

  mod._resetQuotaCache();
  calls = 0;
  const bad = fakeFetch(() => { calls++; return new Response("", { status: 500 }); });
  await mod.fetchQuota(dir, bad, NOW);
  await mod.fetchQuota(dir, bad, NOW + 29_000);
  expect(calls).toBe(1);
  await mod.fetchQuota(dir, bad, NOW + 31_000);
  expect(calls).toBe(2);
});

test("fetchQuota with no credentials never touches the network", async () => {
  const dir = makeConfigDir();
  let calls = 0;
  const r = await mod.fetchQuota(dir, fakeFetch(() => { calls++; return new Response("{}"); }), NOW);
  expect(calls).toBe(0);
  expect(r.quota).toBeNull();
  expect(r.reason).toContain("no credentials");
});

// --- harnesses.setQuotaEnabled ---------------------------------------------------

test("setQuotaEnabled roundtrips and works on the built-in (same carve-out as enabled)", () => {
  const builtin = dbMod.harnesses.get("claude-code");
  expect(builtin).not.toBeNull();
  expect(builtin!.quotaEnabled).toBe(false); // off by default — the opt-in contract
  const on = dbMod.harnesses.setQuotaEnabled("claude-code", true);
  expect(on.quotaEnabled).toBe(true);
  const off = dbMod.harnesses.setQuotaEnabled("claude-code", false);
  expect(off.quotaEnabled).toBe(false);
});
