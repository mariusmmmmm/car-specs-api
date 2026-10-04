import type { Env } from "../types";
import { isUsable, sha256Hex, type KeyRecord } from "./apikey";
import { checkAndConsume } from "./quota";

export type AuthResult =
  | { ok: true; keyHash: string; record: KeyRecord }
  | { ok: false; status: 401 | 403 | 429 | 503; detail: string };

const GET_KEY = "Request a free key at https://cars-data.com/en/api/for-ai-agents (manually reviewed), or use the Apify Actor.";

/** Pull the key from `X-Api-Key` or `Authorization: Bearer …` (Cursor,
 *  Claude Desktop, Windsurf configs). For MCP only, also `?key=` in the URL:
 *  the claude.ai and ChatGPT custom-connector dialogs take a URL and nothing
 *  else, so a header can't be set there. */
export function readApiKey(headers: Headers, url?: URL): string | null {
  const x = headers.get("X-Api-Key")?.trim();
  if (x) return x;
  const auth = headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  if (m) return m[1];
  return url?.searchParams.get("key")?.trim() || null;
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
    // A metering failure is OUR fault, not the caller's, and a client library
    // should treat it differently: 503 + Retry-After means "come back", 429
    // means "you are over your limit". Collapsing them into 429 would tell an
    // integrator to throttle their own usage over an outage on our side.
    if (q.reason === "metering") {
      return {
        ok: false,
        status: 503,
        detail: "Usage metering is temporarily unavailable, so this request cannot be served. Retry shortly.",
      };
    }
    return {
      ok: false,
      status: 429,
      detail: q.reason === "quota"
        ? "Monthly quota exceeded. Bulk data is licensed separately: https://cars-data.com/en/api."
        : q.reason === "daily"
          ? "Daily request limit for this key reached. It resets at 00:00 UTC."
          : q.reason === "global"
            // Says plainly that the caller did nothing wrong. Hiding a
            // service-wide ceiling behind "slow down" would send an integrator
            // hunting a bug in their own client.
            ? "The service-wide daily limit for free catalogue access has been reached — this is not a limit on your key. It resets at 00:00 UTC. Licensed exports are not rate-limited: https://cars-data.com/en/api."
            : "Rate limit exceeded — slow down and retry shortly.",
    };
  }
  return { ok: true, keyHash, record };
}
