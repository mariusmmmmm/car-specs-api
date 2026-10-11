// x402 v2 — pay-per-request for callers WITHOUT an API key (T216, D-22-3).
//
// Off unless X402_PAY_TO holds a valid receiving address. There is no separate
// on/off flag on purpose: T134 deleted X402_ENABLED because nothing read it,
// and a flag next to a missing wallet is two ways to be half-configured. The
// address IS the switch — unset it and every route answers exactly as it did
// before T216 (a 401 that asks for a key).
//
// Every malformed value also means OFF, never "on with a default". A typo in a
// wallet address must not route money to the wrong place, and a bad price must
// not quietly become a free or a ruinous one.

/** CAIP-2 ids for the aliases people actually type. */
const NETWORK_ALIASES: Record<string, string> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
};

/** Testnet by default: mainnet has to be asked for by name. */
export const DEFAULT_NETWORK = "eip155:84532";
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
/** Networks the default facilitator may serve. Anything else is treated as a
 *  mainnet that needs an explicit X402_FACILITATOR_URL. */
const TESTNETS: ReadonlySet<string> = new Set(["eip155:84532"]);

// The two prices, and why they are not the $0.001 the July plan (BIZ-L2d) had.
//
// Full Specs — every data module, the whole catalogue, English — is published
// at €2,900 on https://cars-data.com/en/api. Over ~103k variants that is about
// €0.028 per variant. At $0.001 a call the same catalogue would cost ~$103
// through this door: a 28x discount on the licensed export, sold to anyone,
// with no terms negotiated. So the per-variant price sits ABOVE the export's
// per-variant price — the export stays the cheap way to buy in bulk, and this
// stays the convenient way to buy a few cars, which is what an agent needs.
//
// Search returns only identity data (names, years, opaque ids) that the public
// site already shows, and it is the only way a caller without a key can learn
// an id to pay for. Cheap, but not free: a free search would be an anonymous,
// unmetered read path into the database.
export const DEFAULT_SPECS_PRICE_USD = 0.05;
export const DEFAULT_SEARCH_PRICE_USD = 0.005;

// Bounds. Below 0.001 a USDC amount stops being meaningful against facilitator
// and gas economics; above 100 is not a per-request price, it is a typo.
const MIN_PRICE_USD = 0.001;
const MAX_PRICE_USD = 100;

export type X402Settings = {
  payTo: `0x${string}`;
  network: string;
  facilitatorUrl: string;
  specsPriceUsd: number;
  searchPriceUsd: number;
};

export type X402Env = {
  X402_PAY_TO?: string;
  X402_NETWORK?: string;
  X402_FACILITATOR_URL?: string;
  X402_PRICE_SPECS_USD?: string;
  X402_PRICE_SEARCH_USD?: string;
};

export type X402ConfigResult =
  | { ok: true; settings: X402Settings }
  | { ok: false; reason: "off" | "invalid"; detail?: string };

function price(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+(\.\d+)?$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= MIN_PRICE_USD && n <= MAX_PRICE_USD ? n : null;
}

/** Pure, so a test can execute every branch without a Worker. */
export function parseX402Config(env: X402Env): X402ConfigResult {
  const payTo = env.X402_PAY_TO?.trim();
  if (!payTo) return { ok: false, reason: "off" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    return { ok: false, reason: "invalid", detail: "X402_PAY_TO is not a 0x-prefixed 20-byte address" };
  }

  const rawNetwork = env.X402_NETWORK?.trim() || DEFAULT_NETWORK;
  const network = NETWORK_ALIASES[rawNetwork] ?? rawNetwork;
  // EVM only: the scheme registered in middleware/x402.ts is ExactEvmScheme.
  if (!/^eip155:\d+$/.test(network)) {
    return { ok: false, reason: "invalid", detail: `X402_NETWORK ${rawNetwork} is not an eip155 network` };
  }

  // T226: the default facilitator (x402.org) settles TESTNET only — measured on
  // its /supported, 2026-10-11: eip155:84532, no eip155:8453. Mainnet with the
  // default would boot "configured" and fail every payment. So a mainnet network
  // needs a facilitator named on purpose, or x402 stays off.
  const explicitFacilitator = env.X402_FACILITATOR_URL?.trim();
  if (!TESTNETS.has(network) && !explicitFacilitator) {
    return {
      ok: false,
      reason: "invalid",
      detail: `X402_NETWORK ${network} is a mainnet; set X402_FACILITATOR_URL explicitly — the default ${DEFAULT_FACILITATOR_URL} settles testnet only`,
    };
  }
  const facilitatorUrl = explicitFacilitator || DEFAULT_FACILITATOR_URL;
  if (!/^https:\/\/[^\s/]+/.test(facilitatorUrl)) {
    return { ok: false, reason: "invalid", detail: "X402_FACILITATOR_URL must be an https URL" };
  }

  const specsPriceUsd = price(env.X402_PRICE_SPECS_USD, DEFAULT_SPECS_PRICE_USD);
  const searchPriceUsd = price(env.X402_PRICE_SEARCH_USD, DEFAULT_SEARCH_PRICE_USD);
  if (specsPriceUsd === null || searchPriceUsd === null) {
    return {
      ok: false,
      reason: "invalid",
      detail: `prices must be plain decimals between ${MIN_PRICE_USD} and ${MAX_PRICE_USD} USD`,
    };
  }

  return {
    ok: true,
    settings: { payTo: payTo as `0x${string}`, network, facilitatorUrl, specsPriceUsd, searchPriceUsd },
  };
}

let warned = false;

/** The settings, or null when x402 is off. An INVALID config is logged once
 *  per isolate and treated as off — the caller then gets today's 401. */
export function readX402Config(env: X402Env): X402Settings | null {
  const r = parseX402Config(env);
  if (r.ok) return r.settings;
  if (r.reason === "invalid" && !warned) {
    warned = true;
    console.error(`x402 disabled — invalid configuration: ${r.detail}`);
  }
  return null;
}

/** Which REST routes take payment instead of a key, and at what price.
 *  An allowlist, not a pattern over everything: a route is paid only if it is
 *  named here, so the next route someone adds is NOT silently for sale.
 *  `/v1` is optional because tests mount the router bare. */
export function paidRoute(
  method: string,
  path: string,
  s: X402Settings,
): { label: string; priceUsd: number; description: string } | null {
  if (method !== "GET") return null;
  if (/^(?:\/v1)?\/variants\/[^/]+\/specs\/?$/.test(path)) {
    return {
      label: "/v1/variants/:id/specs",
      priceUsd: s.specsPriceUsd,
      description: "Full localized specifications for one vehicle variant (cars-data.com).",
    };
  }
  if (/^(?:\/v1)?\/search\/?$/.test(path)) {
    return {
      label: "/v1/search",
      priceUsd: s.searchPriceUsd,
      description: "Search the cars-data.com catalogue; returns variant ids to pass to /v1/variants/{id}/specs.",
    };
  }
  return null;
}
