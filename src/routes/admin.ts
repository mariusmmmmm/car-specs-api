import { Hono } from "hono";
import type { Env } from "../types";
import { envelope, problem } from "../lib/response";
import { generateApiKey, isUsable, sha256Hex, type KeyRecord } from "../lib/apikey";
import { TOS_VERSION } from "../lib/key-request";
import { sendEmail } from "../lib/notify";

// Owner-only key administration (T73). A key on a plan the public cannot
// self-serve is granted by hand;
// scripts/keys-admin.mjs is the client. Guarded by the ADMIN_TOKEN secret —
// with no secret set the whole surface answers 404, so a fresh deploy can't
// expose it by accident.
export const admin = new Hono<{ Bindings: Env }>();

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

admin.use("*", async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  const sent = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || !sent || !safeEqual(sent, token)) {
    const { body, status, headers } = problem(404, "Not Found", `No route for ${c.req.path}`);
    return c.json(body, status, headers);
  }
  await next();
});

const now = () => new Date().toISOString();
const ok = <T>(c: { json: (b: unknown, s?: number) => Response }, data: T) =>
  c.json(envelope(data, { last_synced_at: now() }));
const notFound = (c: { json: (b: unknown, s: number, h: Record<string, string>) => Response }, what: string) => {
  const { body, status, headers } = problem(404, "Not Found", what);
  return c.json(body, status, headers);
};

async function listValues<T>(kv: KVNamespace, prefix: string): Promise<{ name: string; value: T }[]> {
  const out: { name: string; value: T }[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    const values = await Promise.all(page.keys.map((k) => kv.get(k.name)));
    page.keys.forEach((k, i) => { if (values[i]) out.push({ name: k.name, value: JSON.parse(values[i]!) as T }); });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// The `keyreq:` review surface is GONE (owner, 2026-10-06). Nothing creates
// those records any more: the only self-serve key is the demo, issued on an
// email click, and the lead reaches the inbox at that moment. Endpoints that
// read a record type nothing writes are worse than absent — `approve` minted a
// FULL-CATALOGUE key, so a stale one was a door with no wall behind it.
//
// What replaced it is below: `grant`, the owner's deliberate path to a plan the
// public cannot self-serve. Removing the review without it would have quietly
// taken away the ability to say yes to someone like the two export enquiries
// already in the inbox.

// ── grant: the only way a non-demo key comes into being ─────────────────────
// `plan` is REQUIRED since T166. It used to default to `free`, so the retired
// tier was what an owner got by not finishing the command — the one shape of
// mistake this endpoint must not make. GRANTABLE is the offered set and
// nothing else: `free` is refused here BY NAME, with its own message, because
// a bare "unknown plan" would read like a typo to whoever just typed it.
const GRANTABLE = ["demo", "apify"] as const;
type Grantable = (typeof GRANTABLE)[number];

admin.post("/grant", async (c) => {
  const email = (c.req.query("email") ?? "").trim().toLowerCase();
  const plan = (c.req.query("plan") ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    const { body, status, headers } = problem(400, "Bad Request", "`email` is required.");
    return c.json(body, status, headers);
  }
  if (plan === "free") {
    const { body, status, headers } = problem(
      400,
      "Bad Request",
      "The `free` plan was retired on 2026-10-08 and can no longer be granted. Use `demo` for an evaluation key, or `apify` for the paid channel.",
    );
    return c.json(body, status, headers);
  }
  if (!(GRANTABLE as readonly string[]).includes(plan)) {
    const { body, status, headers } = problem(400, "Bad Request", "`plan` is required and must be demo or apify.");
    return c.json(body, status, headers);
  }

  const rawKey = generateApiKey(plan === "demo" ? "cd_demo" : "cd_apify");
  const keyHash = await sha256Hex(rawKey);
  const record: KeyRecord = {
    email,
    plan: plan as Grantable,
    tos_version: TOS_VERSION,
    tos_accepted_at: now(),
    created_at: now(),
    // Granted by hand, so the address is as verified as the owner's judgement.
    email_verified: true,
    approved: true,
    approved_at: now(),
  };
  await c.env.API_KEYS.put(`key:${keyHash}`, JSON.stringify(record));

  const sent = await sendEmail(c.env, {
    to: email,
    replyTo: c.env.NOTIFY_TO,
    subject: "Your cars-data.com API key",
    text:
      `Your API key:\n\n${rawKey}\n\n` +
      `Send it as the X-Api-Key header (REST) or "Authorization: Bearer <key>" (MCP).\n` +
      `Terms: https://cars-data.com/en/api/terms\nDocs: https://cars-data.com/en/api/for-ai-agents\n\n` +
      `Store it now — we keep only a hash and cannot show it again.\n\n— cars-data.com`,
  });
  // Returned to the admin caller when the email failed, and only then.
  return ok(c, { email, plan, key_hash_prefix: keyHash.slice(0, 8), emailed: sent, api_key: sent ? undefined : rawKey });
});

// ── existing keys (incl. those issued before manual approval) ───────────────
admin.get("/keys", async (c) => {
  const all = await listValues<KeyRecord>(c.env.API_KEYS, "key:");
  const rows = all.map(({ name, value: r }) => ({
    key_hash_prefix: name.slice(4, 12),
    email: r.email,
    plan: r.plan,
    created_at: r.created_at,
    approved: r.approved === true,
    revoked: Boolean(r.revoked_at),
    usable: isUsable(r),
  }));
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return ok(c, rows);
});

async function findKey(kv: KVNamespace, prefix: string) {
  if (!/^[0-9a-f]{8,64}$/.test(prefix)) return null;
  const page = await kv.list({ prefix: `key:${prefix}` });
  if (page.keys.length !== 1) return null; // unknown or ambiguous
  const name = page.keys[0].name;
  const raw = await kv.get(name);
  return raw ? { name, record: JSON.parse(raw) as KeyRecord } : null;
}

admin.post("/keys/:prefix/:action{approve|revoke}", async (c) => {
  const found = await findKey(c.env.API_KEYS, c.req.param("prefix"));
  if (!found) return notFound(c, "No single key matches that hash prefix.");
  const action = c.req.param("action");
  const record: KeyRecord = action === "approve"
    ? { ...found.record, approved: true, approved_at: now(), revoked_at: undefined }
    : { ...found.record, revoked_at: now() };
  await c.env.API_KEYS.put(found.name, JSON.stringify(record));
  return ok(c, { key_hash_prefix: found.name.slice(4, 12), email: record.email, usable: isUsable(record) });
});
