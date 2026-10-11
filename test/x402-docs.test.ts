import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
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

describe("openapi ↔ x402 (T219)", () => {
  test("the prices in the spec are the Worker's defaults", () => {
    expect(yaml).toContain(`\`GET /variants/{id}/specs\` — $${DEFAULT_SPECS_PRICE_USD}`);
    expect(yaml).toContain(`\`GET /search\` — $${DEFAULT_SEARCH_PRICE_USD}`);
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
    expect(documented.size).toBe(2);
  });
});
