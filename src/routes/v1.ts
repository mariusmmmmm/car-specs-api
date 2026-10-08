import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { getDb } from "../lib/db";
import { envelope } from "../lib/response";
import { catalog } from "./catalog";
import { variants } from "./variants";
import { search } from "./search";
import { compare } from "./compare";
import { keys } from "./keys";
import { keysDemo } from "./keys-demo";
import { admin } from "./admin";
import { docs } from "./docs";
import { usage } from "./usage";
import { exportRoute } from "./export";
import { requireApiKey } from "../middleware/auth";
import { opaqueIds } from "../middleware/opaque-ids";
import { demo } from "./demo";
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
// Self-serve demo keys, mounted BEFORE /keys so "/keys/demo" is not swallowed
// by the reviewed-request handler. Public by design: the whole point is that
// review leaves the critical path for people who only want to see it answer.
v1.route("/keys/demo", keysDemo);
v1.route("/keys", keys);
// Owner-only, behind ADMIN_TOKEN (404 without it) — not part of the public API.
v1.route("/admin", admin);

// The reference and the spec, public. A door that opens only for people who
// already came in is not documentation — and what a caller without a key most
// needs the docs for is how to get one. Mounted before requireApiKey for that
// reason; keep it there.
v1.route("/", docs);

// Everything below needs a key (demo or paid) and counts against quota. There
// is no free tier: the only self-serve key is the demo above, scoped to 40
// cars; everything else is the Apify Actor or a licensed export.
const protectedV1 = new Hono<{ Bindings: Env; Variables: Variables }>();
protectedV1.use("*", requireApiKey);

// A demo key is answered entirely from the pre-rendered blob in KV and never
// reaches the routes below (T111). Dispatching here, rather than checking a
// scope allowlist inside each route, is what makes the guarantee structural:
// a demo request is never handed a database connection, so there is nothing
// outside the 40-car blob for it to read. A route that forgets to consult an
// allowlist leaks; a route that is never reached cannot.
protectedV1.use("*", async (c, next) => {
  if (c.get("apiKeyRecord")?.plan !== "demo") return next();
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/v1/, "") || "/";
  // No next() — the response is final.
  c.res = await demo.fetch(new Request(url, c.req.raw), c.env);
});

// Internal ids never leave: one gate on the way out instead of one rewrite per
// route, so the next route someone adds cannot forget (T111). Mounted after the
// demo dispatch because routes/demo.ts already hands back tokens.
protectedV1.use("*", opaqueIds);
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
