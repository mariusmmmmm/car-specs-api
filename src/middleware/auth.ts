import type { Context, Next } from "hono";
import type { Env, Variables } from "../types";
import { problem } from "../lib/response";
import { authenticate, readApiKey } from "../lib/auth-key";

const TITLES = {
  401: "Unauthorized",
  403: "Forbidden",
  429: "Too Many Requests",
  // 503 is OUR failure, not the caller's — see the metering branch in
  // lib/auth-key.ts. A client library must be able to tell them apart.
  503: "Service Unavailable",
} as const;

export async function requireApiKey(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  // A request paid with x402 (T216) carries no key by construction, and the
  // flag is set only on the path where the payment middleware verified before
  // calling next(). An unpaid request never gets here — it was answered 402.
  if (c.get("x402")) return next();
  const auth = await authenticate(c.env, readApiKey(c.req.raw.headers));
  if (!auth.ok) {
    const { body, status, headers } = problem(auth.status, TITLES[auth.status], auth.detail);
    // Retry-After only on 503: a metering outage is transient and the caller
    // should come back. A 429 means they are over their own limit.
    return c.json(body, status, auth.status === 503 ? { ...headers, "Retry-After": "30" } : headers);
  }
  c.set("apiKeyHash", auth.keyHash);
  c.set("apiKeyRecord", auth.record);
  await next();
}
