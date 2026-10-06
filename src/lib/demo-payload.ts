import type { Env } from "../types";

// The demo tier is served from a pre-rendered blob in KV, one per locale, and
// NEVER from Postgres (T107 §5.0.2).
//
// Three things fall out of that, and the third is the point:
//   * `cars_api_readonly` has CONNECTION LIMIT 10 — the only genuinely scarce
//     resource in the system, and the one implicated in the cold-start 5xx
//     bursts. Demo traffic, which is mostly directory probes, stops touching it.
//   * the per-minute limit on a demo key stops protecting anything real, so it
//     is left only as hygiene.
//   * the scope guarantee stops being a CHECK and becomes an IMPOSSIBILITY: a
//     demo request is never handed a database connection, so there is nothing
//     outside the blob for it to read. An allowlist can be bypassed by a route
//     that forgets to consult it; this cannot.

export type DemoVariant = {
  /** Internal public_id. Never serialised to a client — routes/demo.ts hands
   *  back opaque tokens like every other surface. */
  variant_id: number;
  generation_id: number;
  model_id: number;
  brand: string;
  model: string;
  generation: string;
  display_name: string;
  fuel: string;
  body_type: string | null;
  years: string | null;
  power_hp: number | null;
  battery_kwh: number | null;
  price_new_eur: number | null;
  /** Every spec the variant carries, localised for this blob's locale, in the
   *  EXACT shape localizeVariantSpecs() returns — a record keyed by spec key,
   *  not a list. The first draft used a list, which would have shipped a demo
   *  whose response SHAPE differed from the live API's: a client that worked
   *  against the demo would break on its first call with a reviewed key. The
   *  generator now stores the function's output verbatim, so there is nothing
   *  to keep in step. */
  specs: Record<string, { label: string; value: unknown; unit: string | null; confidence: number | null }>;
  images: { url: string; variant: "hero" | "card" }[];
};

export type DemoPayload = {
  /** Bumped when the shape changes, so a stale blob is detected, not guessed. */
  schema: 1;
  locale: string;
  built_at: string;
  /** Mirrors DEMO_SET_DESCRIPTION at build time — a blob that disagrees with
   *  the frozen set is a stale blob. */
  set_description: string;
  variants: DemoVariant[];
};

const kvKey = (locale: string) => `demo:v1:${locale}`;

/** Reads the blob for one locale. Returns null when it is missing, which the
 *  caller must treat as "demo unavailable" — not as "demo is empty". A demo
 *  that answers 200 with no cars looks like a broken catalogue to whoever is
 *  evaluating us, which is precisely the audience it exists for. */
export async function loadDemoPayload(env: Env, locale: string): Promise<DemoPayload | null> {
  const raw = await env.API_KEYS.get(kvKey(locale));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DemoPayload;
    return parsed.schema === 1 && Array.isArray(parsed.variants) ? parsed : null;
  } catch {
    return null;
  }
}

export const demoPayloadKey = kvKey;
