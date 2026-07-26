// Per-IP throttle for unauthenticated MCP access. Per
// BIZ-L2b-mcp-apify-distribution.md §1: "free tier works
// unauthenticated-but-throttled for discovery" — no API key required for MCP
// tool calls in Phase 1, but capped hard per IP per minute so it can't
// substitute for a Free key's own (higher, key-scoped) quota. Per-key MCP
// auth parity with REST is a fast-follow, not required for the MVP.
const ANON_PER_MINUTE = 20;

export async function checkAnonRate(kv: KVNamespace, ip: string): Promise<boolean> {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const key = `mcp-anon:${ip}:${minuteBucket}`;
  const used = Number((await kv.get(key)) ?? 0);
  if (used >= ANON_PER_MINUTE) return false;
  await kv.put(key, String(used + 1), { expirationTtl: 70 });
  return true;
}
