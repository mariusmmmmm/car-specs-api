import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { keys } from "../src/routes/keys";
import { keysDemo } from "../src/routes/keys-demo";
import { admin } from "../src/routes/admin";
import { authenticate, readApiKey } from "../src/lib/auth-key";
import { sha256Hex, type KeyRecord } from "../src/lib/apikey";
import type { Env } from "../src/types";

// The MX lookup is a real DNS-over-HTTPS call; stubbed so these tests do not
// depend on the network. The offline half of the triage (disposable, our own
// domains) is NOT stubbed — it must hold without any network at all.
const mx = { answers: true };
vi.mock("../src/lib/email-domain", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, hasMailExchanger: async () => mx.answers };
});

// In-memory KVNamespace: get / put / delete / list(prefix) — all the flow uses.
function fakeKv() {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  } as unknown as KVNamespace;
  return { kv, store };
}

// The handler does its emailing and inbox ingest inside waitUntil, so a test
// that drops those promises asserts on work that has not happened yet. This ctx
// collects them and `settle()` awaits them — which is also what the platform
// does before tearing the request down.
const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => void pending.push(p),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const settle = async () => { while (pending.length) await pending.shift(); };

let env: Env;
let store: Map<string, string>;
let sent: { to: string; subject: string; text: string }[];

const app = new Hono<{ Bindings: Env }>();
app.route("/v1/keys/demo", keysDemo);
app.route("/v1/keys", keys);
app.route("/v1/admin", admin);

const request = async (body: unknown, ip = "1.1.1.1") => {
  const res = await app.request("/v1/keys", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) }, env, ctx);
  await settle();
  return res;
};
const adminCall = async (path: string, method = "GET", token = "secret-admin") => {
  const res = await app.request(`/v1/admin${path}`, { method, headers: { Authorization: `Bearer ${token}` } }, env, ctx);
  await settle();
  return res;
};

const valid = { email: "dev@evcompare.fr", name: "Dev", company: "EV Compare", website: "evcompare.fr", role: "Developer", use_case: "Comparison site for EVs in France, public, ad-funded.", accept_tos: true };

beforeEach(() => {
  const f = fakeKv();
  store = f.store;
  sent = [];
  pending.length = 0;
  mx.answers = true;
  env = { API_KEYS: f.kv, ADMIN_TOKEN: "secret-admin", BREVO_API_KEY: "b", NOTIFY_TO: "owner@example.com" } as unknown as Env;
  vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    sent.push({ to: b.to[0].email, subject: b.subject, text: b.textContent });
    return new Response("{}", { status: 201 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("key requests — one self-serve tier, auto-issued (owner, 2026-10-06)", () => {
  // There is no reviewed Free tier any more: nothing self-serve reaches the
  // full catalogue. The form still asks everything it asked for review (T90),
  // because those fields were never the gate — they are the lead — and asking
  // for them after issuing means nobody fills them in.
  const verifyLink = () => /verify\?t=([0-9a-f]{48})/.exec(sent.at(-1)!.text)![1];
  const clickLink = async (t: string) => {
    const res = await app.request(`/v1/keys/demo/verify?t=${t}`, {}, env, ctx);
    await settle();
    return res;
  };

  it("records the request, issues NO key, and emails the REQUESTER a link", async () => {
    const res = await request(valid);
    expect(res.status).toBe(202);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data.status).toBe("verification_sent");
    expect(JSON.stringify(body)).not.toContain("cd_demo_");
    expect([...store.keys()].some((k) => k.startsWith("key:"))).toBe(false);
    // The owner is NOT told yet, which is the change: an address nobody
    // confirmed is noise in an inbox a person reads.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("dev@evcompare.fr");
    expect(sent[0].text).toMatch(/\/v1\/keys\/demo\/verify\?t=[0-9a-f]{48}/);
  });

  it("requires company, website and role (T90) — still, because they are the lead", async () => {
    expect((await request({ ...valid, company: "" })).status).toBe(400);
    expect((await request({ ...valid, website: undefined })).status).toBe(400);
    expect((await request({ ...valid, website: "not a site" })).status).toBe(400);
    expect((await request({ ...valid, website: "javascript:alert(1)" })).status).toBe(400);
    expect((await request({ ...valid, role: " " })).status).toBe(400);
  });

  it("rejects a request without a real use case", async () => {
    expect((await request({ ...valid, use_case: "test" })).status).toBe(400);
  });

  it("the click mints the key and ONLY THEN hands the owner the full lead", async () => {
    expect((await request(valid)).status).toBe(202);
    const res = await clickLink(verifyLink());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { api_key: string; plan: string } };
    expect(body.data.api_key).toMatch(/^cd_demo_[0-9a-f]{48}$/);
    expect(body.data.plan).toBe("demo");

    const rec = JSON.parse(store.get([...store.keys()].find((k) => k.startsWith("key:"))!)!);
    expect(rec.plan).toBe("demo");
    expect(rec.email_verified).toBe(true);

    // The lead, with every field, and the website normalised.
    const toOwner = sent.find((m) => m.to === "owner@example.com")!;
    expect(toOwner.text).toContain("Company: EV Compare");
    expect(toOwner.text).toContain("Website: https://evcompare.fr");
    expect(toOwner.text).toContain("Role:    Developer");
    expect(toOwner.text).toContain("Comparison site for EVs in France");
    // And the requester gets the key itself, nobody else.
    const toUser = sent.filter((m) => m.to === "dev@evcompare.fr").at(-1)!;
    expect(toUser.text).toContain(body.data.api_key);
    expect(toOwner.text).not.toContain(body.data.api_key);
  });

  it("a second request RESENDS a link instead of refusing — a lost email is not a lockout", async () => {
    // Deliberately different from the retired flow, which created one request
    // per address and ignored the rest. Nothing is minted until a click, so a
    // second link costs an email and the per-IP cap bounds it.
    await request(valid);
    await request({ ...valid, email: "DEV@evcompare.fr" });
    expect(sent).toHaveLength(2);
    expect([...store.keys()].filter((k) => k.startsWith("demoverify:"))).toHaveLength(2);
    expect([...store.keys()].some((k) => k.startsWith("key:"))).toBe(false);
  });

  it("once a key EXISTS for the address, a repeat request is refused and says why", async () => {
    await request(valid);
    await clickLink(verifyLink());
    const res = await request(valid);
    expect(res.status).toBe(409);
    expect((await res.json() as { detail: string }).detail).toMatch(/cannot resend/);
    expect([...store.keys()].filter((k) => k.startsWith("key:"))).toHaveLength(1);
  });

  it("a double click cannot mint two keys", async () => {
    await request(valid);
    const t = verifyLink();
    expect((await clickLink(t)).status).toBe(200);
    expect((await clickLink(t)).status).toBe(409);
    expect([...store.keys()].filter((k) => k.startsWith("key:"))).toHaveLength(1);
  });

  it("caps requests per IP per day, and points at the surface that needs no key", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await request({ ...valid, email: `a${i}@evcompare.fr` })).status).toBe(202);
    }
    const over = await request({ ...valid, email: "late@evcompare.fr" });
    expect(over.status).toBe(429);
    expect((await over.json() as { detail: string }).detail).toMatch(/\/mcp/);
    expect((await request({ ...valid, email: "other@carscope.de" }, "2.2.2.2")).status).toBe(202);
  });

  it("refuses a domain that takes no mail — we cannot send a key there", async () => {
    mx.answers = false;
    const res = await request({ ...valid, email: "dev@nothing-here-xyz9.io" });
    expect(res.status).toBe(422);
    expect((await res.json() as { detail: string }).detail).toMatch(/does not accept email/);
  });

  it("gmail is NOT blocked by a per-domain rule — one key per ADDRESS", async () => {
    // The plan said one key per DOMAIN. That would have let exactly one gmail
    // user through, ever; 17 of the 184 existing keys are gmail.
    expect((await request({ ...valid, email: "alice@gmail.com" })).status).toBe(202);
    expect((await request({ ...valid, email: "bob@gmail.com" }, "9.9.9.9")).status).toBe(202);
  });

  it("a malformed or forged verification link is refused, not guessed at", async () => {
    for (const t of ["", "abc", "z".repeat(48), "0".repeat(48)]) {
      const res = await app.request(`/v1/keys/demo/verify?t=${t}`, {}, env, ctx);
      expect([400, 409]).toContain(res.status);
    }
    expect([...store.keys()].some((k) => k.startsWith("key:"))).toBe(false);
  });

  it("a junk body is a 400, not a crash", async () => {
    for (const v of [undefined, "", "not-an-email", 42, { a: 1 }]) {
      expect((await request({ ...valid, email: v })).status, String(v)).toBe(400);
    }
  });

  it("refuses disposable and non-deliverable addresses before spending anything", async () => {
    expect((await request({ ...valid, email: "x@1secmail.com" })).status).toBe(422);
    expect((await request({ ...valid, email: "x@cars-data.com" })).status).toBe(422);
    expect((await request({ ...valid, email: "x@example.com" })).status).toBe(422);
    expect(sent).toHaveLength(0);
    expect([...store.keys()]).toHaveLength(0);
  });
});

describe("browser form CORS", () => {
  it("answers the preflight for cars-data.com and echoes the origin on POST", async () => {
    const pre = await app.request("/v1/keys", { method: "OPTIONS", headers: { Origin: "https://cars-data.com" } }, env, ctx);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("https://cars-data.com");
    const res = await app.request("/v1/keys", { method: "POST", headers: { Origin: "https://cars-data.com", "content-type": "application/json" }, body: JSON.stringify(valid) }, env, ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://cars-data.com");
  });

  it("does not grant CORS to other origins", async () => {
    const pre = await app.request("/v1/keys", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }, env, ctx);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("admin grant — the only path to a non-demo key", () => {
  it("is invisible without the admin token", async () => {
    expect((await adminCall("/grant?email=x@carscope.de", "POST", "wrong")).status).toBe(404);
  });

  it("mints a working key on the chosen plan and emails the holder only", async () => {
    const res = await adminCall("/grant?email=mirsad@softcrafter.net&plan=free", "POST");
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { key_hash_prefix: string; emailed: boolean; plan: string } };
    expect(data.plan).toBe("free");
    expect(data.emailed).toBe(true);

    const toUser = sent.find((m) => m.to === "mirsad@softcrafter.net")!;
    const key = /cd_free_[0-9a-f]{48}/.exec(toUser.text)![0];
    expect(sent.some((m) => m.to === "owner@example.com")).toBe(false);

    // and it authenticates, on the full catalogue
    const auth = await authenticate(env, key);
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.record.plan).toBe("free");
  });

  it("refuses a plan it does not know, rather than inventing one", async () => {
    expect((await adminCall("/grant?email=x@carscope.de&plan=enterprise", "POST")).status).toBe(400);
    expect((await adminCall("/grant?email=not-an-email", "POST")).status).toBe(400);
  });
});

describe("authenticate", () => {
  const put = async (raw: string, r: Partial<KeyRecord>) =>
    store.set(`key:${await sha256Hex(raw)}`, JSON.stringify({ email: "x@y.z", plan: "free", tos_version: "v", tos_accepted_at: "", created_at: "", email_verified: false, ...r }));

  it("turns away a key issued before manual approval existed", async () => {
    await put("cd_free_legacy", {});
    expect(await authenticate(env, "cd_free_legacy")).toMatchObject({ ok: false, status: 403 });
  });

  it("accepts it once the owner approves it, and refuses it once revoked", async () => {
    await put("cd_free_ok", { approved: true });
    expect((await authenticate(env, "cd_free_ok")).ok).toBe(true);
    await put("cd_free_rev", { approved: true, revoked_at: "2026-10-02" });
    expect(await authenticate(env, "cd_free_rev")).toMatchObject({ ok: false, status: 403 });
  });

  it("leaves Apify keys working without approval", async () => {
    await put("cd_apify_x", { plan: "apify" });
    expect((await authenticate(env, "cd_apify_x")).ok).toBe(true);
  });

  it("reads the key from X-Api-Key, Bearer, or ?key= (MCP URL-only connectors)", () => {
    expect(readApiKey(new Headers({ "X-Api-Key": "a" }))).toBe("a");
    expect(readApiKey(new Headers({ Authorization: "Bearer b" }))).toBe("b");
    expect(readApiKey(new Headers(), new URL("https://api.cars-data.com/mcp?key=c"))).toBe("c");
    expect(readApiKey(new Headers())).toBeNull();
  });

  it("requires a key at all", async () => {
    expect(await authenticate(env, null)).toMatchObject({ ok: false, status: 401 });
  });
});

// T77: a key request goes into the site's contact_messages via /api/inbox/ingest
// (which emails the owner); the Worker emails directly only if that fails.
describe("the lead reaches the site inbox (T77) — at the click, not the request", () => {
  const verifyLink = () => /verify\?t=([0-9a-f]{48})/.exec(sent.at(-1)!.text)![1];

  it("ingests the verified lead with every field, and sends no duplicate to the owner", async () => {
    const ingested: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      if (String(u).includes("/api/inbox/ingest")) { ingested.push(b); return new Response("{}", { status: 200 }); }
      sent.push({ to: b.to[0].email, subject: b.subject, text: b.textContent });
      return new Response("{}", { status: 201 });
    });
    env = { ...env, INBOX_INGEST_TOKEN: "t" } as unknown as Env;

    await request(valid);
    await app.request(`/v1/keys/demo/verify?t=${verifyLink()}`, {}, env, ctx);
    await settle();

    expect(ingested).toHaveLength(1);
    expect(ingested[0].kind).toBe("api_key_request");
    expect(ingested[0].email).toBe("dev@evcompare.fr");
    const meta = ingested[0].meta as Record<string, unknown>;
    expect(meta).toMatchObject({ company: "EV Compare", website: "https://evcompare.fr", role: "Developer", auto_issued: true });
    // the inbox got it, so the owner is not emailed a second copy
    expect(sent.filter((m) => m.to === "owner@example.com")).toHaveLength(0);
  });

  it("falls back to emailing the owner when ingest fails", async () => {
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      if (String(u).includes("/api/inbox/ingest")) return new Response("nope", { status: 500 });
      const b = JSON.parse(String(init.body));
      sent.push({ to: b.to[0].email, subject: b.subject, text: b.textContent });
      return new Response("{}", { status: 201 });
    });
    env = { ...env, INBOX_INGEST_TOKEN: "t" } as unknown as Env;

    await request(valid);
    await app.request(`/v1/keys/demo/verify?t=${verifyLink()}`, {}, env, ctx);
    await settle();

    const toOwner = sent.find((m) => m.to === "owner@example.com")!;
    expect(toOwner.text).toContain("Company: EV Compare");
  });
});
