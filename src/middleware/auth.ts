import type { Context, Next } from "hono";
import type { Env, Variables } from "../types";
import { problem } from "../lib/response";
import { authenticate, readApiKey } from "../lib/auth-key";

const TITLES = { 401: "Unauthorized", 403: "Forbidden", 429: "Too Many Requests" } as const;

export async function requireApiKey(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const auth = await authenticate(c.env, readApiKey(c.req.raw.headers));
  if (!auth.ok) {
    const { body, status, headers } = problem(auth.status, TITLES[auth.status], auth.detail);
    return c.json(body, status, headers);
  }
  c.set("apiKeyHash", auth.keyHash);
  c.set("apiKeyRecord", auth.record);
  await next();
}
