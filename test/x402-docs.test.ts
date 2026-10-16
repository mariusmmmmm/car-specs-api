import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { doors, doorsSentence } from "../src/lib/doors";
import { buildManifest } from "../src/lib/server-manifest";
import {
  DEFAULT_COMPARE_PRICE_USD,
  DEFAULT_FILTER_PRICE_USD,
  DEFAULT_SEARCH_PRICE_USD,
  DEFAULT_SPECS_PRICE_USD,
  paidRoute,
  parseX402Config,
} from "../src/lib/x402-config";

// T219 — the published spec says what the Worker charges and where. Two things
// drift silently unless something reads both:
//   1. the PRICES quoted in openapi.yaml vs the defaults in lib/x402-config.ts;
//   2. WHICH routes document a 402 vs which routes the allowlist sells.
// Either drift tells an agent to pay for something that answers 401, or hides a
// paid route from the docs. Both directions are checked.

const yaml = readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");
const json = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
};

const settings = (parseX402Config({ X402_PAY_TO: "0x1111111111111111111111111111111111111111" }) as {
  ok: true;
  settings: never;
}).settings;

// T334 variant B — no surface claims the Apify Actor charges what we charge.
//
// It SHOULD, by the owner's decision of 2026-10-16, and it will: T335 sets the
// Apify Console to these four prices on 2026-10-23, the first date the Console
// allows a change (measured there: it refuses one until then, with a different
// change already scheduled). Until that happens the Actor sells a specs lookup
// at $0.003 against $0.05 here, so a sentence saying the prices match would
// publish a price Apify does not charge — the exact defect T334 exists to
// close, inverted. This test fails the day such a sentence comes back before
// its price does. When T335 lands, it is deleted in the same commit.
describe("no premature price-parity claim (T334 variant B)", () => {
  const PARITY = /(same|identical)[^.\n]{0,40}pric|one price,? which(ever)? door|at (the )?same prices/i;
  const surfaces: [string, string][] = [
    ["README.md", readFileSync(new URL("../README.md", import.meta.url), "utf8")],
    ["openapi.yaml", yaml],
    ["doors.ts", readFileSync(new URL("../src/lib/doors.ts", import.meta.url), "utf8")],
    ["x402.ts", readFileSync(new URL("../src/middleware/x402.ts", import.meta.url), "utf8")],
    ["server-manifest.ts", readFileSync(new URL("../src/lib/server-manifest.ts", import.meta.url), "utf8")],
  ];

  // Comments may state the INTENT, with its date; strings served to a caller
  // may not. So the check reads the strings, not the files: every door text
  // doors.ts actually produces, and the manifest's published description.
  test("no door text promises Apify charges our prices", () => {
    const s = settings;
    const texts = [...doors(s).map((d) => `${d.for} ${d.how}`), doorsSentence(s), doorsSentence(null)];
    for (const t of texts) expect(t, t).not.toMatch(PARITY);
    // and the Apify door still tells the caller who bills, which is the part
    // that IS true today
    expect(doors(s).find((d) => d.door === "apify")!.how).toContain("billed per event by Apify");
    expect(JSON.stringify(buildManifest())).not.toMatch(PARITY);
  });

  // The prose in the two published documents, minus the comment lines that are
  // allowed to record the decision and its date.
  test("no published document promises it either", () => {
    for (const [name, text] of surfaces) {
      const prose = text
        .split("\n")
        .filter((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l))
        .join("\n");
      const m = PARITY.exec(prose);
      expect(m?.[0], `${name}: ${m?.[0] ?? ""}`).toBeUndefined();
    }
  });

  test("the guard catches the sentence it was written for", () => {
    for (const planted of [
      "the Apify Actor sells these same four operations at these same prices",
      "One row of data has one price, whichever door",
      "the same four operations at the same prices as the Apify Actor",
    ]) {
      expect(planted).toMatch(PARITY);
    }
  });
});

describe("openapi ↔ x402 (T219)", () => {
  test("the prices in the spec are the Worker's defaults", () => {
    expect(yaml).toContain(`\`GET /variants/{id}/specs\` — $${DEFAULT_SPECS_PRICE_USD}`);
    expect(yaml).toContain(`\`GET /search\` — $${DEFAULT_SEARCH_PRICE_USD}`);
    // T334 — the two the Apify Actor sold; the README quotes the same four.
    expect(yaml).toContain(`\`GET /variants\` — $${DEFAULT_FILTER_PRICE_USD}`);
    expect(yaml).toContain(`\`GET /compare\` — $${DEFAULT_COMPARE_PRICE_USD}`);
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(`\`GET /v1/variants\` ($${DEFAULT_FILTER_PRICE_USD}`);
    expect(readme).toContain(`\`GET /v1/compare\` ($${DEFAULT_COMPARE_PRICE_USD.toFixed(2)}`);
    // the worked atomic-unit example must be the specs price in USDC (6 decimals)
    expect(yaml).toContain(`$${DEFAULT_SPECS_PRICE_USD} is \`${Math.round(DEFAULT_SPECS_PRICE_USD * 1e6)}\``);
  });

  test("every route that documents a 402 is on the allowlist, and every allowlisted route documents one", () => {
    const documented = new Set<string>();
    const allowlisted = new Set<string>();
    for (const [path, ops] of Object.entries(json.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const concrete = `/v1${path.replace(/\{[^}]+\}/g, "v_1a2b3c4d")}`;
        if (op.responses && "402" in op.responses) documented.add(`${method.toUpperCase()} ${path}`);
        if (paidRoute(method.toUpperCase(), concrete, settings)) allowlisted.add(`${method.toUpperCase()} ${path}`);
      }
    }
    expect([...documented].sort()).toEqual([...allowlisted].sort());
    expect(documented.size).toBe(4);
  });
});
