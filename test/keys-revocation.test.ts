import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { admin } from "../src/routes/admin";
import { authenticate } from "../src/lib/auth-key";
import { sha256Hex, type KeyRecord } from "../src/lib/apikey";
import type { Env } from "../src/types";

// T944 — revocation has to survive ONE wrong keystroke.
//
// The state these tests defend is not hypothetical. Measured on production
// 2026-10-20 with `GET /v1/admin/keys`: 192 keys, 6 usable, 186 revoked, 183
// of the revoked ones on the retired `free` plan, which still resolves the
// WHOLE catalogue at 1.000/month. Before this change a single
// `POST /v1/admin/keys/<prefix>/approve` set `approved: true` AND wrote
// `revoked_at: undefined`, so every one of those 186 was one mistyped row
// away from working again.
//
// Every case below drives the REAL `admin` router against a real KV double
// and reads the stored record back; nothing here re-implements the decision
// it is checking. Probed RED against a mutant that restores
// `revoked_at: undefined` in the approve branch — see the T944 queue block.

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

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const app = new Hono<{ Bindings: Env }>();
app.route("/v1/admin", admin);

let env: Env;
let store: Map<string, string>;

const call = (path: string, method = "POST", token = "secret-admin") =>
  app.request(`/v1/admin${path}`, { method, headers: { Authorization: `Bearer ${token}` } }, env, ctx);

/** Writes a key record and returns the raw key plus the 8-char hash prefix
 *  the admin surface addresses it by — the same slice routes/admin.ts uses. */
async function put(raw: string, r: Partial<KeyRecord> = {}) {
  const hash = await sha256Hex(raw);
  store.set(`key:${hash}`, JSON.stringify({
    email: "holder@carscope.de",
    plan: "free",
    tos_version: "2026-10-15-v8",
    tos_accepted_at: "2026-10-01T00:00:00.000Z",
    created_at: "2026-10-01T00:00:00.000Z",
    email_verified: false,
    ...r,
  }));
  return { raw, hash, prefix: hash.slice(0, 8) };
}

const stored = (hash: string) => JSON.parse(store.get(`key:${hash}`)!) as KeyRecord;

beforeEach(() => {
  const f = fakeKv();
  store = f.store;
  env = { API_KEYS: f.kv, ADMIN_TOKEN: "secret-admin" } as unknown as Env;
});

describe("one wrong keystroke cannot restore a revoked key (T944)", () => {
  it("approve REFUSES a revoked key and leaves the record untouched", async () => {
    const k = await put("cd_free_revoked", { approved: true, revoked_at: "2026-10-08T10:00:00.000Z", revoked_reason: "temp-mail sweep" });
    const before = store.get(`key:${k.hash}`);

    const res = await call(`/keys/${k.prefix}/approve`);
    expect(res.status).toBe(409);
    const body = await res.json() as { detail: string };
    // The refusal has to hand over the way forward, or the owner reaches for
    // raw KV — which is how the field got cleared silently in the first place.
    expect(body.detail).toMatch(/unrevoke\?confirm=/);
    expect(body.detail).toContain("temp-mail sweep");

    // Nothing was written. Byte-for-byte, not field-by-field.
    expect(store.get(`key:${k.hash}`)).toBe(before);
    expect((await authenticate(env, "cd_free_revoked"))).toMatchObject({ ok: false, status: 403 });
  });

  it("NO single admin call turns a revoked free key usable", async () => {
    const k = await put("cd_free_sweep", { approved: true, revoked_at: "2026-10-08T10:00:00.000Z" });
    // Every one-shot shape an owner could plausibly fire at the wrong row.
    for (const path of [
      `/keys/${k.prefix}/approve`,
      `/keys/${k.prefix}/revoke`,
      `/keys/${k.prefix}/unrevoke`,
      `/keys/${k.prefix}/unrevoke?confirm=`,
      `/keys/${k.prefix}/unrevoke?confirm=yes`,
      `/keys/${k.prefix}/unrevoke?confirm=${k.hash}`,
    ]) {
      await call(path);
      expect(stored(k.hash).revoked_at, path).toBeTruthy();
      expect((await authenticate(env, "cd_free_sweep")).ok, path).toBe(false);
    }
  });

  it("unrevoke needs the key's OWN prefix echoed back, not any confirmation", async () => {
    const a = await put("cd_free_a", { approved: true, revoked_at: "2026-10-08T10:00:00.000Z" });
    const b = await put("cd_free_b", { approved: true, revoked_at: "2026-10-08T10:00:00.000Z" });

    // Another real key's prefix is still the wrong answer for this one.
    const res = await call(`/keys/${a.prefix}/unrevoke?confirm=${b.prefix}`);
    expect(res.status).toBe(400);
    expect(stored(a.hash).revoked_at).toBeTruthy();
    expect(stored(b.hash).revoked_at).toBeTruthy();
  });
});

describe("coming back is possible, and takes two deliberate commands", () => {
  it("unrevoke clears the revocation but does NOT grant approval", async () => {
    const k = await put("cd_free_back", { revoked_at: "2026-10-08T10:00:00.000Z", revoked_reason: "unused" });

    const res = await call(`/keys/${k.prefix}/unrevoke?confirm=${k.prefix}`);
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { usable: boolean; revoked_at: string | null } };

    const rec = stored(k.hash);
    expect(rec.revoked_at).toBeUndefined();
    expect(rec.revoked_reason).toBeUndefined();
    expect(rec.unrevoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Still inert: this is a `free` key and nobody approved it.
    expect(rec.approved).not.toBe(true);
    expect(data.usable).toBe(false);
    expect(data.revoked_at).toBeNull();
    expect((await authenticate(env, "cd_free_back"))).toMatchObject({ ok: false, status: 403 });

    // The SECOND, differently-named command is what makes it work again.
    expect((await call(`/keys/${k.prefix}/approve`)).status).toBe(200);
    expect((await authenticate(env, "cd_free_back")).ok).toBe(true);
    // and the round trip is still visible on the record
    expect(stored(k.hash).unrevoked_at).toBeTruthy();
  });

  it("refuses to un-revoke a key that is not revoked, instead of writing a no-op", async () => {
    const k = await put("cd_free_live", { approved: true });
    const res = await call(`/keys/${k.prefix}/unrevoke?confirm=${k.prefix}`);
    expect(res.status).toBe(409);
    expect(stored(k.hash).unrevoked_at).toBeUndefined();
    expect((await authenticate(env, "cd_free_live")).ok).toBe(true);
  });

  it("approve still works normally on a key that was never revoked", async () => {
    const k = await put("cd_free_pending");
    expect((await authenticate(env, "cd_free_pending"))).toMatchObject({ ok: false, status: 403 });
    expect((await call(`/keys/${k.prefix}/approve`)).status).toBe(200);
    expect(stored(k.hash).approved).toBe(true);
    expect((await authenticate(env, "cd_free_pending")).ok).toBe(true);
  });
});

describe("a revocation records WHY, and the listing shows it", () => {
  it("revoke stores the reason and the listing projects when and why", async () => {
    const k = await put("cd_demo_abuse", { plan: "demo", approved: true });
    expect((await authenticate(env, "cd_demo_abuse")).ok).toBe(true);

    const res = await call(`/keys/${k.prefix}/revoke?reason=${encodeURIComponent("temp-mail domain (mailinator.com)")}`);
    expect(res.status).toBe(200);
    expect(stored(k.hash).revoked_reason).toBe("temp-mail domain (mailinator.com)");
    expect((await authenticate(env, "cd_demo_abuse"))).toMatchObject({ ok: false, status: 403 });

    const { data } = await (await call("/keys", "GET")).json() as { data: Record<string, unknown>[] };
    expect(data).toHaveLength(1);
    expect(data[0].revoked).toBe(true);
    expect(data[0].revoked_reason).toBe("temp-mail domain (mailinator.com)");
    expect(data[0].revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data[0].usable).toBe(false);
  });

  it("a revocation with no reason reads back null, never an invented one", async () => {
    // The shape of all 186 records already in production: revoked before the
    // field existed. "Not recorded" must not render as "no reason given".
    const k = await put("cd_free_old", { approved: true, revoked_at: "2026-10-08T10:00:00.000Z" });
    const { data } = await (await call("/keys", "GET")).json() as { data: Record<string, unknown>[] };
    expect(data[0].revoked).toBe(true);
    expect(data[0].revoked_at).toBe("2026-10-08T10:00:00.000Z");
    expect(data[0].revoked_reason).toBeNull();
    expect(data[0].unrevoked_at).toBeNull();
    expect(stored(k.hash).revoked_reason).toBeUndefined();
  });

  it("the whole surface is still invisible without the admin token", async () => {
    const k = await put("cd_free_x", { revoked_at: "2026-10-08T10:00:00.000Z" });
    for (const p of [`/keys/${k.prefix}/approve`, `/keys/${k.prefix}/unrevoke?confirm=${k.prefix}`, `/keys/${k.prefix}/revoke`]) {
      expect((await call(p, "POST", "wrong")).status).toBe(404);
    }
    expect(stored(k.hash).revoked_at).toBe("2026-10-08T10:00:00.000Z");
  });
});

// The sweep tool (scripts/keys-admin.mjs) decides whether the DEPLOYED Worker
// still has the T944 hole by firing `unrevoke` with a deliberately wrong
// `confirm` and reading the status code. That reading is only as good as the
// two cases below, so they are pinned here — against the REAL app from
// src/app.ts, with its real middleware order, not against the admin router in
// isolation. Measured on production 2026-10-20 before the fix: 401.
describe("the sweep's capability probe reads a real status code (T944)", () => {
  it("post-T944 answers 400 to a wrong confirm, and an unknown admin action still falls through to 401", async () => {
    const { app: realApp } = await import("../src/app");
    const k = await put("cd_free_probe", { approved: true, revoked_at: "2026-10-08T10:00:00.000Z" });
    const hit = (p: string) =>
      realApp.request(`/v1/admin/keys/${k.prefix}/${p}`, { method: "POST", headers: { Authorization: "Bearer secret-admin" } }, env, ctx);

    // The probe's "fixed" leg: the route exists and refuses the bad confirm.
    expect((await hit("unrevoke?confirm=__probe_not_a_prefix__")).status).toBe(400);

    // The probe's "not fixed" leg, reproduced: an action the admin router does
    // not know falls past it into requireApiKey, which reads the admin token
    // as an API key and does not find one. That is why the probe treats 401
    // exactly like 404 — both mean "no such admin route".
    expect((await hit("resurrect")).status).toBe(401);

    // Neither request touched the record.
    expect(stored(k.hash).revoked_at).toBe("2026-10-08T10:00:00.000Z");
    expect(stored(k.hash).unrevoked_at).toBeUndefined();
  });
});
