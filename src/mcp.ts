import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./types";
import { getDb } from "./lib/db";
import { resolveLocale, SUPPORTED_LOCALES } from "./lib/locale";
import { searchVariants, listGenerationsForModel, filterVariants, getVariantImages } from "./lib/queries";
import { localizeVariantSpecs } from "./lib/localize-variant";

const localeSchema = z.enum(SUPPORTED_LOCALES).optional();

function json(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], isError };
}

// Thin MCP wrapper over the same /v1 read-model (lib/queries.ts, lib/localize-variant.ts)
// — no separate query logic, per BIZ-L2b-mcp-apify-distribution.md §1.
// Phase 1: unauthenticated (rate-limited per-IP in index.ts) for discovery,
// per L2b's explicit design; per-key auth/quota parity with REST is a fast-follow.
export class CarsDataMCP extends McpAgent<Env> {
  server = new McpServer({ name: "cars-data-specs", version: "1.0.0" });

  async init() {
    const env = this.env;

    this.server.registerTool(
      "search_cars",
      {
        description:
          "Free-text search across 102,191 vehicle variants, 116 brands, 19 languages. Returns candidate variant_ids to pass to get_specs/get_images/compare_variants.",
        inputSchema: {
          query: z.string().describe("e.g. 'bmw 3 series' or 'tesla model s'"),
          locale: localeSchema,
          limit: z.number().int().min(1).max(50).optional(),
        },
      },
      async ({ query, locale, limit }) => {
        const sql = getDb(env);
        const rows = await searchVariants(sql, resolveLocale(locale), query, limit ?? 10);
        return json(rows);
      },
    );

    this.server.registerTool(
      "get_specs",
      {
        description:
          "Full localized specs for one vehicle variant, in any of 19 languages — 180 spec types covering engine & fuel, performance, EV/hybrid, safety (30 specs), comfort & interior (47), exterior, chassis, dimensions & weights, consumption (WLTP/NEDC). Each spec carries a confidence score; the response carries last_synced_at — surface both so you don't overstate certainty.",
        inputSchema: {
          variant_id: z.number().int().describe("from search_cars or filter_cars"),
          locale: localeSchema,
        },
      },
      async ({ variant_id, locale }) => {
        const sql = getDb(env);
        const loc = resolveLocale(locale);
        const result = await localizeVariantSpecs(sql, loc, variant_id);
        if (!result) return json({ error: `No variant with id ${variant_id}` }, true);
        return json({
          variant_id,
          locale: loc,
          last_synced_at: result.last_synced_at.toISOString(),
          specs: result.specs,
        });
      },
    );

    this.server.registerTool(
      "compare_variants",
      {
        description: "Side-by-side localized specs for 2-4 vehicle variants.",
        inputSchema: {
          variant_ids: z.array(z.number().int()).min(2).max(4),
          locale: localeSchema,
        },
      },
      async ({ variant_ids, locale }) => {
        const sql = getDb(env);
        const loc = resolveLocale(locale);
        const results = await Promise.all(variant_ids.map((id) => localizeVariantSpecs(sql, loc, id)));
        const missing = variant_ids.filter((_, i) => !results[i]);
        if (missing.length > 0) return json({ error: `No variant(s) with id ${missing.join(", ")}` }, true);
        return json({
          locale: loc,
          data: variant_ids.map((id, i) => ({ variant_id: id, specs: results[i]!.specs })),
        });
      },
    );

    this.server.registerTool(
      "list_generations",
      {
        description: "Generations/facelifts of a model, with production years.",
        inputSchema: { model_id: z.number().int(), locale: localeSchema },
      },
      async ({ model_id, locale }) => {
        const sql = getDb(env);
        const rows = await listGenerationsForModel(sql, resolveLocale(locale), model_id);
        return json(rows);
      },
    );

    this.server.registerTool(
      "filter_cars",
      {
        description:
          "Structured catalog filter: fuel type, body type, drive layout, power/price range, model year, EV-only.",
        inputSchema: {
          fuel: z.string().optional().describe("e.g. petrol, diesel, electric, hybrid"),
          body: z.string().optional().describe("body_slug, e.g. suv, sedan, hatchback"),
          drive: z.string().optional().describe("substring match, e.g. 'front', 'rear', 'all'"),
          power_min: z.number().int().optional(),
          power_max: z.number().int().optional(),
          price_max: z.number().int().optional(),
          year: z.number().int().optional(),
          ev: z.boolean().optional(),
          locale: localeSchema,
          limit: z.number().int().min(1).max(50).optional(),
        },
      },
      async (args) => {
        const sql = getDb(env);
        const rows = await filterVariants(sql, resolveLocale(args.locale), {
          fuel: args.fuel,
          body: args.body,
          drive: args.drive,
          powerMin: args.power_min ?? null,
          powerMax: args.power_max ?? null,
          priceMax: args.price_max ?? null,
          year: args.year ?? null,
          ev: args.ev ?? false,
          limit: args.limit ?? 10,
        });
        return json(rows);
      },
    );

    this.server.registerTool(
      "get_images",
      {
        description: "Image URLs (own CDN, no attribution burden) for a vehicle variant.",
        inputSchema: { variant_id: z.number().int() },
      },
      async ({ variant_id }) => {
        const sql = getDb(env);
        const rows = await getVariantImages(sql, variant_id);
        return json(rows);
      },
    );
  }
}
