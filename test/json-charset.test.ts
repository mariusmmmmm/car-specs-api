import { describe, test, expect, vi } from "vitest";
import { sha256Hex, type KeyRecord } from "../src/lib/apikey";
import type { Env } from "../src/types";

// T152 / T144 §2 — every JSON response must declare its charset.
//
// Measured on prod 2026-10-07 (https://api.cars-data.com/v1/demo):
//     content-type: application/json          ← no "; charset=utf-8"
//     body bytes:   34 30 20 63 61 72 73 20 e2 80 94  = "40 cars " + U+2014
// Valid UTF-8, undeclared, so a browser falls back to a single-byte decoding
// and the key-activation page — the one page a new customer reads with their
// eyes — shows "40 cars â€" Volkswagen…".
//
// These assertions are on the HEADER, not the body: the bytes were already
// correct on prod, and a body-only test passes with the defect live (the plan's
// acceptance criterion 2 says so explicitly).
//
// They run against ../src/app, the REAL composition root — real middleware
// order, real routes, real notFound/onError — not a hand-assembled Hono app
// that happens to have jsonCharset bolted on (project_guard_scope_blind_spot).

const FAKE_IDS = new Set(Array.from({ length: 40 }, (_, i) => 1000 + i));
vi.mock("../src/lib/demo-set", () => ({
  DEMO_VARIANT_IDS: FAKE_IDS,
  DEMO_GENERATION_IDS: new Set([500]),
  DEMO_MODEL_IDS: new Set([90]),
  DEMO_SET_SIZE: 40,
  DEMO_SET_DESCRIPTION: "test set",
  demoSetReady: () => FAKE_IDS.size === 40,
}));

const { app } = await import("../src/app");

const SECRET = "test-secret-at-least-16-chars-long";
const RAW_KEY = "cd_demo_charset_test_key";

function variant(id: number) {
  return {
    variant_id: id, generation_id: 500, model_id: 90,
    brand: "Volkswagen", model: "Golf", generation: "Golf VII",
    // An em-dash in the DATA as well as in the copy, so the assertion is not
    // hostage to a marketing string someone may reword.
    display_name: "Volkswagen Golf — 1.5 TSI", fuel: "Petrol", body_type: "Hatchback",
    years: "2012–2019", power_hp: 110, battery_kwh: null, price_new_eur: 24990,
    specs: {}, images: [],
  };
}

const PAYLOAD = {
  schema: 1, locale: "en", built_at: "2026-10-05T00:00:00.000Z", set_description: "test set",
  variants: Array.from({ length: 40 }, (_, i) => variant(1000 + i)),
};

async function env(): Promise<Env> {
  const store = new Map<string, string>();
  const record: KeyRecord = {
    email: "charset@example.com", name: "Charset", plan: "demo",
    created_at: new Date().toISOString(), email_verified: true, approved: true,
  } as KeyRecord;
  store.set(`key:${await sha256Hex(RAW_KEY)}`, JSON.stringify(record));
  return {
    ID_TOKEN_KEY: SECRET,
    API_KEYS: {
      get: async (k: string) => (k.startsWith("demo:v1:") ? JSON.stringify(PAYLOAD) : store.get(k) ?? null),
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
    // If any of this reaches Postgres the demo tier is broken, not the charset.
    HYPERDRIVE: { get connectionString(): string { throw new Error("database touched"); } },
  } as unknown as Env;
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const call = async (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers }, await env(), ctx);

describe("every JSON response declares charset=utf-8 (T152 / T144 §2)", () => {
  test("a 200 whose body carries an em-dash — the exact prod case", async () => {
    const res = await call("/v1/demo", { "X-Api-Key": RAW_KEY });
    expect(res.status).toBe(200);

    // The body really does contain U+2014, so the header is load-bearing and
    // not an assertion about an all-ASCII payload.
    const raw = new Uint8Array(await res.clone().arrayBuffer());
    expect(new TextDecoder("utf-8").decode(raw)).toContain("—");
    expect(Array.from(raw).join(",")).toContain("226,128,148"); // e2 80 94

    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  test("problem+json too — a 401 whose detail carries an em-dash", async () => {
    const res = await call("/v1/demo");
    expect(res.status).toBe(401);
    expect(await res.clone().text()).toContain("—");
    expect(res.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
  });

  test("the 404 from app.notFound — outside /v1, so auth does not answer first", async () => {
    const res = await call("/no-such-route");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
  });

  test("a charset already present is left alone, not doubled", async () => {
    const res = await call("/v1/demo", { "X-Api-Key": RAW_KEY });
    expect(res.headers.get("content-type")?.match(/charset=/g)).toHaveLength(1);
  });
});
