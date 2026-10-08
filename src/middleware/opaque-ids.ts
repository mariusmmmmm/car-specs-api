import type { Context, Next } from "hono";
import type { Env, Variables } from "../types";
import { encodeId, decodeId, type IdKind } from "../lib/public-id";

// ONE gate for the whole protected surface, not one per route (T111).
//
// Every route projects its own rows, so rewriting ids route by route means the
// next route someone adds leaks real `public_id` values and nothing notices —
// the same shape as the guard blind spots this project keeps hitting. So the
// rewrite happens once, on the way out, by walking the response JSON.
//
// Keys rewritten: `variant_id`, `generation_id`, `model_id`, and the pagination
// `links.next`. The cursor matters as much as the ids: the /v1/variants filter
// uses a KEYSET cursor whose value is literally the last row's variant_id, so a
// response that hid the ids and published the cursor would hand back one id per
// page anyway.

export const ID_FIELD_KIND: Record<string, IdKind> = {
  variant_id: "variant",
  generation_id: "generation",
  model_id: "model",
};

/** Walks the body once. Arrays and nested objects included, because list
 *  endpoints nest rows under `data` and `/v1/compare` nests per-variant blocks.
 *  Exported because /mcp needs the SAME field list — the MCP surface used to
 *  hand back raw public_id values, outside this gate entirely. One table of
 *  field names, two surfaces. */
export async function encodeTree(secret: string | undefined, node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map((n) => encodeTree(secret, n)));
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const kind = ID_FIELD_KIND[key];
    if (kind && typeof value === "number") {
      out[key] = await encodeId(secret, kind, value);
    } else if (kind && value === null) {
      out[key] = null;
    } else {
      out[key] = await encodeTree(secret, value);
    }
  }
  return out;
}

/** The `apify` plan keeps RAW integer ids, in both directions.
 *
 *  Not a loophole — a measured one-line exception, taken because the
 *  alternative was shipping a break into a live paid product. The Apify Actor
 *  declares `variantId` as `"type": "integer"` in .actor/input_schema.json and
 *  interpolates whatever the user typed straight into the URL, with
 *  "A variant_id from a prior search/filter run" as its help text. Tokens break
 *  it BOTH ways: the Actor cannot accept `v_a7afb0ae` (Apify's own input
 *  validation rejects a non-integer) and a user cannot feed back an id the
 *  Actor wrote into its dataset.
 *
 *  What makes the exception safe is where the risk actually was: the August
 *  extraction ran on free-tier keys — a tier retired on 2026-10-08 (D-01),
 *  which narrows the exposure further. The apify plan is metered and billed
 *  per-result by Apify, so pulling the catalogue through it costs the puller
 *  money per row — the business model is the defence there, not obscurity.
 *
 *  Note the inverse still holds and still matters: every NON-apify plan gets
 *  tokens, legacy `free` included, so the one live free key sees exactly the
 *  id shape it has always seen.
 *
 *  Remove this once the Actor's input schema takes a string. Until then an id
 *  is opaque per PLAN, which is worth knowing when reading two responses side
 *  by side. */
const RAW_IDS_PLAN = "apify";

export async function opaqueIds(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  await next();

  if (c.get("apiKeyRecord")?.plan === RAW_IDS_PLAN) return;

  const type = c.res.headers.get("content-type") ?? "";
  if (!type.includes("json")) return;
  // Errors carry no ids and must not be reshaped — a problem+json body is a
  // contract of its own.
  if (c.res.status >= 400) return;

  const body = (await c.res.clone().json()) as Record<string, unknown>;
  const rewritten = (await encodeTree(c.env.ID_TOKEN_KEY, body)) as Record<string, unknown>;

  // `links.next` is produced by lib/pagination as a bare number-as-string.
  const links = rewritten.links as Record<string, unknown> | undefined;
  if (links && typeof links.next === "string" && /^\d+$/.test(links.next)) {
    links.next = await encodeId(c.env.ID_TOKEN_KEY, "cursor", Number(links.next));
  }

  c.res = new Response(JSON.stringify(rewritten), {
    status: c.res.status,
    headers: c.res.headers,
  });
}

/** Request side. Returns null for a missing, malformed or wrong-kind token, and
 *  callers turn that into the same 404 an unknown id gets — so a guessed token
 *  and a car that does not exist look identical from outside. */
export function readId(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  kind: IdKind,
  param = "id",
): Promise<number | null> {
  const raw = (c.req.param(param) ?? "").trim();
  if (c.get("apiKeyRecord")?.plan === RAW_IDS_PLAN) return Promise.resolve(rawInt(raw));
  return decodeId(c.env.ID_TOKEN_KEY, kind, raw);
}

/** A bare positive integer, or null. Deliberately strict: "12e3", "0x2a" and
 *  " 42 " with inner junk must not slip through as ids. */
function rawInt(s: string): number | null {
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

export async function readCursor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<number> {
  const raw = c.req.query("cursor");
  if (!raw) return 0;
  if (c.get("apiKeyRecord")?.plan === RAW_IDS_PLAN) return rawInt(raw) ?? 0;
  const n = await decodeId(c.env.ID_TOKEN_KEY, "cursor", raw);
  // An unreadable cursor restarts from the beginning rather than 400-ing: a
  // client that kept a cursor across a key rotation should page again, not break.
  return n ?? 0;
}

export async function readIdList(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  kind: IdKind,
  query: string,
): Promise<(number | null)[]> {
  const raw = c.req.query(query);
  if (!raw) return [];
  const parts = raw.split(",").map((t) => t.trim());
  if (c.get("apiKeyRecord")?.plan === RAW_IDS_PLAN) return parts.map(rawInt);
  return Promise.all(parts.map((t) => decodeId(c.env.ID_TOKEN_KEY, kind, t)));
}
