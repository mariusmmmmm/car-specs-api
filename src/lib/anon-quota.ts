// Per-IP limits for unauthenticated MCP access. Per
// BIZ-L2b-mcp-apify-distribution.md §1: "free tier works
// unauthenticated-but-throttled for discovery" — no API key required for MCP
// tool calls in Phase 1. Per-key MCP auth parity with REST is a fast-follow,
// not required for the MVP.
//
// The per-minute cap alone still allowed ~28,800 requests per IP per day with
// no ceiling, i.e. the whole catalogue in a few days from one machine. The
// monthly cap (T73, owner decision 2026-10-02) keeps MCP open for discovery —
// measured 2026-10-02: the busiest IP made 262 tool calls in 90 days — while
// closing it as an extraction route. Counted per HTTP request, so protocol
// messages (initialize, tools/list) count too.
export const ANON_PER_MINUTE = 20;
export const ANON_PER_MONTH = 1000;

export type AnonLimit = { ok: true } | { ok: false; reason: "minute" | "month" };

function monthBucket(d = new Date()): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function checkAnonRate(kv: KVNamespace, ip: string): Promise<AnonLimit> {
  const minuteKey = `mcp-anon:${ip}:${Math.floor(Date.now() / 60_000)}`;
  const monthKey = `mcp-anon-m:${ip}:${monthBucket()}`;
  const [minuteRaw, monthRaw] = await Promise.all([kv.get(minuteKey), kv.get(monthKey)]);
  const minuteUsed = Number(minuteRaw ?? 0);
  const monthUsed = Number(monthRaw ?? 0);
  if (monthUsed >= ANON_PER_MONTH) return { ok: false, reason: "month" };
  if (minuteUsed >= ANON_PER_MINUTE) return { ok: false, reason: "minute" };
  // Fail OPEN on KV put failure (e.g. free-tier daily put cap → 429): let the
  // MCP call through rather than 500 the server. Limits resume when KV writes
  // recover. See quota.ts for the same rationale.
  try {
    await Promise.all([
      kv.put(minuteKey, String(minuteUsed + 1), { expirationTtl: 70 }),
      kv.put(monthKey, String(monthUsed + 1), { expirationTtl: 60 * 60 * 24 * 35 }),
    ]);
  } catch (e) {
    console.error("anon-rate KV put failed — allowing:", e);
  }
  return { ok: true };
}
