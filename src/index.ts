import { Hono } from "hono";
import type { Env } from "./types";
import { v1 } from "./routes/v1";
import { problem } from "./lib/response";
import { CarsDataMCP } from "./mcp";
import { authenticate, readApiKey } from "./lib/auth-key";
import { ipHash, recordMcpThrottled } from "./lib/usage";
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
      // MCP needs an API key like REST (T73, owner decision 2026-10-02). It
      // used to be anonymous with a per-IP minute limit, which put no ceiling
      // on what one machine could pull. Same gate, same quota as REST; the key
      // comes as X-Api-Key or Authorization: Bearer (what MCP clients send).
      const iph = await ipHash(request.headers.get("cf-connecting-ip") ?? "unknown", env.IP_HASH_SALT);
      const auth = await authenticate(env, readApiKey(request.headers, url));
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
      const props: McpProps = {
        ipHash: iph,
        ua: request.headers.get("user-agent") ?? undefined,
        keyPrefix: auth.keyHash.slice(0, 8),
      };
      (ctx as ExecutionContext & { props?: McpProps }).props = props;
      return CarsDataMCP.serve("/mcp").fetch(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
};
