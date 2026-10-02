import { Hono } from "hono";
import type { Env } from "./types";
import { v1 } from "./routes/v1";
import { problem } from "./lib/response";
import { CarsDataMCP } from "./mcp";
import { checkAnonRate, ANON_PER_MINUTE, ANON_PER_MONTH } from "./lib/anon-quota";
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
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const iph = await ipHash(ip, env.IP_HASH_SALT);
      const limit = await checkAnonRate(env.API_KEYS, ip);
      if (!limit.ok) {
        recordMcpThrottled(env, iph, limit.reason);
        const { body, status, headers } = problem(
          429,
          "Too Many Requests",
          limit.reason === "month"
            ? `Anonymous MCP access is limited to ${ANON_PER_MONTH} requests per month per IP. For more, use the REST API with a free key or the Apify Actor — see https://cars-data.com/en/api/for-ai-agents. Bulk data: https://cars-data.com/en/api.`
            : `MCP anonymous rate limit exceeded (${ANON_PER_MINUTE}/min).`,
        );
        return new Response(JSON.stringify(body), { status, headers: headers as HeadersInit });
      }
      // Carry the hashed IP + UA into the McpAgent DO via ctx.props (McpAgent
      // reads props from the execution context) so per-tool-call telemetry can
      // attribute a call without the raw IP ever crossing into the DO.
      const props: McpProps = { ipHash: iph, ua: request.headers.get("user-agent") ?? undefined };
      (ctx as ExecutionContext & { props?: McpProps }).props = props;
      return CarsDataMCP.serve("/mcp").fetch(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
};
