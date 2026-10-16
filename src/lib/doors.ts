// The three doors to the full catalogue, said ONCE (T334).
//
// Until T334 the demo — REST and MCP alike — told a caller who hit its edge
// that "the full catalogue is a licensed export". True, and useless to the
// caller the demo mostly meets: an agent. An agent cannot buy an export; it
// can pay per request under x402, and the paid tools had been live on Base
// mainnet since T231 without a single demo response naming them. The demo was
// a shop window whose sign pointed at a door agents cannot open.
//
// Every demo refusal, the /demo index and the MCP tool descriptions read from
// here, so the three doors cannot drift apart again. The x402 door is listed
// only while x402 is configured: pointing at paid routes that answer 401 would
// be the same defect in the other direction.
import type { X402Settings } from "./x402-config";

export const APIFY_URL = "https://apify.com/carsdatacom/car-specs-api";
export const EXPORT_URL = "https://cars-data.com/en/api";
export const AGENTS_URL = "https://cars-data.com/en/api/for-ai-agents";

export type Door = {
  door: "x402" | "apify" | "export";
  /** Who this door is for, in one clause. */
  for: string;
  /** How it is paid, with the numbers that bind. */
  how: string;
  url: string;
};

/** Machine-readable, in the order a caller should consider them. */
export function doors(x402: X402Settings | null): Door[] {
  const out: Door[] = [];
  if (x402) {
    out.push({
      door: "x402",
      for: "an agent with a wallet — no key, no account",
      how:
        `pay per request in USDC on Base (x402 v2): GET /v1/search $${x402.searchPriceUsd}, ` +
        `GET /v1/variants $${x402.filterPriceUsd}, GET /v1/variants/{id}/specs $${x402.specsPriceUsd}, ` +
        `GET /v1/compare $${x402.comparePriceUsd}; on MCP the same four are search_catalogue, ` +
        "filter_catalogue, get_specs_full and compare_full",
      url: AGENTS_URL,
    });
  }
  out.push({
    door: "apify",
    for: "an Apify account — datasets, no-code runs, Apify's own MCP",
    // No price here, and no claim that it matches x402's. The owner decided on
    // 2026-10-16 that it should (one row of data, one price, whichever door),
    // but the Apify Console refuses any price change until 2026-10-23, so until
    // then the Actor is cheaper and saying otherwise would publish a price
    // Apify does not charge. The prices live on the Store page; T335 restores
    // the claim here once the Console matches.
    how: "the same four operations, billed per event by Apify",
    url: APIFY_URL,
  });
  out.push({
    door: "export",
    for: "the whole database",
    how: "a licensed CSV/JSON export by module, with an optional update subscription — this demo is its sample",
    url: EXPORT_URL,
  });
  return out;
}

/** The same three doors as one sentence, for a Problem `detail` or an MCP
 *  error — the places a caller reads when a demo request stops. */
export function doorsSentence(x402: X402Settings | null): string {
  const parts: string[] = [];
  if (x402) {
    parts.push(
      `pay per request with x402, no key (GET /v1/variants/{id}/specs $${x402.specsPriceUsd}, ` +
        `/v1/search $${x402.searchPriceUsd}, /v1/variants $${x402.filterPriceUsd}, /v1/compare $${x402.comparePriceUsd}, USDC on Base)`,
    );
  }
  parts.push(`the Apify Actor, billed per event by Apify (${APIFY_URL})`);
  parts.push(`the whole database as a licensed export (${EXPORT_URL})`);
  const last = parts.pop();
  return `Full catalogue: ${parts.join("; ")}; or ${last}.`;
}
