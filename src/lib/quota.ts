// The plans the API OFFERS. D-01 (owner, 2026-10-08): only DEMO and paid
// exist — `free` is retired and is deliberately not a member here, so no new
// code path can name it without reaching for LegacyPlan on purpose.
export type Plan = "demo" | "apify";

// `free` is RETIRED, not erased — and the difference is a person.
//
// Every path that brings a plan into being now refuses it: /v1/admin/grant
// 400s on it, scripts/keys-admin.mjs will not send it, and generateApiKey has
// no default prefix left to fall back to. Nothing can mint a free key again.
//
// What `free` still has to do is be READ. Production inventory, measured
// 2026-10-08: 185 keys, 182 of them inert free keys now revoked, and exactly
// one APPROVED free key still in use — D-01 §4, a named integrator mid-test
// whom the owner is answering personally. Deleting the string from this file
// would not delete his KV record. It would make the quota lookup below return
// undefined and throw on destructuring, i.e. turn every one of his requests
// into a 500 — a silent outage for the one caller we deliberately kept.
export type LegacyPlan = "free";

/** What a stored KeyRecord's `plan` may say. Wider than `Plan` on purpose:
 *  what we will ISSUE and what we must still SERVE are different sets. */
export type StoredPlan = Plan | LegacyPlan;

const LEGACY_PLANS: ReadonlySet<string> = new Set<LegacyPlan>(["free"]);

/** True for a plan that exists only on already-issued keys. */
export const isLegacyPlan = (plan: string): plan is LegacyPlan => LEGACY_PLANS.has(plan);

// Apify usage is metered/billed through Apify's own pay-per-event platform
// (BIZ-L2b §2) — this cap exists only as a backstop against a bug/runaway
// loop, not as the real limit on legitimate usage.
//
// `daily` added 2026-10-03 (T79). The monthly cap alone says how MUCH a key
// may take, never how FAST. On 30–31 August, 139 keys minted on temp-mail
// addresses pulled 109.969 calls in two days — and every single one of them
// stayed INSIDE its monthly cap (the highest was 987 of 1000). The cap was not
// bypassed; it was simply irrelevant at that time scale. A daily ceiling makes
// a key take a week to drain its month, which is the difference between an
// abusive key being noticed and an abusive key being finished.
//
// `demo` added 2026-10-04 (T111). Its real limit is not here: a demo key can
// only ever resolve the 40 variants in lib/demo-set.ts, served pre-rendered
// from KV, so no number in this table protects the catalogue — the allowlist
// does. What is left for a demo key to protect is the database and our own
// tidiness, so it keeps a minute limit and generous day/month ceilings that a
// real evaluation will never notice.
const QUOTAS: Record<Plan, { monthly: number; daily: number; perMinute: number }> = {
  demo: { monthly: 20_000, daily: 2_000, perMinute: 10 },
  apify: { monthly: 100_000, daily: 10_000, perMinute: 120 },
};

// Not an offer — a floor under keys that already exist. The numbers are
// copied unchanged from the free row as it stood at e8f0330, because the whole
// point is that the one live holder sees no change: 200/day was a fifth of the
// month in one day, chosen to leave an integration test or a full day of real
// development untouched (measured legitimate traffic is ~225 calls/day ACROSS
// THE WHOLE API, and the busiest legitimate day on record is 1.245 REST calls
// spread over all keys).
//
// WHEN THIS GOES: when no usable key is left on the plan. `node
// scripts/keys-admin.mjs keys` is the check — once it prints no ACTIVE row
// whose plan is `free`, delete LegacyPlan, this table, the LEGACY_PLANS set,
// the isLegacyPlan branch in lib/apikey.ts isUsable, and collapse StoredPlan
// back into Plan. Nothing else depends on it.
const LEGACY_QUOTAS: Record<LegacyPlan, { monthly: number; daily: number; perMinute: number }> = {
  free: { monthly: 1000, daily: 200, perMinute: 20 },
};

const ALL_QUOTAS: Record<StoredPlan, { monthly: number; daily: number; perMinute: number }> = {
  ...QUOTAS,
  ...LEGACY_QUOTAS,
};

// The service-wide ceiling on catalogue reads (T111 M1) — the ONLY layer that a
// new credential cannot defeat by existing. Per-key caps provably do not bound
// a GROUP: on 30–31 August 139 keys each stayed inside its own monthly cap and
// together pulled 85–99% of the catalogue. This counter does not care how many
// keys there are, who holds them, or whether the per-key counter is accurate.
//
// 5.000/day = 4,0x the busiest LEGITIMATE day on record (1.245 REST calls
// across every key, 2026-09-16) and 7,5% of 31 August (66.774). At this rate
// the full catalogue costs 21 days of monopolising the entire unlicensed
// budget, and the monopolising is itself the alarm.
//
// Exempt, deliberately:
//   * `demo` — scoped to 40 variants and served from KV, so it cannot spend
//     catalogue exposure. Counting it would let discovery probes exhaust the
//     budget that protects the catalogue, which is backwards.
//   * `apify` — metered and billed by Apify's own platform (BIZ-L2b §2).
//
// Which leaves the legacy `free` plan as the ONLY counted one — and T166 kept
// it that way on purpose, against the first reading of "remove free from
// GLOBAL_COUNTED_PLANS". Both offered plans are exempt, so emptying this set
// would not narrow the ceiling, it would switch it OFF: a live counter with no
// subjects is dead code. And the subject it would lose is precisely the one
// credential left with unbilled full-catalogue reach, which is what T111 M1
// was built for. Counting it is also simply what production does today, and
// "the live key keeps working" means unchanged, not more generous.
export const GLOBAL_DAILY_CATALOGUE_READS = 5_000;
const GLOBAL_COUNTED_PLANS: ReadonlySet<string> = new Set<StoredPlan>(["free"]);

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
  | { ok: false; reason: "quota" | "daily" | "rate" | "metering" | "global"; used: number; quota: number };

// Non-atomic get-then-put, and MEASURED TO LOSE ABOUT HALF ITS INCREMENTS.
//
// The note that stood here until 2026-10-04 said the cap "was never the weak
// point: KV absorbed 133.548 writes in a day without a miss, and no key
// exceeded its cap." That read the wrong number. The 987-of-1000 figure it
// rested on came from Analytics Engine, i.e. TRAFFIC; the enforcement counters
// themselves were read out of KV on 2026-10-04, for 138 of the 139 keys of the
// August extraction, and say something else:
//
//   counters summed          53.952
//   requests actually served >=93.986  (Analytics Engine raw rows, a floor)
//   loss                     >=42,6%   (median 0,526 per key, min 0,410)
//
// The key whose traffic read 987 had a counter of 383. So "1.000/month" is in
// practice 1.350–2.440 served calls, and the factor is not constant, so it
// cannot be compensated by dividing. The same applies to `daily`.
//
// The cap never mattered in August only because nobody came near it: the
// extraction stopped when the CATALOGUE ran out (87.600–102.292 spec reads
// against 103.099 variants), not when a limit bit.
//
// Consequence, and the reason T111 exists: an exact per-key cap needs atomic
// counting (one Durable Object per key — $0 at this volume), and until then the
// layer that actually bounds exposure is the service-wide ceiling below plus
// the demo allowlist, neither of which depends on counting being right.
export async function checkAndConsume(kv: KVNamespace, keyHash: string, plan: StoredPlan): Promise<QuotaResult> {
  // `plan` arrives from JSON.parse of a KV record, so the type is a promise,
  // not a guarantee. Before T166 an unrecognised value destructured undefined
  // and threw a 500; now it refuses, by the same rule as the put below — if
  // we cannot count it, we do not serve it. This is what makes removing a plan
  // name from the offered set a safe operation rather than an outage.
  const limits = ALL_QUOTAS[plan];
  if (!limits) {
    console.error("unknown plan on a stored key — refusing:", plan);
    return { ok: false, reason: "metering", used: 0, quota: 0 };
  }
  const { monthly, daily, perMinute } = limits;
  const monthlyKey = `usage:${keyHash}:${monthBucket()}`;
  const dailyKey = `daily:${keyHash}:${dayBucket()}`;
  const minuteKey = `rl:${keyHash}:${minuteBucket()}`;
  const counted = GLOBAL_COUNTED_PLANS.has(plan);
  const globalKey = `global:${dayBucket()}`;

  let monthlyUsed: number, dailyUsed: number, minuteUsed: number, globalUsed: number;
  try {
    const [m, d, r, g] = await Promise.all([
      kv.get(monthlyKey),
      kv.get(dailyKey),
      kv.get(minuteKey),
      counted ? kv.get(globalKey) : Promise.resolve(null),
    ]);
    monthlyUsed = Number(m ?? 0);
    dailyUsed = Number(d ?? 0);
    minuteUsed = Number(r ?? 0);
    globalUsed = Number(g ?? 0);
  } catch (e) {
    // A read we cannot do is a count we do not have. Same rule as the write
    // below: refuse rather than guess.
    console.error("metering KV get failed — refusing:", e);
    return { ok: false, reason: "metering", used: 0, quota: monthly };
  }

  // The service-wide ceiling is checked FIRST and on purpose: it is the only
  // limit that still means something when every per-key number has been
  // defeated by minting more keys.
  if (counted && globalUsed >= GLOBAL_DAILY_CATALOGUE_READS) {
    return { ok: false, reason: "global", used: globalUsed, quota: GLOBAL_DAILY_CATALOGUE_READS };
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
      ...(counted
        ? [kv.put(globalKey, String(globalUsed + 1), { expirationTtl: 60 * 60 * 36 })]
        : []),
    ]);
  } catch (e) {
    console.error("metering KV put failed — refusing the request:", e);
    return { ok: false, reason: "metering", used: monthlyUsed, quota: monthly };
  }

  return { ok: true, used: monthlyUsed + 1, quota: monthly };
}

export async function currentUsage(kv: KVNamespace, keyHash: string, plan: StoredPlan): Promise<{ used: number; quota: number }> {
  const raw = await kv.get(`usage:${keyHash}:${monthBucket()}`);
  return { used: Number(raw ?? 0), quota: ALL_QUOTAS[plan]?.monthly ?? 0 };
}

/** The OFFERED caps — what may be published, quoted on the site, or granted.
 *  Exposed for the tests and for /v1/usage, so they have one source. */
export const PLAN_QUOTAS = QUOTAS;

/** Every cap a stored key can be metered against, offered or legacy. Use this
 *  only where an already-issued key is being served; never to advertise. */
export const ALL_PLAN_QUOTAS = ALL_QUOTAS;

// ── anonymous demo MCP (T111 D9) ─────────────────────────────────────────────
//
// An anonymous caller reaches only the pre-rendered 40-car blob, so there is no
// catalogue exposure to bound and no monthly quota to keep. What is left to
// protect is this Worker's CPU and KV reads, which a per-IP minute limit
// handles. Fails CLOSED like everything else in this file: if the counter
// cannot be read or written, the request is refused rather than served
// uncounted — the rule that T79 had to come back and fix.
export const ANON_DEMO_PER_MINUTE = 20;

export async function checkAnonDemoRate(
  kv: KVNamespace,
  ipHash: string,
): Promise<{ ok: true } | { ok: false; reason: "rate" | "metering" }> {
  const key = `anon:${ipHash}:${minuteBucket()}`;
  let used: number;
  try {
    used = Number((await kv.get(key)) ?? 0);
  } catch (e) {
    console.error("anon rate KV get failed — refusing:", e);
    return { ok: false, reason: "metering" };
  }
  if (used >= ANON_DEMO_PER_MINUTE) return { ok: false, reason: "rate" };
  try {
    await kv.put(key, String(used + 1), { expirationTtl: 70 });
  } catch (e) {
    console.error("anon rate KV put failed — refusing:", e);
    return { ok: false, reason: "metering" };
  }
  return { ok: true };
}
