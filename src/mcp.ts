import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Env, McpProps } from "./types";
import { recordMcpCall } from "./lib/usage";
import { sourceFor, type McpSource } from "./lib/mcp-source";
import { decodeId } from "./lib/public-id";
import { encodeTree } from "./middleware/opaque-ids";
import { readX402Config } from "./lib/x402-config";
import { getDb } from "./lib/db";
import { filterVariants, searchVariants } from "./lib/queries";
import { localizeVariantSpecs } from "./lib/localize-variant";
import { registerDemoTools, registerPaidTools, type ToolContext, type Tokenized } from "./mcp-tools";

// Thin MCP wrapper over the same /v1 read-model (lib/queries.ts, lib/localize-variant.ts)
// — no separate query logic, per BIZ-L2b-mcp-apify-distribution.md §1.
//
// Two kinds of caller reach it (T111):
//   * a key holder, authenticated in index.ts with the same gate as REST (T73);
//   * an ANONYMOUS caller on the demo scope, which gets a source backed by the
//     pre-rendered blob and no database connection at all.
//
// Anonymous access reverses T73's "MCP needs a key", and only because T73's
// reason no longer applies: it required one because anonymous MCP "put no
// ceiling on what one machine could pull". A surface that can only return 40
// cars has that ceiling built in. What it buys is measured — since T73 shipped,
// MCP calls fell to 0 and `mcp-throttled` rose to 1.009 in a day, all
// `unauthorized`, from 20+ directory probes. Every directory and agent that
// tried the server learned it does not work.
//
// Ids on this surface are OPAQUE, like everywhere else. Until 2026-10-05 the
// tools took `variant_id: number` and handed back raw `public_id` values, which
// put /mcp outside the id gate entirely — the REST surface could have been
// sealed and the catalogue still walkable through here.
export class CarsDataMCP extends McpAgent<Env> {
  server = new McpServer({ name: "cars-data-specs", version: "1.0.0" });

  // One usage datapoint per tool call (BIZ-D7 §5). client = the MCP client's
  // self-reported clientInfo.name from the initialize handshake (distinguishes
  // Claude Desktop / Cursor / ChatGPT connectors / custom agents), falling back
  // to the User-Agent carried in props; actor = the salted IP hash from props.
  private track(tool: string, locale?: string): void {
    const props = this.props as McpProps;
    const client =
      (this.server as McpServer).server.getClientVersion?.()?.name ?? props.ua ?? "-";
    recordMcpCall(
      this.env,
      props.demo ? `${tool}:demo` : tool,
      locale ?? "-",
      client,
      props.keyPrefix ?? props.ipHash ?? "-",
    );
  }

  /** The data source for this call: the blob for an anonymous demo caller, the
   *  database for a key holder. null means the demo blob is not there. */
  private source(locale?: string): Promise<McpSource | null> {
    const props = this.props as McpProps;
    return sourceFor(this.env, { ...props, locale: locale ?? props.locale ?? "en" });
  }

  /** Every id out of this surface is a token. One field table, shared with the
   *  REST gate (middleware/opaque-ids.ts), so the two cannot disagree. */
  private encode(value: unknown): Promise<unknown> {
    return encodeTree(this.env.ID_TOKEN_KEY, value);
  }

  private token(kind: "variant" | "model", raw: string): Promise<number | null> {
    return decodeId(this.env.ID_TOKEN_KEY, kind, raw);
  }

  async init() {
    // The tools themselves live in mcp-tools.ts (T286), where a test can run
    // tools/list and call them; this class only supplies what is per-Worker.
    const ctx: ToolContext = {
      track: (tool, locale) => this.track(tool, locale),
      source: (locale) => this.source(locale),
      encode: <T>(value: T) => this.encode(value) as Promise<Tokenized<T>>,
      token: (kind, raw) => this.token(kind, raw),
    };
    // Paid tools exist only when x402 is configured (T216). Unset X402_PAY_TO
    // and this surface is byte-for-byte the demo one — the demo tools then
    // name the other two doors, not a paid tool that is not there (T334).
    const x402 = readX402Config(this.env);
    registerDemoTools(this.server, ctx, x402);

    if (x402) {
      registerPaidTools(this.server, x402, ctx, {
        search: (locale, query, limit) => searchVariants(getDb(this.env), locale, query, limit, 0),
        specs: (locale, id) => localizeVariantSpecs(getDb(this.env), locale, id),
        filter: (locale, f) => filterVariants(getDb(this.env), locale, f),
      });
    }
  }
}
