// T165 — the sample boundary, proved from the OUTSIDE.
//
// demo-tier.test.ts proves routes/demo.ts cannot leave the 40. It does that by
// calling `demo.fetch` directly, which assumes the thing this file tests: that
// a request carrying a demo KEY is actually dispatched there. That assumption
// is the whole guardrail, so it gets its own test, entered the way a real
// caller enters — a key on the wire, through requireApiKey and the /v1 chain.
//
// Both surfaces are covered, because until T165 only one of them held:
//   * REST (routes/v1.ts) — dispatches on plan === "demo". Always held.
//   * MCP  (index.ts → lib/mcp-source.ts) — did NOT. props were built without
//     `demo` for any authenticated key, so sourceFor() fell through to
//     dbSource() and a demo key reached the entire catalogue.
import { describe, test, expect, vi } from "vitest";

const FAKE_IDS = new Set(Array.from({ length: 40 }, (_, i) => 3000 + i));
vi.mock("../src/lib/demo-set", () => ({
  DEMO_VARIANT_IDS: FAKE_IDS,
  DEMO_GENERATION_IDS: new Set([600]),
  DEMO_MODEL_IDS: new Set([70]),
  DEMO_SET_SIZE: 40,
  DEMO_SET_DESCRIPTION: "test set",
  demoSetReady: () => FAKE_IDS.size === 40,
}));
// The landmine. Every assertion below is only worth something because this
// throws: "it answered 200" and "it never asked for a connection" are two
// different claims, and only the second one is the guarantee.
vi.mock("../src/lib/db", () => ({
  getDb: () => {
    throw new Error("a demo key was handed a database connection");
  },
}));

const { v1 } = await import("../src/routes/v1");
const { sourceFor, isDemoScope } = await import("../src/lib/mcp-source");
const { sha256Hex } = await import("../src/lib/apikey");
const { encodeId } = await import("../src/lib/public-id");

const SECRET = "test-secret-at-least-16-chars-long";
const DEMO_KEY = "cd_demo_t165000000000000000000000000000000000000";
const APIFY_KEY = "cd_free_t165111111111111111111111111111111111111";

const variant = (id: number) => ({
  variant_id: id,
  generation_id: 600,
  model_id: 70,
  brand: "Toyota",
  model: "Corolla",
  generation: "Corolla XII",
  display_name: `Toyota Corolla ${String.fromCharCode(65 + (id % 26))}`,
  fuel: "Hybrid",
  body_type: "Hatchback",
  years: "2018–2024",
  power_hp: 122,
  battery_kwh: null,
  price_new_eur: 28990,
  specs: { length_mm: { label: "Length", value: "4370 mm", unit: "mm", confidence: 0.9 } },
  images: [{ url: "https://cdn.example/corolla.jpg", variant: "hero" }],
});

const PAYLOAD = {
  schema: 1,
  locale: "en",
  built_at: "2026-10-06T00:00:00.000Z",
  set_description: "test set",
  variants: Array.from({ length: 40 }, (_, i) => variant(3000 + i)),
};

async function env() {
  const store = new Map<string, string>();
  store.set(`demo:v1:en`, JSON.stringify(PAYLOAD));
  const rec = (plan: string) => ({
    email: "t165@example.com",
    plan,
    tos_version: "2026-10-02-v1",
    tos_accepted_at: "2026-10-06T00:00:00.000Z",
    created_at: "2026-10-06T00:00:00.000Z",
    email_verified: true,
    approved: true,
  });
  store.set(`key:${await sha256Hex(DEMO_KEY)}`, JSON.stringify(rec("demo")));
  store.set(`key:${await sha256Hex(APIFY_KEY)}`, JSON.stringify(rec("apify")));
  return {
    ID_TOKEN_KEY: SECRET,
    API_KEYS: {
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        store.set(k, v);
      },
    },
    HYPERDRIVE: {
      get connectionString(): string {
        throw new Error("a demo key was handed a database connection");
      },
    },
  } as never;
}

const get = async (path: string, key = DEMO_KEY) =>
  v1.fetch(new Request(`http://x/v1${path}`, { headers: { "X-Api-Key": key } }), await env());

describe("a demo KEY is confined to the sample — REST (T165)", () => {
  test("(a) a car INSIDE the 40 answers, with every spec", async () => {
    const token = await encodeId(SECRET, "variant", 3000);
    const res = await get(`/variants/${token}/specs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.specs.length_mm.value).toBe("4370 mm");
    // The id on the wire stays opaque even on the demo tier.
    expect(body.data.variant_id).toMatch(/^v_[0-9a-f]{8}$/);
  });

  test("(b) a car OUTSIDE the 40 is refused, with the upgrade path", async () => {
    const token = await encodeId(SECRET, "variant", 88_888);
    const res = await get(`/variants/${token}/specs`);
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toMatch(/outside the demo set/i);
  });

  test("(c) nothing a demo key asks for reaches the catalogue", async () => {
    // Two outcomes are allowed and no third one is.
    //
    //   * routes the demo tier implements answer 200 FROM THE BLOB. The proof
    //     that they did not go to Postgres is not the status — it is getDb()
    //     throwing, which would surface as a 500.
    //   * everything else is 403 with the upgrade path, never a 404 and never
    //     a row.
    //
    // /export is the one that matters most: it is the licensed bulk route,
    // mounted under the same protected chain, one `plan` check away.
    for (const path of ["/demo", "/search?q=golf", "/brands"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(await res.json()), path).not.toMatch(/database connection/);
    }
    for (const path of ["/export", "/usage", "/brands/volkswagen/models", "/models/x/generations"]) {
      const res = await get(path);
      expect(res.status, path).toBe(403);
      const body = JSON.stringify(await res.json());
      expect(body, path).toMatch(/not part of the demo tier|outside the demo set/);
      expect(body, path).not.toMatch(/database connection/);
    }
  });

  test("the whole demo set is 40 and nothing else, through the keyed path", async () => {
    const res = await get("/demo");
    expect(res.status).toBe(200);
    expect((await res.json()).data.variant_count).toBe(40);
  });
});

describe("a demo KEY is confined to the sample — MCP (T165)", () => {
  test("the scope decision itself: no key and a demo key are the same scope", () => {
    expect(isDemoScope(null)).toBe(true);
    expect(isDemoScope({ plan: "demo" })).toBe(true);
    // The two plans that are PAID for, and the only ones the catalogue is
    // meant to be reachable from.
    expect(isDemoScope({ plan: "apify" })).toBe(false);
    expect(isDemoScope({ plan: "free" })).toBe(false);
  });

  test("a demo-plan key gets the blob, NOT the database", async () => {
    // props exactly as index.ts builds them for an authenticated caller.
    const src = await sourceFor(await env(), {
      keyPrefix: "abcd1234",
      demo: isDemoScope({ plan: "demo" }),
      locale: "en",
    });
    expect(src!.demo).toBe(true);
    const rows = (await src!.search("en", "", 50)) as { variant_id: number }[];
    expect(rows).toHaveLength(40);
    for (const r of rows) expect(FAKE_IDS.has(r.variant_id)).toBe(true);
  });

  // Era pe dos până la 2026-10-08: „o cheie plătită primește baza". Strategia
  // owner-ului (D-01) spune altceva — plătit înseamnă Actor-ul Apify, care
  // facturează per rezultat, și exportul licențiat. MCP e suprafața demo.
  // Actor-ul apelează /v1, nu /mcp (măsurat în apify-actor/src), deci o cheie
  // apify pe /mcp n-avea consumator legitim — doar expunere dacă scurgea.
  test("nici măcar o cheie plătită nu trece de demo pe MCP — suprafața, nu planul, decide", async () => {
    const src = await sourceFor(await env(), { keyPrefix: "abcd1234", demo: isDemoScope({ plan: "apify" }) });
    expect(src!.demo).toBe(true);
    const rows = (await src!.search("en", "", 50)) as { variant_id: number }[];
    expect(rows).toHaveLength(40);
  });

  // Garda de regresie care contează: `demo` din props nu mai poate reactiva
  // baza. Dacă cineva reintroduce o ramură pe plan, testul ăsta pică.
  test("nici un props nu mai poate cere baza", async () => {
    for (const props of [{}, { demo: false }, { demo: false, keyPrefix: "deadbeef" }]) {
      const src = await sourceFor(await env(), props);
      expect(src!.demo).toBe(true);
    }
  });
});
