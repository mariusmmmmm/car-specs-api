import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { envelope, problem } from "../lib/response";
import { formCors } from "../middleware/form-cors";
import { generateApiKey, sha256Hex, type KeyRecord } from "../lib/apikey";
import { ipHash } from "../lib/usage";
import { sendEmail, ingestToInbox } from "../lib/notify";
import { checkDomainOffline, hasMailExchanger, domainOf } from "../lib/email-domain";
import { DEMO_SET_SIZE, DEMO_SET_DESCRIPTION } from "../lib/demo-set";
import { TOS_VERSION, normaliseWebsite } from "../lib/key-request";

// THE ONLY self-serve key (owner decision 2026-10-06). There is no Free tier
// any more: nothing hands out the full catalogue without money. What used to be
// two tiers — a reviewed Free key over 103,099 variants, and a demo over 40 —
// is now one, and it keeps the better half of each:
//
//   * from the demo: the 40-car scope, which is what makes auto-issuing safe.
//     A hundred of these keys expose exactly what one does.
//   * from the Free form: every field. Company, website, role and use case are
//     still required, so the owner gets the lead — which was the whole point of
//     requiring them (T90) — WITHOUT the request waiting on a human.
//
// That removes the vector of 30–31 August by construction rather than by
// vigilance: 139 self-issued keys pulled 85–99% of the catalogue, and the only
// reason they could is that a self-issued key reached the catalogue at all.
export const keysDemo = new Hono<{ Bindings: Env }>();
keysDemo.use("*", formCors);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const PER_IP_PER_DAY = 5;
const VERIFY_TTL_S = 60 * 60 * 24 * 3;

const day = () => new Date().toISOString().slice(0, 10);

function fail(c: Context<{ Bindings: Env }>, status: 400 | 409 | 422 | 429 | 503, title: string, detail: string) {
  const p = problem(status, title, detail);
  return c.json(p.body, p.status, p.headers);
}

type Pending = {
  email: string; name: string; company: string; website: string; role: string;
  use_case: string; created_at: string; ip_hash: string;
};

/** POST — records the request and sends a one-click link. No key yet.
 *
 *  Registered on BOTH /v1/keys/demo and /v1/keys: the second is where the old
 *  reviewed form posted, and a cached page or a copied curl line should keep
 *  working rather than 404 into silence. */
export async function requestDemoKey(c: Context<{ Bindings: Env }>) {
  const p = await c.req.json().catch(() => null);
  const email = str(p?.email, 254).toLowerCase();
  const name = str(p?.name, 120);
  const company = str(p?.company, 120);
  const website = normaliseWebsite(str(p?.website, 200));
  const role = str(p?.role, 80);
  const useCase = str(p?.use_case, 2000);

  // Same required set as the reviewed form had (T90). The fields are not a
  // gate any more — nothing is reviewed — they are the lead. Asking for them
  // after issuing would mean nobody fills them in.
  if (!EMAIL_RE.test(email)) return fail(c, 400, "Bad Request", "A valid `email` is required — the activation link is sent there.");
  if (name.length < 2) return fail(c, 400, "Bad Request", "`name` is required.");
  if (company.length < 2) return fail(c, 400, "Bad Request", "`company` is required — the organisation the key is for (your own name if you are independent).");
  if (!website) return fail(c, 400, "Bad Request", "`website` is required — the site or app the data will be used in, e.g. https://example.com.");
  if (role.length < 2) return fail(c, 400, "Bad Request", "`role` is required — your role there, e.g. developer, CTO, founder.");
  if (useCase.length < 20) return fail(c, 400, "Bad Request", "`use_case` is required (at least 20 characters).");
  if (p?.accept_tos !== true) return fail(c, 400, "Bad Request", "`accept_tos: true` is required — see https://cars-data.com/en/api/terms.");

  const offline = checkDomainOffline(email);
  if (!offline.ok) return fail(c, 422, "Unprocessable Entity", offline.detail);

  const iph = await ipHash(c.req.header("cf-connecting-ip") ?? "unknown", c.env.IP_HASH_SALT);
  const ipKey = `demoreq-ip:${iph}:${day()}`;
  const ipCount = Number((await c.env.API_KEYS.get(ipKey)) ?? 0);
  if (ipCount >= PER_IP_PER_DAY) {
    return fail(c, 429, "Too Many Requests", "Too many key requests from this network today. The MCP server needs no key at all: https://api.cars-data.com/mcp");
  }

  const emailHash = await sha256Hex(email);
  if (await c.env.API_KEYS.get(`demokey-email:${emailHash}`)) {
    return fail(c, 409, "Conflict", "A key was already issued to this address. We keep only a hash of it and cannot resend it — write to office@cars-data.com and we will replace it.");
  }

  const domain = domainOf(email)!;
  if (!(await hasMailExchanger(domain))) {
    return fail(c, 422, "Unprocessable Entity", `${domain} does not accept email, so we cannot send the key there.`);
  }

  const token = generateApiKey("vfy").slice(4);
  const pending: Pending = {
    email, name, company, website, role, use_case: useCase,
    created_at: new Date().toISOString(), ip_hash: iph,
  };
  try {
    await c.env.API_KEYS.put(`demoverify:${await sha256Hex(token)}`, JSON.stringify(pending), { expirationTtl: VERIFY_TTL_S });
    await c.env.API_KEYS.put(ipKey, String(ipCount + 1), { expirationTtl: 60 * 60 * 26 });
  } catch (e) {
    console.error("demo request KV put failed:", e);
    return fail(c, 503, "Service Unavailable", "Could not record the request — please try again shortly.");
  }

  const link = `https://api.cars-data.com/v1/keys/demo/verify?t=${token}`;
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: email,
      replyTo: c.env.NOTIFY_TO,
      subject: "Your cars-data.com API key — one click",
      text:
        `Hi ${name},\n\nClick to activate your key:\n\n${link}\n\n` +
        `The link works once and expires in 3 days.\n\n` +
        `It covers ${DEMO_SET_SIZE} cars — ${DEMO_SET_DESCRIPTION} — with every spec and photo, in 20 languages. ` +
        `That is there to show you the data and the API shape, not to cover a catalogue.\n` +
        `For all 103,099 variants we license an export of exactly the modules you need: https://cars-data.com/en/api\n` +
        `No key at all is needed for the MCP server: https://api.cars-data.com/mcp\n\n` +
        `Terms: https://cars-data.com/en/api/terms\n\n— cars-data.com`,
    }),
  );

  return c.json(
    envelope(
      { status: "verification_sent", note: "Check your inbox — one click and the key is active. Nothing is created until you click." },
      { last_synced_at: new Date().toISOString() },
    ),
    202,
  );
}

keysDemo.post("/", requestDemoKey);

/** GET /v1/keys/demo/verify?t=… — creates the key and shows it once. */
keysDemo.get("/verify", async (c) => {
  const token = (c.req.query("t") ?? "").trim();
  if (!/^[0-9a-f]{48}$/.test(token)) return fail(c, 400, "Bad Request", "That is not a valid verification link.");

  const vKey = `demoverify:${await sha256Hex(token)}`;
  const raw = await c.env.API_KEYS.get(vKey);
  if (!raw) {
    return fail(c, 409, "Conflict", "This link has already been used, or it expired after 3 days. Request a new one at https://cars-data.com/en/api/for-ai-agents");
  }
  const pending = JSON.parse(raw) as Pending;
  const emailHash = await sha256Hex(pending.email);

  // Burn the token BEFORE minting, so a double click cannot produce two keys.
  await c.env.API_KEYS.delete(vKey);
  if (await c.env.API_KEYS.get(`demokey-email:${emailHash}`)) {
    return fail(c, 409, "Conflict", "A key already exists for this address.");
  }

  const rawKey = generateApiKey("cd_demo");
  const keyHash = await sha256Hex(rawKey);
  const now = new Date().toISOString();
  const record: KeyRecord = {
    email: pending.email,
    name: pending.name,
    plan: "demo",
    tos_version: TOS_VERSION,
    tos_accepted_at: pending.created_at,
    created_at: now,
    email_verified: true,
    approved: true,
    approved_at: now,
  };
  await c.env.API_KEYS.put(`key:${keyHash}`, JSON.stringify(record));
  await c.env.API_KEYS.put(`demokey-email:${emailHash}`, keyHash.slice(0, 8));

  // The lead reaches the owner HERE, not at request time: an address that was
  // never confirmed is noise, and the inbox is read by a person. So what lands
  // is a verified address with company, website, role and use case attached —
  // the thing requiring those fields was for (T90) — and it lands without
  // anyone having waited on it.
  const summary =
    `New API key — issued automatically, email verified.\n\n` +
    `Name:    ${pending.name}\nRole:    ${pending.role}\nEmail:   ${pending.email}\n` +
    `Company: ${pending.company}\nWebsite: ${pending.website}\n\n` +
    `Use case:\n${pending.use_case}\n\n` +
    `Key covers the ${DEMO_SET_SIZE}-car demo set. Full catalogue is a licensed export.\n` +
    `Key hash prefix: ${keyHash.slice(0, 8)}\n`;
  c.executionCtx.waitUntil(
    (async () => {
      const stored = await ingestToInbox(c.env, {
        kind: "api_key_request",
        name: pending.name,
        email: pending.email,
        subject: `API key issued — ${pending.company}`,
        message: summary,
        meta: {
          company: pending.company, website: pending.website, role: pending.role,
          tos_version: TOS_VERSION, ip_hash: pending.ip_hash,
          key_hash_prefix: keyHash.slice(0, 8), auto_issued: true,
        },
      });
      if (!stored && c.env.NOTIFY_TO) {
        await sendEmail(c.env, { to: c.env.NOTIFY_TO, replyTo: pending.email, subject: `[cars-data API] key issued — ${pending.company}`, text: summary });
      }
      await sendEmail(c.env, {
        to: pending.email,
        replyTo: c.env.NOTIFY_TO,
        subject: "Your cars-data.com API key",
        text:
          `Hi ${pending.name},\n\nYour key:\n\n${rawKey}\n\n` +
          `Send it as the X-Api-Key header, or "Authorization: Bearer <key>".\n` +
          `Start here: GET https://api.cars-data.com/v1/demo — the whole set in one call.\n\n` +
          `Store it now: we keep only a hash and cannot show it again.\n\n— cars-data.com`,
      });
    })(),
  );

  return c.json(
    envelope(
      {
        api_key: rawKey,
        plan: "demo",
        covers: `${DEMO_SET_SIZE} cars — ${DEMO_SET_DESCRIPTION}`,
        start_here: "https://api.cars-data.com/v1/demo",
        full_catalogue: "https://cars-data.com/en/api",
        note: "Store this key now — we keep only a hash and cannot show it again. A copy is in your inbox.",
      },
      { last_synced_at: now },
    ),
  );
});
