import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { AccountUsageSummary } from "../shared/types.ts";

/**
 * Live limit utilization (5-hour / weekly) for a Claude account — the SDD's
 * "plane B", opt-in per harness via `Harness.quotaEnabled`.
 *
 * Endpoint verified empirically 2026-08-14 against both real accounts on
 * this machine (not inferred from docs): `GET
 * https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer
 * <accessToken from <configDir>/.credentials.json>` and `anthropic-beta:
 * oauth-2025-04-20` returns `{ five_hour: { utilization, resets_at },
 * seven_day: { utilization, resets_at }, limits: [...], ... }` with
 * utilization as a 0–100 number. The endpoint is UNOFFICIAL: everything is
 * parsed through a strict validator and any drift degrades to
 * `{ quota: null, reason }` — never a throw into the `/harnesses` route.
 *
 * Token hygiene (the terms of the user's opt-in): the access token is read
 * from disk at request time, held only in a local variable, sent only to
 * api.anthropic.com, and never persisted, logged, cached, or included in a
 * reason string.
 */

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const FETCH_TIMEOUT_MS = 5_000;
/** Successful responses are fresh enough for a minute; failures retry
 *  sooner but still shield the endpoint from the 15s `/harnesses` poll. */
const TTL_OK_MS = 60_000;
const TTL_ERR_MS = 30_000;

export type Quota = NonNullable<AccountUsageSummary["quota"]>;
export interface QuotaResult {
  quota: Quota | null;
  /** User-facing reason when quota is null. Never contains the token. */
  reason: string | null;
}

const cache = new Map<string, { at: number; result: QuotaResult }>();

/** Test hook — the cache is module state. */
export function _resetQuotaCache(): void {
  cache.clear();
}

/**
 * Read the account's access token. Returns a reason instead of a token when
 * the account can't be queried — the distinction between "never logged in"
 * and "login expired" is what the Settings hint renders.
 */
export function readAccessToken(
  configDir: string,
  nowMs = Date.now(),
): { token: string | null; reason: string | null } {
  let raw: string;
  try {
    raw = readFileSync(path.join(configDir, ".credentials.json"), "utf8");
  } catch {
    return { token: null, reason: "no credentials — run /login for this account" };
  }
  let oauth: any;
  try { oauth = JSON.parse(raw)?.claudeAiOauth; } catch { oauth = null; }
  const token = typeof oauth?.accessToken === "string" && oauth.accessToken ? oauth.accessToken : null;
  if (!token) return { token: null, reason: "credentials unreadable — run /login for this account" };
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < nowMs) {
    // The claude CLI refreshes this token whenever it runs; agetor
    // deliberately never writes credentials, so an expired token is the
    // user's cue to open the account's shell and /login (or just run claude).
    return { token: null, reason: "login expired — run claude (or /login) for this account" };
  }
  return { token, reason: null };
}

/** One window's `{ utilization, resets_at }` block, strictly validated. */
function parseWindow(v: unknown): { pct: number; resetsAt: string | null } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.utilization !== "number" || !Number.isFinite(o.utilization)) return null;
  return {
    pct: o.utilization,
    resetsAt: typeof o.resets_at === "string" ? o.resets_at : null,
  };
}

/**
 * Strict parse of the usage endpoint's body into agetor's quota shape.
 * Exported for the gate tests (recorded real fixture + drift cases).
 * Returns null on any shape mismatch — the caller reports "unavailable".
 */
export function parseQuotaResponse(body: unknown): Quota | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const fiveHour = parseWindow(o.five_hour);
  const sevenDay = parseWindow(o.seven_day);
  if (!fiveHour || !sevenDay) return null;
  return {
    fiveHourPct: fiveHour.pct,
    weeklyPct: sevenDay.pct,
    resetsAt: fiveHour.resetsAt,
  };
}

/**
 * Fetch (with TTL cache) the live quota for one account. Never throws.
 * `fetchImpl`/`nowMs` are injectable for the gate tests.
 */
export async function fetchQuota(
  configDir: string,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<QuotaResult> {
  const hit = cache.get(configDir);
  if (hit && nowMs - hit.at < (hit.result.quota ? TTL_OK_MS : TTL_ERR_MS)) {
    return hit.result;
  }
  const result = await fetchQuotaUncached(configDir, fetchImpl, nowMs);
  cache.set(configDir, { at: nowMs, result });
  return result;
}

async function fetchQuotaUncached(
  configDir: string,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<QuotaResult> {
  const { token, reason } = readAccessToken(configDir, nowMs);
  if (!token) return { quota: null, reason };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(USAGE_ENDPOINT, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "anthropic-beta": OAUTH_BETA_HEADER,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      return { quota: null, reason: "re-login needed — run claude (or /login) for this account" };
    }
    if (!res.ok) {
      return { quota: null, reason: `quota unavailable (HTTP ${res.status})` };
    }
    const body = await res.json().catch(() => null);
    // Verified against a real enterprise-plan account: the endpoint answers
    // 200 with `five_hour: null, seven_day: null, limits: []` — the account
    // simply has no rate-limit windows to report. A legitimate state, not
    // shape drift; say so instead of "unexpected response shape".
    if (body && typeof body === "object"
      && (body as Record<string, unknown>).five_hour === null
      && (body as Record<string, unknown>).seven_day === null) {
      return { quota: null, reason: "this account reports no usage limits (enterprise/team plan)" };
    }
    const quota = parseQuotaResponse(body);
    return quota
      ? { quota, reason: null }
      : { quota: null, reason: "quota unavailable (unexpected response shape)" };
  } catch {
    // Timeout, DNS, offline — degrade quietly; the tokens-only view stands.
    return { quota: null, reason: "quota unavailable (network)" };
  }
}
