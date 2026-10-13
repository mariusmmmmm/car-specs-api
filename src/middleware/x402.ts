import type { Context, Next } from "hono";
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient, type RouteConfig, type RoutesConfig } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { PaymentPayload, PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
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

// ── Bazaar discovery (T285) ────────────────────────────────────────────────
//
// PayAI's Bazaar (GET https://facilitator.payai.network/discovery/resources) is
// where agents with a wallet look for paid APIs: 20,087 resources on
// 2026-10-13, not one of them vehicle specifications — and not us. Listing is
// automatic and needs no form: our 402 declares the resource, the buyer's x402
// client echoes the declaration into its payment payload, and the facilitator
// catalogs it on /verify (no funds move) or /settle. A GET resource is admitted
// once its read-only probe answers 402, which ours do. PayAI's docs:
// https://docs.payai.network/x402/facilitators/bazaar.md
//
// The HTTP method is not declared here: the bazaar server extension fills it,
// and `routeTemplate`, from the request it enriches.
//
// The routes are passed to the middleware KEYED by pattern ("GET
// /v1/variants/:id/specs") so the bazaar server extension can fill
// `routeTemplate`. Without it the catalog key is the concrete URL, and every
// car someone paid for would become its own listing.
const SPECS_EXAMPLE = {
  data: {
    variant_id: "v_1a2b3c4d",
    locale: "en",
    specs: {
      power_hp: { label: "Power", value: "150 hp", confidence: 0.98 },
      fuel_type: { label: "Fuel", value: "Petrol", confidence: 1 },
      length_mm: { label: "Length", value: "4370 mm", confidence: 0.97 },
    },
  },
  meta: { locale: "en", last_synced_at: "2026-10-01T00:00:00.000Z" },
};
const SEARCH_EXAMPLE = {
  data: [
    {
      variant_id: "v_1a2b3c4d",
      display_name: "Golf 1.5 eTSI 150hp Style",
      brand_slug: "volkswagen",
      model_slug: "golf",
      generation_id: "g_5e6f7a8b",
      year_from: 2020,
      year_to: null,
    },
  ],
  meta: { locale: "en", last_synced_at: "2026-10-13T00:00:00.000Z" },
  links: { next: "c_9a8b7c6d" },
};
const LOCALES = ["ar", "bg", "cs", "da", "de", "el", "en", "es", "fr", "hr", "hu", "it", "no", "pl", "pt", "ro", "sk", "sr", "sv", "tr"];

function discovery(label: string) {
  if (label === "/v1/search") {
    return declareDiscoveryExtension({
      input: { q: "golf", locale: "en", limit: 10 },
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Brand, model or variant name, e.g. 'bmw 3 series'" },
          locale: { type: "string", enum: LOCALES, default: "en" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          cursor: { type: "string", description: "links.next of the previous page" },
        },
        required: ["q"],
      },
      output: { example: SEARCH_EXAMPLE },
    });
  }
  return declareDiscoveryExtension({
    pathParams: { id: "v_1a2b3c4d" },
    pathParamsSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Opaque variant id (v_…) from /v1/search" } },
      required: ["id"],
    },
    input: { locale: "en" },
    inputSchema: {
      type: "object",
      properties: { locale: { type: "string", enum: LOCALES, default: "en" } },
    },
    output: { example: SPECS_EXAMPLE },
  });
}

// Keyed by the REQUEST's method: paidRoute() admits GET and HEAD (T237), and a
// "GET …" key would not match a HEAD, which then fell through to 405 instead of
// seeing the price. The discovery declaration rides on GET only — a HEAD never
// buys (x402Gate answers a paid HEAD 405), so a declaration on it could only
// put a wrong "HEAD" listing in the catalog through a verify.
function routeConfig(
  s: X402Settings,
  route: { label: string; priceUsd: number; description: string },
  method: string,
): RoutesConfig {
  return { [`${method} ${route.label}`]: routeEntry(s, route, method === "GET") };
}

function routeEntry(
  s: X402Settings,
  route: { label: string; priceUsd: number; description: string },
  declare: boolean,
): RouteConfig {
  return {
    accepts: {
      scheme: "exact",
      payTo: s.payTo,
      price: `$${route.priceUsd}`,
      network: s.network as `${string}:${string}`,
      maxTimeoutSeconds: 300,
    },
    description: route.description,
    mimeType: "application/json",
    serviceName: "cars-data.com API",
    tags: ["cars", "vehicle-specs", "automotive", "ev", "multilingual"],
    iconUrl: "https://cars-data.com/apple-touch-icon.png",
    ...(declare ? { extensions: discovery(route.label) } : {}),
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

/** The facilitator's reason, carried in the `error` field of PAYMENT-REQUIRED. */
function refusalReason(res: Response): string | undefined {
  const h = res.headers.get("PAYMENT-REQUIRED");
  if (!h) return undefined;
  try {
    return decodePaymentRequiredHeader(h).error;
  } catch {
    return "undecodable";
  }
}

function logOutcome(route: string, res: Response, priceUsd: number, paymentPresented: boolean): void {
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
  // T226: a 402 that answers a request which CARRIED a payment is a refusal,
  // not a challenge. Until T226 both were logged "402_issued", so on the day x402
  // is switched on the first real payer to be turned away — wrong network, no
  // funds, expired authorization — would have been invisible among the probes.
  // Measured 2026-10-11 against the real x402.org facilitator: an unfunded
  // payer logged "402_issued", indistinguishable from an agent that never paid.
  const outcome =
    res.status === 402
      ? header ? "settle_failed" : paymentPresented ? "verify_failed" : "402_issued"
      : res.status < 400 ? (tx ? "settled" : "served_unsettled")
      : "error";
  const reason = outcome === "verify_failed" || outcome === "settle_failed" ? refusalReason(res) : undefined;
  // One line per paid-route request (BIZ-L2d §6). The on-chain tx is the
  // receipt; there is deliberately no accounting store beyond this.
  console.log(JSON.stringify({ x402: outcome, route, status: res.status, price_usd: priceUsd, reason, tx, payer, network }));
}

/** A refused payment came back with the body `{}` — the library builds the
 *  refusal without our unpaidResponseBody. The reason IS in PAYMENT-REQUIRED,
 *  but a client that only reads the body learned nothing. Say it in words,
 *  keeping every header, and say plainly that nothing was taken. */
async function explainRefusal(res: Response): Promise<Response> {
  if (res.status !== 402 || !(res.headers.get("content-type") ?? "").includes("json")) return res;
  const text = await res.clone().text();
  if (text.trim() !== "{}") return res;
  const reason = refusalReason(res) ?? "unknown";
  const { body } = problem(
    402,
    "Payment Required",
    `The payment was not accepted (${reason}). Nothing was charged. ` +
      "The terms are in the PAYMENT-REQUIRED header — pay again against them, or send an API key.",
  );
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/problem+json");
  return new Response(JSON.stringify(body), { status: 402, headers });
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
  const mw = paymentMiddleware(routeConfig(settings, route, c.req.method), server);

  const paymentPresented = Boolean(c.req.header("payment-signature") || c.req.header("x-payment"));

  // T237 — HEAD ANUNȚĂ prețul, dar nu cumpără niciodată.
  //
  // Hono servește HEAD din handlerul de GET (verificat: HEAD /v1/openapi.json → 200),
  // deci dacă HEAD ar trece mai departe, o plată prezentată pe HEAD s-ar deconta
  // și ar întoarce un răspuns FĂRĂ CORP: clientul plătit, nimic livrat. Corpul e
  // exact lucrul pentru care se plătește.
  //
  // Un HEAD NEplătit nu ajunge aici — middleware-ul răspunde 402 cu
  // PAYMENT-REQUIRED înainte de `next`, adică exact antetele pe care le-ar da un
  // GET neplătit. Asta E reparația.
  //
  // Un HEAD CU plată ajunge, și primește 405. Nu e o a doua formulare a refuzului:
  // un răspuns ≥400 face @x402/hono să ANULEZE decontarea — aceeași regulă pe care
  // se bazează deja comentariul de la începutul fișierului. Deci plata e
  // verificată și apoi explicit NEluată.
  const headNever: Next = async () => {
    const { body, status, headers } = problem(
      405,
      "Method Not Allowed",
      "HEAD advertises the price of this route but never serves it, and never charges for it — " +
        "the response has no body by definition. Repeat the request as GET, paying against the " +
        "PAYMENT-REQUIRED header. Nothing was charged.",
    );
    c.res = c.json(body, status, { ...headers, Allow: "GET" });
  };

  const returned = await mw(c, c.req.method === "HEAD" ? headNever : next);
  let res = returned instanceof Response ? returned : c.res;
  if (paymentPresented) {
    res = await explainRefusal(res);
    c.res = res;
  }
  logOutcome(route.label, res, route.priceUsd, paymentPresented);
  return paymentPresented ? res : returned;
}
