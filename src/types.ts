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
  // T77: key requests are also written to cars-data.com's contact_messages
  // (the one table the daily inbox agent reads) via POST /api/inbox/ingest.
  // INBOX_INGEST_TOKEN is a secret; INBOX_INGEST_URL defaults to production.
  INBOX_INGEST_TOKEN?: string;
  INBOX_INGEST_URL?: string;
  // T111: the key that turns `variants.public_id` into an opaque token
  // (lib/public-id.ts). Optional in the TYPE only because every other secret
  // here is — the code does NOT degrade: a missing ID_TOKEN_KEY throws
  // MissingIdSecret rather than minting tokens from a built-in default, which
  // would make every one of them guessable.
  ID_TOKEN_KEY?: string;
};

// Props carried from the /mcp entrypoint (index.ts) into the McpAgent Durable
// Object via ctx.props — the connecting IP is hashed there and never crosses
// as a raw value.
export type McpProps = {
  ipHash?: string;
  ua?: string;
  /** First 8 hex chars of the authenticated key's hash — telemetry actor. */
  keyPrefix?: string;
  /** True for an anonymous caller on the demo scope (T111 D9). No key, no
   *  database connection: the tools are answered from the pre-rendered blob. */
  demo?: boolean;
  /** Locale the blob should be read in, when `demo`. */
  locale?: string;
};

export type Variables = {
  apiKeyHash: string;
  apiKeyRecord: KeyRecord;
};
