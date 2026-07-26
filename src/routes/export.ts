import { Hono } from "hono";
import type { Env } from "../types";
import { problem } from "../lib/response";

export const exportRoute = new Hono<{ Bindings: Env }>();

// Exists per the contract (BIZ-L2a §2, x-phase1-gated in openapi.yaml) but
// stays 403 until L0 clean provenance clears — do not lift this without a
// legal review pass beyond the Phase-1 ToS. See specs/plans/BIZ-L0-*.
exportRoute.get("/", (c) => {
  const { body, status, headers } = problem(
    403,
    "Forbidden",
    "Bulk/export is gated pending L0 clean-sourcing provenance. See https://cars-data.com/api/terms.",
  );
  return c.json(body, status, headers);
});
