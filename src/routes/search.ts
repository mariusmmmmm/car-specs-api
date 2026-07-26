import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../lib/db";
import { envelope, problem } from "../lib/response";
import { resolveLocale } from "../lib/locale";
import { searchVariants } from "../lib/queries";

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
  const rows = await searchVariants(sql, locale, q, limit);

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
