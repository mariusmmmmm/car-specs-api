import { describe, expect, test } from "vitest";
import { anonThrottleReason, keyedThrottleReason } from "./mcp-throttle-reason";
import { checkAnonDemoRate, checkX402Rate, ANON_DEMO_PER_MINUTE } from "./quota";

/**
 * The defect these tests exist for (T1132, 2026-11-03): src/index.ts recorded
 * EVERY anonymous refusal as "quota", including the one that answers 503. The
 * keyed door two branches below was already right, so the two doors disagreed
 * about the same question for a month and nothing failed. Both are pinned here,
 * together, because that is the only way a later edit to one of them cannot
 * quietly leave the other behind.
 */

// T1194: uşa anonimă NU mai atinge KV deloc — numărarea stă pe un Durable Object
// (D-64, varianta E), fiindcă `get`-apoi-`put` pe KV lăsa să treacă ~6× nominala. Deci
// fixtura de aici nu mai poate fi un KV rupt: `failGet`/`failPut` pe KV n-ar mai produce
// niciun eşec de numărare, iar testele ar fi ieşit VERZI fără să măsoare nimic — exact
// clasa „garda afirmă mai mult decât măsoară". Ce se rupe acum e contorul.
//
// `fakeRateCounter` rulează CLASA REALĂ peste un storage în memorie, deci intenţia lui
// T1132 — ce SPUNE metrica atunci când numărarea nu poate funcţiona — se probează pe
// codul livrat, nu pe o imitaţie.
import { fakeRateCounter } from "../../test/fake-rate-counter";

const counter = (opts: { fail?: boolean } = {}) => ({ RATE_COUNTER: fakeRateCounter(opts) });

/** Duce uşa exact la plafon, prin apeluri reale. Întoarce legătura folosită. */
async function laPlafon(iph: string) {
  const env = counter();
  for (let i = 0; i < ANON_DEMO_PER_MINUTE; i++) {
    const r = await checkAnonDemoRate(env, iph);
    expect(r.ok, `cererea ${i + 1} trebuia servită sub plafon`).toBe(true);
  }
  return env;
}

const IPH = "abc123def456";

describe("the anonymous demo door records WHY, not just THAT", () => {
  test("un contor care nu răspunde e defectul NOSTRU — 'unavailable', niciodată 'quota'", async () => {
    const gate = await checkAnonDemoRate(counter({ fail: true }), IPH);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("metering");
    expect(anonThrottleReason(gate.reason)).toBe("unavailable");
  });

  test("şi un contor care aruncă la a doua cerere, la fel", async () => {
    await checkAnonDemoRate(counter(), IPH);
    const gate = await checkAnonDemoRate(counter({ fail: true }), IPH);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("metering");
    expect(anonThrottleReason(gate.reason)).toBe("unavailable");
  });

  test("o atingere reală de plafon e limita APELANTULUI — 'anon-rate', nu defectul nostru", async () => {
    const env = await laPlafon(IPH);
    const gate = await checkAnonDemoRate(env, IPH);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("rate");
    expect(anonThrottleReason(gate.reason)).toBe("anon-rate");
  });

  test("sub plafon nu se înregistrează nimic", async () => {
    const env = counter();
    for (let i = 0; i < ANON_DEMO_PER_MINUTE - 1; i++) await checkAnonDemoRate(env, IPH);
    expect((await checkAnonDemoRate(env, IPH)).ok).toBe(true);
  });

  // T1194 — PROBA care dă forma livrării. Pe contorul vechi, N cereri concurente pe
  // aceeaşi cheie mişcau contorul cu ~N/10 şi treceau toate; aici trebuie să-l mişte cu
  // exact N, deci a (N+1)-a e refuzată. Dacă substratul redevine `get`-apoi-`put`,
  // testul ăsta cade — e singurul care deosebeşte „plafon 60" de „plafon 60 care
  // numără corect".
  test("N cereri PARALELE pe aceeaşi uşă consumă exact N unităţi, nu ~N/10", async () => {
    const env = counter();
    const n = ANON_DEMO_PER_MINUTE;
    const toate = await Promise.all(
      Array.from({ length: n }, () => checkAnonDemoRate(env, "paralel")),
    );
    expect(toate.filter((r) => r.ok).length, "toate cele N trebuie servite").toBe(n);
    const peste = await checkAnonDemoRate(env, "paralel");
    expect(peste.ok, "a (N+1)-a trebuie refuzată — altfel contorul a pierdut incremente").toBe(false);
    if (!peste.ok) expect(peste.reason).toBe("rate");
  });

  test("uşile NU împart contorul: x402 nu e atins de plafonul uşii anonime", async () => {
    const env = counter();
    for (let i = 0; i < ANON_DEMO_PER_MINUTE; i++) await checkAnonDemoRate(env, IPH);
    expect((await checkAnonDemoRate(env, IPH)).ok).toBe(false);
    expect((await checkX402Rate(env, IPH)).ok, "x402 are contorul lui").toBe(true);
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
