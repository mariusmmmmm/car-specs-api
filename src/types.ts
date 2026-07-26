import type { KeyRecord } from "./lib/apikey";

export type Env = {
  HYPERDRIVE: Hyperdrive;
  API_KEYS: KVNamespace;
  ENVIRONMENT: string;
  X402_ENABLED: string;
};

export type Variables = {
  apiKeyHash: string;
  apiKeyRecord: KeyRecord;
};
