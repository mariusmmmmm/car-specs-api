// Usage observability (BIZ-D7 §5). One Analytics Engine datapoint per MCP tool
// call, REST request and anon-429. Shape is fixed so scripts/usage-report.mjs
// can query it by column:
//   blob1 = surface     ("mcp" | "rest" | "mcp-throttled")
//   blob2 = tool/route  (tool name, or matched REST route pattern)
//   blob3 = locale
//   blob4 = client/plan (MCP clientInfo.name, or REST plan free|apify)
//   blob5 = actor       (salted IP hash for MCP, or key-hash prefix for REST)
//   double1 = 1         (one call; SUM(_sample_interval) reconstructs true count)
import type { Env } from "../types";

const IP_HASH_LEN = 12; // first 12 hex chars of SHA-256(ip + salt)
const FALLBACK_SALT = "cd-usage-v1"; // used only if the IP_HASH_SALT secret is unset

/** Salted, truncated hash of a client IP. Raw IPs are never stored (GDPR) —
 *  this is enough for the concentration analysis (top-N, distinct counts) the
 *  §4 tripwires need. */
export async function ipHash(ip: string, salt: string | undefined): Promise<string> {
  const data = new TextEncoder().encode(`${salt ?? FALLBACK_SALT}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, IP_HASH_LEN);
}

// writeDataPoint is synchronous and non-blocking. Guard the binding (absent in
// some local setups) and never let telemetry throw into a request path.
function write(env: Env, blobs: (string | null)[]): void {
  try {
    env.USAGE?.writeDataPoint({ blobs, doubles: [1] });
  } catch {
    /* telemetry must never break a request */
  }
}

export function recordMcpCall(env: Env, tool: string, locale: string, client: string, actor: string): void {
  write(env, ["mcp", tool || "-", locale || "-", client || "-", actor || "-"]);
}

export function recordRestCall(env: Env, route: string, locale: string, plan: string, keyPrefix: string): void {
  write(env, ["rest", route || "-", locale || "-", plan || "-", keyPrefix || "-"]);
}

/** blob2 = which limit tripped ("minute" | "month"), so the report can tell
 *  a burst from an IP that used up its month. */
export function recordMcpThrottled(env: Env, actor: string, reason: "minute" | "month" = "minute"): void {
  write(env, ["mcp-throttled", reason, "-", "-", actor || "-"]);
}
