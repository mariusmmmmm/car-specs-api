import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { getDb } from "../lib/db";
import { envelope } from "../lib/response";
import { catalog } from "./catalog";
import { variants } from "./variants";
import { search } from "./search";
import { keys } from "./keys";
import { usage } from "./usage";
import { requireApiKey } from "../middleware/auth";

export const v1 = new Hono<{ Bindings: Env; Variables: Variables }>();

// Public — no key needed.
v1.get("/health", async (c) => {
  const sql = getDb(c.env);
  const [{ count }] = await sql`SELECT count(*)::int FROM variants WHERE is_active`;
  return c.json(
    envelope(
      { status: "ok", active_variants: count },
      { last_synced_at: new Date().toISOString() },
    ),
  );
});
v1.route("/keys", keys);

// Everything else needs a Free (or later, paid) API key + counts against quota.
const protectedV1 = new Hono<{ Bindings: Env; Variables: Variables }>();
protectedV1.use("*", requireApiKey);
protectedV1.route("/", catalog);
protectedV1.route("/variants", variants);
protectedV1.route("/search", search);
protectedV1.route("/usage", usage);

v1.route("/", protectedV1);
