import type { Context, Next } from "hono";
import type { Env, Variables } from "../types";
import { sha256Hex } from "../lib/apikey";
import { problem } from "../lib/response";
import { checkAndConsume } from "../lib/quota";

export async function requireApiKey(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const key = c.req.header("X-Api-Key");
  if (!key) {
    const { body, status, headers } = problem(
      401,
      "Unauthorized",
      "Missing X-Api-Key header. Get a free key: POST /v1/keys.",
    );
    return c.json(body, status, headers);
  }

  const keyHash = await sha256Hex(key);
  const recordRaw = await c.env.API_KEYS.get(`key:${keyHash}`);
  if (!recordRaw) {
    const { body, status, headers } = problem(401, "Unauthorized", "Invalid API key.");
    return c.json(body, status, headers);
  }
  const record = JSON.parse(recordRaw);

  const result = await checkAndConsume(c.env.API_KEYS, keyHash, record.plan);
  if (!result.ok) {
    const { body, status, headers } = problem(
      429,
      "Too Many Requests",
      result.reason === "quota"
        ? "Monthly quota exceeded. See pricing at https://cars-data.com/api."
        : "Rate limit exceeded — slow down and retry shortly.",
    );
    return c.json(body, status, headers);
  }

  c.set("apiKeyHash", keyHash);
  c.set("apiKeyRecord", record);
  await next();
}
