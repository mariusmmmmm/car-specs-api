import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

// T216 — x402 v2 on the REST surface, end to end through the REAL router.
//
// What must hold, in the order a regression would hurt:
//   1. OFF is today, exactly: no X402_PAY_TO → a keyless request still gets the
//      401 that asks for a key. Deploying this branch changes nothing until the
//      owner sets a wallet.
//   2. A presented key is never turned into a payment prompt — an invalid key
//      gets its 401, not a 402.
//   3. Only allowlisted routes are for sale.
//   4. ON, no payment → 402 with a v2 PAYMENT-REQUIRED header naming OUR
//      address, the configured network and the right USDC amount; and the
//      database is not touched.
//   5. ON, valid payment → the route runs and the payment is settled once; a
//      route that answers 404 is NOT settled.
//
// The facilitator is a stub on global fetch; the database is a mock. Nothing
// here talks to a chain.

const PAY_TO = "0x1111111111111111111111111111111111111111";
const FACILITATOR = "https://facilitator.test";
const SECRET = "test-secret-at-least-16-chars-long";
const VARIANT = 4242;

const db = { touched: 0 };

vi.mock("../src/lib/db", () => ({
  getDb: () => {
    db.touched++;
    return (async () => []) as never;
  },
}));

vi.mock("../src/lib/localize-variant", () => ({
  localizeVariantSpecs: async (_sql: unknown, _locale: string, id: number) =>
    id === VARIANT
      ? { specs: { power_hp: { value: "150 hp" } }, last_synced_at: new Date("2026-10-01T00:00:00Z") }
      : null,
}));

const { v1 } = await import("../src/routes/v1");
const { encodeId, decodeId } = await import("../src/lib/public-id");
const { parseX402Config, paidRoute } = await import("../src/lib/x402-config");
const { __resetX402Cache } = await import("../src/middleware/x402");
const { decodePaymentRequiredHeader, decodePaymentResponseHeader } = await import("@x402/core/http");

const app = new Hono();
app.route("/v1", v1);

function env(x402: Record<string, string> = {}) {
  const store = new Map<string, string>();
  return {
    ID_TOKEN_KEY: SECRET,
    IP_HASH_SALT: "salt",
    API_KEYS: {
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        store.set(k, v);
      },
    },
    USAGE: { writeDataPoint() {} },
    HYPERDRIVE: { connectionString: "postgres://unused" },
    ...x402,
  } as never;
}

const ON = { X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: FACILITATOR };

// ── facilitator stub ─────────────────────────────────────────────────────────
const calls = { supported: 0, verify: 0, settle: 0 };
/** T226: what the stubbed facilitator answers on /verify. */
let verifyRefusal: string | null = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.supported = calls.verify = calls.settle = 0;
  verifyRefusal = null;
  db.touched = 0;
  __resetX402Cache();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(FACILITATOR)) return realFetch(input as never, init);
    const path = new URL(url).pathname;
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path.endsWith("/supported")) {
      calls.supported++;
      return reply({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
        extensions: [],
        signers: { "eip155:*": ["0x2222222222222222222222222222222222222222"] },
      });
    }
    if (path.endsWith("/verify")) {
      calls.verify++;
      return reply(
        verifyRefusal
          ? { isValid: false, invalidReason: verifyRefusal, payer: "0x3333333333333333333333333333333333333333" }
          : { isValid: true, payer: "0x3333333333333333333333333333333333333333" },
      );
    }
    if (path.endsWith("/settle")) {
      calls.settle++;
      return reply({
        success: true,
        transaction: "0xfeedbeef",
        network: "eip155:84532",
        payer: "0x3333333333333333333333333333333333333333",
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const specsPath = async (id = VARIANT) => `/v1/variants/${await encodeId(SECRET, "variant", id)}/specs`;
const get = (path: string, e: unknown, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`https://api.test${path}`, { headers }), e as never);

/** A payment for whatever the 402 asked for. The facilitator stub accepts any
 *  signature, so what is being tested is OUR side of the handshake. */
async function paymentFor(path: string, e: unknown): Promise<string> {
  const challenge = await get(path, e);
  const required = decodePaymentRequiredHeader(challenge.headers.get("PAYMENT-REQUIRED")!);
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0],
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: "0x3333333333333333333333333333333333333333",
        to: PAY_TO,
        value: required.accepts[0]!.amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: "0x" + "cd".repeat(32),
      },
    },
  };
  return btoa(JSON.stringify(payload));
}

describe("config — the address is the switch", () => {
  test("no address → off", () => {
    expect(parseX402Config({})).toEqual({ ok: false, reason: "off" });
    expect(parseX402Config({ X402_PAY_TO: "  " })).toEqual({ ok: false, reason: "off" });
  });

  test("a malformed address is OFF, never 'on with a default'", () => {
    for (const bad of ["0x123", "1111111111111111111111111111111111111111", "0xZZ11111111111111111111111111111111111111"]) {
      expect(parseX402Config({ X402_PAY_TO: bad })).toMatchObject({ ok: false, reason: "invalid" });
    }
  });

  test("testnet unless mainnet is asked for by name; aliases normalise to CAIP-2", () => {
    const at = (n?: string) => {
      const r = parseX402Config({ X402_PAY_TO: PAY_TO, X402_NETWORK: n });
      return r.ok ? r.settings.network : r.reason;
    };
    expect(at(undefined)).toBe("eip155:84532");
    expect(at("base")).toBe("eip155:8453");
    expect(at("base-sepolia")).toBe("eip155:84532");
    expect(at("eip155:8453")).toBe("eip155:8453");
    expect(at("solana:mainnet")).toBe("invalid");
  });

  test("prices: defaults sit above the export's per-variant price; junk is refused", () => {
    const r = parseX402Config({ X402_PAY_TO: PAY_TO });
    expect(r.ok && r.settings.specsPriceUsd).toBe(0.05);
    expect(r.ok && r.settings.searchPriceUsd).toBe(0.005);
    // €2,900 Full Specs / ~103k variants ≈ €0.028 — the default must not undercut it.
    expect(r.ok && r.settings.specsPriceUsd).toBeGreaterThan(2900 / 103_000);
    for (const bad of ["0", "0.0001", "abc", "-1", "1e-3", "101"]) {
      expect(parseX402Config({ X402_PAY_TO: PAY_TO, X402_PRICE_SPECS_USD: bad })).toMatchObject({ ok: false });
    }
    expect(parseX402Config({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: "http://plain.test" })).toMatchObject({
      ok: false,
    });
  });
});

describe("allowlist — only named routes are for sale", () => {
  const s = (parseX402Config({ X402_PAY_TO: PAY_TO }) as { ok: true; settings: never }).settings;
  test.each([
    ["GET", "/v1/variants/v_1a2b3c4d/specs", true],
    ["GET", "/v1/search", true],
    ["POST", "/v1/search", false],
    ["GET", "/v1/variants/v_1a2b3c4d", false],
    ["GET", "/v1/variants/v_1a2b3c4d/images", false],
    ["GET", "/v1/variants", false],
    ["GET", "/v1/export", false],
    ["GET", "/v1/compare", false],
    ["GET", "/v1/usage", false],
  ])("%s %s → paid=%s", (method, path, expected) => {
    expect(paidRoute(method, path, s) !== null).toBe(expected);
  });
});

describe("REST — x402 OFF is exactly today", () => {
  test("keyless request on a would-be paid route → 401 asking for a key, no 402", async () => {
    const res = await get(await specsPath(), env());
    expect(res.status).toBe(401);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(calls.supported + calls.verify + calls.settle).toBe(0);
  });

  test("a malformed address behaves like no address", async () => {
    const res = await get(await specsPath(), env({ X402_PAY_TO: "0xnot-an-address" }));
    expect(res.status).toBe(401);
  });
});

describe("REST — x402 ON", () => {
  test("no payment → 402 v2 naming our address, the network and 0.05 USDC; database untouched", async () => {
    const path = await specsPath();
    const res = await get(path, env(ON));
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    expect(required.x402Version).toBe(2);
    const a = required.accepts[0]!;
    expect(a.scheme).toBe("exact");
    expect(a.network).toBe("eip155:84532");
    expect(a.payTo.toLowerCase()).toBe(PAY_TO);
    expect(a.amount).toBe("50000"); // USDC has 6 decimals: $0.05 = 50,000 units
    expect(required.resource?.url).toContain(path);
    const body = (await res.json()) as { status: number; detail: string };
    expect(body.status).toBe(402);
    expect(body.detail).toContain("$0.05");
    expect(db.touched).toBe(0);
    expect(calls.verify + calls.settle).toBe(0);
  });

  test("search is priced separately", async () => {
    const res = await get("/v1/search?q=golf", env(ON));
    expect(res.status).toBe(402);
    const a = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).accepts[0]!;
    expect(a.amount).toBe("5000"); // $0.005
  });

  test("a PRESENTED key — even an invalid one — is never turned into a payment prompt", async () => {
    const res = await get(await specsPath(), env(ON), { "X-Api-Key": "cd_demo_doesnotexist" });
    expect(res.status).toBe(401);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(calls.supported).toBe(0);
  });

  test("a route not on the allowlist still wants a key", async () => {
    const res = await get(`/v1/variants/${await encodeId(SECRET, "variant", VARIANT)}`, env(ON));
    expect(res.status).toBe(401);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });

  test("a browser gets our page, not the library's note to developers", async () => {
    const res = await get(await specsPath(), env(ON), {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0",
    });
    expect(res.status).toBe(402);
    const html = await res.text();
    expect(html).toContain("cars-data.com/en/api");
    expect(html).not.toContain("@x402/paywall");
  });

  test("valid payment → 200 with opaque ids, settled exactly once, PAYMENT-RESPONSE carries the tx", async () => {
    const e = env(ON);
    const path = await specsPath();
    const payment = await paymentFor(path, e);
    const res = await get(path, e, { "PAYMENT-SIGNATURE": payment });
    expect(res.status).toBe(200);
    expect(calls.verify).toBe(1);
    expect(calls.settle).toBe(1);
    const settled = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settled.transaction).toBe("0xfeedbeef");
    const body = (await res.json()) as { data: { variant_id: string; specs: unknown } };
    // Same id gate as every non-apify plan: a token, never the raw public_id.
    expect(body.data.variant_id).toMatch(/^v_[0-9a-f]{8}$/);
    expect(await decodeId(SECRET, "variant", body.data.variant_id)).toBe(VARIANT);
    expect(JSON.stringify(body)).not.toContain(String(VARIANT));
  });

  test("a paid request for a car that is not there → 404 and NO settlement", async () => {
    const e = env(ON);
    const path = await specsPath(999_999);
    const payment = await paymentFor(path, e);
    const res = await get(path, e, { "PAYMENT-SIGNATURE": payment });
    expect(res.status).toBe(404);
    expect(calls.settle).toBe(0);
  });

  test("/supported is fetched once per isolate, not once per request", async () => {
    const e = env(ON);
    await get(await specsPath(), e);
    await get(await specsPath(), e);
    await get("/v1/search?q=golf", e);
    expect(calls.supported).toBe(1);
  });

  test("per-IP minute limit holds on the paid path", async () => {
    const e = env(ON);
    const path = await specsPath();
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await get(path, e, { "cf-connecting-ip": "203.0.113.9" })).status;
    expect(last).toBe(429);
  });
});

// ── T226 — a refused payment must be visible, to the caller and in the log ──
describe("REST — a payment the facilitator REFUSES (T226)", () => {
  // The exact reason the real x402.org facilitator gave an unfunded testnet
  // payer on 2026-10-11, through `wrangler dev`.
  const REASON = "invalid_exact_evm_insufficient_balance";

  function captureLog() {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    return {
      outcomes: () =>
        lines.filter((l) => l.startsWith('{"x402"')).map((l) => JSON.parse(l) as Record<string, unknown>),
      restore: () => spy.mockRestore(),
    };
  }

  test("402 whose body says WHY, headers kept, nothing settled, logged verify_failed with the reason", async () => {
    const e = env(ON);
    const path = await specsPath();
    const payment = await paymentFor(path, e);
    verifyRefusal = REASON;
    const log = captureLog();
    const res = await get(path, e, { "PAYMENT-SIGNATURE": payment });
    log.restore();

    expect(res.status).toBe(402);
    expect(calls.settle).toBe(0);
    expect(res.headers.get("PAYMENT-REQUIRED")).not.toBeNull();
    expect(decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).error).toBe(REASON);
    const body = (await res.json()) as { status: number; detail: string };
    expect(body.status).toBe(402);
    expect(body.detail).toContain(REASON);
    expect(body.detail).toContain("Nothing was charged");

    const last = log.outcomes().at(-1)!;
    expect(last.x402).toBe("verify_failed");
    expect(last.reason).toBe(REASON);
  });

  test("an UNPAID request is still a challenge: 402_issued, our unpaid body, no reason", async () => {
    const log = captureLog();
    const res = await get(await specsPath(), env(ON));
    log.restore();
    expect(res.status).toBe(402);
    expect(((await res.json()) as { detail: string }).detail).toContain("$0.05");
    const last = log.outcomes().at(-1)!;
    expect(last.x402).toBe("402_issued");
    expect(last.reason).toBeUndefined();
  });

  test("an ACCEPTED payment is still logged settled with its tx", async () => {
    const e = env(ON);
    const path = await specsPath();
    const payment = await paymentFor(path, e);
    const log = captureLog();
    const res = await get(path, e, { "PAYMENT-SIGNATURE": payment });
    log.restore();
    expect(res.status).toBe(200);
    const last = log.outcomes().at(-1)!;
    expect(last.x402).toBe("settled");
    expect(last.tx).toBe("0xfeedbeef");
  });
});
