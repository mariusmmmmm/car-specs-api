import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

// 180 spec labels x 19 locales + 4 enum groups x ~4-8 values x 19 locales:
// a few thousand rows, small enough to hold whole in the Worker isolate's
// memory and refresh on a TTL, per BIZ-L2a-openapi-readmodel.md §1.
type TranslationCache = {
  loadedAt: number;
  specLabels: Map<string, Map<string, string>>; // spec_key -> locale -> label
  enumLabels: Map<string, Map<string, Map<string, string>>>; // enum_group -> value_en -> locale -> translation
};

let cache: TranslationCache | null = null;
const TTL_MS = 10 * 60 * 1000;

export async function getTranslationCache(sql: Sql): Promise<TranslationCache> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache;

  const [specRows, enumRows] = await Promise.all([
    sql<{ spec_key: string; locale_code: string; display_name: string }[]>`
      SELECT sc.spec_key, sct.locale_code, sct.display_name
      FROM specs_catalog_translations sct
      JOIN specs_catalog sc ON sc.id = sct.spec_id
    `,
    sql<{ enum_group: string; enum_value_en: string; locale_code: string; translation: string }[]>`
      SELECT enum_group, enum_value_en, locale_code, translation FROM enum_translations
    `,
  ]);

  const specLabels = new Map<string, Map<string, string>>();
  for (const r of specRows) {
    if (!specLabels.has(r.spec_key)) specLabels.set(r.spec_key, new Map());
    specLabels.get(r.spec_key)!.set(r.locale_code, r.display_name);
  }

  const enumLabels = new Map<string, Map<string, Map<string, string>>>();
  for (const r of enumRows) {
    if (!enumLabels.has(r.enum_group)) enumLabels.set(r.enum_group, new Map());
    const byValue = enumLabels.get(r.enum_group)!;
    if (!byValue.has(r.enum_value_en)) byValue.set(r.enum_value_en, new Map());
    byValue.get(r.enum_value_en)!.set(r.locale_code, r.translation);
  }

  cache = { loadedAt: Date.now(), specLabels, enumLabels };
  return cache;
}

export type RawSpecValue = { v?: unknown; u?: string; e?: string; c?: number };

export function localizeSpec(
  specKey: string,
  raw: RawSpecValue,
  locale: string,
  t: TranslationCache,
) {
  const label = t.specLabels.get(specKey)?.get(locale) ?? t.specLabels.get(specKey)?.get("en") ?? specKey;
  let value = raw.v;
  if (raw.e) {
    // enum_group == spec_key for every current enum spec (fuel_type,
    // transmission, drive_wheel, body_type) — verified against cars_v3.
    const translated = t.enumLabels.get(specKey)?.get(raw.e)?.get(locale);
    if (translated) value = translated;
  }
  return { label, value, unit: raw.u ?? null, confidence: raw.c ?? null };
}
