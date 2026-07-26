const FREE_MONTHLY_QUOTA = 1000;
const FREE_PER_MINUTE = 30;

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
export async function checkAndConsume(kv: KVNamespace, keyHash: string): Promise<QuotaResult> {
  const monthlyKey = `usage:${keyHash}:${monthBucket()}`;
  const minuteKey = `rl:${keyHash}:${minuteBucket()}`;

  const [monthlyRaw, minuteRaw] = await Promise.all([kv.get(monthlyKey), kv.get(minuteKey)]);
  const monthlyUsed = Number(monthlyRaw ?? 0);
  const minuteUsed = Number(minuteRaw ?? 0);

  if (monthlyUsed >= FREE_MONTHLY_QUOTA) {
    return { ok: false, reason: "quota", used: monthlyUsed, quota: FREE_MONTHLY_QUOTA };
  }
  if (minuteUsed >= FREE_PER_MINUTE) {
    return { ok: false, reason: "rate", used: monthlyUsed, quota: FREE_MONTHLY_QUOTA };
  }

  await Promise.all([
    kv.put(monthlyKey, String(monthlyUsed + 1), { expirationTtl: 60 * 60 * 24 * 35 }),
    kv.put(minuteKey, String(minuteUsed + 1), { expirationTtl: 70 }),
  ]);

  return { ok: true, used: monthlyUsed + 1, quota: FREE_MONTHLY_QUOTA };
}

export async function currentUsage(kv: KVNamespace, keyHash: string): Promise<{ used: number; quota: number }> {
  const raw = await kv.get(`usage:${keyHash}:${monthBucket()}`);
  return { used: Number(raw ?? 0), quota: FREE_MONTHLY_QUOTA };
}
