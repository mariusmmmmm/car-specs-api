import { describe, expect, test } from "vitest";
import { checkAndConsume, PLAN_QUOTAS, ALL_PLAN_QUOTAS, GLOBAL_DAILY_CATALOGUE_READS } from "./quota";

/**
 * A KV stub that can be told to break. The point of these tests is not that
 * counting works — it is what happens when counting CANNOT work, which is the
 * case that shipped wrong and stayed wrong from 2026-07 to 2026-10.
 */
function fakeKv(opts: { seed?: Record<string, string>; failGet?: boolean; failPut?: boolean } = {}) {
  const store = new Map<string, string>(Object.entries(opts.seed ?? {}));
  const puts: string[] = [];
  return {
    puts,
    store,
    kv: {
      async get(k: string) {
        if (opts.failGet) throw new Error("KV get unavailable");
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        if (opts.failPut) throw new Error("KV put unavailable");
        puts.push(k);
        store.set(k, v);
      },
    } as unknown as KVNamespace,
  };
}

const HASH = "deadbeef";

// `free` is retired as an OFFER (D-01, 2026-10-08) but still metered, because
// one approved key is still live. These tests were written against it and stay
// against it on purpose: they are now the proof that the legacy plan is served
// exactly as before, which is the one thing T166 was not allowed to change.
const LEGACY = "free" as const;

describe("checkAndConsume — fail CLOSED when metering breaks (T79)", () => {
  // The defect: incident 889ca1e made a failed put serve the request anyway,
  // to stop the Workers KV free-tier daily put cap from 500-ing the API. The
  // account left the free tier on 2026-07-27, so the reason expired — but the
  // open door did not. Over that quota, a key was served and nothing recorded it.
  test("a failed PUT refuses the request instead of serving it unmetered", async () => {
    const { kv } = fakeKv({ failPut: true });
    const r = await checkAndConsume(kv, HASH, LEGACY);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("metering");
  });

  test("a failed GET refuses too — a count we cannot read is not a count of zero", async () => {
    const { kv } = fakeKv({ failGet: true });
    const r = await checkAndConsume(kv, HASH, LEGACY);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("metering");
  });

  test("the happy path still counts, and writes all three buckets", async () => {
    const { kv, puts } = fakeKv();
    const r = await checkAndConsume(kv, HASH, LEGACY);
    expect(r.ok).toBe(true);
    expect(r.ok && r.used).toBe(1);
    expect(puts.filter((k) => k.startsWith("usage:")).length).toBe(1);
    expect(puts.filter((k) => k.startsWith("daily:")).length).toBe(1);
    expect(puts.filter((k) => k.startsWith("rl:")).length).toBe(1);
  });
});

describe("daily cap — how FAST a key may spend its month", () => {
  // August 30-31: 139 keys, 109.969 calls, and every key stayed inside its
  // monthly cap (max 987 of 1000). The monthly number was never breached, so
  // it never fired. This is the limit that would have.
  test("a key at its daily ceiling is refused, with its own reason", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const { kv } = fakeKv({ seed: { [`daily:${HASH}:${day}`]: String(ALL_PLAN_QUOTAS.free.daily) } });
    const r = await checkAndConsume(kv, HASH, LEGACY);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("daily");
  });

  test("one under the ceiling still passes", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const { kv } = fakeKv({ seed: { [`daily:${HASH}:${day}`]: String(ALL_PLAN_QUOTAS.free.daily - 1) } });
    expect((await checkAndConsume(kv, HASH, LEGACY)).ok).toBe(true);
  });

  test("the daily cap cannot exceed the monthly one on any plan, legacy included", () => {
    for (const [plan, q] of Object.entries(ALL_PLAN_QUOTAS)) {
      expect(q.daily, `${plan}: a daily cap above the monthly one never fires`).toBeLessThan(q.monthly);
    }
  });

  test("the monthly cap still fires on its own", async () => {
    const month = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
    const { kv } = fakeKv({ seed: { [`usage:${HASH}:${month}`]: String(ALL_PLAN_QUOTAS.free.monthly) } });
    const r = await checkAndConsume(kv, HASH, LEGACY);
    expect(r.ok === false && r.reason).toBe("quota");
  });
});

// ── T111: the service-wide ceiling ───────────────────────────────────────────
const TODAY = new Date().toISOString().slice(0, 10);

describe("service-wide daily ceiling (T111 M1)", () => {
  // Per-key caps provably do not bound a GROUP. On 30–31 August every one of
  // 139 keys stayed inside its own cap and the catalogue left anyway. This is
  // the only limit a new credential cannot defeat by existing.
  test("a legacy free key is refused at the ceiling even with its own quota untouched", async () => {
    const { kv } = fakeKv({ seed: { [`global:${TODAY}`]: String(GLOBAL_DAILY_CATALOGUE_READS) } });
    const r = await checkAndConsume(kv, HASH, LEGACY);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("global");
  });

  test("ten FRESH legacy keys share one ceiling — three get served, seven do not", async () => {
    const { kv } = fakeKv({ seed: { [`global:${TODAY}`]: String(GLOBAL_DAILY_CATALOGUE_READS - 3) } });
    const out = [];
    for (let i = 0; i < 10; i++) out.push(await checkAndConsume(kv, `fresh-${i}`, LEGACY));
    expect(out.filter((r) => r.ok).length).toBe(3);
    expect(out.filter((r) => r.ok === false && r.reason === "global").length).toBe(7);
  });

  test("demo traffic is exempt — a key scoped to 40 cars cannot spend catalogue budget", async () => {
    const { kv, puts } = fakeKv({ seed: { [`global:${TODAY}`]: String(GLOBAL_DAILY_CATALOGUE_READS + 500) } });
    const r = await checkAndConsume(kv, HASH, "demo");
    expect(r.ok).toBe(true);
    // and it must not top up the counter it is exempt from
    expect(puts.filter((k) => k.startsWith("global:")).length).toBe(0);
  });

  test("apify traffic is exempt — Apify meters and bills it", async () => {
    const { kv } = fakeKv({ seed: { [`global:${TODAY}`]: String(GLOBAL_DAILY_CATALOGUE_READS + 500) } });
    const r = await checkAndConsume(kv, HASH, "apify");
    expect(r.ok).toBe(true);
  });

  test("a served legacy request increments the shared counter", async () => {
    const { kv, store } = fakeKv();
    await checkAndConsume(kv, "key-a", LEGACY);
    await checkAndConsume(kv, "key-b", LEGACY);
    expect(store.get(`global:${TODAY}`)).toBe("2");
  });

  test("the ceiling is checked before the per-key caps, so the reason is honest", async () => {
    // A key that is BOTH over its own daily cap and past the global ceiling
    // must be told about the ceiling: otherwise an integrator reads "your key
    // is over its limit" and goes looking for a bug in their own client.
    const { kv } = fakeKv({
      seed: {
        [`global:${TODAY}`]: String(GLOBAL_DAILY_CATALOGUE_READS),
        [`daily:${HASH}:${TODAY}`]: String(ALL_PLAN_QUOTAS.free.daily),
      },
    });
    const r = await checkAndConsume(kv, HASH, LEGACY);
    expect(r.ok === false && r.reason).toBe("global");
  });

  // T166. Both OFFERED plans are exempt from the ceiling, so if the legacy
  // plan stopped being counted the counter would have no subjects at all and
  // T111 M1 would be dead code — while the legacy key is the only credential
  // left with unbilled full-catalogue reach. That is why `free` stayed in
  // GLOBAL_COUNTED_PLANS when it left everywhere else.
  test("the ceiling still has a subject — the offered plans alone cannot trip it", async () => {
    const { kv } = fakeKv({ seed: { [`global:${TODAY}`]: String(GLOBAL_DAILY_CATALOGUE_READS) } });
    for (const plan of Object.keys(PLAN_QUOTAS)) {
      const r = await checkAndConsume(kv, `k-${plan}`, plan as "demo" | "apify");
      expect(r.ok, `${plan} must stay exempt`).toBe(true);
    }
    expect((await checkAndConsume(kv, HASH, LEGACY)).ok, "legacy must still be counted").toBe(false);
  });

  test("demo keeps a minute limit — the DB still needs protecting", async () => {
    const minute = Math.floor(Date.now() / 60_000);
    const { kv } = fakeKv({ seed: { [`rl:${HASH}:${minute}`]: String(PLAN_QUOTAS.demo.perMinute) } });
    const r = await checkAndConsume(kv, HASH, "demo");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("rate");
  });
});

// ── T166: retiring a plan must not 500 the keys that still carry it ─────────
describe("a stored plan that is no longer offered", () => {
  // The whole reason `free` survives in lib/quota.ts. Before the split, the
  // quota lookup was `QUOTAS[plan]` with no fallback: drop the row and the
  // destructure throws, which reaches the caller as a 500 on every request.
  test("the retired free plan is still metered, on its original numbers", async () => {
    const { kv, puts } = fakeKv();
    const r = await checkAndConsume(kv, HASH, LEGACY);
    expect(r.ok).toBe(true);
    expect(r.ok && r.quota).toBe(1000);
    expect(ALL_PLAN_QUOTAS.free).toEqual({ monthly: 1000, daily: 200, perMinute: 20 });
    expect(puts.filter((k) => k.startsWith("usage:")).length).toBe(1);
  });

  test("it is NOT in the offered table, so nothing can publish or grant it", () => {
    expect(Object.keys(PLAN_QUOTAS).sort()).toEqual(["apify", "demo"]);
    expect(PLAN_QUOTAS).not.toHaveProperty("free");
  });

  // A record whose plan we cannot recognise at all used to throw the same way.
  test("an unrecognised stored plan refuses instead of throwing a 500", async () => {
    const { kv, puts } = fakeKv();
    const r = await checkAndConsume(kv, HASH, "enterprise" as never);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("metering");
    expect(puts.length, "and it must not count what it refused").toBe(0);
  });
});
