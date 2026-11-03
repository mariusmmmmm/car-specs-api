import { describe, expect, test } from "vitest";
import { anonThrottleReason, keyedThrottleReason } from "./mcp-throttle-reason";
import { checkAnonDemoRate, ANON_DEMO_PER_MINUTE } from "./quota";

/**
 * The defect these tests exist for (T1132, 2026-11-03): src/index.ts recorded
 * EVERY anonymous refusal as "quota", including the one that answers 503. The
 * keyed door two branches below was already right, so the two doors disagreed
 * about the same question for a month and nothing failed. Both are pinned here,
 * together, because that is the only way a later edit to one of them cannot
 * quietly leave the other behind.
 */

// Same stub as quota.test.ts, kept local on purpose: these tests are about what
// the metric SAYS when counting cannot work, so the breaking is the fixture.
function fakeKv(opts: { seed?: Record<string, string>; failGet?: boolean; failPut?: boolean } = {}) {
  const store = new Map<string, string>(Object.entries(opts.seed ?? {}));
  return {
    async get(k: string) {
      if (opts.failGet) throw new Error("KV get unavailable");
      return store.get(k) ?? null;
    },
    async put(k: string, v: string) {
      if (opts.failPut) throw new Error("KV put unavailable");
      store.set(k, v);
    },
  } as unknown as KVNamespace;
}

const IPH = "abc123def456";
const anonKey = () => `anon:${IPH}:${Math.floor(Date.now() / 60_000)}`;

describe("the anonymous demo door records WHY, not just THAT", () => {
  test("a metering failure on the PUT is our outage — 'unavailable', never 'quota'", async () => {
    const gate = await checkAnonDemoRate(fakeKv({ failPut: true }), IPH);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("metering");
    expect(anonThrottleReason(gate.reason)).toBe("unavailable");
  });

  test("a metering failure on the GET is our outage too", async () => {
    const gate = await checkAnonDemoRate(fakeKv({ failGet: true }), IPH);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("metering");
    expect(anonThrottleReason(gate.reason)).toBe("unavailable");
  });

  test("a real per-minute hit is the caller's ceiling — 'anon-rate', not our outage", async () => {
    const seed = { [anonKey()]: String(ANON_DEMO_PER_MINUTE) };
    const gate = await checkAnonDemoRate(fakeKv({ seed }), IPH);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("rate");
    expect(anonThrottleReason(gate.reason)).toBe("anon-rate");
  });

  test("under the ceiling nothing is recorded at all", async () => {
    const seed = { [anonKey()]: String(ANON_DEMO_PER_MINUTE - 1) };
    expect((await checkAnonDemoRate(fakeKv({ seed }), IPH)).ok).toBe(true);
  });

  // A keyless caller has no key, so it can have no quota. This is the label
  // that made 811 ordinary refusals read as four callers hammering us.
  test("no anonymous outcome is ever counted as 'quota'", () => {
    for (const reason of ["rate", "metering"] as const) {
      expect(anonThrottleReason(reason)).not.toBe("quota");
    }
  });
});

describe("the keyed door keeps its mapping", () => {
  test.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [429, "quota"],
    [503, "unavailable"],
  ] as const)("status %i is counted as %s", (status, expected) => {
    expect(keyedThrottleReason(status)).toBe(expected);
  });
});

describe("the two doors agree about whose failure a 503 is", () => {
  // The invariant that was broken: whatever answers 503 must be countable as
  // ours on BOTH doors. Written as one table so a change to either side has to
  // come back through here.
  test("every 503 outcome, on either door, counts as 'unavailable'", () => {
    expect(anonThrottleReason("metering")).toBe("unavailable");
    expect(keyedThrottleReason(503)).toBe("unavailable");
  });

  test("and every 429 outcome counts as the caller's limit, not ours", () => {
    for (const r of [anonThrottleReason("rate"), keyedThrottleReason(429)]) {
      expect(r).not.toBe("unavailable");
      expect(r).not.toBe("unauthorized");
    }
  });
});
