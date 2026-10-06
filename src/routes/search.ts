import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { getDb } from "../lib/db";
import { envelope, problem } from "../lib/response";
import { resolveLocale } from "../lib/locale";
import { parsePaging, nextLink } from "../lib/pagination";
import { searchVariants } from "../lib/queries";

export const search = new Hono<{ Bindings: Env; Variables: Variables }>();

// Simplified port of v3/lib/server/search.ts's trigram matching: same
// f_unaccent_lower/f_unaccent_alnum columns, single-phrase match instead of
// the full per-word AND-of-OR + NL filter parser (year/power/fuel/body
// tokens). Structured filtering has its own endpoint (/v1/variants); this
// one is the typeahead the MCP `search_cars` tool calls.
search.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  const locale = resolveLocale(c.req.query("locale"));
  const { limit, offset } = await parsePaging(c);
  if (!q) {
    const { body, status, headers } = problem(400, "Bad Request", "Missing required query param: q");
    return c.json(body, status, headers);
  }

  const sql = getDb(c.env);
  const rows = await searchVariants(sql, locale, q, limit, offset);

  return c.json(
    envelope(
      rows.map((r) => ({
        variant_id: r.variant_id,
        display_name: r.display_name,
        brand_slug: r.brand_slug,
        model_slug: r.model_slug,
        generation_id: r.generation_id,
        year_from: r.year_from,
        year_to: r.year_to,
      })),
      { locale, last_synced_at: new Date().toISOString() },
      nextLink(rows.length, limit, offset),
    ),
  );
});
