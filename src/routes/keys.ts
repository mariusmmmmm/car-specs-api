import { Hono } from "hono";
import type { Env } from "../types";
import { envelope, problem } from "../lib/response";
import { generateApiKey, sha256Hex, type KeyRecord } from "../lib/apikey";

export const keys = new Hono<{ Bindings: Env }>();

// Bump when specs/plans/BIZ-API-terms-of-service-draft.md changes; kept with
// the key record so we know which version a given customer accepted.
const TOS_VERSION = "2026-07-26-draft-v1";

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
      "`accept_tos: true` is required — see https://cars-data.com/api/terms.",
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
  await c.env.API_KEYS.put(`key:${keyHash}`, JSON.stringify(record));

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
