// Shared by routes/keys.ts and routes/keys-demo.ts. Kept out of both so the
// alias can point one way: keys.ts imports the handler from keys-demo.ts, and
// a constant living in keys.ts would have closed that into a cycle.

/** The version recorded against every key we issue. MUST equal
 *  DATA_TERMS_VERSION in v3/lib/config/data-pricing.ts — the text actually
 *  published at /{locale}/api/terms (T73). Bump BOTH, in the same delivery.
 *
 *  "Bump both together" was already written here and it still did not happen:
 *  v3 moved to 2026-10-06-v2 on 2026-10-06 (T119, the A12 governing-language
 *  clause) and this line stayed on 2026-10-02-v1 for two days. The consequence
 *  is not cosmetic and is not repairable after the fact — a key issued in that
 *  window recorded v1 while the requester had just clicked through v2. No key
 *  in existence records 2026-10-06-v2 at all; this constant skipped it.
 *
 *  A unit test cannot catch this: the other constant is in another repo and
 *  this one's tests never see it. The guard that can is
 *  specs/tools/check-terms-version.sh in the specs repo, which reads both
 *  working copies and is run by specs/tools/enqueue-delivery.sh — so a branch
 *  touching either constant cannot reach the deploy queue while they diverge.
 *
 *  Version history lives in ONE place, v3/lib/config/data-pricing.ts, and is
 *  appended to, never rewritten. (T167, D-01, owner 2026-10-08.)
 *
 *  2026-10-08-v4: the published text changed — the ban on training,
 *  fine-tuning, evaluating or benchmarking ML/AI models is gone from A5 and
 *  B4, in all 20 locales (T178, owner decision 2026-10-08). A prohibition we
 *  cannot observe is worse than none: once the export sits on the customer's
 *  disk nothing tells us what was trained on it. The competing-product and
 *  resale bans stay, and they still cover the case that matters. Paired branch
 *  in v3: fix/t178-drop-ml-training-clause.
 *
 *  2026-10-10-v5: the published text changed again — clause A3 said the MCP
 *  server "requires an API key like the REST API, and counts against the same
 *  quota". Both halves were false here, in this repo: src/index.ts serves /mcp
 *  to a caller with NO key at all (the anonymous demo, T111 D9), metered by
 *  ANON_DEMO_PER_MINUTE per hashed IP in src/lib/quota.ts rather than against
 *  any key's quota; and sourceFor() in src/lib/mcp-source.ts returns the demo
 *  source for EVERY caller, so a key does not widen what /mcp serves. The
 *  sentence was a leftover from before the demo tier and survived T111, T167
 *  and T178. On 2026-10-08 twenty individual emails (D-05) promised the
 *  opposite in writing. The terms now say what this code does. Paired branch
 *  in v3: fix/t192-terms-mcp-no-key. */
export const TOS_VERSION = "2026-10-10-v5";

/** "clearfly.co.uk" is a fine answer, so a missing scheme is added rather than
 *  refused. What must hold: http(s), a dotted hostname, nothing else. Returns
 *  the normalised URL or null. */
export function normaliseWebsite(raw: string): string | null {
  if (!raw || /\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(u.hostname)) return null;
  return `${u.protocol}//${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
}
