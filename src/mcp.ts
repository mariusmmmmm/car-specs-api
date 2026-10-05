import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import type { Env, McpProps } from "./types";
import { resolveLocale, SUPPORTED_LOCALES } from "./lib/locale";
import { recordMcpCall } from "./lib/usage";
import { sourceFor, DEMO_UNSUPPORTED_FILTERS, type McpSource } from "./lib/mcp-source";
import { decodeId } from "./lib/public-id";
import { encodeTree } from "./middleware/opaque-ids";
import { CATALOGUE, n } from "./lib/catalogue-facts";

const localeSchema = z.enum(SUPPORTED_LOCALES).optional();

function json(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], isError };
}

// Thin MCP wrapper over the same /v1 read-model (lib/queries.ts, lib/localize-variant.ts)
// — no separate query logic, per BIZ-L2b-mcp-apify-distribution.md §1.
//
// Two kinds of caller reach it (T92):
//   * a key holder, authenticated in index.ts with the same gate as REST (T73);
//   * an ANONYMOUS caller on the demo scope, which gets a source backed by the
//     pre-rendered blob and no database connection at all.
//
// Anonymous access reverses T73's "MCP needs a key", and only because T73's
// reason no longer applies: it required one because anonymous MCP "put no
// ceiling on what one machine could pull". A surface that can only return 40
// cars has that ceiling built in. What it buys is measured — since T73 shipped,
// MCP calls fell to 0 and `mcp-throttled` rose to 1.009 in a day, all
// `unauthorized`, from 20+ directory probes. Every directory and agent that
// tried the server learned it does not work.
//
// Ids on this surface are OPAQUE, like everywhere else. Until 2026-10-05 the
// tools took `variant_id: number` and handed back raw `public_id` values, which
// put /mcp outside the id gate entirely — the REST surface could have been
// sealed and the catalogue still walkable through here.
export class CarsDataMCP extends McpAgent<Env> {
  server = new McpServer({ name: "cars-data-specs", version: "1.0.0" });

  // One usage datapoint per tool call (BIZ-D7 §5). client = the MCP client's
  // self-reported clientInfo.name from the initialize handshake (distinguishes
  // Claude Desktop / Cursor / ChatGPT connectors / custom agents), falling back
  // to the User-Agent carried in props; actor = the salted IP hash from props.
  private track(tool: string, locale?: string): void {
    const props = this.props as McpProps;
    const client =
      (this.server as McpServer).server.getClientVersion?.()?.name ?? props.ua ?? "-";
    recordMcpCall(
      this.env,
      props.demo ? `${tool}:demo` : tool,
      locale ?? "-",
      client,
      props.keyPrefix ?? props.ipHash ?? "-",
    );
  }

  /** The data source for this call: the blob for an anonymous demo caller, the
   *  database for a key holder. null means the demo blob is not there. */
  private source(locale?: string): Promise<McpSource | null> {
    const props = this.props as McpProps;
    return sourceFor(this.env, { ...props, locale: locale ?? props.locale ?? "en" });
  }

  /** Every id out of this surface is a token. One field table, shared with the
   *  REST gate (middleware/opaque-ids.ts), so the two cannot disagree. */
  private encode(value: unknown): Promise<unknown> {
    return encodeTree(this.env.ID_TOKEN_KEY, value);
  }

  private token(kind: "variant" | "model", raw: string): Promise<number | null> {
    return decodeId(this.env.ID_TOKEN_KEY, kind, raw);
  }

  async init() {
    const unavailable = () =>
      json(
        {
          error:
            "The demo dataset is briefly unavailable. Nothing is wrong with your request — retry shortly. " +
            "A reviewed key covers the whole catalogue: https://cars-data.com/en/api/for-ai-agents",
        },
        true,
      );
    const notInDemo = (what: string) =>
      json(
        {
          error: `${what} is outside the demo set (40 cars). A reviewed key covers all ${n(CATALOGUE.variants)}: https://cars-data.com/en/api/for-ai-agents`,
        },
        true,
      );

    this.server.registerTool(
      "search_cars",
      {
        description:
          `Free-text search across ${n(CATALOGUE.variants)} vehicle variants, ${CATALOGUE.brands} brands, ` +
          `${CATALOGUE.locales} languages. Returns candidate variant_ids to pass to ` +
          "get_specs/get_images/compare_variants. Each result carries generation_id and production years so " +
          "same-named variants from different generations can be told apart. " +
          "Without an API key this answers from a fixed 40-car demo set; a free reviewed key opens the whole catalogue.",
        inputSchema: {
          query: z.string().describe("e.g. 'bmw 3 series' or 'tesla model s'"),
          locale: localeSchema,
          limit: z.number().int().min(1).max(50).optional(),
        },
      },
      async ({ query, locale, limit }) => {
        this.track("search_cars", locale);
        const src = await this.source(locale);
        if (!src) return unavailable();
        const rows = await src.search(resolveLocale(locale), query, limit ?? 10);
        return json(await this.encode(rows));
      },
    );

    this.server.registerTool(
      "get_specs",
      {
        description:
          `Full localized specs for one vehicle variant, in any of ${CATALOGUE.locales} languages — ` +
          `${CATALOGUE.specTypesDefined} spec types covering engine & fuel, performance, EV/hybrid, safety, comfort & ` +
          "interior, exterior, chassis, dimensions & weights, consumption (WLTP/NEDC). Each spec carries a " +
          "confidence score; the response carries last_synced_at — surface both so you don't overstate certainty.",
        inputSchema: {
          variant_id: z.string().describe("opaque variant id from search_cars or filter_cars, e.g. v_1a2b3c4d"),
          locale: localeSchema,
        },
      },
      async ({ variant_id, locale }) => {
        this.track("get_specs", locale);
        const src = await this.source(locale);
        if (!src) return unavailable();
        const id = await this.token("variant", variant_id);
        // A guessed token and a car that is not there answer identically.
        if (id === null) return json({ error: `No variant with id ${variant_id}` }, true);
        const loc = resolveLocale(locale);
        const result = await src.specs(loc, id);
        if (!result) return src.demo ? notInDemo(variant_id) : json({ error: `No variant with id ${variant_id}` }, true);
        return json({
          variant_id,
          locale: loc,
          last_synced_at: result.last_synced_at,
          specs: result.specs,
        });
      },
    );

    this.server.registerTool(
      "compare_variants",
      {
        description: "Side-by-side localized specs for 2-4 vehicle variants.",
        inputSchema: {
          variant_ids: z.array(z.string()).min(2).max(4).describe("opaque variant ids from search_cars"),
          locale: localeSchema,
        },
      },
      async ({ variant_ids, locale }) => {
        this.track("compare_variants", locale);
        const src = await this.source(locale);
        if (!src) return unavailable();
        const ids = await Promise.all(variant_ids.map((t) => this.token("variant", t)));
        const badAt = ids.findIndex((id) => id === null);
        if (badAt !== -1) return json({ error: `Not a valid variant id: ${variant_ids[badAt]}` }, true);
        const loc = resolveLocale(locale);
        const results = await Promise.all((ids as number[]).map((id) => src.specs(loc, id)));
        const missingAt = results.findIndex((r) => !r);
        if (missingAt !== -1) {
          return src.demo
            ? notInDemo(variant_ids[missingAt])
            : json({ error: `No variant with id ${variant_ids[missingAt]}` }, true);
        }
        return json({
          locale: loc,
          data: variant_ids.map((token, i) => ({ variant_id: token, specs: results[i]!.specs })),
        });
      },
    );

    this.server.registerTool(
      "list_generations",
      {
        description: "Generations/facelifts of a model, with production years.",
        inputSchema: {
          model_id: z.string().describe("opaque model id, e.g. m_1a2b3c4d"),
          locale: localeSchema,
        },
      },
      async ({ model_id, locale }) => {
        this.track("list_generations", locale);
        const src = await this.source(locale);
        if (!src) return unavailable();
        const id = await this.token("model", model_id);
        if (id === null) return json({ error: `No model with id ${model_id}` }, true);
        const rows = await src.generations(resolveLocale(locale), id);
        return json(await this.encode(rows));
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
        this.track("filter_cars", args.locale);
        const src = await this.source(args.locale);
        if (!src) return unavailable();
        const rows = await src.filter(resolveLocale(args.locale), {
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
        // Say which filters the demo could not honour. Silently ignoring one
        // would make an agent conclude the DATA has no drive layout, which is
        // a worse outcome than a short refusal.
        const ignored = src.demo
          ? DEMO_UNSUPPORTED_FILTERS.filter((k) => args[k as "drive" | "year"] !== undefined)
          : [];
        return json({
          data: await this.encode(rows),
          ...(src.demo ? { demo: true, ignored_filters: ignored } : {}),
        });
      },
    );

    this.server.registerTool(
      "get_images",
      {
        description: "Image URLs (own CDN, no attribution burden) for a vehicle variant.",
        inputSchema: { variant_id: z.string().describe("opaque variant id from search_cars") },
      },
      async ({ variant_id }) => {
        this.track("get_images");
        const src = await this.source();
        if (!src) return unavailable();
        const id = await this.token("variant", variant_id);
        if (id === null) return json({ error: `No variant with id ${variant_id}` }, true);
        return json(await this.encode(await src.images(id)));
      },
    );
  }
}
