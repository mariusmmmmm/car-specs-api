import postgres from "postgres";
import type { Env } from "../types";

// One Hyperdrive connection string -> one postgres.js client per request.
// Workers are stateless per-request; postgres.js pools internally and
// Hyperdrive provides the actual connection pooling/caching in front of it.
export function getDb(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
  });
}
