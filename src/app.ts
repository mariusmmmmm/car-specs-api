import { Hono } from "hono";
import type { Env } from "./types";
import { v1 } from "./routes/v1";
import { problem, jsonCharset } from "./lib/response";

// The routed app lives here, apart from index.ts, for one reason: index.ts
// imports ./mcp, which imports "agents/mcp", which pulls "cloudflare:*" — and
// nothing that does can be imported by a test ("Only URLs with a scheme in:
// file, data, and node are supported by the default ESM loader"). That is why
// lib/mcp-method-gate.ts was already carved out of index.ts. A guard that can
// only reach a hand-assembled copy of the app proves the copy, not the Worker
// (project_guard_scope_blind_spot); test/json-charset.test.ts asserts against
// THIS module, so it sees the real middleware order, the real routes and the
// real notFound/onError.
export const app = new Hono<{ Bindings: Env }>();

// FIRST, so it wraps every route, the demo short-circuit, opaqueIds, notFound
// and onError on the way out (T152 / T144 §2). c.json() emits a bare
// "application/json" and a browser then decodes the em-dashes in our own copy
// with a single-byte fallback.
app.use("*", jsonCharset);

app.route("/v1", v1);

app.notFound((c) => {
  const { body, status, headers } = problem(404, "Not Found", `No route for ${c.req.path}`);
  return c.json(body, status, headers);
});

app.onError((err, c) => {
  console.error(err);
  const { body, status, headers } = problem(500, "Internal Server Error");
  return c.json(body, status, headers);
});
