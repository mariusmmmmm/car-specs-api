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
    }[]
  >`
    SELECT v.last_synced_at, vd.specs,
           v.fuel_type_en, v.transmission_en, v.drive_wheel_en, v.body_type_en
    FROM variants v
    LEFT JOIN variant_doc vd ON vd.variant_id = v.public_id
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

  return { specs: localized, last_synced_at: row.last_synced_at ?? new Date() };
}
