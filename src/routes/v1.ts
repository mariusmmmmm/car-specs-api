import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../lib/db";
import { envelope } from "../lib/response";

// Business endpoints (brands/models/generations/variants/search/compare) land
// on Day 2-4 per specs/plans/BIZ-Phase1-BUILD-RUNBOOK.md Stage B. This file is
// the Day 1 scaffold: routing + db wiring proven end-to-end against the local
// cars_v3 replica via Hyperdrive's localConnectionString.
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
