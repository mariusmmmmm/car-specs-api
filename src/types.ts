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
};

// Props carried from the /mcp entrypoint (index.ts) into the McpAgent Durable
// Object via ctx.props — the connecting IP is hashed there and never crosses
// as a raw value.
export type McpProps = {
  ipHash?: string;
  ua?: string;
};

export type Variables = {
  apiKeyHash: string;
  apiKeyRecord: KeyRecord;
};
