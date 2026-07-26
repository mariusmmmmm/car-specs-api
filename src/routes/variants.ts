import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../lib/db";
import { envelope, problem } from "../lib/response";
import { resolveLocale } from "../lib/locale";
import type { RawSpecValue } from "../lib/translations";
import { localizeVariantSpecs } from "../lib/localize-variant";
import { maxSyncedAt } from "../lib/meta";

export const variants = new Hono<{ Bindings: Env }>();

variants.get("/", async (c) => {
  const sql = getDb(c.env);
  const locale = resolveLocale(c.req.query("locale"));
  const fuel = c.req.query("fuel");
  const body = c.req.query("body");
  const drive = c.req.query("drive");
  const powerMin = c.req.query("power_min") ? Number(c.req.query("power_min")) : null;
  const powerMax = c.req.query("power_max") ? Number(c.req.query("power_max")) : null;
  const priceMax = c.req.query("price_max") ? Number(c.req.query("price_max")) : null;
  const year = c.req.query("year") ? Number(c.req.query("year")) : null;
  const ev = c.req.query("ev") === "true";
  const cursor = c.req.query("cursor") ? Number(c.req.query("cursor")) : 0;
  const limit = Math.min(Number(c.req.query("limit") ?? 24) || 24, 50);

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
      AND (${fuel ?? null}::text IS NULL OR v.fuel_slug = ${fuel ?? null})
      AND (${ev} = false OR v.fuel_slug = 'electric')
      AND (${body ?? null}::text IS NULL OR g.body_slug = ${body ?? null})
      AND (${drive ?? null}::text IS NULL OR v.drive_wheel_en ILIKE ${drive ? `%${drive}%` : null})
      AND (${powerMin ?? null}::int IS NULL OR v.power_hp >= ${powerMin ?? null})
      AND (${powerMax ?? null}::int IS NULL OR v.power_hp <= ${powerMax ?? null})
      AND (${priceMax ?? null}::int IS NULL OR v.price_new_eur <= ${priceMax ?? null})
      AND (${year ?? null}::int IS NULL OR (g.years_start <= ${year ?? null} AND (g.years_end IS NULL OR g.years_end >= ${year ?? null})))
    ORDER BY v.public_id ASC
    LIMIT ${limit}
  `;

  const nextCursor = rows.length === limit ? rows[rows.length - 1].variant_id : null;
  return c.json(
    envelope(
      rows.map((r) => ({
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
      })),
      { locale, last_synced_at: maxSyncedAt(rows) },
      { next: nextCursor ? String(nextCursor) : undefined },
    ),
  );
});

variants.get("/:id", async (c) => {
  const sql = getDb(c.env);
  const id = Number(c.req.param("id"));
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
      specs: Record<string, RawSpecValue> | null;
      spec_count: number | null;
    }[]
  >`
    SELECT v.public_id::int AS variant_id, g.public_id::int AS generation_id, v.display_name,
           v.power_hp, v.battery_kwh, v.top_speed_kmh, v.torque_nm, v.accel_0_100_s,
           v.fuel_slug, v.body_type_en, v.price_new_eur, v.last_synced_at,
           vd.specs, vd.spec_count
    FROM variants v
    JOIN generations g ON g.id = v.generation_id
    LEFT JOIN variant_doc vd ON vd.variant_id = v.public_id
    WHERE v.is_active AND v.public_id = ${id}
    LIMIT 1
  `;
  const v = rows[0];
  if (!v) {
    const { body, status, headers } = problem(404, "Not Found", `No variant with id ${id}`);
    return c.json(body, status, headers);
  }
  return c.json(
    envelope(
      {
        variant_id: v.variant_id,
        generation_id: v.generation_id,
        display_name: v.display_name,
        power_hp: v.power_hp,
        battery_kwh: v.battery_kwh !== null ? Number(v.battery_kwh) : null,
        top_speed_kmh: v.top_speed_kmh,
        torque_nm: v.torque_nm,
        accel_0_100_s: v.accel_0_100_s !== null ? Number(v.accel_0_100_s) : null,
        fuel_slug: v.fuel_slug,
        body_type_en: v.body_type_en,
        price_new_eur: v.price_new_eur,
        spec_count: v.spec_count ?? 0,
        specs: v.specs ?? {}, // language-neutral; empty for the ~1 variant with no spec_values rows
      },
      { last_synced_at: (v.last_synced_at ?? new Date()).toISOString() },
    ),
  );
});

variants.get("/:id/specs", async (c) => {
  const sql = getDb(c.env);
  const locale = resolveLocale(c.req.query("locale"));
  const id = Number(c.req.param("id"));
  const result = await localizeVariantSpecs(sql, locale, id);
  if (!result) {
    const { body, status, headers } = problem(404, "Not Found", `No variant with id ${id}`);
    return c.json(body, status, headers);
  }
  return c.json(
    envelope(
      { variant_id: id, locale, specs: result.specs },
      { locale, last_synced_at: result.last_synced_at.toISOString() },
    ),
  );
});

variants.get("/:id/images", async (c) => {
  const sql = getDb(c.env);
  const id = Number(c.req.param("id"));
  const exists = await sql`SELECT 1 FROM variants WHERE public_id = ${id} AND is_active LIMIT 1`;
  if (exists.length === 0) {
    const { body, status, headers } = problem(404, "Not Found", `No variant with id ${id}`);
    return c.json(body, status, headers);
  }
  const rows = await sql<{ cdn_url: string; role: string }[]>`
    SELECT ma.cdn_url, em.role
    FROM entity_media em
    JOIN media_assets ma ON ma.id = em.asset_id
    WHERE em.entity_kind = 'variant' AND em.entity_id = ${id} AND ma.is_active
    ORDER BY em.display_order ASC
  `;
  return c.json(
    envelope(
      rows.map((r) => ({
        url: r.cdn_url,
        variant: r.role === "hero" ? "hero" : "card",
      })),
      { last_synced_at: new Date().toISOString() },
    ),
  );
});

variants.get("/:id/prices", async (c) => {
  const sql = getDb(c.env);
  const id = Number(c.req.param("id"));
  const rows = await sql<{ price_eur: number; recorded_at: Date }[]>`
    SELECT ph.price_eur, ph.recorded_at
    FROM variants v
    JOIN prices_history ph ON ph.variant_id = v.id
    WHERE v.public_id = ${id} AND v.is_active
      AND ph.price_type = 'new_msrp' AND ph.market = 'NL'
    ORDER BY ph.year DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    const { body, status, headers } = problem(404, "Not Found", `No price snapshot for variant ${id}`);
    return c.json(body, status, headers);
  }
  return c.json(
    envelope(
      {
        variant_id: id,
        price_eur: row.price_eur,
        as_of: row.recorded_at.toISOString().slice(0, 10),
      },
      { last_synced_at: row.recorded_at.toISOString() },
    ),
  );
});
