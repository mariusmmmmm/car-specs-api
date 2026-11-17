import { Hono } from "hono";
import type { Env } from "../types";
import { problem } from "../lib/response";

export const exportRoute = new Hono<{ Bindings: Env }>();

// Exists per the contract (BIZ-L2a §2, x-phase1-gated in openapi.yaml) and
// stays 403. It used to point the caller at a licensed export; T1196
// withdrew that offer (Part B of the terms is gone), so the answer no longer
// names a product we do not sell. The endpoint is kept because a straight
// 403 is a better answer to „give me everything" than a 404.
exportRoute.get("/", (c) => {
  const { body, status, headers } = problem(
    403,
    "Forbidden",
    "Bulk data is not served through the API, and bulk access is not licensed. Single records are available per request with x402, or through the Apify Actor — see https://cars-data.com/en/api/for-ai-agents.",
  );
  return c.json(body, status, headers);
});
