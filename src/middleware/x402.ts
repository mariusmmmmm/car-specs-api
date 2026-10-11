import type { Context, Next } from "hono";
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient, type RouteConfig } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/hono";
import type { Env, Variables } from "../types";
import { readApiKey } from "../lib/auth-key";
import { checkX402Rate } from "../lib/quota";
import { ipHash } from "../lib/usage";
import { problem } from "../lib/response";
import { paidRoute, readX402Config, type X402Settings } from "../lib/x402-config";

// x402 v2 on the REST surface (T216). Sits in front of requireApiKey and is an
// ALTERNATIVE entry, never a replacement:
//
//   * a request that PRESENTS a key goes on to requireApiKey untouched — valid,
//     invalid, revoked or over quota, it gets exactly today's answer. A bad key
//     is not quietly downgraded to "so pay instead", for the reason index.ts
//     gives about /mcp: the holder would think they had access.
//   * no key, x402 configured, and the route is on the allowlist in
//     lib/x402-config.ts → 402 with PAYMENT-REQUIRED; with a valid
//     PAYMENT-SIGNATURE → the route runs and the payment is settled only if it
//     answered < 400 (the @x402/hono middleware cancels settlement otherwise).
//   * anything else → next(), i.e. requireApiKey's 401, as before T216.
//
// The paid request then runs the SAME downstream chain as a key holder minus
// the key: no demo dispatch (no record), opaque ids on the way out (tokens, like
// every non-apify plan), and one usage datapoint with plan "x402".

// The facilitator's /supported answer, cached per isolate as a plain VALUE.
// Workers do not let one request await I/O started by another, so a shared
// in-flight promise is not safe here; a resolved object is. One hour is long
// enough to keep /supported off the hot path and short enough to pick up a
// facilitator that adds or drops a network.
const SUPPORTED_TTL_MS = 60 * 60 * 1000;
let supportedCache: { url: string; at: number; value: SupportedResponse } | null = null;

class CachingFacilitator implements FacilitatorClient {
  private readonly inner: HTTPFacilitatorClient;
  constructor(private readonly url: string) {
    // 15s, not the library's 90s default: a facilitator that slow is down, and
    // the caller is an agent waiting on an HTTP response.
    this.inner = new HTTPFacilitatorClient({ url, timeoutMs: 15_000 });
  }
  verify(p: PaymentPayload, r: PaymentRequirements) {
    return this.inner.verify(p, r);
  }
  settle(p: PaymentPayload, r: PaymentRequirements) {
    return this.inner.settle(p, r);
  }
  async getSupported(): Promise<SupportedResponse> {
    const c = supportedCache;
    if (c && c.url === this.url && Date.now() - c.at < SUPPORTED_TTL_MS) return c.value;
    const value = await this.inner.getSupported();
    supportedCache = { url: this.url, at: Date.now(), value };
    return value;
  }
}

/** Test seam: forget the cached /supported answer. */
export function __resetX402Cache(): void {
  supportedCache = null;
}

// What a browser sees on a paid route. The library's fallback page tells the
// visitor to "install @x402/paywall" — a note to us, shown to them.
const BROWSER_HTML =
  '<!doctype html><meta charset="utf-8"><title>Payment required</title>' +
  '<p>This endpoint is paid per request with x402 (USDC), or with an API key. ' +
  'See <a href="https://cars-data.com/en/api">cars-data.com/en/api</a>.</p>';

function routeConfig(s: X402Settings, route: { priceUsd: number; description: string }, url: string): RouteConfig {
  return {
    accepts: {
      scheme: "exact",
      payTo: s.payTo,
      price: `$${route.priceUsd}`,
      network: s.network as `${string}:${string}`,
      maxTimeoutSeconds: 300,
    },
    resource: url,
    description: route.description,
    mimeType: "application/json",
    serviceName: "cars-data.com API",
    customPaywallHtml: BROWSER_HTML,
    // The JSON a client WITHOUT an x402 library reads. The machine-readable
    // terms are in the PAYMENT-REQUIRED header; this says the same in words,
    // and names the other door.
    unpaidResponseBody: () => ({
      contentType: "application/json",
      body: {
        type: "about:blank",
        title: "Payment Required",
        status: 402,
        detail:
          `This request costs $${route.priceUsd} in USDC via x402 — the terms are in the PAYMENT-REQUIRED header. ` +
          "Alternatively send an API key. Docs and licensing: https://cars-data.com/en/api",
      },
    }),
  };
}

function logOutcome(route: string, res: Response, priceUsd: number): void {
  const header = res.headers.get("PAYMENT-RESPONSE");
  let tx: string | undefined;
  let payer: string | undefined;
  let network: string | undefined;
  if (header) {
    try {
      const s = decodePaymentResponseHeader(header);
      tx = s.transaction;
      payer = s.payer;
      network = s.network;
    } catch {
      /* an undecodable header is itself worth seeing in the log line */
      tx = "undecodable";
    }
  }
  const outcome =
    res.status === 402 ? (header ? "settle_failed" : "402_issued")
    : res.status < 400 ? (tx ? "settled" : "served_unsettled")
    : "error";
  // One line per paid-route request (BIZ-L2d §6). The on-chain tx is the
  // receipt; there is deliberately no accounting store beyond this.
  console.log(JSON.stringify({ x402: outcome, route, status: res.status, price_usd: priceUsd, tx, payer, network }));
}

export async function x402Gate(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const settings = readX402Config(c.env);
  if (!settings) return next();
  if (readApiKey(c.req.raw.headers)) return next();
  const route = paidRoute(c.req.method, c.req.path, settings);
  if (!route) return next();

  const iph = await ipHash(c.req.header("cf-connecting-ip") ?? "unknown", c.env.IP_HASH_SALT);
  const gate = await checkX402Rate(c.env.API_KEYS, iph);
  if (!gate.ok) {
    const { body, status, headers } =
      gate.reason === "rate"
        ? problem(429, "Too Many Requests", "Too many requests from this network this minute — retry shortly.")
        : problem(503, "Service Unavailable", "Request metering is temporarily unavailable. Retry shortly.");
    return c.json(body, status, { ...headers, "Retry-After": "60" });
  }

  // Tells requireApiKey that the payment middleware owns this request. It can
  // only reach requireApiKey through the middleware's next(), which runs after
  // the payment verified — an unpaid request is answered 402 before that.
  c.set("x402", true);

  const server = new x402ResourceServer(new CachingFacilitator(settings.facilitatorUrl));
  registerExactEvmScheme(server);
  const mw = paymentMiddleware(routeConfig(settings, route, c.req.url), server);

  const returned = await mw(c, next);
  const res = returned instanceof Response ? returned : c.res;
  logOutcome(route.label, res, route.priceUsd);
  return returned;
}
