import { describe, test, expect, vi, beforeEach } from "vitest";

const FAKE_IDS = new Set(Array.from({ length: 40 }, (_, i) => 3000 + i));
vi.mock("../src/lib/demo-set", () => ({
  DEMO_VARIANT_IDS: FAKE_IDS, DEMO_GENERATION_IDS: new Set([9]), DEMO_MODEL_IDS: new Set([8]),
  DEMO_SET_SIZE: 40, DEMO_SET_DESCRIPTION: "test set", demoSetReady: () => true,
}));
const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("../src/lib/notify", () => ({
  sendEmail: async (_e: unknown, m: { to: string; subject: string; text: string }) => { sent.push(m); return true; },
  ingestToInbox: async () => true,
}));
let mxAnswer = true;
const mxCalls: string[] = [];
vi.mock("../src/lib/email-domain", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, hasMailExchanger: async (d: string) => { mxCalls.push(d); return mxAnswer; } };
});

const { keysDemo } = await import("../src/routes/keys-demo");

function env() {
  const store = new Map<string, string>();
  return {
    store,
    env: {
      IP_HASH_SALT: "salt",
      NOTIFY_TO: "office@cars-data.com",
      API_KEYS: {
        async get(k: string) { return store.get(k) ?? null; },
        async put(k: string, v: string) { store.set(k, v); },
        async delete(k: string) { store.delete(k); },
      },
    } as never,
  };
}

const post = (e: never, email: unknown, ip = "1.2.3.4") =>
  keysDemo.fetch(
    new Request("http://x/", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ email }) }),
    e,
    { waitUntil: (p: Promise<unknown>) => p } as never,
  );

beforeEach(() => { sent.length = 0; mxCalls.length = 0; mxAnswer = true; });

describe("self-serve demo keys (T111 R1–R4)", () => {
  test("a real address gets a verification email and NO key yet", async () => {
    const { env: e, store } = env();
    const res = await post(e, "dev@clearfly.co.uk");
    expect(res.status).toBe(202);
    expect([...store.keys()].some((k) => k.startsWith("demoverify:"))).toBe(true);
    // the whole difference from the flow that produced 135 dead records:
    expect([...store.keys()].some((k) => k.startsWith("key:"))).toBe(false);
    expect(sent[0].text).toMatch(/\/v1\/keys\/demo\/verify\?t=[0-9a-f]{48}/);
  });

  test("clicking the link creates the key, once", async () => {
    const { env: e, store } = env();
    await post(e, "dev@clearfly.co.uk");
    const link = /verify\?t=([0-9a-f]{48})/.exec(sent[0].text)![1];
    const ok = await keysDemo.fetch(new Request(`http://x/verify?t=${link}`), e, { waitUntil: (p: Promise<unknown>) => p } as never);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.data.api_key).toMatch(/^cd_demo_[0-9a-f]{48}$/);
    expect(body.data.plan).toBe("demo");
    const rec = JSON.parse(store.get([...store.keys()].find((k) => k.startsWith("key:"))!)!);
    expect(rec.plan).toBe("demo");
    expect(rec.approved).toBe(true);

    // a second click must not mint a second key
    const again = await keysDemo.fetch(new Request(`http://x/verify?t=${link}`), e, { waitUntil: (p: Promise<unknown>) => p } as never);
    expect(again.status).toBe(409);
    expect([...store.keys()].filter((k) => k.startsWith("key:")).length).toBe(1);
  });

  test("DISPOSABLE mail is refused, and without spending a DNS lookup", async () => {
    const { env: e } = env();
    for (const addr of ["x@1secmail.com", "x@wwjmp.com", "x@esiix.com", "x@mailinator.com"]) {
      const res = await post(e, addr);
      expect(res.status, addr).toBe(422);
      expect((await res.json()).detail).toMatch(/disposable/i);
    }
    expect(mxCalls).toHaveLength(0);
  });

  test("our own and synthetic domains are refused — they are 20 of today's 184 records", async () => {
    const { env: e } = env();
    for (const addr of ["x@cars-data.com", "x@example.com", "x@test.com", "x@hermes-test.local"]) {
      expect((await post(e, addr)).status, addr).toBe(422);
    }
  });

  test("a domain that takes no mail is refused", async () => {
    const { env: e } = env();
    mxAnswer = false;
    const res = await post(e, "dev@nothing-here.io");
    expect(res.status).toBe(422);
    expect((await res.json()).detail).toMatch(/does not accept email/);
  });

  test("gmail is NOT blocked by a per-domain rule — one key per ADDRESS", async () => {
    // The plan said one demo per DOMAIN. That would have let exactly one gmail
    // user through, ever. 17 of the existing keys are gmail.
    const { env: e } = env();
    expect((await post(e, "alice@gmail.com")).status).toBe(202);
    expect((await post(e, "bob@gmail.com", "5.6.7.8")).status).toBe(202);
  });

  test("the same address twice, after a key exists, is told plainly — not reissued, not duplicated", async () => {
    const { env: e, store } = env();
    await post(e, "dev@clearfly.co.uk");
    const t = /verify\?t=([0-9a-f]{48})/.exec(sent[0].text)![1];
    await keysDemo.fetch(new Request(`http://x/verify?t=${t}`), e, { waitUntil: (p: Promise<unknown>) => p } as never);
    const res = await post(e, "dev@clearfly.co.uk");
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toMatch(/cannot resend/);
    expect([...store.keys()].filter((k) => k.startsWith("key:")).length).toBe(1);
  });

  test("per-IP cap, and it points at the surface that needs no key at all", async () => {
    const { env: e } = env();
    for (let i = 0; i < 5; i++) expect((await post(e, `u${i}@clearfly.co.uk`)).status).toBe(202);
    const res = await post(e, "u6@clearfly.co.uk");
    expect(res.status).toBe(429);
    expect((await res.json()).detail).toMatch(/\/mcp/);
  });

  test("a malformed or forged verification link is refused", async () => {
    const { env: e } = env();
    for (const t of ["", "abc", "z".repeat(48), "0".repeat(48)]) {
      const res = await keysDemo.fetch(new Request(`http://x/verify?t=${t}`), e, { waitUntil: (p: Promise<unknown>) => p } as never);
      expect([400, 409]).toContain(res.status);
    }
  });

  test("a junk body is a 400, not a crash", async () => {
    const { env: e } = env();
    for (const v of [undefined, "", "not-an-email", 42, { a: 1 }]) {
      expect((await post(e, v)).status, String(v)).toBe(400);
    }
  });
});
