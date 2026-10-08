import { describe, test, expect, vi } from "vitest";

const FAKE_IDS = new Set(Array.from({ length: 40 }, (_, i) => 2000 + i));
vi.mock("../src/lib/demo-set", () => ({
  DEMO_VARIANT_IDS: FAKE_IDS, DEMO_GENERATION_IDS: new Set([700]), DEMO_MODEL_IDS: new Set([80]),
  DEMO_SET_SIZE: 40, DEMO_SET_DESCRIPTION: "test set", demoSetReady: () => FAKE_IDS.size === 40,
}));
// If the demo source ever reaches for a connection, this throws.
vi.mock("../src/lib/db", () => ({
  getDb: () => { throw new Error("demo source opened a database connection"); },
}));

const { demoSource, sourceFor, DEMO_UNSUPPORTED_FILTERS } = await import("../src/lib/mcp-source");

const v = (id: number, over: Record<string, unknown> = {}) => ({
  variant_id: id, generation_id: 700, model_id: 80,
  brand: "BMW", model: "i3", generation: "i3",
  display_name: `BMW i3 ${String.fromCharCode(65 + (id % 26))}`,
  fuel: "Electric", body_type: "Hatchback", years: "2013–2022",
  power_hp: 170, battery_kwh: 42.2, price_new_eur: 39000,
  specs: { range_wltp_km: { label: "Range", value: "310 km", unit: "km", confidence: 0.9 } },
  images: [{ url: "https://cdn.example/i3.jpg", variant: "hero" }],
  ...over,
});

const PAYLOAD = {
  schema: 1, locale: "en", built_at: "2026-10-05T00:00:00.000Z", set_description: "test set",
  variants: [
    v(2000),
    v(2001, { brand: "Ford", model: "Focus", fuel: "LPG", battery_kwh: null, power_hp: 115 }),
    ...Array.from({ length: 38 }, (_, i) => v(2002 + i)),
  ],
};

const env = (payload: unknown = PAYLOAD) => ({
  ID_TOKEN_KEY: "test-secret-at-least-16-chars-long",
  API_KEYS: { async get(k: string) { return k.startsWith("demo:v1:") && payload ? JSON.stringify(payload) : null; } },
}) as never;

describe("MCP demo source — the blob, never the database (T111 D9)", () => {
  test("search cannot return anything outside the 40, for any query", async () => {
    const src = (await demoSource(env(), "en"))!;
    for (const q of ["", "bmw", "e", "mercedes", "' OR 1=1 --", "%"]) {
      const rows = (await src.search("en", q, 50)) as { variant_id: number }[];
      expect(rows.length).toBeLessThanOrEqual(40);
      for (const r of rows) expect(FAKE_IDS.has(r.variant_id)).toBe(true);
    }
  });

  test("specs for a car outside the set are null, so the tool can say so", async () => {
    const src = (await demoSource(env(), "en"))!;
    expect(await src.specs("en", 2000)).not.toBeNull();
    expect(await src.specs("en", 99_999)).toBeNull();
  });

  test("specs come back in the SAME shape the live API returns — a record, not a list", async () => {
    const src = (await demoSource(env(), "en"))!;
    const r = await src.specs("en", 2000);
    expect(Array.isArray(r!.specs)).toBe(false);
    expect((r!.specs as Record<string, { value: unknown }>).range_wltp_km.value).toBe("310 km");
  });

  test("filter honours what the blob carries and stays inside the set", async () => {
    const src = (await demoSource(env(), "en"))!;
    const lpg = (await src.filter("en", { fuel: "LPG", limit: 50 })) as { variant_id: number }[];
    expect(lpg).toHaveLength(1);
    expect(lpg[0].variant_id).toBe(2001);
    const evs = (await src.filter("en", { ev: true, limit: 50 })) as unknown[];
    expect(evs).toHaveLength(39);
  });

  test("the filters the blob cannot honour are named, not silently dropped", () => {
    // An agent that asked for `drive: rear`, got everything, and was told
    // nothing would conclude the DATA has no drive layout.
    expect([...DEMO_UNSUPPORTED_FILTERS]).toEqual(["drive", "year"]);
  });

  test("images come from the blob", async () => {
    const src = (await demoSource(env(), "en"))!;
    expect((await src.images(2000)) as unknown[]).toHaveLength(1);
    expect((await src.images(99_999)) as unknown[]).toHaveLength(0);
  });

  test("a missing blob is null — never an empty source", async () => {
    // An agent told "no cars match" concludes our catalogue is thin. An agent
    // told "unavailable" concludes nothing about our data.
    expect(await demoSource(env(null), "en")).toBeNull();
  });

  // NOT "a key holder" any more (T165): a demo-plan key is on the demo scope
  // too, and index.ts derives that through isDemoScope(). What `props` without
  // `demo` means here is only "a caller the dispatcher placed off the demo
  // scope" — see test/demo-key-scope.test.ts for the decision itself.
  test("sourceFor gives the demo scope the blob and everyone else the database", async () => {
    expect((await sourceFor(env(), { demo: true, locale: "en" }))!.demo).toBe(true);
    // the db source is constructed lazily, so asking for it must not throw yet
    const db = await sourceFor(env(), {});
    expect(db!.demo).toBe(false);
    // ...but using it would, which is exactly how the demo test above proves itself
    await expect(db!.search("en", "x", 1)).rejects.toThrow(/database connection/);
  });
});

describe("anonymous demo rate limit", () => {
  test("refuses past the ceiling and FAILS CLOSED when KV breaks", async () => {
    const { checkAnonDemoRate, ANON_DEMO_PER_MINUTE } = await import("../src/lib/quota");
    const store = new Map<string, string>();
    const kv = {
      async get(k: string) { return store.get(k) ?? null; },
      async put(k: string, val: string) { store.set(k, val); },
    } as unknown as KVNamespace;

    for (let i = 0; i < ANON_DEMO_PER_MINUTE; i++) {
      expect((await checkAnonDemoRate(kv, "iphash")).ok).toBe(true);
    }
    const over = await checkAnonDemoRate(kv, "iphash");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("rate");

    const broken = { async get() { throw new Error("down"); }, async put() {} } as unknown as KVNamespace;
    const r = await checkAnonDemoRate(broken, "iphash");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metering");
  });
});

describe("the /mcp door answers probes honestly", () => {
  // Registries, uptime monitors and link checkers probe with HEAD. 404 there
  // reads as "no such endpoint" — and this project's own publishing checklist
  // ran exactly that probe and would have concluded the server was broken.
  //
  // Tested through lib/mcp-method-gate.ts rather than src/index.ts: the entry
  // point imports agents/mcp, which imports from `cloudflare:workers`, and
  // Node's ESM loader refuses that scheme. That is why no test here touches the
  // entry point — and why the rule lives in a module of its own.
  test("HEAD gets 405 with Allow, not 404", async () => {
    const { mcpMethodGate } = await import("../src/lib/mcp-method-gate");
    const res = mcpMethodGate("HEAD")!;
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST, OPTIONS");
  });

  test("every method that CAN carry a call is passed through untouched", async () => {
    const { mcpMethodGate } = await import("../src/lib/mcp-method-gate");
    for (const m of ["POST", "GET", "OPTIONS", "DELETE"]) {
      expect(mcpMethodGate(m), m).toBeNull();
    }
  });
});
