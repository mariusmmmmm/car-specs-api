import { Hono } from "hono";
import type { Env } from "../types";
import { envelope, problem } from "../lib/response";
import { generateApiKey, isUsable, sha256Hex, type KeyRecord, type KeyRequest } from "../lib/apikey";
import { sendEmail } from "../lib/notify";

// Owner-only key administration (T73). Every Free key is approved by hand;
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

// ── requests ────────────────────────────────────────────────────────────────
admin.get("/requests", async (c) => {
  const status = c.req.query("status") ?? "pending";
  const all = await listValues<KeyRequest>(c.env.API_KEYS, "keyreq:");
  const rows = all.map((r) => r.value).filter((r) => status === "all" || r.status === status);
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return ok(c, rows);
});

admin.post("/requests/:id/approve", async (c) => {
  const id = c.req.param("id");
  const raw = await c.env.API_KEYS.get(`keyreq:${id}`);
  if (!raw) return notFound(c, `No request ${id}`);
  const req = JSON.parse(raw) as KeyRequest;
  if (req.status !== "pending") {
    const { body, status, headers } = problem(409, "Conflict", `Request ${id} is already ${req.status}.`);
    return c.json(body, status, headers);
  }

  const rawKey = generateApiKey();
  const keyHash = await sha256Hex(rawKey);
  const record: KeyRecord = {
    email: req.email,
    name: req.name,
    plan: "free",
    tos_version: req.tos_version,
    tos_accepted_at: req.tos_accepted_at,
    created_at: now(),
    email_verified: true, // the key only reaches the requester through this address
    approved: true,
    approved_at: now(),
    request_id: req.id,
  };
  await c.env.API_KEYS.put(`key:${keyHash}`, JSON.stringify(record));
  const decided: KeyRequest = { ...req, status: "approved", decided_at: now(), key_hash_prefix: keyHash.slice(0, 8) };
  await c.env.API_KEYS.put(`keyreq:${id}`, JSON.stringify(decided));

  const sent = await sendEmail(c.env, {
    to: req.email,
    replyTo: c.env.NOTIFY_TO,
    subject: "Your cars-data.com API key",
    text:
      `Hi ${req.name},\n\nYour request was approved. Your API key:\n\n${rawKey}\n\n` +
      `Send it as the X-Api-Key header (REST) or as "Authorization: Bearer <key>" (MCP, https://api.cars-data.com/mcp).\n` +
      `Free plan: 1,000 requests per month, 20 per minute, attribution required.\n` +
      `Terms: https://cars-data.com/en/api/terms\nDocs: https://cars-data.com/en/api/for-ai-agents\n\n` +
      `Store it now — we keep only a hash and cannot show it again.\n\n— cars-data.com`,
  });
  // If the email failed the owner still needs to deliver the key somehow, so
  // it is returned to the admin caller (and only to the admin caller).
  return ok(c, { id, email: req.email, key_hash_prefix: keyHash.slice(0, 8), emailed: sent, api_key: sent ? undefined : rawKey });
});

admin.post("/requests/:id/reject", async (c) => {
  const id = c.req.param("id");
  const raw = await c.env.API_KEYS.get(`keyreq:${id}`);
  if (!raw) return notFound(c, `No request ${id}`);
  const req = JSON.parse(raw) as KeyRequest;
  await c.env.API_KEYS.put(`keyreq:${id}`, JSON.stringify({ ...req, status: "rejected", decided_at: now() }));
  // Free the email so a genuine requester can try again with a better use case.
  await c.env.API_KEYS.delete(`keyreq-email:${await sha256Hex(req.email)}`);
  return ok(c, { id, status: "rejected" });
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
