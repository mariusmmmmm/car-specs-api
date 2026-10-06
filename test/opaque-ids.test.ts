import { describe, test, expect } from "vitest";
import { Hono } from "hono";
import { opaqueIds } from "../src/middleware/opaque-ids";
import { decodeId } from "../src/lib/public-id";
import { envelope, problem } from "../src/lib/response";

const SECRET = "test-secret-at-least-16-chars-long";
const env = { ID_TOKEN_KEY: SECRET } as never;

/** Stands in for a database route: the middleware must work on whatever shape a
 *  route happens to project, which is the reason it is a response gate and not
 *  a per-route rewrite. */
function app(body: unknown, status = 200) {
  const a = new Hono();
  a.use("*", opaqueIds as never);
  a.get("/", (c) => c.json(body as never, status as never));
  return a;
}

const get = (body: unknown, status?: number) => app(body, status).fetch(new Request("http://x/"), env);

describe("opaque ids — one gate on the way out (T111)", () => {
  test("rewrites variant_id, generation_id and model_id wherever they sit", async () => {
    const res = await get(envelope(
      { variant_id: 42, generation_id: 7, model_id: 3, display_name: "x" },
      { last_synced_at: "now" },
    ));
    const b = await res.json();
    expect(await decodeId(SECRET, "variant", b.data.variant_id)).toBe(42);
    expect(await decodeId(SECRET, "generation", b.data.generation_id)).toBe(7);
    expect(await decodeId(SECRET, "model", b.data.model_id)).toBe(3);
  });

  test("reaches ids nested in arrays and in arrays of objects — list routes", async () => {
    const res = await get(envelope(
      [{ variant_id: 1 }, { variant_id: 2, nested: [{ generation_id: 9 }] }],
      { last_synced_at: "now" },
    ));
    const b = await res.json();
    expect(await decodeId(SECRET, "variant", b.data[0].variant_id)).toBe(1);
    expect(await decodeId(SECRET, "generation", b.data[1].nested[0].generation_id)).toBe(9);
  });

  test("makes the PAGINATION CURSOR opaque too", async () => {
    // /v1/variants uses a keyset cursor whose value is literally the last row's
    // variant_id. Hiding the ids and publishing the cursor would hand back one
    // real id per page, which is the leak that is easiest to miss.
    const res = await get(envelope([{ variant_id: 5150 }], { last_synced_at: "now" }, { next: "5150" }));
    const b = await res.json();
    expect(b.links.next).toMatch(/^c_[0-9a-f]{8}$/);
    expect(await decodeId(SECRET, "cursor", b.links.next)).toBe(5150);
  });

  test("NO bare integer id survives anywhere in a realistic response", async () => {
    const res = await get(envelope(
      [{ variant_id: 103099, generation_id: 5395, model_id: 1234, power_hp: 103099 }],
      { last_synced_at: "now" },
      { next: "103099" },
    ));
    const text = await res.text();
    // power_hp is NOT an id and must survive untouched — the gate keys off the
    // field name, so a value that merely looks like an id is left alone.
    expect(text).toContain('"power_hp":103099');
    expect(text).not.toContain('"variant_id":103099');
    expect(text).not.toContain('"next":"103099"');
  });

  test("passes null ids through as null rather than minting a token for 0", async () => {
    const res = await get(envelope({ variant_id: null, generation_id: null }, { last_synced_at: "now" }));
    const b = await res.json();
    expect(b.data.variant_id).toBeNull();
  });

  test("leaves problem+json error bodies alone — that is a contract of its own", async () => {
    const { body, status } = problem(404, "Not Found", "No variant with id v_deadbeef");
    const res = await get(body, status);
    expect(res.status).toBe(404);
    expect((await res.json()).title).toBe("Not Found");
  });

  test("leaves non-JSON responses alone", async () => {
    const a = new Hono();
    a.use("*", opaqueIds as never);
    a.get("/", (c) => c.text("openapi: 3.1.0"));
    const res = await a.fetch(new Request("http://x/"), env);
    expect(await res.text()).toBe("openapi: 3.1.0");
  });

  test("FAILS rather than serving raw ids when the secret is missing", async () => {
    // The alternative — degrade to plain integers — would publish the whole
    // catalogue's id space the first time a deploy forgot the secret, silently.
    // The throw is caught by the app's error handler (problem+json 500 in
    // index.ts); what matters here is that nothing with an id in it gets out.
    const a = app(envelope({ variant_id: 42 }, { last_synced_at: "now" }));
    const res = await a.fetch(new Request("http://x/"), {} as never);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("42");
  });
});

describe("the apify plan keeps RAW ids — a live paid product must not break", () => {
  // The Actor declares variantId as "type": "integer" in its Apify input
  // schema and interpolates the user's value straight into the URL. Tokens
  // break it both ways: it cannot accept v_a7afb0ae, and a user cannot feed
  // back an id it wrote into a dataset. The free tier — which is where the
  // August extraction ran — still gets tokens.
  function appWithPlan(plan: string, body: unknown) {
    const a = new Hono<{ Bindings: typeof env; Variables: { apiKeyRecord: { plan: string } } }>();
    a.use("*", async (c, next) => { c.set("apiKeyRecord", { plan } as never); await next(); });
    a.use("*", opaqueIds as never);
    a.get("/", (c) => c.json(body as never));
    return a;
  }

  test("an apify response keeps integer ids and a plain cursor", async () => {
    const res = await appWithPlan("apify", envelope([{ variant_id: 42164 }], { last_synced_at: "n" }, { next: "42164" }))
      .fetch(new Request("http://x/"), env);
    const text = await res.text();
    expect(text).toContain('"variant_id":42164');
    expect(text).toContain('"next":"42164"');
  });

  test("a free response on the very same body gets tokens", async () => {
    const res = await appWithPlan("free", envelope([{ variant_id: 42164 }], { last_synced_at: "n" }, { next: "42164" }))
      .fetch(new Request("http://x/"), env);
    const text = await res.text();
    expect(text).not.toContain("42164");
    expect(text).toMatch(/"variant_id":"v_[0-9a-f]{8}"/);
  });

  test("a demo response gets tokens too", async () => {
    const res = await appWithPlan("demo", envelope([{ variant_id: 42164 }], { last_synced_at: "n" }))
      .fetch(new Request("http://x/"), env);
    expect(await res.text()).not.toContain("42164");
  });
});
