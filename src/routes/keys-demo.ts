import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { envelope, problem } from "../lib/response";
import { generateApiKey, sha256Hex, type KeyRecord } from "../lib/apikey";
import { ipHash } from "../lib/usage";
import { sendEmail } from "../lib/notify";
import { checkDomainOffline, hasMailExchanger, domainOf } from "../lib/email-domain";
import { DEMO_SET_SIZE, DEMO_SET_DESCRIPTION } from "../lib/demo-set";
import { TOS_VERSION, formCors } from "./keys";

// Self-serve demo keys (T111 R1–R4). The reviewed key stays reviewed: this is
// the tier below it, and it exists so that REVIEW LEAVES THE CRITICAL PATH.
// Someone who only wants to see that the API answers gets an answer in a
// minute; the owner's attention is spent only on requests with intent behind
// them.
//
// Auto-issuing is safe here for one reason and it is not the rules below: a
// demo key can only ever resolve the 40 cars in lib/demo-set.ts, so a hundred
// of them expose exactly what one does. The rules keep the key table readable —
// 135 of today's 184 records came from five disposable-mail domains in two days.
export const keysDemo = new Hono<{ Bindings: Env }>();

// Same origin rule as /v1/keys — the request form posts straight from the
// browser so the per-IP cap sees the visitor, not the site's one IP.
keysDemo.use("*", formCors);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PER_IP_PER_DAY = 5;
const VERIFY_TTL_S = 60 * 60 * 24 * 3;

const day = () => new Date().toISOString().slice(0, 10);
function bad(
  c: Context<{ Bindings: Env }>,
  status: 400 | 409 | 422 | 429,
  title: string,
  detail: string,
) {
  const p = problem(status, title, detail);
  return c.json(p.body, p.status, p.headers);
}

/** POST /v1/keys/demo { email } → 202, and an email with a one-click link.
 *
 *  The key is NOT created here. It is created when the link is clicked, so an
 *  address that was typed wrong or does not belong to the requester leaves
 *  nothing behind — which is the difference between this and the flow that
 *  produced 135 unusable records. */
keysDemo.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = String(body?.email ?? "").trim().toLowerCase().slice(0, 254);
  if (!EMAIL_RE.test(email)) return bad(c, 400, "Bad Request", "A valid `email` is required.");

  const offline = checkDomainOffline(email);
  if (!offline.ok) return bad(c, 422, "Unprocessable Entity", offline.detail);

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const iph = await ipHash(ip, c.env.IP_HASH_SALT);
  const ipKey = `demoreq-ip:${iph}:${day()}`;
  const ipCount = Number((await c.env.API_KEYS.get(ipKey)) ?? 0);
  if (ipCount >= PER_IP_PER_DAY) {
    return bad(c, 429, "Too Many Requests", "Too many demo requests from this network today. The MCP server needs no key at all: https://api.cars-data.com/mcp");
  }

  const emailHash = await sha256Hex(email);

  // Already has a live demo key. We keep only a hash of it, so it cannot be
  // resent — saying so plainly beats silently minting a second key and beats
  // revoking the one their integration is using.
  if (await c.env.API_KEYS.get(`demokey-email:${emailHash}`)) {
    return bad(
      c,
      409,
      "Conflict",
      "A demo key was already issued to this address. We only store a hash of it and cannot resend it — write to office@cars-data.com and we will replace it.",
    );
  }

  const domain = domainOf(email)!;
  if (!(await hasMailExchanger(domain))) {
    return bad(c, 422, "Unprocessable Entity", `${domain} does not accept email, so we cannot send the key there.`);
  }

  const token = generateApiKey("vfy").slice(4); // 48 hex chars, same CSPRNG
  const pending = { email, created_at: new Date().toISOString(), ip_hash: iph };
  await c.env.API_KEYS.put(`demoverify:${await sha256Hex(token)}`, JSON.stringify(pending), { expirationTtl: VERIFY_TTL_S });
  await c.env.API_KEYS.put(ipKey, String(ipCount + 1), { expirationTtl: 60 * 60 * 26 });

  const link = `https://api.cars-data.com/v1/keys/demo/verify?t=${token}`;
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: email,
      replyTo: c.env.NOTIFY_TO,
      subject: "Your cars-data.com demo key — one click",
      text:
        `Click to activate your demo key:\n\n${link}\n\n` +
        `The link works once and expires in 3 days.\n\n` +
        `The demo covers ${DEMO_SET_SIZE} cars — ${DEMO_SET_DESCRIPTION} — with every spec and photo, ` +
        `in 20 languages. It is there to show the API answers with real data, not to cover a catalogue.\n` +
        `For all 103,099 variants, ask for a reviewed key (also free): https://cars-data.com/en/api/for-ai-agents\n` +
        `No key at all is needed for the MCP server: https://api.cars-data.com/mcp\n\n— cars-data.com`,
    }),
  );

  return c.json(
    envelope(
      { status: "verification_sent", note: "Check your inbox — one click and the key is active. Nothing is created until you click." },
      { last_synced_at: new Date().toISOString() },
    ),
    202,
  );
});

/** GET /v1/keys/demo/verify?t=… — creates the key and shows it once.
 *
 *  A GET that changes state, which is normally wrong; it is right here because
 *  the thing clicking is a mail client, and the token is single-use. */
keysDemo.get("/verify", async (c) => {
  const token = (c.req.query("t") ?? "").trim();
  if (!/^[0-9a-f]{48}$/.test(token)) return bad(c, 400, "Bad Request", "That is not a valid verification link.");

  const vKey = `demoverify:${await sha256Hex(token)}`;
  const raw = await c.env.API_KEYS.get(vKey);
  if (!raw) {
    return bad(c, 409, "Conflict", "This link has already been used, or it expired after 3 days. Request a new one at https://cars-data.com/en/api/for-ai-agents");
  }
  const pending = JSON.parse(raw) as { email: string };
  const emailHash = await sha256Hex(pending.email);

  // Burn the token BEFORE minting, so a double click cannot produce two keys.
  await c.env.API_KEYS.delete(vKey);
  if (await c.env.API_KEYS.get(`demokey-email:${emailHash}`)) {
    return bad(c, 409, "Conflict", "A demo key already exists for this address.");
  }

  const rawKey = generateApiKey("cd_demo");
  const keyHash = await sha256Hex(rawKey);
  const now = new Date().toISOString();
  const record: KeyRecord = {
    email: pending.email,
    plan: "demo",
    tos_version: TOS_VERSION,
    tos_accepted_at: now,
    created_at: now,
    email_verified: true,
    approved: true,
    approved_at: now,
  };
  await c.env.API_KEYS.put(`key:${keyHash}`, JSON.stringify(record));
  await c.env.API_KEYS.put(`demokey-email:${emailHash}`, keyHash.slice(0, 8));

  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: pending.email,
      replyTo: c.env.NOTIFY_TO,
      subject: "Your cars-data.com demo key",
      text:
        `Your demo key:\n\n${rawKey}\n\n` +
        `Send it as the X-Api-Key header, or "Authorization: Bearer <key>".\n` +
        `Start here: GET https://api.cars-data.com/v1/demo — the whole demo set in one call.\n\n` +
        `Store it now: we keep only a hash and cannot show it again.\n\n— cars-data.com`,
    }),
  );

  return c.json(
    envelope(
      {
        api_key: rawKey,
        plan: "demo",
        covers: `${DEMO_SET_SIZE} cars — ${DEMO_SET_DESCRIPTION}`,
        start_here: "https://api.cars-data.com/v1/demo",
        note: "Store this key now — we keep only a hash and cannot show it again. A copy is in your inbox.",
      },
      { last_synced_at: now },
    ),
  );
});
