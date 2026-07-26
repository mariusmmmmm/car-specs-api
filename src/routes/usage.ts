import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { envelope } from "../lib/response";
import { currentUsage, resetsAt } from "../lib/quota";

export const usage = new Hono<{ Bindings: Env; Variables: Variables }>();

usage.get("/", async (c) => {
  const keyHash = c.get("apiKeyHash");
  const record = c.get("apiKeyRecord");
  const { used, quota } = await currentUsage(c.env.API_KEYS, keyHash);
  return c.json(
    envelope(
      { plan: record.plan, used, quota, resets_at: resetsAt() },
      { last_synced_at: new Date().toISOString() },
    ),
  );
});
