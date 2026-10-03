export type Plan = "free" | "apify";

// Apify usage is metered/billed through Apify's own pay-per-event platform
// (BIZ-L2b §2), not our Free-tier quota — this cap exists only as a backstop
// against a bug/runaway loop, not as the real limit on legitimate usage.
//
// `daily` added 2026-10-03 (T79). The monthly cap alone says how MUCH a key
// may take, never how FAST. On 30–31 August, 139 keys minted on temp-mail
// addresses pulled 109.969 calls in two days — and every single one of them
// stayed INSIDE its monthly cap (the highest was 987 of 1000). The cap was not
// bypassed; it was simply irrelevant at that time scale. A daily ceiling makes
// a key take a week to drain its month, which is the difference between an
// abusive key being noticed and an abusive key being finished.
//
// 200/day for free = a fifth of the month in one day. Chosen to leave an
// integration test or a day of real development completely untouched: measured
// legitimate traffic is ~225 calls/day ACROSS THE WHOLE API, and the busiest
// legitimate day on record is 1.245 REST calls spread over all keys.
const QUOTAS: Record<Plan, { monthly: number; daily: number; perMinute: number }> = {
  free: { monthly: 1000, daily: 200, perMinute: 20 },
  apify: { monthly: 100_000, daily: 10_000, perMinute: 120 },
};

function monthBucket(d = new Date()): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dayBucket(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function minuteBucket(d = new Date()): number {
  return Math.floor(d.getTime() / 60_000);
}

export function resetsAt(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

export type QuotaResult =
  | { ok: true; used: number; quota: number }
  | { ok: false; reason: "quota" | "daily" | "rate" | "metering"; used: number; quota: number };

// Non-atomic get-then-put: acceptable for a KV-backed scaffold per BIZ-L2a §3
// ("keys/rate-limit ... in Workers KV") — under heavy concurrent bursts this
// can slightly overcount past the limit. A Durable Object would give exact
// counting. Measured against the worst day on record it was never the weak
// point: KV absorbed 133.548 writes in a day without a miss, and no key
// exceeded its cap. The weak point was that a failed write served the request
// anyway — see below.
export async function checkAndConsume(kv: KVNamespace, keyHash: string, plan: Plan): Promise<QuotaResult> {
  const { monthly, daily, perMinute } = QUOTAS[plan];
  const monthlyKey = `usage:${keyHash}:${monthBucket()}`;
  const dailyKey = `daily:${keyHash}:${dayBucket()}`;
  const minuteKey = `rl:${keyHash}:${minuteBucket()}`;

  let monthlyUsed: number, dailyUsed: number, minuteUsed: number;
  try {
    const [m, d, r] = await Promise.all([kv.get(monthlyKey), kv.get(dailyKey), kv.get(minuteKey)]);
    monthlyUsed = Number(m ?? 0);
    dailyUsed = Number(d ?? 0);
    minuteUsed = Number(r ?? 0);
  } catch (e) {
    // A read we cannot do is a count we do not have. Same rule as the write
    // below: refuse rather than guess.
    console.error("metering KV get failed — refusing:", e);
    return { ok: false, reason: "metering", used: 0, quota: monthly };
  }

  if (monthlyUsed >= monthly) {
    return { ok: false, reason: "quota", used: monthlyUsed, quota: monthly };
  }
  if (dailyUsed >= daily) {
    return { ok: false, reason: "daily", used: monthlyUsed, quota: monthly };
  }
  if (minuteUsed >= perMinute) {
    return { ok: false, reason: "rate", used: monthlyUsed, quota: monthly };
  }

  // FAIL CLOSED (T79, 2026-10-03). This used to swallow the error and serve
  // the request unmetered, which was added during incident 889ca1e to stop the
  // Workers KV FREE-tier daily put cap (1000/day) from 500-ing the whole API.
  //
  // That reason expired on 2026-07-27, when the account moved to Workers Paid:
  // the trigger it was protecting against cannot fire any more. What stayed
  // was a door that opens by itself precisely when something is wrong — a key
  // over its quota is served, and nothing records that it was.
  //
  // So: if we cannot count it, we do not serve it. 503 with Retry-After, not
  // 429 — this is our failure, not the caller's, and the distinction matters
  // to anyone writing a client against us. At ~225 calls/day of real traffic
  // (1,3% of the paid allowance) a KV outage reaching a caller at all is
  // already unlikely; being briefly unavailable is cheaper than being silently
  // unmetered.
  try {
    await Promise.all([
      kv.put(monthlyKey, String(monthlyUsed + 1), { expirationTtl: 60 * 60 * 24 * 35 }),
      kv.put(dailyKey, String(dailyUsed + 1), { expirationTtl: 60 * 60 * 36 }),
      kv.put(minuteKey, String(minuteUsed + 1), { expirationTtl: 70 }),
    ]);
  } catch (e) {
    console.error("metering KV put failed — refusing the request:", e);
    return { ok: false, reason: "metering", used: monthlyUsed, quota: monthly };
  }

  return { ok: true, used: monthlyUsed + 1, quota: monthly };
}

export async function currentUsage(kv: KVNamespace, keyHash: string, plan: Plan): Promise<{ used: number; quota: number }> {
  const raw = await kv.get(`usage:${keyHash}:${monthBucket()}`);
  return { used: Number(raw ?? 0), quota: QUOTAS[plan].monthly };
}

/** Exposed for the tests and for /v1/usage, so the published caps have one source. */
export const PLAN_QUOTAS = QUOTAS;
