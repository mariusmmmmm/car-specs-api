import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Envelope + errors per BIZ-L2a-openapi-readmodel.md §2:
// { data, meta:{locale,units,last_synced_at}, links:{next} }; errors = RFC 9457 (problem+json).

export type Meta = {
  locale?: string;
  units?: "metric" | "imperial";
  last_synced_at: string;
  [key: string]: unknown;
};

export function envelope<T>(data: T, meta: Meta, links?: { next?: string }) {
  return { data, meta, ...(links ? { links } : {}) };
}

// Every JSON body this Worker emits is UTF-8, and plenty of it is non-ASCII:
// the demo copy alone carries em-dashes ("40 cars — ..."). Without an
// explicit charset a browser falls back to a single-byte decoding and shows
// "40 cars â€”". That matters on exactly one page — the key the
// customer reads with their eyes at GET /v1/keys/demo/verify — but the
// declaration belongs on every JSON response, not on that one route.
//
// Hono does NOT add it: c.json() goes through setDefaultContentType(
// "application/json") with no charset (hono/dist/context.js:360), unlike
// c.html() which does carry one. So both halves need fixing in one place:
// the problem+json literal below, and jsonCharset() for everything c.json()
// produces.
export const JSON_UTF8 = "application/json; charset=utf-8";
export const PROBLEM_JSON_UTF8 = "application/problem+json; charset=utf-8";

export function problem(
  status: ContentfulStatusCode,
  title: string,
  detail?: string,
  extra?: Record<string, unknown>,
) {
  return {
    body: { type: "about:blank", title, status, ...(detail ? { detail } : {}), ...extra },
    status,
    headers: { "Content-Type": PROBLEM_JSON_UTF8 } as const,
  };
}

/** Outermost middleware: stamps "; charset=utf-8" on any JSON response that
 *  left without one. One gate on the way out instead of one argument per
 *  c.json() call — the same reason opaqueIds is a middleware and not a rewrite
 *  per route: the next route someone adds cannot forget.
 *
 *  Only touches JSON (`application/json`, `application/problem+json`,
 *  `application/*+json`); text/html already declares its own charset, and a
 *  body with no Content-Type at all (204, CORS preflight) is left alone. */
export async function jsonCharset(c: Context, next: Next) {
  await next();
  const type = c.res.headers.get("content-type");
  if (!type) return;
  const lower = type.toLowerCase();
  if (!lower.includes("json") || lower.includes("charset=")) return;
  // Headers on a Response built by Hono are mutable; a response whose headers
  // are guarded (e.g. one handed back verbatim by another runtime) must not
  // take the whole request down over a cosmetic header.
  try {
    c.res.headers.set("content-type", `${type}; charset=utf-8`);
  } catch {
    c.res = new Response(c.res.body, {
      status: c.res.status,
      headers: { ...Object.fromEntries(c.res.headers), "content-type": `${type}; charset=utf-8` },
    });
  }
}
