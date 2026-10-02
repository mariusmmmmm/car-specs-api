import { Hono } from "hono";
import type { Env } from "../types";
import { envelope, problem } from "../lib/response";
import { sha256Hex, type KeyRequest } from "../lib/apikey";
import { ipHash } from "../lib/usage";
import { sendEmail } from "../lib/notify";

export const keys = new Hono<{ Bindings: Env }>();

// Kept with the key record so we know which version a customer accepted.
// Must match DATA_TERMS_VERSION in v3/lib/config/data-pricing.ts — the
// published text at /en/api/terms (T73). Bump both together.
export const TOS_VERSION = "2026-10-02-v1";

// A request is cheap to send and costs the owner a review, so cap it per IP.
// One open-or-approved request per email: asking again changes nothing.
export const REQUESTS_PER_IP_PER_DAY = 3;

// The request form on cars-data.com/en/api/for-ai-agents posts here straight
// from the browser, so the per-IP cap sees the visitor's IP (a server-side
// proxy would put every request on the site's one IP). CORS is not a guard —
// curl ignores it — the review is.
const FORM_ORIGINS = /^https:\/\/(www\.)?cars-data\.com$|^http:\/\/localhost:\d+$/;
keys.use("*", async (c, next) => {
  const origin = c.req.header("Origin") ?? "";
  const allowed = FORM_ORIGINS.test(origin);
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: allowed
        ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" }
        : {},
    });
  }
  await next();
  if (allowed) {
    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.append("Vary", "Origin");
  }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// POST /v1/keys — no longer hands out a key (T73, owner decision 2026-10-02).
// It records a request; the owner approves it by hand (scripts/keys-admin.mjs)
// and the key is emailed to the requester. Self-issued keys were how the
// whole catalogue left on 30–31 Aug: 138 keys, ~110k calls.
keys.post("/", async (c) => {
  const p = await c.req.json().catch(() => null);
  const email = str(p?.email, 254).toLowerCase();
  const name = str(p?.name, 120);
  const company = str(p?.company, 120) || null;
  const useCase = str(p?.use_case, 2000);

  const bad = (detail: string) => {
    const { body, status, headers } = problem(400, "Bad Request", detail);
    return c.json(body, status, headers);
  };
  if (!EMAIL_RE.test(email)) return bad("A valid `email` is required — the key is sent there after review.");
  if (name.length < 2) return bad("`name` is required.");
  if (useCase.length < 20) return bad("`use_case` is required (at least 20 characters) — keys are reviewed by hand.");
  if (p?.accept_tos !== true) return bad("`accept_tos: true` is required — see https://cars-data.com/en/api/terms.");

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const iph = await ipHash(ip, c.env.IP_HASH_SALT);
  const day = new Date().toISOString().slice(0, 10);
  const ipKey = `keyreq-ip:${iph}:${day}`;
  const ipCount = Number((await c.env.API_KEYS.get(ipKey)) ?? 0);
  if (ipCount >= REQUESTS_PER_IP_PER_DAY) {
    const { body, status, headers } = problem(429, "Too Many Requests", "Too many key requests from this network today.");
    return c.json(body, status, headers);
  }

  const accepted = () =>
    c.json(
      envelope(
        { status: "pending_review", note: "Thanks — every key is reviewed by hand. If approved, the key is emailed to you." },
        { last_synced_at: new Date().toISOString() },
      ),
      202,
    );

  const emailKey = `keyreq-email:${await sha256Hex(email)}`;
  if (await c.env.API_KEYS.get(emailKey)) return accepted(); // already pending or approved

  const now = new Date().toISOString();
  const req: KeyRequest = {
    id: crypto.randomUUID().slice(0, 8),
    email,
    name,
    company,
    use_case: useCase,
    tos_version: TOS_VERSION,
    tos_accepted_at: now,
    created_at: now,
    ip_hash: iph,
    status: "pending",
  };
  try {
    await c.env.API_KEYS.put(`keyreq:${req.id}`, JSON.stringify(req));
    await c.env.API_KEYS.put(emailKey, req.id);
    await c.env.API_KEYS.put(ipKey, String(ipCount + 1), { expirationTtl: 60 * 60 * 26 });
  } catch (e) {
    console.error("key request KV put failed:", e);
    const { body, status, headers } = problem(503, "Service Unavailable", "Could not record the request — please try again shortly.");
    return c.json(body, status, headers);
  }

  if (c.env.NOTIFY_TO) {
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        to: c.env.NOTIFY_TO,
        replyTo: email,
        subject: `[cars-data API] Key request ${req.id} — ${company ?? name}`,
        text:
          `New API key request — waiting for your approval.\n\n` +
          `Request: ${req.id}\nName:    ${name}\nEmail:   ${email}\nCompany: ${company ?? "—"}\n\n` +
          `Use case:\n${useCase}\n\n` +
          `Approve: node scripts/keys-admin.mjs approve ${req.id}\n` +
          `Reject:  node scripts/keys-admin.mjs reject ${req.id}\n`,
      }),
    );
  }
  return accepted();
});
