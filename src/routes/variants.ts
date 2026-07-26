import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../lib/db";
import { envelope, problem } from "../lib/response";
import { resolveLocale } from "../lib/locale";
import { getTranslationCache, localizeSpec, type RawSpecValue } from "../lib/translations";

export const variants = new Hono<{ Bindings: Env }>();

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
    WHERE v.is_active AND v.public_id = ${id}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    const { body, status, headers } = problem(404, "Not Found", `No variant with id ${id}`);
    return c.json(body, status, headers);
  }
  const t = await getTranslationCache(sql);
  const raw = row.specs ?? {};
  const localized: Record<string, ReturnType<typeof localizeSpec>> = {};
  for (const [specKey, value] of Object.entries(raw)) {
    localized[specKey] = localizeSpec(specKey, value, locale, t);
  }
  // fuel_type/transmission/drive_wheel/body_type live on the flat `variants`
  // columns, not in spec_values (verified 2026-07-26: zero variant_doc rows
  // carry these 4 spec_keys) — merge them in from enum_translations directly
  // so /specs?locale= actually localizes them instead of silently omitting.
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
  return c.json(
    envelope(
      { variant_id: id, locale, specs: localized },
      { locale, last_synced_at: (row.last_synced_at ?? new Date()).toISOString() },
    ),
  );
});
