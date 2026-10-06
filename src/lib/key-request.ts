// Shared by routes/keys.ts and routes/keys-demo.ts. Kept out of both so the
// alias can point one way: keys.ts imports the handler from keys-demo.ts, and
// a constant living in keys.ts would have closed that into a cycle.

/** Must match DATA_TERMS_VERSION in v3/lib/config/data-pricing.ts — the
 *  published text at /en/api/terms (T73). Bump both together. */
export const TOS_VERSION = "2026-10-02-v1";

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
