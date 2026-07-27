export type Plan = "free" | "apify";

// Apify usage is metered/billed through Apify's own pay-per-event platform
// (BIZ-L2b §2), not our Free-tier quota — this cap exists only as a backstop
// against a bug/runaway loop, not as the real limit on legitimate usage.
const QUOTAS: Record<Plan, { monthly: number; perMinute: number }> = {
  free: { monthly: 1000, perMinute: 20 },
  apify: { monthly: 100_000, perMinute: 120 },
};

function monthBucket(d = new Date()): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function minuteBucket(d = new Date()): number {
  return Math.floor(d.getTime() / 60_000);
}

export function resetsAt(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

export type QuotaResult =
  | { ok: true; used: number; quota: number }
  | { ok: false; reason: "quota" | "rate"; used: number; quota: number };

// Non-atomic get-then-put: acceptable for a Phase 1 KV-backed scaffold per
// BIZ-L2a §3 ("keys/rate-limit ... in Workers KV") — under heavy concurrent
// bursts this can slightly overcount past the limit. A Durable Object would
// give exact counting; not needed at Free-tier launch volume.
export async function checkAndConsume(kv: KVNamespace, keyHash: string, plan: Plan): Promise<QuotaResult> {
  const { monthly, perMinute } = QUOTAS[plan];
  const monthlyKey = `usage:${keyHash}:${monthBucket()}`;
  const minuteKey = `rl:${keyHash}:${minuteBucket()}`;

  const [monthlyRaw, minuteRaw] = await Promise.all([kv.get(monthlyKey), kv.get(minuteKey)]);
  const monthlyUsed = Number(monthlyRaw ?? 0);
  const minuteUsed = Number(minuteRaw ?? 0);

  if (monthlyUsed >= monthly) {
    return { ok: false, reason: "quota", used: monthlyUsed, quota: monthly };
  }
  if (minuteUsed >= perMinute) {
    return { ok: false, reason: "rate", used: monthlyUsed, quota: monthly };
  }

  // KV puts can fail — most notably the Workers KV free-tier daily put cap
  // (1000/day), which returns 429 for the rest of the UTC day. Fail OPEN:
  // serve the request unmetered rather than 500 the whole API. Metering/limits
  // resume automatically when KV writes recover (cap reset, or Workers Paid).
  try {
    await Promise.all([
      kv.put(monthlyKey, String(monthlyUsed + 1), { expirationTtl: 60 * 60 * 24 * 35 }),
      kv.put(minuteKey, String(minuteUsed + 1), { expirationTtl: 70 }),
    ]);
  } catch (e) {
    console.error("metering KV put failed — serving unmetered:", e);
  }

  return { ok: true, used: monthlyUsed + 1, quota: monthly };
}

export async function currentUsage(kv: KVNamespace, keyHash: string, plan: Plan): Promise<{ used: number; quota: number }> {
  const raw = await kv.get(`usage:${keyHash}:${monthBucket()}`);
  return { used: Number(raw ?? 0), quota: QUOTAS[plan].monthly };
}
