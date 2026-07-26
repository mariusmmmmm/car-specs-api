import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../lib/db";
import { envelope } from "../lib/response";
import { catalog } from "./catalog";
import { variants } from "./variants";
import { search } from "./search";

export const v1 = new Hono<{ Bindings: Env }>();

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

v1.route("/", catalog);
v1.route("/variants", variants);
v1.route("/search", search);
