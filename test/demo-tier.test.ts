import { describe, test, expect, vi, beforeEach } from "vitest";

// The frozen set is not generated yet (the monthly pipeline was mid-run), so
// these tests mock it. That is not a workaround: the set is DATA and the tier's
// behaviour must be provable without it, which is also what lets the guard on
// the real set stay a separate, data-only check.
const FAKE_IDS = new Set(Array.from({ length: 40 }, (_, i) => 1000 + i));
vi.mock("../src/lib/demo-set", () => ({
  DEMO_VARIANT_IDS: FAKE_IDS,
  DEMO_GENERATION_IDS: new Set([500, 501]),
  DEMO_MODEL_IDS: new Set([90]),
  DEMO_SET_SIZE: 40,
  DEMO_SET_DESCRIPTION: "test set",
  demoSetReady: () => FAKE_IDS.size === 40,
}));

const { demo } = await import("../src/routes/demo");
const { encodeId } = await import("../src/lib/public-id");

const SECRET = "test-secret-at-least-16-chars-long";

function variant(id: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    variant_id: id, generation_id: 500, model_id: 90,
    brand: "Volkswagen", model: "Golf", generation: "Golf VII",
    display_name: `Volkswagen Golf ${String.fromCharCode(65 + (id % 26))} TSI`, fuel: "Petrol", body_type: "Hatchback",
    years: "2012–2019", power_hp: 110, battery_kwh: null, price_new_eur: 24990,
    // Same shape localizeVariantSpecs() returns: a record keyed by spec key.
    specs: { length_mm: { label: "Length", value: "4258 mm", unit: "mm", confidence: 0.9 } },
    images: [{ url: "https://cdn.example/x.jpg", variant: "hero" }],
    ...over,
  };
}

const PAYLOAD = {
  schema: 1, locale: "en", built_at: "2026-10-05T00:00:00.000Z", set_description: "test set",
  variants: [
    variant(1000),
    variant(1001, { brand: "Hyundai", model: "Nexo", fuel: "Hydrogen", display_name: "Hyundai Nexo FCEV" }),
    ...Array.from({ length: 38 }, (_, i) => variant(1002 + i)),
  ],
};

function env(opts: { payload?: unknown; dbShouldNeverBeTouched?: boolean } = {}) {
  const has = "payload" in opts ? opts.payload : PAYLOAD;
  return {
    ID_TOKEN_KEY: SECRET,
    API_KEYS: {
      async get(k: string) { return k.startsWith("demo:v1:") && has ? JSON.stringify(has) : null; },
      async put() {},
    },
    // Deliberately a landmine: if any demo path reaches Postgres, this throws.
    HYPERDRIVE: { get connectionString(): string { throw new Error("demo tier touched the database"); } },
  } as never;
}

const call = (path: string, e = env()) => demo.fetch(new Request(`http://x${path}`), e);

describe("demo tier — served from KV, never from Postgres (T111)", () => {
  test("the index hands over the whole set in one call, with opaque ids", async () => {
    const res = await call("/demo");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.variant_count).toBe(40);
    expect(body.data.fuels).toContain("Hydrogen");
    for (const v of body.data.variants) {
      expect(v.variant_id).toMatch(/^v_[0-9a-f]{8}$/);
      expect(v.generation_id).toMatch(/^g_[0-9a-f]{8}$/);
      // no internal public_id may appear anywhere in the row, under any key
      expect(JSON.stringify(v)).not.toMatch(/\b10[0-9][0-9]\b/);
    }
  });

  test("a car inside the set returns real specs", async () => {
    const token = await encodeId(SECRET, "variant", 1000);
    const res = await call(`/variants/${token}/specs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.specs.length_mm.value).toBe("4258 mm");
  });

  test("photos are IN the demo", async () => {
    const token = await encodeId(SECRET, "variant", 1000);
    const res = await call(`/variants/${token}/images`);
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].variant).toBe("hero");
  });

  test("a car OUTSIDE the set is 403 with the upgrade path, not 404", async () => {
    const token = await encodeId(SECRET, "variant", 77_777);
    const res = await call(`/variants/${token}/specs`);
    expect(res.status).toBe(403);
    // Asserts the upgrade PATH, not a number: the catalogue count moves with
    // every import, and a test pinned to it fails for the wrong reason.
    const { detail } = await res.json();
    expect(detail).toMatch(/licensed export/i);
    expect(detail).toContain("cars-data.com/en/api");
  });

  test("A GUESSED token is indistinguishable from a car outside the set", async () => {
    const res = await call("/variants/v_deadbeef/specs");
    expect(res.status).toBe(403);
  });

  test("compare refuses a mixed pair — one in, one out", async () => {
    const inside = await encodeId(SECRET, "variant", 1000);
    const outside = await encodeId(SECRET, "variant", 77_777);
    expect((await call(`/compare?ids=${inside},${outside}`)).status).toBe(403);
    expect((await call(`/compare?ids=${inside},${await encodeId(SECRET, "variant", 1001)}`)).status).toBe(200);
  });

  test("search cannot return anything outside the set, whatever the query", async () => {
    for (const q of ["", "a", "e", "Mercedes", "%", "' OR 1=1 --"]) {
      const res = await call(`/search?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      const ids = (await res.json()).data.map((r: { variant_id: string }) => r.variant_id);
      expect(ids.length).toBeLessThanOrEqual(40);
    }
  });

  test("a miss in search says so, instead of looking like an empty catalogue", async () => {
    const body = await (await call("/search?q=lamborghini")).json();
    expect(body.data).toHaveLength(0);
    expect(body.meta.demo_note).toMatch(/outside|No match/i);
  });

  test("anything not in the tier is 403 with the route named, not 404", async () => {
    const res = await call("/export");
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toMatch(/not part of the demo tier/);
  });

  test("NO demo path opens a database connection", async () => {
    // env() rigs HYPERDRIVE to throw. Reaching Postgres anywhere here fails.
    const token = await encodeId(SECRET, "variant", 1000);
    for (const p of ["/demo", `/variants/${token}`, `/variants/${token}/specs`, `/variants/${token}/images`, "/search?q=golf", "/brands"]) {
      const res = await call(p);
      expect(res.status, p).toBe(200);
    }
  });

  test("a missing blob is 503 with Retry-After — never 200 with no cars", async () => {
    const res = await call("/demo", env({ payload: null }));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect((await res.json()).detail).toMatch(/Nothing is wrong with your key/);
  });
});

describe("demo tier — before the set is generated", () => {
  beforeEach(() => vi.resetModules());

  test("an ungenerated set serves NOTHING rather than an empty catalogue", async () => {
    vi.doMock("../src/lib/demo-set", () => ({
      DEMO_VARIANT_IDS: new Set<number>(), DEMO_GENERATION_IDS: new Set<number>(),
      DEMO_MODEL_IDS: new Set<number>(), DEMO_SET_SIZE: 40,
      DEMO_SET_DESCRIPTION: "not generated", demoSetReady: () => false,
    }));
    const { demo: fresh } = await import("../src/routes/demo");
    const res = await fresh.fetch(new Request("http://x/demo"), env());
    expect(res.status).toBe(503);
  });
});
