import { Hono } from "hono";
import type { Env } from "../types";
import { envelope, problem } from "../lib/response";
import { generateApiKey, sha256Hex, type KeyRecord } from "../lib/apikey";

export const keys = new Hono<{ Bindings: Env }>();

// Kept with the key record so we know which version a customer accepted.
// Must match DATA_TERMS_VERSION in v3/lib/config/data-pricing.ts — the
// published text at /en/api/terms (T73). Bump both together.
const TOS_VERSION = "2026-10-02-v1";

keys.post("/", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const email = typeof payload?.email === "string" ? payload.email.trim() : "";
  const acceptTos = payload?.accept_tos === true;

  if (!email || !email.includes("@")) {
    const { body, status, headers } = problem(400, "Bad Request", "A valid `email` is required.");
    return c.json(body, status, headers);
  }
  if (!acceptTos) {
    const { body, status, headers } = problem(
      400,
      "Bad Request",
      "`accept_tos: true` is required — see https://cars-data.com/en/api/terms.",
    );
    return c.json(body, status, headers);
  }

  const rawKey = generateApiKey();
  const keyHash = await sha256Hex(rawKey);
  const now = new Date().toISOString();
  const record: KeyRecord = {
    email,
    plan: "free",
    tos_version: TOS_VERSION,
    tos_accepted_at: now,
    created_at: now,
    email_verified: false,
  };
  try {
    await c.env.API_KEYS.put(`key:${keyHash}`, JSON.stringify(record));
  } catch (e) {
    // Key issuance genuinely needs the KV write (unlike metering, we can't
    // fail-open here). On a KV put failure (e.g. free-tier daily cap) return a
    // clear, retryable 503 instead of a raw 500.
    console.error("key issuance KV put failed:", e);
    const { body, status, headers } = problem(
      503,
      "Service Unavailable",
      "Could not issue a key right now — please try again shortly.",
    );
    return c.json(body, status, headers);
  }

  return c.json(
    envelope(
      {
        api_key: rawKey,
        plan: "free",
        note: "Store this key now — it is not shown again. Send it as the X-Api-Key header.",
      },
      { last_synced_at: now },
    ),
    201,
  );
});
