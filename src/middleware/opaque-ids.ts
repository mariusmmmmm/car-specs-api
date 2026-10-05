import type { Context, Next } from "hono";
import type { Env, Variables } from "../types";
import { encodeId, decodeId, type IdKind } from "../lib/public-id";

// ONE gate for the whole protected surface, not one per route (T92).
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

export async function opaqueIds(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  await next();

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
export function readId(c: Context<{ Bindings: Env }>, kind: IdKind, param = "id"): Promise<number | null> {
  return decodeId(c.env.ID_TOKEN_KEY, kind, c.req.param(param) ?? "");
}

export async function readCursor(c: Context<{ Bindings: Env }>): Promise<number> {
  const raw = c.req.query("cursor");
  if (!raw) return 0;
  const n = await decodeId(c.env.ID_TOKEN_KEY, "cursor", raw);
  // An unreadable cursor restarts from the beginning rather than 400-ing: a
  // client that kept a cursor across a key rotation should page again, not break.
  return n ?? 0;
}

export async function readIdList(c: Context<{ Bindings: Env }>, kind: IdKind, query: string): Promise<(number | null)[]> {
  const raw = c.req.query(query);
  if (!raw) return [];
  return Promise.all(
    raw.split(",").map((t) => decodeId(c.env.ID_TOKEN_KEY, kind, t)),
  );
}
