import type { Context, Next } from "hono";
import type { Env } from "../types";

// The key form on cars-data.com posts straight from the browser, so the
// Worker's per-IP cap sees the visitor's IP (a server-side proxy would put
// every request on the site's one IP). CORS is not a guard here — curl ignores
// it — the triage in lib/email-domain.ts and the 40-car scope are.
//
// One copy, shared by /v1/keys and /v1/keys/demo. It briefly existed only in
// routes/keys.ts and was lost when that file's old handler was removed, which
// would have broken the browser form while every curl test kept passing.
const FORM_ORIGINS = /^https:\/\/(www\.)?cars-data\.com$|^http:\/\/localhost:\d+$/;

export async function formCors(c: Context<{ Bindings: Env }>, next: Next) {
  const origin = c.req.header("Origin") ?? "";
  const allowed = FORM_ORIGINS.test(origin);
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: allowed
        ? {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
            Vary: "Origin",
          }
        : {},
    });
  }
  await next();
  if (allowed) {
    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.append("Vary", "Origin");
  }
}
