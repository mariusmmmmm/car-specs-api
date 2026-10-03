import { describe, expect, test } from "vitest";
import { checkAndConsume, PLAN_QUOTAS } from "./quota";

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

describe("checkAndConsume — fail CLOSED when metering breaks (T79)", () => {
  // The defect: incident 889ca1e made a failed put serve the request anyway,
  // to stop the Workers KV free-tier daily put cap from 500-ing the API. The
  // account left the free tier on 2026-07-27, so the reason expired — but the
  // open door did not. Over that quota, a key was served and nothing recorded it.
  test("a failed PUT refuses the request instead of serving it unmetered", async () => {
    const { kv } = fakeKv({ failPut: true });
    const r = await checkAndConsume(kv, HASH, "free");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("metering");
  });

  test("a failed GET refuses too — a count we cannot read is not a count of zero", async () => {
    const { kv } = fakeKv({ failGet: true });
    const r = await checkAndConsume(kv, HASH, "free");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("metering");
  });

  test("the happy path still counts, and writes all three buckets", async () => {
    const { kv, puts } = fakeKv();
    const r = await checkAndConsume(kv, HASH, "free");
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
    const { kv } = fakeKv({ seed: { [`daily:${HASH}:${day}`]: String(PLAN_QUOTAS.free.daily) } });
    const r = await checkAndConsume(kv, HASH, "free");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("daily");
  });

  test("one under the ceiling still passes", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const { kv } = fakeKv({ seed: { [`daily:${HASH}:${day}`]: String(PLAN_QUOTAS.free.daily - 1) } });
    expect((await checkAndConsume(kv, HASH, "free")).ok).toBe(true);
  });

  test("the daily cap cannot exceed the monthly one on any plan", () => {
    for (const [plan, q] of Object.entries(PLAN_QUOTAS)) {
      expect(q.daily, `${plan}: a daily cap above the monthly one never fires`).toBeLessThan(q.monthly);
    }
  });

  test("the monthly cap still fires on its own", async () => {
    const month = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
    const { kv } = fakeKv({ seed: { [`usage:${HASH}:${month}`]: String(PLAN_QUOTAS.free.monthly) } });
    const r = await checkAndConsume(kv, HASH, "free");
    expect(r.ok === false && r.reason).toBe("quota");
  });
});
