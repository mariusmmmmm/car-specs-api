import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { getDb } from "../lib/db";
import { envelope } from "../lib/response";
import { catalog } from "./catalog";
import { variants } from "./variants";
import { search } from "./search";
import { compare } from "./compare";
import { docs } from "./docs";
import { keys } from "./keys";
import { usage } from "./usage";
import { exportRoute } from "./export";
import { requireApiKey } from "../middleware/auth";
import { recordRestCall } from "../lib/usage";

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

// Documentation is public: a reference behind an API key only opens for
// people who already got in. Mounted before requireApiKey for that reason.
v1.route("/", docs);

// Documentation is public: a reference behind an API key only opens for
// people who already got in. Mounted before requireApiKey for that reason.
v1.route("/", docs);

// Everything else needs a Free (or later, paid) API key + counts against quota.
const protectedV1 = new Hono<{ Bindings: Env; Variables: Variables }>();
protectedV1.use("*", requireApiKey);
// Usage observability (BIZ-D7 §5): one datapoint per authenticated REST call,
// after the route resolves so routePath is the matched pattern (not "*").
// Runs only for requests that passed auth — rejected 401/429s never reach here.
protectedV1.use("*", async (c, next) => {
  await next();
  recordRestCall(
    c.env,
    c.req.routePath,
    c.req.query("locale") ?? "-",
    c.get("apiKeyRecord")?.plan ?? "-",
    (c.get("apiKeyHash") ?? "").slice(0, 8),
  );
});
protectedV1.route("/", catalog);
protectedV1.route("/variants", variants);
protectedV1.route("/search", search);
protectedV1.route("/compare", compare);
protectedV1.route("/usage", usage);
protectedV1.route("/export", exportRoute);

v1.route("/", protectedV1);
