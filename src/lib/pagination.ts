import type { Context } from "hono";
import type { Env, Variables } from "../types";
import { decodeId } from "./public-id";

// Uniform list pagination (all list endpoints, per owner decision 2026-07-27):
// 50 rows/page, offset-based via an OPAQUE `cursor` token the client echoes
// back. Opaque so each endpoint can keep its own ORDER BY (brands by
// popularity, variants by name, …) without exposing an internal keyset — the
// client just passes `links.next` back as `?cursor=`. `/variants` filter keeps
// its own keyset cursor (also opaque); the contract is identical either way.
export const PAGE_LIMIT = 50;

// The cursor is an opaque token (T111), for the same reason the ids are: the
// /v1/variants filter uses a KEYSET cursor whose value is the last row's
// variant_id, so a published cursor hands back one real id per page.
// An unreadable cursor restarts from the first page rather than 400-ing — a
// client holding one across a key rotation should page again, not break.
export async function parsePaging(
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<{ limit: number; offset: number }> {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || PAGE_LIMIT, 1), PAGE_LIMIT);
  const raw = c.req.query("cursor")?.trim();
  if (!raw) return { limit, offset: 0 };
  // The apify plan keeps RAW ids and cursors (see middleware/opaque-ids.ts for
  // why). Decoding its plain-number cursor as a token would fail and silently
  // restart at page 1 — a wrong answer dressed as a right one, on the surface
  // that makes 956 of its calls.
  if (c.get("apiKeyRecord")?.plan === "apify") {
    const n = /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
    return { limit, offset: Math.max(n, 0) };
  }
  const decoded = await decodeId(c.env.ID_TOKEN_KEY, "cursor", raw);
  return { limit, offset: Math.max(decoded ?? 0, 0) };
}

// A full page implies there may be more → hand back the next offset. On the
// exact-multiple boundary the next fetch returns an empty page and the client
// stops; that is standard offset-pagination behavior, not a bug.
export function nextLink(rowsLen: number, limit: number, offset: number): { next: string } | undefined {
  return rowsLen === limit ? { next: String(offset + limit) } : undefined;
}
