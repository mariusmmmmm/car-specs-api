import { Hono } from "hono";
import type { Env } from "./types";
import { v1 } from "./routes/v1";
import { problem } from "./lib/response";
import { CarsDataMCP } from "./mcp";
import { authenticate, readApiKey } from "./lib/auth-key";
import { checkAnonDemoRate } from "./lib/quota";
import { ipHash, recordMcpThrottled } from "./lib/usage";
import { mcpMethodGate } from "./lib/mcp-method-gate";
import { isDemoScope } from "./lib/mcp-source";
import type { McpProps } from "./types";

export { CarsDataMCP };

const app = new Hono<{ Bindings: Env }>();

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      // Probes that cannot carry a JSON-RPC call (see lib/mcp-method-gate.ts —
      // it lives there because this file cannot be imported by a test).
      const gated = mcpMethodGate(request.method);
      if (gated) return gated;
      // MCP needs an API key like REST (T73, owner decision 2026-10-02). It
      // used to be anonymous with a per-IP minute limit, which put no ceiling
      // on what one machine could pull. Same gate, same quota as REST; the key
      // comes as X-Api-Key or Authorization: Bearer (what MCP clients send).
      const iph = await ipHash(request.headers.get("cf-connecting-ip") ?? "unknown", env.IP_HASH_SALT);
      const presented = readApiKey(request.headers, url);

      // NO KEY AT ALL → the demo scope, anonymously (T111 D9). Scoped to the
      // 40-car blob and answered without a database connection, so T73's
      // reason for demanding a key here — "no ceiling on what one machine
      // could pull" — is structurally satisfied instead of enforced.
      //
      // A key that is PRESENT but invalid, unapproved, revoked or over quota
      // still gets its 401/403/429. Quietly downgrading such a caller to the
      // demo would hide a revoked key behind working-looking answers, which is
      // the worst of both: they think they have access and we think we stopped
      // them.
      if (!presented) {
        const gate = await checkAnonDemoRate(env.API_KEYS, iph);
        if (!gate.ok) {
          recordMcpThrottled(env, iph, "quota");
          const { body, status, headers } = gate.reason === "rate"
            // Does NOT offer a key as the remedy. It used to ("a free key
            // raises it"), and that was wrong twice over after T165: there is
            // no free tier any more, and a demo key is the SAME 40-car scope
            // at a LOWER per-minute ceiling (10 vs 20 here) — so the advice
            // sent an agent to a form to get slower.
            ? problem(429, "Too Many Requests", "Too many anonymous demo requests from this network this minute — retry shortly. This surface covers a fixed 40-car demo set; the full catalogue is a licensed export: https://cars-data.com/en/api")
            : problem(503, "Service Unavailable", "Request metering is temporarily unavailable. Retry shortly.");
          return new Response(JSON.stringify(body), { status, headers: { ...headers, "Retry-After": "60" } });
        }
        const props: McpProps = {
          ipHash: iph,
          ua: request.headers.get("user-agent") ?? undefined,
          demo: isDemoScope(null),
        };
        (ctx as ExecutionContext & { props?: McpProps }).props = props;
        return CarsDataMCP.serve("/mcp").fetch(request, env, ctx);
      }

      const auth = await authenticate(env, presented);
      if (!auth.ok) {
        // 503 is a metering outage on OUR side, not a throttle on theirs — it
        // must not be recorded as "quota", or the MCP throttle metric counts
        // our own failures as abuse by the caller.
        recordMcpThrottled(env, iph,
          auth.status === 429 ? "quota" : auth.status === 503 ? "unavailable" : "unauthorized");
        const titles = {
          401: "Unauthorized", 403: "Forbidden",
          429: "Too Many Requests", 503: "Service Unavailable",
        } as const;
        const { body, status, headers } = problem(auth.status, titles[auth.status], auth.detail);
        const h: Record<string, string> = { ...headers };
        if (auth.status === 401) h["WWW-Authenticate"] = 'Bearer realm="cars-data.com API"';
        if (auth.status === 503) h["Retry-After"] = "30";
        return new Response(JSON.stringify(body), { status, headers: h });
      }
      // Carry the hashed IP + UA + key prefix into the McpAgent DO via
      // ctx.props so per-tool-call telemetry can attribute a call without the
      // raw IP or key ever crossing into the DO.
      //
      // `demo` is carried too, and it is NOT telemetry (T165). Until it was,
      // the demo scope held on /v1 and on anonymous /mcp but had a hole
      // exactly here: props were built without it for ANY authenticated key,
      // so sourceFor() fell through to dbSource() and a demo-plan key — the
      // one thing anyone can self-issue from a form — reached the whole
      // catalogue through search_cars/filter_cars/get_specs. The REST side
      // dispatches on the same fact (routes/v1.ts: plan === "demo" → the
      // blob); this is that dispatch, for the other surface.
      //
      // It is also what the quota table already assumes: demo is 2.000/day,
      // ~10x free, and lib/quota.ts says in writing that this is safe because
      // "a demo key can only ever resolve the 40 variants". That sentence was
      // false on /mcp.
      const props: McpProps = {
        ipHash: iph,
        ua: request.headers.get("user-agent") ?? undefined,
        keyPrefix: auth.keyHash.slice(0, 8),
        demo: isDemoScope(auth.record),
      };
      (ctx as ExecutionContext & { props?: McpProps }).props = props;
      return CarsDataMCP.serve("/mcp").fetch(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
};
