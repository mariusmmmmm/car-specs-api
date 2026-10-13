import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withX402 } from "agents/x402";
import { z } from "zod";
import { resolveLocale, SUPPORTED_LOCALES } from "./lib/locale";
import { DEMO_UNSUPPORTED_FILTERS, type McpSource } from "./lib/mcp-source";
import { CATALOGUE, n } from "./lib/catalogue-facts";
import { DEMO_SET_SIZE } from "./lib/demo-set";
import type { X402Settings } from "./lib/x402-config";
import type { searchVariants } from "./lib/queries";
import type { localizeVariantSpecs } from "./lib/localize-variant";

// The eight MCP tools, outside src/mcp.ts (T286).
//
// mcp.ts extends McpAgent from agents/mcp, which imports `cloudflare:workers`
// and cannot load under vitest — the same wall T152 hit with index.ts. While
// the tools lived there, nothing could run tools/list or call a tool in a test.
// That mattered once the tools declared an outputSchema: the SDK REJECTS a
// successful result whose structuredContent does not parse against it, so a
// schema that drifts from the handler turns a working tool into an error —
// and on the two paid tools, an error AFTER the payment settled. Here the real
// McpServer can be connected to a real Client in a test, which validates the
// output a second time with ajv, the way a client in the field does.
//
// mcp.ts keeps what is Worker-specific (props, env, telemetry) and hands this
// module a ToolContext.

type IdKey = "variant_id" | "generation_id" | "model_id";

/** What encodeTree() does to a value, as a type: the three id fields go from
 *  internal integers to opaque string tokens; nothing else changes. */
export type Tokenized<T> = T extends readonly (infer U)[]
  ? Tokenized<U>[]
  : T extends Date
    ? T
    : T extends object
      ? { [K in keyof T]: K extends IdKey ? (null extends T[K] ? string | null : string) : Tokenized<T[K]> }
      : T;

export type ToolContext = {
  track(tool: string, locale?: string): void;
  /** null = the demo blob is not there. */
  source(locale?: string): Promise<McpSource | null>;
  encode<T>(value: T): Promise<Tokenized<T>>;
  token(kind: "variant" | "model", raw: string): Promise<number | null>;
};

/** The database reads behind the paid tools. Injected so the module never
 *  opens a connection itself — mcp.ts binds them to getDb(env). */
export type PaidQueries = {
  search(locale: string, query: string, limit: number): ReturnType<typeof searchVariants>;
  specs(locale: string, variantId: number): ReturnType<typeof localizeVariantSpecs>;
};

// ── input parameters ────────────────────────────────────────────────────────

const localeParam = z
  .enum(SUPPORTED_LOCALES)
  .optional()
  .describe(
    `Response language, one of the ${CATALOGUE.locales} published languages ` +
      `(${SUPPORTED_LOCALES.join(", ")}). Spec labels and enum values come back translated. Default: en.`,
  );

const limitParam = z.number().int().min(1).max(50).optional().describe("Maximum number of results, 1–50. Default: 10.");

const queryParam = (min?: number) =>
  (min ? z.string().min(min) : z.string()).describe(
    "Free text matched against brand, model and variant names, accent- and punctuation-insensitive — " +
      "e.g. 'bmw 3 series' or 'tesla model s'.",
  );

// ── output schemas ──────────────────────────────────────────────────────────
//
// looseObject, not object: zod's strict default becomes
// `additionalProperties: false` in the published JSON Schema, and a client that
// validates (the SDK's Client does, with ajv) would then reject every response
// the day a row gains a field. Listed fields are a promise; the rest is not
// forbidden.

const variantToken = z.string().describe("Opaque variant id, e.g. v_1a2b3c4d. Pass it to get_specs / get_images / compare_variants.");

const specEntry = z.looseObject({
  label: z.string().describe("Spec name in the requested language"),
  // Optional because it is, measured: variant_doc holds `{"c": 0.9}` shells
  // with no value (2,132 in cars_v3 on 2026-10-13; 2 of the 40 demo cars), and
  // localizeSpec leaves `value` undefined, so JSON drops the key. Required
  // here, the SDK would have failed those calls.
  value: z
    .unknown()
    .optional()
    .describe("The value: a string, number or boolean, already localized. Absent when the source holds no value"),
  unit: z.string().nullable().describe("Unit of the value (km, kW, l/100km, …); null when unitless"),
  confidence: z.number().nullable().describe("Confidence score 0–1 for this value; null when not scored"),
});

const specsRecord = z
  .record(z.string(), specEntry)
  .describe("Every spec the variant carries, keyed by spec key (e.g. range_wltp_km)");

const carRow = z.looseObject({
  variant_id: variantToken,
  generation_id: z.string().describe("Opaque generation id — tells same-named variants of different generations apart"),
  model_id: z.string().describe("Opaque model id, e.g. m_1a2b3c4d. Pass it to list_generations."),
  display_name: z.string().describe("Full variant name"),
  brand: z.string(),
  model: z.string(),
  generation: z.string().describe("Generation name"),
  fuel_slug: z.string().describe("Fuel type, English label (e.g. Electric, Petrol)"),
  body_type_en: z.string().nullable().describe("Body type, English label"),
  years: z.string().nullable().describe("Production years, e.g. '2019–2024'; an open range '2021–' is still in production"),
  power_hp: z.number().nullable().describe("Power, hp"),
  battery_kwh: z.number().nullable().describe("Traction battery capacity, kWh; null without one"),
  price_new_eur: z.number().nullable().describe("New list price, EUR"),
});

const generationRow = z.looseObject({
  generation_id: z.string().describe("Opaque generation id"),
  model_id: z.string().describe("Opaque model id"),
  display_name: z.string().describe("Generation / facelift name"),
  years: z.string().nullable().describe("Production years, e.g. '2019–2024'; '2021–' is still in production"),
});

const imageRow = z.looseObject({
  url: z.string().describe("Image URL on the cars-data.com CDN"),
  variant: z.enum(["hero", "card"]).describe("hero = large lead image, card = thumbnail-size"),
});

const catalogueRow = z.looseObject({
  variant_id: z.string().describe("Opaque variant id, e.g. v_1a2b3c4d. Pass it to get_specs_full."),
  display_name: z.string().describe("Full variant name, localized when a translation exists"),
  brand_slug: z.string(),
  model_slug: z.string(),
  generation_id: z.string().describe("Opaque generation id"),
  year_from: z.number().nullable().describe("First production year of the generation"),
  year_to: z.number().nullable().describe("Last production year; 0 or null while still in production"),
});

const lastSynced = z.string().describe("ISO-8601 time the data was last synced — surface it with the specs");
const localeOut = z.enum(SUPPORTED_LOCALES).describe("Language the response is in");

export const OUTPUT = {
  search_cars: z.looseObject({ data: z.array(carRow).describe("Matches, best first; empty when nothing matches") }),
  get_specs: z.looseObject({
    variant_id: variantToken,
    locale: localeOut,
    last_synced_at: lastSynced,
    specs: specsRecord,
  }),
  compare_variants: z.looseObject({
    locale: localeOut,
    data: z
      .array(z.looseObject({ variant_id: variantToken, specs: specsRecord }))
      .describe("One entry per requested variant, in the order asked"),
  }),
  list_generations: z.looseObject({ data: z.array(generationRow).describe("Generations of the model") }),
  filter_cars: z.looseObject({
    data: z.array(carRow).describe("Matches; empty when nothing matches"),
    demo: z.boolean().optional().describe("true when answered from the demo set"),
    ignored_filters: z
      .array(z.string())
      .optional()
      .describe("Filters you passed that the demo set cannot apply — results are NOT narrowed by them"),
  }),
  get_images: z.looseObject({ data: z.array(imageRow).describe("Images of the variant; empty when it has none") }),
  search_catalogue: z.looseObject({ data: z.array(catalogueRow).describe("Matches, most powerful first") }),
  get_specs_full: z.looseObject({
    variant_id: variantToken,
    locale: localeOut,
    display_name: z.string().describe("Full variant name"),
    brand_slug: z.string(),
    model_slug: z.string(),
    year_from: z.number().nullable().describe("First production year"),
    year_to: z.number().nullable().describe("Last production year; 0 or null while still in production"),
    power_hp: z.number().nullable().describe("Power, hp"),
    battery_kwh: z.number().nullable().describe("Traction battery capacity, kWh"),
    top_speed_kmh: z.number().nullable().describe("Top speed, km/h"),
    torque_nm: z.number().nullable().describe("Torque, Nm"),
    accel_0_100_s: z.number().nullable().describe("0–100 km/h, seconds"),
    price_new_eur: z.number().nullable().describe("New list price, EUR"),
    last_synced_at: lastSynced,
    specs: specsRecord,
  }),
} as const;

type ToolName = keyof typeof OUTPUT;

// ── results ─────────────────────────────────────────────────────────────────

/** An error result. isError skips the SDK's output validation, so errors keep
 *  their own free shape. */
export function failure(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], isError: true };
}

/** A success result that honours the tool's outputSchema: the same object as
 *  structuredContent and, serialized, as the text block (MCP spec: tools with
 *  structured output SHOULD mirror it in text for older clients). Typed
 *  against the schema, so tsc rejects a handler that drifts from it. */
function ok<T extends ToolName>(_tool: T, value: z.input<(typeof OUTPUT)[T]>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/** Every demo tool only reads a frozen, pre-rendered set. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false, idempotentHint: true } as const;

// ── the six demo tools ──────────────────────────────────────────────────────

export function registerDemoTools(server: McpServer, ctx: ToolContext): void {
  const unavailable = () =>
    failure({
      error:
        "The demo dataset is briefly unavailable. Nothing is wrong with your request — retry shortly. " +
        "The full catalogue is a licensed export: https://cars-data.com/en/api",
    });
  const notInDemo = (what: string) =>
    failure({
      error: `${what} is outside the demo set (${DEMO_SET_SIZE} cars) — the only self-serve tier. All ${n(CATALOGUE.variants)} variants are licensed as an export: https://cars-data.com/en/api`,
    });
  const noVariant = (id: string) => failure({ error: `No variant with id ${id}` });

  server.registerTool(
    "search_cars",
    {
      title: "Search cars",
      description:
        `Free-text search across ${n(CATALOGUE.variants)} vehicle variants, ${CATALOGUE.brands} brands, ` +
        `${CATALOGUE.locales} languages. Returns candidate variant_ids to pass to ` +
        "get_specs/get_images/compare_variants. Each result carries generation_id and production years so " +
        "same-named variants from different generations can be told apart. " +
        `Without a key — or with a self-serve demo key — this answers from a fixed ${DEMO_SET_SIZE}-car demo set; the full catalogue is a licensed export.`,
      inputSchema: { query: queryParam(), locale: localeParam, limit: limitParam },
      outputSchema: OUTPUT.search_cars,
      annotations: READ_ONLY,
    },
    async ({ query, locale, limit }) => {
      ctx.track("search_cars", locale);
      const src = await ctx.source(locale);
      if (!src) return unavailable();
      const rows = await src.search(resolveLocale(locale), query, limit ?? 10);
      return ok("search_cars", { data: await ctx.encode(rows) });
    },
  );

  server.registerTool(
    "get_specs",
    {
      title: "Get variant specs",
      description:
        `Full localized specs for one vehicle variant, in any of ${CATALOGUE.locales} languages — ` +
        `${CATALOGUE.specTypesDefined} spec types covering engine & fuel, performance, EV/hybrid, safety, comfort & ` +
        "interior, exterior, chassis, dimensions & weights, consumption (WLTP/NEDC). Each spec carries a " +
        "confidence score; the response carries last_synced_at — surface both so you don't overstate certainty.",
      inputSchema: {
        variant_id: z.string().describe("Opaque variant id from search_cars or filter_cars, e.g. v_1a2b3c4d"),
        locale: localeParam,
      },
      outputSchema: OUTPUT.get_specs,
      annotations: READ_ONLY,
    },
    async ({ variant_id, locale }) => {
      ctx.track("get_specs", locale);
      const src = await ctx.source(locale);
      if (!src) return unavailable();
      const id = await ctx.token("variant", variant_id);
      // A guessed token and a car that is not there answer identically.
      if (id === null) return noVariant(variant_id);
      const loc = resolveLocale(locale);
      const result = await src.specs(loc, id);
      if (!result) return src.demo ? notInDemo(variant_id) : noVariant(variant_id);
      return ok("get_specs", {
        variant_id,
        locale: loc,
        last_synced_at: result.last_synced_at,
        specs: result.specs,
      });
    },
  );

  server.registerTool(
    "compare_variants",
    {
      title: "Compare variants",
      description: "Side-by-side localized specs for 2-4 vehicle variants.",
      inputSchema: {
        variant_ids: z
          .array(z.string())
          .min(2)
          .max(4)
          .describe("2 to 4 opaque variant ids from search_cars or filter_cars, e.g. ['v_1a2b3c4d', 'v_5e6f7a8b']"),
        locale: localeParam,
      },
      outputSchema: OUTPUT.compare_variants,
      annotations: READ_ONLY,
    },
    async ({ variant_ids, locale }) => {
      ctx.track("compare_variants", locale);
      const src = await ctx.source(locale);
      if (!src) return unavailable();
      const ids = await Promise.all(variant_ids.map((t) => ctx.token("variant", t)));
      const badAt = ids.findIndex((id) => id === null);
      if (badAt !== -1) return failure({ error: `Not a valid variant id: ${variant_ids[badAt]}` });
      const loc = resolveLocale(locale);
      const results = await Promise.all((ids as number[]).map((id) => src.specs(loc, id)));
      const missingAt = results.findIndex((r) => !r);
      if (missingAt !== -1) {
        return src.demo ? notInDemo(variant_ids[missingAt]) : noVariant(variant_ids[missingAt]);
      }
      return ok("compare_variants", {
        locale: loc,
        data: variant_ids.map((token, i) => ({ variant_id: token, specs: results[i]!.specs })),
      });
    },
  );

  server.registerTool(
    "list_generations",
    {
      title: "List generations of a model",
      description: "Generations/facelifts of a model, with production years.",
      inputSchema: {
        model_id: z.string().describe("Opaque model id from a search_cars or filter_cars result, e.g. m_1a2b3c4d"),
        locale: localeParam,
      },
      outputSchema: OUTPUT.list_generations,
      annotations: READ_ONLY,
    },
    async ({ model_id, locale }) => {
      ctx.track("list_generations", locale);
      const src = await ctx.source(locale);
      if (!src) return unavailable();
      const id = await ctx.token("model", model_id);
      if (id === null) return failure({ error: `No model with id ${model_id}` });
      const rows = await src.generations(resolveLocale(locale), id);
      return ok("list_generations", { data: await ctx.encode(rows) });
    },
  );

  const notInDemoNote = "Not applied by the demo set — reported back in ignored_filters.";
  server.registerTool(
    "filter_cars",
    {
      title: "Filter cars",
      description:
        "Structured catalog filter: fuel type, body type, drive layout, power/price range, model year, EV-only.",
      inputSchema: {
        fuel: z
          .string()
          .optional()
          .describe("Fuel type, case-insensitive substring of the English label — e.g. petrol, diesel, electric, hybrid"),
        body: z
          .string()
          .optional()
          .describe("Body type, case-insensitive substring of the English label — e.g. suv, sedan, hatchback"),
        drive: z.string().optional().describe(`Drive layout, substring match — e.g. 'front', 'rear', 'all'. ${notInDemoNote}`),
        power_min: z.number().int().optional().describe("Minimum power, hp"),
        power_max: z.number().int().optional().describe("Maximum power, hp"),
        price_max: z.number().int().optional().describe("Maximum new list price, EUR"),
        year: z.number().int().optional().describe(`Production year the generation covers, e.g. 2022. ${notInDemoNote}`),
        ev: z
          .boolean()
          .optional()
          .describe("true = only variants with a traction battery (battery_kwh set: electric and plug-in). Default: false"),
        locale: localeParam,
        limit: limitParam,
      },
      outputSchema: OUTPUT.filter_cars,
      annotations: READ_ONLY,
    },
    async (args) => {
      ctx.track("filter_cars", args.locale);
      const src = await ctx.source(args.locale);
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
      return ok("filter_cars", {
        data: await ctx.encode(rows),
        ...(src.demo ? { demo: true, ignored_filters: ignored } : {}),
      });
    },
  );

  server.registerTool(
    "get_images",
    {
      title: "Get variant images",
      description: "Image URLs (own CDN, no attribution burden) for a vehicle variant.",
      inputSchema: {
        variant_id: z.string().describe("Opaque variant id from search_cars or filter_cars, e.g. v_1a2b3c4d"),
      },
      outputSchema: OUTPUT.get_images,
      annotations: READ_ONLY,
    },
    async ({ variant_id }) => {
      ctx.track("get_images");
      const src = await ctx.source();
      if (!src) return unavailable();
      const id = await ctx.token("variant", variant_id);
      if (id === null) return noVariant(variant_id);
      return ok("get_images", { data: await ctx.encode(await src.images(id)) });
    },
  );
}

// ── the two paid tools ──────────────────────────────────────────────────────

/** The paid callbacks, exported so a test can run them without a payment —
 *  withX402 only calls them after the facilitator verified one. */
export function paidHandlers(ctx: ToolContext, q: PaidQueries) {
  return {
    async search_catalogue({ query, locale, limit }: { query: string; locale?: string; limit?: number }) {
      ctx.track("search_catalogue:paid", locale);
      const rows = await q.search(resolveLocale(locale), query, limit ?? 10);
      if (rows.length === 0) return failure({ error: `No variant matches "${query}"` });
      return ok("search_catalogue", { data: await ctx.encode([...rows]) });
    },

    async get_specs_full({ variant_id, locale }: { variant_id: string; locale?: string }) {
      ctx.track("get_specs_full:paid", locale);
      const id = await ctx.token("variant", variant_id);
      if (id === null) return failure({ error: `No variant with id ${variant_id}` });
      const loc = resolveLocale(locale);
      const result = await q.specs(loc, id);
      if (!result) return failure({ error: `No variant with id ${variant_id}` });
      return ok("get_specs_full", {
        variant_id,
        locale: loc,
        // Sumarul variantei (T264). Aici se poate, fiindcă `get_specs_full`
        // cheamă `localizeVariantSpecs` DIRECT. `get_specs` şi
        // `compare_variants` trec prin `McpSource`, al cărui `SpecsResult`
        // n-are `summary`, iar implementarea lui demo construieşte dintr-un
        // blob îngheţat fără brand_slug / year_from / top_speed / torque /
        // accel. Alinierea lor cere regenerat blobul — task separat, nu
        // strecurat într-o livrare de contract.
        ...result.summary,
        last_synced_at: result.last_synced_at.toISOString(),
        specs: result.specs,
      });
    },
  };
}

/** The full catalogue, per call, paid with x402 v2 (T216).
 *
 *  mcp-source.ts says MCP is the demo surface "always, for anyone", and that
 *  a paid MCP would have to be "a deliberate construction, not a flag flip".
 *  This is that construction, and it keeps the property sourceFor() was
 *  protecting: the six demo tools still never see a database connection.
 *  Only these two do, and only inside the callback that withX402 runs AFTER
 *  the facilitator verified the payment. There is no branch on a key, a plan
 *  or a prop that could hand the database to an unpaid caller.
 *
 *  A callback that answers isError — unknown id, nothing found — is NOT
 *  settled (agents/x402 skips settlement on a failed result), so a guessed
 *  token costs the caller nothing.
 *
 *  paidTool() takes no title or outputSchema, so both are set on the
 *  RegisteredTool it returns. Validation runs on the result the wrapper hands
 *  back: its payment-required answers are isError and skip it. */
export function registerPaidTools(server: McpServer, s: X402Settings, ctx: ToolContext, q: PaidQueries): void {
  const paid = withX402(server, {
    network: s.network,
    recipient: s.payTo,
    facilitator: { url: s.facilitatorUrl, timeoutMs: 15_000 },
  });
  const h = paidHandlers(ctx, q);
  // Not idempotentHint: a repeated call is charged again.
  const annotations = { readOnlyHint: true, openWorldHint: false };

  const searchTool = paid.paidTool(
      "search_catalogue",
      `Search all ${n(CATALOGUE.variants)} variants (not only the ${DEMO_SET_SIZE}-car demo). Returns opaque variant_ids for ` +
        `get_specs_full. Paid per call with x402 (USDC) — $${s.searchPriceUsd}.`,
      s.searchPriceUsd,
      { query: queryParam(2), locale: localeParam, limit: limitParam },
      annotations,
      h.search_catalogue,
    );

  const specsTool = paid.paidTool(
      "get_specs_full",
      `Full localized specs for ANY variant in the catalogue, in ${CATALOGUE.locales} languages. ` +
        `Paid per call with x402 (USDC) — $${s.specsPriceUsd}. Not charged when the id is unknown.`,
      s.specsPriceUsd,
      {
        variant_id: z.string().describe("Opaque variant id from search_catalogue, e.g. v_1a2b3c4d"),
        locale: localeParam,
      },
      annotations,
      h.get_specs_full,
    );

  // Assigned, not passed to update(): update() takes a raw shape and rebuilds
  // it as a STRICT object, which would publish `additionalProperties: false`
  // and drop the looseObject reasoning above. Registration happens in init(),
  // before any client is connected, so no list_changed is owed.
  searchTool.title = "Search the full catalogue (paid)";
  searchTool.outputSchema = OUTPUT.search_catalogue;
  specsTool.title = "Get full specs, any variant (paid)";
  specsTool.outputSchema = OUTPUT.get_specs_full;
}
