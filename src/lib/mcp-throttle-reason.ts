// How a refusal at the /mcp door is COUNTED (blob2 of an `mcp-throttled`
// datapoint). Lives here rather than inline in src/index.ts for the reason
// lib/mcp-method-gate.ts gives about itself: index.ts imports agents/mcp, which
// imports from `cloudflare:workers`, so Node's ESM loader refuses it outside
// workerd and no test can reach it. A rule that cannot be tested is a rule that
// drifts — and this one drifted on the anonymous branch for a month.
//
// MEASURED 2026-11-03 (T1132), the 7 days to that date: 811 refusals against
// 109 served calls, every one of them labelled "quota", i.e. as the caller
// taking more than their share. Two different things were wearing that label:
//
//   * our own 503, when the counter could not be read or written. At most 8 of
//     the 811 — the KV namespace logged 6 write-429 and 2 write-500 across
//     142.850 operations in 9 days (kvOperationsAdaptiveGroups).
//   * ~803 callers hitting ANON_DEMO_PER_MINUTE, a ceiling they are allowed to
//     hit, which has nothing to do with a key's quota because they have no key.
//
// Read as one number they said "four callers are hammering us", and the first
// person to read it went looking for an attacker that does not exist — the
// exact failure lib/usage.ts predicted in writing when it added "unavailable".

/** blob2 on an `mcp-throttled` datapoint. */
export type ThrottleReason = "unauthorized" | "quota" | "anon-rate" | "unavailable";

/** The anonymous demo door (no key presented) — checkAnonDemoRate's verdict.
 *  "metering" is OUR failure and answers 503; "rate" is the per-minute ceiling
 *  and answers 429. They must not share a label. */
export function anonThrottleReason(reason: "rate" | "metering"): ThrottleReason {
  return reason === "rate" ? "anon-rate" : "unavailable";
}

/** The keyed door — the status authenticate() chose. 429 is the key's own
 *  quota, 503 is our metering, everything else is the key itself. */
export function keyedThrottleReason(status: 401 | 403 | 429 | 503): ThrottleReason {
  return status === 429 ? "quota" : status === 503 ? "unavailable" : "unauthorized";
}
