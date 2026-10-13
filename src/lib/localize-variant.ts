import type postgres from "postgres";
import { getTranslationCache, localizeSpec, type RawSpecValue } from "./translations";

type Sql = ReturnType<typeof postgres>;

// Shared by /variants/{id}/specs and /compare — one variant's EAV specs
// (variant_doc) merged with the 4 flat-column enum specs (fuel_type,
// transmission, drive_wheel, body_type — verified to have zero variant_doc
// rows, see routes/variants.ts), all localized.
export async function localizeVariantSpecs(sql: Sql, locale: string, variantPublicId: number) {
  const rows = await sql<
    {
      last_synced_at: Date | null;
      specs: Record<string, RawSpecValue> | null;
      fuel_type_en: string | null;
      transmission_en: string | null;
      drive_wheel_en: string | null;
      body_type_en: string | null;
      display_name: string;
      brand_slug: string;
      model_slug: string;
      year_from: number | null;
      year_to: number | null;
      power_hp: number | null;
      battery_kwh: string | null;
      top_speed_kmh: number | null;
      torque_nm: number | null;
      accel_0_100_s: string | null;
      price_new_eur: number | null;
    }[]
  >`
    SELECT v.last_synced_at, vd.specs,
           v.fuel_type_en, v.transmission_en, v.drive_wheel_en, v.body_type_en,
           COALESCE(vt.name, v.display_name) AS display_name,
           b.canonical_slug AS brand_slug,
           COALESCE(mt.slug, m.canonical_slug) AS model_slug,
           g.years_start AS year_from, g.years_end AS year_to,
           v.power_hp, v.battery_kwh, v.top_speed_kmh, v.torque_nm, v.accel_0_100_s,
           NULLIF(v.price_new_eur, 0) AS price_new_eur
    FROM variants v
    JOIN generations g ON g.id = v.generation_id
    JOIN models m ON m.id = g.model_id
    JOIN brands b ON b.id = m.brand_id
    LEFT JOIN variant_doc vd ON vd.variant_id = v.public_id
    LEFT JOIN variant_translations vt ON vt.variant_id = v.id AND vt.locale_code = ${locale}
    LEFT JOIN model_translations mt ON mt.model_id = m.id AND mt.locale_code = ${locale}
    WHERE v.is_active AND v.public_id = ${variantPublicId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  const t = await getTranslationCache(sql);
  const raw = row.specs ?? {};
  const localized: Record<string, ReturnType<typeof localizeSpec>> = {};
  for (const [specKey, value] of Object.entries(raw)) {
    localized[specKey] = localizeSpec(specKey, value, locale, t);
  }
  const flatEnums: Array<[string, string | null]> = [
    ["fuel_type", row.fuel_type_en],
    ["transmission", row.transmission_en],
    ["drive_wheel", row.drive_wheel_en],
    ["body_type", row.body_type_en],
  ];
  for (const [specKey, valueEn] of flatEnums) {
    if (!valueEn) continue;
    localized[specKey] = localizeSpec(specKey, { e: valueEn }, locale, t);
  }

  return {
    specs: localized,
    last_synced_at: row.last_synced_at ?? new Date(),
    summary: {
      display_name: row.display_name,
      brand_slug: row.brand_slug,
      model_slug: row.model_slug,
      year_from: row.year_from,
      year_to: row.year_to,
      power_hp: row.power_hp,
      battery_kwh: row.battery_kwh !== null ? Number(row.battery_kwh) : null,
      top_speed_kmh: row.top_speed_kmh,
      torque_nm: row.torque_nm,
      accel_0_100_s: row.accel_0_100_s !== null ? Number(row.accel_0_100_s) : null,
      price_new_eur: row.price_new_eur,
    },
  };
}
