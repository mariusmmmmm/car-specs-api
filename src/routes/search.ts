import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../lib/db";
import { envelope, problem } from "../lib/response";
import { resolveLocale } from "../lib/locale";
import { normalizeLower, normalizeAlnum } from "../lib/search-normalize";

export const search = new Hono<{ Bindings: Env }>();

// Simplified port of v3/lib/server/search.ts's trigram matching: same
// f_unaccent_lower/f_unaccent_alnum columns, single-phrase match instead of
// the full per-word AND-of-OR + NL filter parser (year/power/fuel/body
// tokens). Structured filtering has its own endpoint (/v1/variants); this
// one is the typeahead the MCP `search_cars` tool calls.
search.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  const locale = resolveLocale(c.req.query("locale"));
  const limit = Math.min(Number(c.req.query("limit") ?? 24) || 24, 50);
  if (!q) {
    const { body, status, headers } = problem(400, "Bad Request", "Missing required query param: q");
    return c.json(body, status, headers);
  }

  const sql = getDb(c.env);
  const patLower = `%${normalizeLower(q)}%`;
  const patAlnum = `%${normalizeAlnum(q)}%`;

  const rows = await sql<
    {
      variant_id: number;
      display_name: string;
      brand_slug: string;
      model_slug: string;
      last_synced_at: Date | null;
    }[]
  >`
    SELECT v.public_id::int AS variant_id,
           COALESCE(vt.name, v.display_name) AS display_name,
           b.canonical_slug AS brand_slug,
           COALESCE(mt.slug, m.canonical_slug) AS model_slug,
           v.last_synced_at
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

  return c.json(
    envelope(
      rows.map((r) => ({
        variant_id: r.variant_id,
        display_name: r.display_name,
        brand_slug: r.brand_slug,
        model_slug: r.model_slug,
      })),
      { locale, last_synced_at: new Date().toISOString() },
    ),
  );
});
