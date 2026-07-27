import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../lib/db";
import { envelope, problem } from "../lib/response";
import { resolveLocale } from "../lib/locale";
import type { RawSpecValue } from "../lib/translations";
import { localizeVariantSpecs } from "../lib/localize-variant";
import { maxSyncedAt } from "../lib/meta";
import { filterVariants, getVariantImages, variantExists } from "../lib/queries";

export const variants = new Hono<{ Bindings: Env }>();

variants.get("/", async (c) => {
  const sql = getDb(c.env);
  const locale = resolveLocale(c.req.query("locale"));
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 50);

  const rows = await filterVariants(sql, locale, {
    fuel: c.req.query("fuel"),
    body: c.req.query("body"),
    drive: c.req.query("drive"),
    powerMin: c.req.query("power_min") ? Number(c.req.query("power_min")) : null,
    powerMax: c.req.query("power_max") ? Number(c.req.query("power_max")) : null,
    priceMax: c.req.query("price_max") ? Number(c.req.query("price_max")) : null,
    year: c.req.query("year") ? Number(c.req.query("year")) : null,
    ev: c.req.query("ev") === "true",
    cursor: c.req.query("cursor") ? Number(c.req.query("cursor")) : 0,
    limit,
  });

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
           v.fuel_slug, v.body_type_en, NULLIF(v.price_new_eur, 0) AS price_new_eur, v.last_synced_at,
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
  if (!(await variantExists(sql, id))) {
    const { body, status, headers } = problem(404, "Not Found", `No variant with id ${id}`);
    return c.json(body, status, headers);
  }
  const rows = await getVariantImages(sql, id);
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
