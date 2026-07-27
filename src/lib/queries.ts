import type postgres from "postgres";
import { normalizeLower, normalizeAlnum } from "./search-normalize";

type Sql = ReturnType<typeof postgres>;

// Shared query functions — called by both the REST routes (routes/*.ts) and
// the MCP tools (mcp.ts), so the SQL lives in exactly one place.

export type VariantSummary = {
  variant_id: number;
  generation_id: number;
  display_name: string;
  power_hp: number | null;
  battery_kwh: number | null;
  top_speed_kmh: number | null;
  torque_nm: number | null;
  accel_0_100_s: number | null;
  fuel_slug: string | null;
  body_type_en: string | null;
  price_new_eur: number | null;
};

function toVariantSummary(r: {
  variant_id: number;
  generation_id: number;
  display_name: string;
  power_hp: number | null;
  battery_kwh: string | null;
  top_speed_kmh: number | null;
  torque_nm: number | null;
  accel_0_100_s: string | null;
  fuel_slug: string | null;
  body_type_en: string | null;
  price_new_eur: number | null;
}): VariantSummary {
  return {
    variant_id: r.variant_id,
    generation_id: r.generation_id,
    display_name: r.display_name,
    power_hp: r.power_hp,
    battery_kwh: r.battery_kwh !== null ? Number(r.battery_kwh) : null,
    top_speed_kmh: r.top_speed_kmh,
    torque_nm: r.torque_nm,
    accel_0_100_s: r.accel_0_100_s !== null ? Number(r.accel_0_100_s) : null,
    fuel_slug: r.fuel_slug,
    body_type_en: r.body_type_en,
    price_new_eur: r.price_new_eur,
  };
}

export async function searchVariants(sql: Sql, locale: string, q: string, limit: number) {
  const patLower = `%${normalizeLower(q)}%`;
  const patAlnum = `%${normalizeAlnum(q)}%`;
  const rows = await sql<
    {
      variant_id: number;
      display_name: string;
      brand_slug: string;
      model_slug: string;
      generation_id: number;
      year_from: number | null;
      year_to: number | null;
    }[]
  >`
    SELECT v.public_id::int AS variant_id,
           COALESCE(vt.name, v.display_name) AS display_name,
           b.canonical_slug AS brand_slug,
           COALESCE(mt.slug, m.canonical_slug) AS model_slug,
           g.public_id::int AS generation_id,
           g.years_start AS year_from,
           g.years_end AS year_to
    FROM variants v
    JOIN generations g ON g.id = v.generation_id
    JOIN models m ON m.id = g.model_id
    JOIN brands b ON b.id = m.brand_id
    LEFT JOIN variant_translations vt ON vt.variant_id = v.id AND vt.locale_code = ${locale}
    LEFT JOIN model_translations mt ON mt.model_id = m.id AND mt.locale_code = ${locale}
    LEFT JOIN brand_translations bt ON bt.brand_id = b.id AND bt.locale_code = ${locale}
    WHERE v.is_active AND (
      f_unaccent_lower(COALESCE(vt.name, v.display_name)) LIKE ${patLower}
      OR f_unaccent_alnum(COALESCE(vt.name, v.display_name)) LIKE ${patAlnum}
      OR f_unaccent_lower(COALESCE(mt.display_name, m.display_name)) LIKE ${patLower}
      OR f_unaccent_alnum(COALESCE(mt.display_name, m.display_name)) LIKE ${patAlnum}
      OR f_unaccent_lower(COALESCE(bt.display_name, b.display_name)) LIKE ${patLower}
      OR f_unaccent_alnum(COALESCE(bt.display_name, b.display_name)) LIKE ${patAlnum}
    )
    ORDER BY v.power_hp DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows;
}

export async function listGenerationsForModel(sql: Sql, locale: string, modelId: number) {
  const rows = await sql<
    {
      id: number;
      model_id: number;
      slug: string;
      name: string;
      years_start: number;
      years_end: number | null;
      last_synced_at: Date | null;
    }[]
  >`
    SELECT g.public_id::int AS id, m.public_id::int AS model_id, g.canonical_slug AS slug,
           COALESCE(gt.display_name, g.display_name) AS name,
           g.years_start, g.years_end, g.last_synced_at
    FROM generations g
    JOIN models m ON m.id = g.model_id
    LEFT JOIN generation_translations gt ON gt.generation_id = g.id AND gt.locale_code = ${locale}
    WHERE g.is_active AND m.public_id = ${modelId}
    ORDER BY g.years_start ASC
  `;
  return rows;
}

export type VariantFilters = {
  fuel?: string;
  body?: string;
  drive?: string;
  powerMin?: number | null;
  powerMax?: number | null;
  priceMax?: number | null;
  year?: number | null;
  ev?: boolean;
  cursor?: number;
  limit?: number;
};

export async function filterVariants(sql: Sql, locale: string, f: VariantFilters) {
  const fuel = f.fuel ?? null;
  const body = f.body ?? null;
  const drive = f.drive ?? null;
  const powerMin = f.powerMin ?? null;
  const powerMax = f.powerMax ?? null;
  const priceMax = f.priceMax ?? null;
  const year = f.year ?? null;
  const ev = f.ev ?? false;
  const cursor = f.cursor ?? 0;
  const limit = Math.min(f.limit ?? 24, 50);

  const rows = await sql<
    {
      variant_id: number;
      generation_id: number;
      display_name: string;
      power_hp: number | null;
      battery_kwh: string | null;
      top_speed_kmh: number | null;
      torque_nm: number | null;
      accel_0_100_s: string | null;
      fuel_slug: string | null;
      body_type_en: string | null;
      price_new_eur: number | null;
      last_synced_at: Date | null;
    }[]
  >`
    SELECT v.public_id::int AS variant_id, g.public_id::int AS generation_id,
           COALESCE(vt.name, v.display_name) AS display_name,
           v.power_hp, v.battery_kwh, v.top_speed_kmh, v.torque_nm, v.accel_0_100_s,
           v.fuel_slug, v.body_type_en, v.price_new_eur, v.last_synced_at
    FROM variants v
    JOIN generations g ON g.id = v.generation_id
    LEFT JOIN variant_translations vt ON vt.variant_id = v.id AND vt.locale_code = ${locale}
    WHERE v.is_active
      AND v.public_id > ${cursor}
      AND (${fuel}::text IS NULL OR v.fuel_slug = ${fuel})
      AND (${ev} = false OR v.fuel_slug = 'electric')
      AND (${body}::text IS NULL OR g.body_slug = ${body})
      AND (${drive}::text IS NULL OR v.drive_wheel_en ILIKE ${drive ? `%${drive}%` : null})
      AND (${powerMin}::int IS NULL OR v.power_hp >= ${powerMin})
      AND (${powerMax}::int IS NULL OR v.power_hp <= ${powerMax})
      AND (${priceMax}::int IS NULL OR v.price_new_eur <= ${priceMax})
      AND (${year}::int IS NULL OR (g.years_start <= ${year} AND (g.years_end IS NULL OR g.years_end >= ${year})))
    ORDER BY v.public_id ASC
    LIMIT ${limit}
  `;
  return rows;
}

export async function getVariantImages(sql: Sql, variantId: number) {
  // Source data can link the same cdn_url more than once (distinct asset rows,
  // same URL) → dedup by URL keeping the lowest display_order, then re-sort by
  // display_order so ordering is unchanged for the common (no-dup) case.
  const rows = await sql<{ cdn_url: string; role: string; display_order: number }[]>`
    SELECT DISTINCT ON (ma.cdn_url) ma.cdn_url, em.role, em.display_order
    FROM entity_media em
    JOIN media_assets ma ON ma.id = em.asset_id
    WHERE em.entity_kind = 'variant' AND em.entity_id = ${variantId} AND ma.is_active
    ORDER BY ma.cdn_url, em.display_order ASC
  `;
  return rows
    .sort((a, b) => a.display_order - b.display_order)
    .map(({ cdn_url, role }) => ({ cdn_url, role }));
}

export async function variantExists(sql: Sql, variantId: number): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM variants WHERE public_id = ${variantId} AND is_active LIMIT 1`;
  return rows.length > 0;
}

export { toVariantSummary };
