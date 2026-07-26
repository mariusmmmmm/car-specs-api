import { Hono } from "hono";
import type { Env } from "./types";
import { v1 } from "./routes/v1";
import { problem } from "./lib/response";
import { CarsDataMCP } from "./mcp";
import { checkAnonRate } from "./lib/anon-quota";

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
      const allowed = await checkAnonRate(env.API_KEYS, ip);
      if (!allowed) {
        const { body, status, headers } = problem(
          429,
          "Too Many Requests",
          "MCP anonymous rate limit exceeded (20/min).",
        );
        return new Response(JSON.stringify(body), { status, headers: headers as HeadersInit });
      }
      return CarsDataMCP.serve("/mcp").fetch(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
};
