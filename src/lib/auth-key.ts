import type { Env } from "../types";
import { isUsable, sha256Hex, type KeyRecord } from "./apikey";
import { checkAndConsume } from "./quota";

export type AuthResult =
  | { ok: true; keyHash: string; record: KeyRecord }
  | { ok: false; status: 401 | 403 | 429; detail: string };

const GET_KEY = "Request a free key at https://cars-data.com/en/api/for-ai-agents (manually reviewed), or use the Apify Actor.";

/** Pull the key from `X-Api-Key` or `Authorization: Bearer …` — MCP clients
 *  (Claude, Cursor, ChatGPT connectors) mostly offer the second. */
export function readApiKey(headers: Headers): string | null {
  const x = headers.get("X-Api-Key")?.trim();
  if (x) return x;
  const auth = headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  return m ? m[1] : null;
}

/** One gate for REST and MCP: the key must exist, be approved, not revoked,
 *  and be inside its quota. Consumes one unit of quota when it passes. */
export async function authenticate(env: Env, rawKey: string | null): Promise<AuthResult> {
  if (!rawKey) return { ok: false, status: 401, detail: `An API key is required. ${GET_KEY}` };
  const keyHash = await sha256Hex(rawKey);
  const raw = await env.API_KEYS.get(`key:${keyHash}`);
  if (!raw) return { ok: false, status: 401, detail: `Invalid API key. ${GET_KEY}` };
  const record = JSON.parse(raw) as KeyRecord;
  if (!isUsable(record)) {
    return {
      ok: false,
      status: 403,
      detail: record.revoked_at
        ? "This API key has been revoked."
        : "This API key is waiting for manual approval. You will get an email when it is active.",
    };
  }
  const q = await checkAndConsume(env.API_KEYS, keyHash, record.plan);
  if (!q.ok) {
    return {
      ok: false,
      status: 429,
      detail: q.reason === "quota"
        ? "Monthly quota exceeded. Bulk data is licensed separately: https://cars-data.com/en/api."
        : "Rate limit exceeded — slow down and retry shortly.",
    };
  }
  return { ok: true, keyHash, record };
}
