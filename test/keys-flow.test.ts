import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { keys, REQUESTS_PER_IP_PER_DAY } from "../src/routes/keys";
import { admin } from "../src/routes/admin";
import { authenticate, readApiKey } from "../src/lib/auth-key";
import { sha256Hex, type KeyRecord } from "../src/lib/apikey";
import type { Env } from "../src/types";

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

const ctx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let env: Env;
let store: Map<string, string>;
let sent: { to: string; subject: string; text: string }[];

const app = new Hono<{ Bindings: Env }>();
app.route("/v1/keys", keys);
app.route("/v1/admin", admin);

const request = (body: unknown, ip = "1.1.1.1") =>
  app.request("/v1/keys", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) }, env, ctx);
const adminCall = (path: string, method = "GET", token = "secret-admin") =>
  app.request(`/v1/admin${path}`, { method, headers: { Authorization: `Bearer ${token}` } }, env, ctx);

const valid = { email: "dev@example.com", name: "Dev", company: "EV Compare", website: "evcompare.fr", role: "Developer", use_case: "Comparison site for EVs in France, public, ad-funded.", accept_tos: true };

beforeEach(() => {
  const f = fakeKv();
  store = f.store;
  sent = [];
  env = { API_KEYS: f.kv, ADMIN_TOKEN: "secret-admin", BREVO_API_KEY: "b", NOTIFY_TO: "owner@example.com" } as unknown as Env;
  vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    sent.push({ to: b.to[0].email, subject: b.subject, text: b.textContent });
    return new Response("{}", { status: 201 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("key requests", () => {
  it("records a pending request, issues NO key, and emails the owner", async () => {
    const res = await request(valid);
    expect(res.status).toBe(202);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data.status).toBe("pending_review");
    expect(JSON.stringify(body)).not.toContain("cd_free_");
    expect([...store.keys()].some((k) => k.startsWith("key:"))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@example.com");
    expect(sent[0].text).toContain("keys-admin.mjs approve");
  });

  it("requires company, website and role (T90)", async () => {
    expect((await request({ ...valid, company: "" })).status).toBe(400);
    expect((await request({ ...valid, website: undefined })).status).toBe(400);
    expect((await request({ ...valid, website: "not a site" })).status).toBe(400);
    expect((await request({ ...valid, website: "javascript:alert(1)" })).status).toBe(400);
    expect((await request({ ...valid, role: " " })).status).toBe(400);
  });

  it("stores the website normalised and shows all three to the owner", async () => {
    expect((await request(valid)).status).toBe(202);
    const rec = JSON.parse(store.get([...store.keys()].find((k) => k.startsWith("keyreq:"))!)!);
    expect(rec).toMatchObject({ company: "EV Compare", website: "https://evcompare.fr", role: "Developer" });
    expect(sent[0].text).toContain("Website: https://evcompare.fr");
    expect(sent[0].text).toContain("Role:    Developer");
  });

  it("rejects a request without a real use case", async () => {
    expect((await request({ ...valid, use_case: "test" })).status).toBe(400);
  });

  it("does not create a second request for the same email", async () => {
    await request(valid);
    await request({ ...valid, email: "DEV@example.com" });
    expect([...store.keys()].filter((k) => k.startsWith("keyreq:"))).toHaveLength(1);
  });

  it(`caps requests at ${REQUESTS_PER_IP_PER_DAY} per IP per day`, async () => {
    for (let i = 0; i < REQUESTS_PER_IP_PER_DAY; i++) expect((await request({ ...valid, email: `a${i}@example.com` })).status).toBe(202);
    expect((await request({ ...valid, email: "late@example.com" })).status).toBe(429);
    expect((await request({ ...valid, email: "other@example.com" }, "2.2.2.2")).status).toBe(202);
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

describe("admin approval", () => {
  it("is invisible without the admin token", async () => {
    expect((await adminCall("/requests", "GET", "wrong")).status).toBe(404);
  });

  it("approve mints a working key and emails it to the requester only", async () => {
    await request(valid);
    const list = await (await adminCall("/requests")).json() as { data: { id: string }[] };
    const id = list.data[0].id;
    const res = await adminCall(`/requests/${id}/approve`, "POST");
    expect(res.status).toBe(200);
    const mail = sent.find((m) => m.to === "dev@example.com")!;
    const key = /cd_free_[0-9a-f]+/.exec(mail.text)![0];
    const auth = await authenticate(env, key);
    expect(auth.ok).toBe(true);
    expect((await adminCall(`/requests/${id}/approve`, "POST")).status).toBe(409);
  });

  it("reject frees the email for a better request", async () => {
    await request(valid);
    const id = ((await (await adminCall("/requests")).json()) as { data: { id: string }[] }).data[0].id;
    await adminCall(`/requests/${id}/reject`, "POST");
    expect((await request(valid, "3.3.3.3")).status).toBe(202);
    expect([...store.keys()].filter((k) => k.startsWith("keyreq:"))).toHaveLength(2);
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
describe("key requests → site inbox (T77)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  let calls: { url: string; body: Record<string, unknown> }[];
  const stubFetch = (ingestStatus: number) =>
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url: String(u), body });
      return new Response("{}", { status: String(u).includes("/api/inbox/ingest") ? ingestStatus : 201 });
    });
  beforeEach(() => {
    calls = [];
    env = { ...env, INBOX_INGEST_TOKEN: "ingest-secret" } as Env;
  });

  it("stores it through the ingest route and sends no second email", async () => {
    stubFetch(201);
    expect((await request(valid)).status).toBe(202);
    await flush();
    expect(calls.map((c) => c.url)).toEqual(["https://cars-data.com/api/inbox/ingest"]);
    expect(calls[0].body.kind).toBe("api_key_request");
    expect(calls[0].body.email).toBe("dev@example.com");
    expect(JSON.stringify(calls[0].body)).not.toContain("1.1.1.1"); // only the hash leaves
  });

  it("falls back to emailing the owner when ingest fails", async () => {
    stubFetch(500);
    expect((await request(valid)).status).toBe(202);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("api.brevo.com");
  });
});
