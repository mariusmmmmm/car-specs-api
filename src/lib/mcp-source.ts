import type { Env, McpProps } from "../types";
import type { KeyRecord } from "./apikey";
import { loadDemoPayload, type DemoVariant } from "./demo-payload";
import { demoSetReady } from "./demo-set";

// Two ways to answer an MCP tool, behind one shape (T111).
//
// Without this seam the demo branch would be an `if` inside each of the six
// tools, and the sixth one added later would forget. With it, an anonymous
// caller is handed a source that has no database connection in it at all —
// the same reason routes/demo.ts is dispatched ahead of the REST routes rather
// than consulting an allowlist.

export type VariantFilters = {
  fuel?: string;
  body?: string;
  drive?: string;
  powerMin?: number | null;
  powerMax?: number | null;
  priceMax?: number | null;
  year?: number | null;
  ev?: boolean;
  limit: number;
};

export type SpecsResult = { last_synced_at: string; specs: Record<string, unknown> } | null;

export type McpSource = {
  readonly demo: boolean;
  search(locale: string, query: string, limit: number): Promise<unknown[]>;
  specs(locale: string, variantId: number): Promise<SpecsResult>;
  generations(locale: string, modelId: number): Promise<unknown[]>;
  filter(locale: string, f: VariantFilters): Promise<unknown[]>;
  images(variantId: number): Promise<unknown[]>;
};


const row = (v: DemoVariant) => ({
  variant_id: v.variant_id,
  generation_id: v.generation_id,
  model_id: v.model_id,
  display_name: v.display_name,
  brand: v.brand,
  model: v.model,
  generation: v.generation,
  fuel_slug: v.fuel,
  body_type_en: v.body_type,
  years: v.years,
  power_hp: v.power_hp,
  battery_kwh: v.battery_kwh,
  price_new_eur: v.price_new_eur,
});

/** null when the blob is missing or the frozen set is not generated. The caller
 *  must turn that into "temporarily unavailable" — never into an empty result.
 *  An agent told "no cars match" concludes the catalogue is thin; an agent told
 *  "unavailable, retry" concludes nothing about our data. */
export async function demoSource(env: Env, locale: string): Promise<McpSource | null> {
  if (!demoSetReady()) return null;
  const payload = await loadDemoPayload(env, locale);
  if (!payload) return null;
  const all = payload.variants;
  const find = (id: number) => all.find((v) => v.variant_id === id) ?? null;

  return {
    demo: true,
    async search(_locale, query, limit) {
      const q = query.trim().toLowerCase();
      const hits = q
        ? all.filter((v) => `${v.brand} ${v.model} ${v.generation} ${v.display_name}`.toLowerCase().includes(q))
        : all;
      return hits.slice(0, limit).map(row);
    },
    async specs(_locale, variantId) {
      const v = find(variantId);
      return v ? { last_synced_at: payload.built_at, specs: v.specs } : null;
    },
    async generations(_locale, modelId) {
      const seen = new Map<number, DemoVariant>();
      for (const v of all) if (v.model_id === modelId && !seen.has(v.generation_id)) seen.set(v.generation_id, v);
      return [...seen.values()].map((v) => ({
        generation_id: v.generation_id,
        model_id: v.model_id,
        display_name: v.generation,
        years: v.years,
      }));
    },
    async filter(_locale, f) {
      // Only the fields the blob actually carries. A filter the demo cannot
      // honour is reported back rather than silently ignored — an agent that
      // asked for `drive: rear` and got everything would believe the data has
      // no drive layout.
      let hits = all;
      if (f.fuel) hits = hits.filter((v) => v.fuel.toLowerCase().includes(f.fuel!.toLowerCase()));
      if (f.body) hits = hits.filter((v) => (v.body_type ?? "").toLowerCase().includes(f.body!.toLowerCase()));
      if (f.powerMin != null) hits = hits.filter((v) => (v.power_hp ?? 0) >= f.powerMin!);
      if (f.powerMax != null) hits = hits.filter((v) => (v.power_hp ?? 0) <= f.powerMax!);
      if (f.priceMax != null) hits = hits.filter((v) => (v.price_new_eur ?? 0) <= f.priceMax!);
      if (f.ev) hits = hits.filter((v) => v.battery_kwh !== null);
      return hits.slice(0, f.limit).map(row);
    },
    async images(variantId) {
      return find(variantId)?.images ?? [];
    },
  };
}

/** Which filter keys the demo blob cannot honour, so a tool can say so. */
export const DEMO_UNSUPPORTED_FILTERS = ["drive", "year"] as const;

/** Who is on the demo scope, decided in ONE place (T165).
 *
 *  `null` = no key at all: the anonymous demo (T111 D9). A `demo`-plan key is
 *  the same scope by a different door, and until T165 it was not treated as
 *  one: index.ts built props with no `demo` for every authenticated key, so
 *  sourceFor() fell through to dbSource() and the self-serve key reached the
 *  whole catalogue through /mcp. REST never had the hole because routes/v1.ts
 *  dispatches on exactly this fact — which is why it lives here as a function
 *  both surfaces can state, and a test can execute, rather than as an `if`
 *  inside index.ts that no test can import. */
export const isDemoScope = (record: Pick<KeyRecord, "plan"> | null): boolean =>
  record === null || record.plan === "demo";

/** MCP este suprafața DEMO. Întotdeauna, pentru oricine.
 *
 *  Strategia owner-ului (D-01, 2026-10-08): două niveluri — demo și plătit.
 *  Plătit înseamnă Actor-ul Apify, care facturează per rezultat pe platforma
 *  lor, și exportul licențiat. MCP nu e niciunul din ele: e suprafața pe care
 *  un agent te găsește fără nicio cheie.
 *
 *  De ce nu mai există o ramură spre bază aici. Până pe 2026-10-08 regula avea
 *  o excepție — planul `apify` primea catalogul — iar excepția nu era scrisă
 *  nicăieri ca funcție. Exact din forma asta a ieșit defectul pe care l-a găsit
 *  T165: o cheie demo, pe care și-o emite oricine din formular, ajungea la tot
 *  catalogul. O regulă cu o excepție se uită; una fără, nu.
 *
 *  Nu pierde nimic: Actor-ul apelează `/v1`, nu `/mcp` — măsurat în sursa lui
 *  (`apify-actor/src`, un singur endpoint: `https://api.cars-data.com/v1`).
 *  Cheia `apify` pe `/mcp` n-avea niciun consumator legitim, doar expunere dacă
 *  scurgea din mediul Actor-ului.
 *
 *  Dacă vreodată se vrea MCP plătit, e o construcție deliberată, nu o
 *  comutare de flag — iar asta e tocmai ce o face sigură. */
export async function sourceFor(env: Env, props: McpProps): Promise<McpSource | null> {
  return demoSource(env, props.locale ?? "en");
}
