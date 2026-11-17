import type { KeyRecord } from "./lib/apikey";

export type Env = {
  HYPERDRIVE: Hyperdrive;
  API_KEYS: KVNamespace;
  // T1194 — contorul de rată ATOMIC (src/rate-counter.ts). Un DO per (uşă, identitate),
  // single-threaded, deci read-modify-write-ul e serializat; KV-ul de deasupra ţine în
  // continuare lunarul, zilnicul şi plafonul global.
  //
  // NU e opţional, şi asta e deliberat: fail-closed înseamnă că fără contor nu servim,
  // iar un binding opţional ar fi invitat exact ramura „dacă lipseşte, lasă să treacă"
  // pe care T79 a venit să o scoată. `MCP_OBJECT` nu e aici fiindcă nimic nu-l atinge
  // prin `env` — SDK-ul îl rezolvă singur în `CarsDataMCP.serve()`.
  RATE_COUNTER: DurableObjectNamespace;
  USAGE: AnalyticsEngineDataset;
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

  /**
   * SHA-ul commitului din care s-a construit Worker-ul care rulează — singurul
   * câmp care răspunde „ce rulează ACUM" (T1200, D-75 punctul 2).
   *
   * OPȚIONAL, și absența lui are înțeles: „build-ul nu s-a identificat".
   * `/v1/health` OMITE cheia când lipsește — niciodată `undefined`, `null` sau
   * șir gol, fiindcă un câmp care apare „undefined" arată ca un răspuns.
   *
   * Se setează pe comanda de deploy, nu în acest fișier și nu în `[vars]`:
   *
   *   wrangler deploy --var BUILD_SHA:$(git rev-parse --short=12 HEAD)
   *
   * De ce NU în `[vars]` din wrangler.toml: SHA-ul unui commit nu poate fi scris
   * ÎN acel commit, deci orice valoare din fișier descrie un build anterior și
   * minte exact când conteză.
   *
   * CAPCANA, scrisă chiar în wrangler.toml despre vars: `wrangler deploy`
   * înlocuiește vars-urile Worker-ului cu ce e în fișier, deci un deploy FĂRĂ
   * flagul de mai sus șterge valoarea. Atunci cheia dispare din `/v1/health` —
   * ceea ce e corect (nu știm) și vizibil (lipsește), nu o cifră veche care s-ar
   * da drept proaspătă.
   */
  BUILD_SHA?: string;
  // T216: x402 v2 for callers without a key. ALL optional and all plain vars
  // (an address and a price are not secrets). X402_PAY_TO is the switch:
  // unset, or malformed, means x402 is off — see lib/x402-config.ts.
  X402_PAY_TO?: string;
  X402_NETWORK?: string;
  X402_FACILITATOR_URL?: string;
  X402_PRICE_SPECS_USD?: string;
  X402_PRICE_SEARCH_USD?: string;
};

// Props carried from the /mcp entrypoint (index.ts) into the McpAgent Durable
// Object via ctx.props — the connecting IP is hashed there and never crosses
// as a raw value.
export type McpProps = {
  ipHash?: string;
  ua?: string;
  /** First 8 hex chars of the authenticated key's hash — telemetry actor. */
  keyPrefix?: string;
  /** True when this call is on the demo scope: an anonymous caller (T111 D9)
   *  OR a holder of a `demo`-plan key (T165). Either way the tools are
   *  answered from the pre-rendered blob and no database connection is handed
   *  out. Set in index.ts, the only place a plan is known on this surface;
   *  lib/mcp-source.ts dispatches on it the way routes/v1.ts dispatches on
   *  `plan === "demo"`. */
  demo?: boolean;
  /** Locale the blob should be read in, when `demo`. */
  locale?: string;
};

export type Variables = {
  apiKeyHash: string;
  apiKeyRecord: KeyRecord;
  /** Set by middleware/x402.ts when the payment middleware owns the request.
   *  Downstream of it the payment has verified; there is no key. */
  x402?: boolean;
};
