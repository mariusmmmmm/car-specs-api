import type { KeyRecord } from "./lib/apikey";

export type Env = {
  HYPERDRIVE: Hyperdrive;
  API_KEYS: KVNamespace;
  USAGE: AnalyticsEngineDataset;
  ENVIRONMENT: string;
  X402_ENABLED: string;
  // Secret (wrangler secret put IP_HASH_SALT); .dev.vars for local. Optional so
  // a missing secret degrades to a fixed fallback salt instead of crashing.
  IP_HASH_SALT?: string;
  // Key approval flow (T73). ADMIN_TOKEN and BREVO_API_KEY are secrets
  // (wrangler secret put); NOTIFY_TO / NOTIFY_FROM can be vars or secrets.
  // All optional so a missing one degrades (no email / admin closed) instead
  // of crashing the Worker.
  ADMIN_TOKEN?: string;
  BREVO_API_KEY?: string;
  NOTIFY_TO?: string;
  NOTIFY_FROM?: string;
};

// Props carried from the /mcp entrypoint (index.ts) into the McpAgent Durable
// Object via ctx.props — the connecting IP is hashed there and never crosses
// as a raw value.
export type McpProps = {
  ipHash?: string;
  ua?: string;
  /** First 8 hex chars of the authenticated key's hash — telemetry actor. */
  keyPrefix?: string;
};

export type Variables = {
  apiKeyHash: string;
  apiKeyRecord: KeyRecord;
};
