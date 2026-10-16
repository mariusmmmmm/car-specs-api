import { describe, test, expect, vi, beforeAll } from "vitest";

// T286 — what a directory (Smithery) and a client read from tools/list, and
// whether the tools honour it. Runs the REAL McpServer from src/mcp-tools.ts
// against the REAL SDK Client over an in-memory transport: the server checks
// structuredContent against outputSchema with zod, and the Client checks it a
// second time with ajv against the published JSON Schema, as a client in the
// field does. A schema that drifts from its handler fails here, not on a live
// call — and on a paid tool a live failure would come AFTER settlement.

const FAKE_IDS = new Set(Array.from({ length: 40 }, (_, i) => 2000 + i));
vi.mock("../src/lib/demo-set", () => ({
  DEMO_VARIANT_IDS: FAKE_IDS, DEMO_GENERATION_IDS: new Set([700]), DEMO_MODEL_IDS: new Set([80]),
  DEMO_SET_SIZE: 40, DEMO_SET_DESCRIPTION: "test set", demoSetReady: () => FAKE_IDS.size === 40,
}));
vi.mock("../src/lib/db", () => ({
  getDb: () => { throw new Error("a tool opened a database connection"); },
}));

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Ajv } = await import("ajv");
const { registerDemoTools, registerPaidTools, paidHandlers, OUTPUT } = await import("../src/mcp-tools");
const { demoSource } = await import("../src/lib/mcp-source");
const { encodeTree } = await import("../src/middleware/opaque-ids");
const { encodeId, decodeId } = await import("../src/lib/public-id");
const { CATALOGUE, n } = await import("../src/lib/catalogue-facts");
const { SUPPORTED_LOCALES } = await import("../src/lib/locale");

const SECRET = "test-secret-at-least-16-chars-long";

const v = (id: number, over: Record<string, unknown> = {}) => ({
  variant_id: id, generation_id: 700, model_id: 80,
  brand: "BMW", model: "i3", generation: "i3",
  display_name: `BMW i3 ${String.fromCharCode(65 + (id % 26))}`,
  fuel: "Electric", body_type: "Hatchback", years: "2013–2022",
  power_hp: 170, battery_kwh: 42.2, price_new_eur: 39000,
  specs: {
    range_wltp_km: { label: "Range", value: "310 km", unit: "km", confidence: 0.9 },
    turbocharged: { label: "Turbo", value: false, unit: null, confidence: null },
    // Measured on the live demo blob (2 of 40 cars) and in cars_v3 (2,132
    // entries): variant_doc carries `{"c": 0.9}` shells with no value, which
    // localizeSpec turns into an entry WITHOUT a `value` key. A schema that
    // required it would turn those get_specs calls into errors.
    service_interval: { label: "Service interval", unit: null, confidence: 0.9 },
  },
  images: [{ url: "https://cdn.example/i3.jpg", variant: "hero" }],
  ...over,
});

const PAYLOAD = {
  schema: 1, locale: "en", built_at: "2026-10-05T00:00:00.000Z", set_description: "test set",
  variants: [
    v(2000),
    v(2001, { brand: "Ford", model: "Focus", fuel: "LPG", battery_kwh: null, power_hp: 115, body_type: null, years: null }),
    ...Array.from({ length: 38 }, (_, i) => v(2002 + i)),
  ],
};

const env = {
  ID_TOKEN_KEY: SECRET,
  API_KEYS: { async get(k: string) { return k.startsWith("demo:v1:") ? JSON.stringify(PAYLOAD) : null; } },
} as never;

const tracked: string[] = [];
const ctx = {
  track: (tool: string) => void tracked.push(tool),
  source: () => demoSource(env, "en"),
  encode: <T,>(value: T) => encodeTree(SECRET, value) as never,
  token: (kind: "variant" | "model", raw: string) => decodeId(SECRET, kind, raw),
};

const x402 = {
  payTo: "0x1111111111111111111111111111111111111111" as const,
  network: "eip155:84532",
  facilitatorUrl: "https://x402.org/facilitator",
  specsPriceUsd: 0.05,
  searchPriceUsd: 0.01,
  filterPriceUsd: 0.005,
  comparePriceUsd: 0.1,
};

const FILTER_ROW = {
  variant_id: 2000, generation_id: 700, display_name: "BMW i3 A", power_hp: 170, battery_kwh: "42.2",
  top_speed_kmh: 150, torque_nm: 250, accel_0_100_s: "7.3", fuel_slug: "electric", body_type_en: "Hatchback",
  price_new_eur: 39000, last_synced_at: new Date("2026-10-10T00:00:00Z"),
};

const paidQueries = {
  search: async () =>
    [{ variant_id: 2000, display_name: "BMW i3 A", brand_slug: "bmw", model_slug: "i3",
       generation_id: 700, year_from: 2013, year_to: 0 }] as never,
  specs: async (_l: string, id: number) =>
    id === 2000
      ? ({
          specs: PAYLOAD.variants[0].specs,
          last_synced_at: new Date("2026-10-10T00:00:00Z"),
          summary: {
            display_name: "BMW i3 A", brand_slug: "bmw", model_slug: "i3", year_from: 2013, year_to: null,
            power_hp: 170, battery_kwh: 42.2, top_speed_kmh: 150, torque_nm: 250, accel_0_100_s: 7.3,
            price_new_eur: null,
          },
        } as never)
      : null,
  // T334 — a page of exactly `limit` rows, so next_cursor is exercised.
  filter: async (_l: string, f: { limit?: number }) =>
    Array.from({ length: f.limit ?? 24 }, (_, i) => ({ ...FILTER_ROW, variant_id: 2000 + i })) as never,
};

type ListedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { properties?: Record<string, { description?: string }> };
  outputSchema?: { type?: string; properties?: Record<string, unknown>; additionalProperties?: unknown };
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean; idempotentHint?: boolean };
};

let client: InstanceType<typeof Client>;
let tools: ListedTool[];

beforeAll(async () => {
  const server = new McpServer({ name: "cars-data-specs", version: "test" });
  registerDemoTools(server, ctx, x402);
  registerPaidTools(server, x402, ctx, paidQueries);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "t286-test", version: "1" });
  await client.connect(b);
  tools = (await client.listTools()).tools as ListedTool[];
});

const DEMO = ["search_cars", "get_specs", "compare_variants", "list_generations", "filter_cars", "get_images"];
const PAID = ["search_catalogue", "get_specs_full", "filter_catalogue", "compare_full"];

type CallResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as unknown as CallResult;

describe("tools/list — the metadata a directory scores (T286)", () => {
  test("all ten tools are listed", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...DEMO, ...PAID].sort());
  });

  // T334 — the demo is the shop window; its description must name the door
  // that opens, with the price, not the export an agent cannot buy.
  test.each([
    ["search_cars", "search_catalogue", x402.searchPriceUsd],
    ["get_specs", "get_specs_full", x402.specsPriceUsd],
    ["compare_variants", "compare_full", x402.comparePriceUsd],
    ["filter_cars", "filter_catalogue", x402.filterPriceUsd],
  ])("%s names its paid pair %s and its price", (demoTool, paidTool, price) => {
    const d = tools.find((t) => t.name === demoTool)!.description!;
    expect(d).toContain(paidTool);
    expect(d).toContain(`$${price}`);
    expect(d).toContain("x402");
    expect(d).not.toMatch(/licensed export\.$/);
  });

  test("the demo tools without a paid pair still name all three doors", () => {
    for (const name of ["list_generations", "get_images"]) {
      const d = tools.find((t) => t.name === name)!.description!;
      expect(d).toContain("x402");
      expect(d).toContain("apify.com/carsdatacom/car-specs-api");
      expect(d).toContain("cars-data.com/en/api");
    }
  });

  test("with x402 OFF the demo names the other two doors and NO paid tool", async () => {
    const server = new McpServer({ name: "off", version: "test" });
    registerDemoTools(server, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "off", version: "1" });
    await c.connect(b);
    const listed = (await c.listTools()).tools as ListedTool[];
    expect(listed.map((t) => t.name).sort()).toEqual([...DEMO].sort());
    for (const t of listed) {
      expect(t.description).not.toContain("search_catalogue");
      expect(t.description).not.toContain("get_specs_full");
      expect(t.description).toContain("apify.com/carsdatacom/car-specs-api");
    }
    const r = (await c.callTool({ name: "search_cars", arguments: { query: "i3" } })) as unknown as CallResult;
    expect(r.structuredContent!.full_catalogue).toBeUndefined();
  });

  test("every parameter of every tool carries a description", () => {
    const missing = tools.flatMap((t) =>
      Object.entries(t.inputSchema.properties ?? {})
        .filter(([, p]) => !p.description || p.description.trim().length < 10)
        .map(([k]) => `${t.name}.${k}`),
    );
    expect(missing).toEqual([]);
    // and the ones Smithery flagged are among them, not vacuously absent
    const filter = tools.find((t) => t.name === "filter_cars")!;
    for (const k of ["power_min", "power_max", "price_max", "year", "ev", "locale", "limit"]) {
      expect(filter.inputSchema.properties?.[k]?.description, k).toBeTruthy();
    }
  });

  test("every tool declares an object outputSchema that does not forbid future fields", () => {
    for (const t of tools) {
      expect(t.outputSchema?.type, t.name).toBe("object");
      expect(Object.keys(t.outputSchema?.properties ?? {}).length, t.name).toBeGreaterThan(0);
      expect(t.outputSchema?.additionalProperties, t.name).not.toBe(false);
    }
  });

  test("every tool is annotated read-only and closed-world; demo tools also idempotent", () => {
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.openWorldHint, t.name).toBe(false);
      expect(t.title, t.name).toBeTruthy();
    }
    for (const name of DEMO) expect(tools.find((t) => t.name === name)!.annotations?.idempotentHint, name).toBe(true);
    // a repeated paid call is charged again — not idempotent
    for (const name of PAID) expect(tools.find((t) => t.name === name)!.annotations?.idempotentHint, name).toBeUndefined();
  });

  test("published numbers come from catalogue-facts, not from a hand-typed copy", () => {
    const desc = (name: string) => tools.find((t) => t.name === name)!.description!;
    expect(desc("search_cars")).toContain(n(CATALOGUE.variants));
    expect(desc("search_cars")).toContain(`${CATALOGUE.brands} brands`);
    expect(desc("get_specs")).toContain(`${CATALOGUE.specTypesDefined} spec types`);
    expect(desc("search_catalogue")).toContain(n(CATALOGUE.variants));
    const locale = tools.find((t) => t.name === "get_specs")!.inputSchema.properties!.locale.description!;
    expect(locale).toContain(`${CATALOGUE.locales} published languages`);
    expect(CATALOGUE.locales).toBe(SUPPORTED_LOCALES.length);
  });
});

describe("demo tools honour their outputSchema (validated by server zod AND client ajv)", () => {
  const ok = (r: CallResult) => {
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    expect(r.structuredContent).toBeDefined();
    // the text block is the same object, for clients without structured output
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
    return r.structuredContent as Record<string, any>;
  };

  test("a demo answer carries full_catalogue naming the paid pair and its price (T334)", async () => {
    const r = await call("search_cars", { query: "i3" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent!.full_catalogue).toContain("search_catalogue");
    expect(r.structuredContent!.full_catalogue).toContain(`$${x402.searchPriceUsd}`);
    const f = await call("filter_cars", { fuel: "electric" });
    expect(f.structuredContent!.full_catalogue).toContain("filter_catalogue");
    const g = await call("get_images", { variant_id: await encodeId(SECRET, "variant", 2000) });
    expect(g.structuredContent!.full_catalogue).toBeUndefined();
  });

  test("search_cars → { data: [...] } with opaque ids", async () => {
    const out = ok(await call("search_cars", { query: "focus" }));
    expect(out.data).toHaveLength(1);
    expect(out.data[0].variant_id).toMatch(/^v_/);
    expect(out.data[0].body_type_en).toBeNull();
  });

  test("get_specs, compare_variants, get_images on a demo car", async () => {
    const id = await encodeId(SECRET, "variant", 2000);
    const id2 = await encodeId(SECRET, "variant", 2001);
    const specs = ok(await call("get_specs", { variant_id: id, locale: "de" }));
    expect(specs.locale).toBe("de");
    expect(specs.specs.turbocharged.value).toBe(false);
    const cmp = ok(await call("compare_variants", { variant_ids: [id, id2] }));
    expect(cmp.data.map((d: { variant_id: string }) => d.variant_id)).toEqual([id, id2]);
    const imgs = ok(await call("get_images", { variant_id: id }));
    expect(imgs.data[0].variant).toBe("hero");
  });

  test("list_generations and filter_cars (with a filter the demo cannot apply)", async () => {
    const gens = ok(await call("list_generations", { model_id: await encodeId(SECRET, "model", 80) }));
    expect(gens.data[0].generation_id).toMatch(/^g_/);
    const f = ok(await call("filter_cars", { ev: true, drive: "rear", limit: 3 }));
    expect(f.data).toHaveLength(3);
    expect(f.demo).toBe(true);
    expect(f.ignored_filters).toEqual(["drive"]);
  });

  test("errors stay isError with no structuredContent — and are not turned into validation failures", async () => {
    const bad = await call("get_specs", { variant_id: "v_nope" });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toBeUndefined();
    const outside = await call("get_specs", { variant_id: await encodeId(SECRET, "variant", 99_999) });
    expect(outside.isError).toBe(true);
    expect(outside.content[0].text).toContain("outside the demo set");
  });
});

describe("paid tools honour their outputSchema (callbacks run directly — no payment in a test)", () => {
  const h = paidHandlers(ctx, paidQueries);
  const ajvCheck = (name: string, value: unknown) => {
    const schema = tools.find((t) => t.name === name)!.outputSchema!;
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  };

  test("search_catalogue", async () => {
    const r = await h.search_catalogue({ query: "i3" });
    expect(r.isError).toBeFalsy();
    const sc = (r as { structuredContent: Record<string, any> }).structuredContent;
    expect(OUTPUT.search_catalogue.safeParse(sc).success).toBe(true);
    ajvCheck("search_catalogue", sc);
    expect(sc.data[0].variant_id).toMatch(/^v_/);
  });

  test("get_specs_full", async () => {
    const r = await h.get_specs_full({ variant_id: await encodeId(SECRET, "variant", 2000), locale: "fr" });
    expect(r.isError).toBeFalsy();
    const sc = (r as { structuredContent: Record<string, any> }).structuredContent;
    expect(OUTPUT.get_specs_full.safeParse(sc).success).toBe(true);
    ajvCheck("get_specs_full", sc);
    expect(sc.last_synced_at).toBe("2026-10-10T00:00:00.000Z");
    expect(sc.torque_nm).toBe(250);
  });

  test("unknown id is an error (not settled), not a schema violation", async () => {
    const r = await h.get_specs_full({ variant_id: await encodeId(SECRET, "variant", 5) });
    expect(r.isError).toBe(true);
  });

  // T334
  test("filter_catalogue: opaque ids, numeric decimals, a cursor that is the last row's token", async () => {
    const r = await h.filter_catalogue({ fuel: "electric", limit: 3 });
    expect(r.isError).toBeFalsy();
    const sc = (r as { structuredContent: Record<string, any> }).structuredContent;
    expect(OUTPUT.filter_catalogue.safeParse(sc).success).toBe(true);
    ajvCheck("filter_catalogue", sc);
    expect(sc.data).toHaveLength(3);
    expect(sc.data[0].variant_id).toMatch(/^v_/);
    expect(sc.data[0].battery_kwh).toBe(42.2);
    expect(sc.data[0].accel_0_100_s).toBe(7.3);
    expect(sc.next_cursor).toBe(sc.data[2].variant_id);
    expect(await decodeId(SECRET, "variant", sc.next_cursor)).toBe(2002);
    expect(JSON.stringify(sc)).not.toMatch(/\b200[0-9]\b/);
    // a garbage cursor is an error, never a silent restart from page one
    expect((await h.filter_catalogue({ cursor: "v_nope" })).isError).toBe(true);
  });

  test("compare_full: one unknown id fails the whole call (unsettled), never a partial comparison", async () => {
    const a = await encodeId(SECRET, "variant", 2000);
    const ok = await h.compare_full({ variant_ids: [a, a], locale: "de" });
    expect(ok.isError).toBeFalsy();
    const sc = (ok as { structuredContent: Record<string, any> }).structuredContent;
    expect(OUTPUT.compare_full.safeParse(sc).success).toBe(true);
    ajvCheck("compare_full", sc);
    expect(sc.locale).toBe("de");
    expect(sc.data).toHaveLength(2);
    expect(sc.data[1].torque_nm).toBe(250);
    expect(sc.data[1].last_synced_at).toBe("2026-10-10T00:00:00.000Z");
    const bad = await h.compare_full({ variant_ids: [a, await encodeId(SECRET, "variant", 5)] });
    expect(bad.isError).toBe(true);
  });
});

describe("the schemas are not vacuous", () => {
  test("a result missing a promised field, or with a wrong type, is rejected", () => {
    expect(OUTPUT.get_specs.safeParse({}).success).toBe(false);
    expect(OUTPUT.search_cars.safeParse({ data: [{ variant_id: 2000 }] }).success).toBe(false);
    expect(
      OUTPUT.get_specs.safeParse({
        variant_id: "v_x", locale: "en", last_synced_at: "x",
        specs: { a: { label: "A", value: 1, unit: 5, confidence: null } },
      }).success,
    ).toBe(false);
  });
});
