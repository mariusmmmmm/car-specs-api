import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../lib/db";
import { envelope, problem } from "../lib/response";
import { resolveLocale } from "../lib/locale";
import { maxSyncedAt } from "../lib/meta";
import { parsePaging, nextLink } from "../lib/pagination";
import { listGenerationsForModel } from "../lib/queries";

export const catalog = new Hono<{ Bindings: Env }>();

catalog.get("/brands", async (c) => {
  const sql = getDb(c.env);
  const locale = resolveLocale(c.req.query("locale"));
  const { limit, offset } = parsePaging(c);
  const rows = await sql<
    { id: number; slug: string; name: string; wikidata_qid: string | null; last_synced_at: Date | null }[]
  >`
    SELECT b.public_id::int AS id, b.canonical_slug AS slug,
           COALESCE(bt.display_name, b.display_name) AS name,
           b.wikidata_qid, b.last_synced_at
    FROM brands b
    LEFT JOIN brand_translations bt ON bt.brand_id = b.id AND bt.locale_code = ${locale}
    WHERE b.is_active
    ORDER BY b.popularity_score DESC, b.display_name ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return c.json(
    envelope(
      rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        sameAs: r.wikidata_qid ? [`https://www.wikidata.org/wiki/${r.wikidata_qid}`] : [],
      })),
      { locale, last_synced_at: maxSyncedAt(rows) },
      nextLink(rows.length, limit, offset),
    ),
  );
});

catalog.get("/brands/:slug", async (c) => {
  const sql = getDb(c.env);
  const locale = resolveLocale(c.req.query("locale"));
  const slug = c.req.param("slug");
  const rows = await sql<
    { id: number; slug: string; name: string; wikidata_qid: string | null; last_synced_at: Date | null }[]
  >`
    SELECT b.public_id::int AS id, b.canonical_slug AS slug,
           COALESCE(bt.display_name, b.display_name) AS name,
           b.wikidata_qid, b.last_synced_at
    FROM brands b
    LEFT JOIN brand_translations bt ON bt.brand_id = b.id AND bt.locale_code = ${locale}
    WHERE b.is_active AND b.canonical_slug = ${slug}
    LIMIT 1
  `;
  const brand = rows[0];
  if (!brand) {
    const { body, status, headers } = problem(404, "Not Found", `No brand with slug "${slug}"`);
    return c.json(body, status, headers);
  }
  return c.json(
    envelope(
      {
        id: brand.id,
        slug: brand.slug,
        name: brand.name,
        sameAs: brand.wikidata_qid ? [`https://www.wikidata.org/wiki/${brand.wikidata_qid}`] : [],
      },
      { locale, last_synced_at: maxSyncedAt(rows) },
    ),
  );
});

catalog.get("/brands/:slug/models", async (c) => {
  const sql = getDb(c.env);
  const locale = resolveLocale(c.req.query("locale"));
  const slug = c.req.param("slug");
  const { limit, offset } = parsePaging(c);
  const rows = await sql<
    { id: number; brand_id: number; slug: string; name: string; last_synced_at: Date | null }[]
  >`
    SELECT m.public_id::int AS id, b.public_id::int AS brand_id,
           COALESCE(mt.slug, m.canonical_slug) AS slug,
           COALESCE(mt.display_name, m.display_name) AS name,
           m.last_synced_at
    FROM models m
    JOIN brands b ON b.id = m.brand_id
    LEFT JOIN model_translations mt ON mt.model_id = m.id AND mt.locale_code = ${locale}
    WHERE m.is_active AND b.canonical_slug = ${slug}
    ORDER BY m.popularity_score DESC, m.display_name ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
  if (rows.length === 0 && offset === 0) {
    const exists = await sql`SELECT 1 FROM brands WHERE canonical_slug = ${slug} AND is_active LIMIT 1`;
    if (exists.length === 0) {
      const { body, status, headers } = problem(404, "Not Found", `No brand with slug "${slug}"`);
      return c.json(body, status, headers);
    }
  }
  return c.json(
    envelope(
      rows.map((r) => ({ id: r.id, brand_id: r.brand_id, slug: r.slug, name: r.name })),
      { locale, last_synced_at: maxSyncedAt(rows) },
      nextLink(rows.length, limit, offset),
    ),
  );
});

catalog.get("/models/:id/generations", async (c) => {
  const sql = getDb(c.env);
  const locale = resolveLocale(c.req.query("locale"));
  const modelId = Number(c.req.param("id"));
  const { limit, offset } = parsePaging(c);
  const rows = await listGenerationsForModel(sql, locale, modelId, { limit, offset });
  if (rows.length === 0 && offset === 0) {
    const exists = await sql`SELECT 1 FROM models WHERE public_id = ${modelId} AND is_active LIMIT 1`;
    if (exists.length === 0) {
      const { body, status, headers } = problem(404, "Not Found", `No model with id ${modelId}`);
      return c.json(body, status, headers);
    }
  }
  return c.json(
    envelope(
      rows.map((r) => ({
        id: r.id,
        model_id: r.model_id,
        slug: r.slug,
        name: r.name,
        year_start: r.years_start,
        year_end: r.years_end,
      })),
      { locale, last_synced_at: maxSyncedAt(rows) },
      nextLink(rows.length, limit, offset),
    ),
  );
});

catalog.get("/generations/:id/variants", async (c) => {
  const sql = getDb(c.env);
  const locale = resolveLocale(c.req.query("locale"));
  const genId = Number(c.req.param("id"));
  const { limit, offset } = parsePaging(c);
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
           v.fuel_slug, v.body_type_en, NULLIF(v.price_new_eur, 0) AS price_new_eur, v.last_synced_at
    FROM variants v
    JOIN generations g ON g.id = v.generation_id
    LEFT JOIN variant_translations vt ON vt.variant_id = v.id AND vt.locale_code = ${locale}
    WHERE v.is_active AND g.public_id = ${genId}
    ORDER BY v.display_name ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
  if (rows.length === 0 && offset === 0) {
    const exists = await sql`SELECT 1 FROM generations WHERE public_id = ${genId} AND is_active LIMIT 1`;
    if (exists.length === 0) {
      const { body, status, headers } = problem(404, "Not Found", `No generation with id ${genId}`);
      return c.json(body, status, headers);
    }
  }
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
      nextLink(rows.length, limit, offset),
    ),
  );
});

catalog.get("/specs/catalog", async (c) => {
  const sql = getDb(c.env);
  const locale = resolveLocale(c.req.query("locale"));
  const { limit, offset } = parsePaging(c);
  const rows = await sql<
    { spec_key: string; display_name: string; unit: string | null; group: string | null }[]
  >`
    SELECT sc.spec_key, COALESCE(sct.display_name, sc.display_name_en) AS display_name,
           sc.unit, cat.code AS group
    FROM specs_catalog sc
    JOIN spec_categories cat ON cat.id = sc.category_id
    LEFT JOIN specs_catalog_translations sct ON sct.spec_id = sc.id AND sct.locale_code = ${locale}
    WHERE sc.is_active
    ORDER BY cat.display_order, sc.display_order
    LIMIT ${limit} OFFSET ${offset}
  `;
  return c.json(
    envelope(rows, { locale, last_synced_at: new Date().toISOString() }, nextLink(rows.length, limit, offset)),
  );
});
