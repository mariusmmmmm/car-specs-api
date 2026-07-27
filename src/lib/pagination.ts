import type { Context } from "hono";

// Uniform list pagination (all list endpoints, per owner decision 2026-07-27):
// 50 rows/page, offset-based via an OPAQUE `cursor` token the client echoes
// back. Opaque so each endpoint can keep its own ORDER BY (brands by
// popularity, variants by name, …) without exposing an internal keyset — the
// client just passes `links.next` back as `?cursor=`. `/variants` filter keeps
// its own keyset cursor (also opaque); the contract is identical either way.
export const PAGE_LIMIT = 50;

export function parsePaging(c: Context): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || PAGE_LIMIT, 1), PAGE_LIMIT);
  const offset = Math.max(Number(c.req.query("cursor")) || 0, 0);
  return { limit, offset };
}

// A full page implies there may be more → hand back the next offset. On the
// exact-multiple boundary the next fetch returns an empty page and the client
// stops; that is standard offset-pagination behavior, not a bug.
export function nextLink(rowsLen: number, limit: number, offset: number): { next: string } | undefined {
  return rowsLen === limit ? { next: String(offset + limit) } : undefined;
}
