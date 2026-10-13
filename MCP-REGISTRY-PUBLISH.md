# Publishing the MCP server to registries

Goal: get `com.cars-data/car-specs-api` into the **official MCP registry** (and,
by extension, the directories that mirror it — Smithery, Glama, PulseMCP,
mcp.so). This is how humans/agents *discover* the server and then connect it —
models do not auto-discover MCP endpoints from the open web.

The manifest is [`server.json`](./server.json). **It is generated, not edited** —
`src/lib/server-manifest.ts` is the source, `npm run server:build` writes the file,
and `test/server-json.test.ts` fails the suite if the two disagree or if the
registry would refuse the result.

> **Publish from the branch that is LIVE, and only after `npm run server:check`.**
> `server.json` differs between branches. On 2026-10-12 the main checkout sat on
> `feat/t29-api-docs` carrying **1.0.2** — publishing from there re-uploads the
> manifest that declares a key mandatory, which is the whole defect this file is
> about. `npm run server:check` is what stands between you and that mistake.

### What actually blocked 1.0.3 for eight days (T251, 2026-10-12)

This section used to say the publish needed credentials an agent could not have.
That was wrong, and the wrongness cost the listing eight days.

The credentials were already in place — the `v=MCPv1` TXT record has been on the
apex since July, `mcp-registry-key.pem` is in `.secrets/`, `mcp-publisher` is
installed, and **1.0.2 was published on 2026-10-04 from exactly that setup.**

The real blocker was the schema: `description` has a `maxLength` of **100**, and
the 1.0.3 draft was **106** characters. The registry would have refused it. A
schema violation was filed as a credentials problem, so nobody re-ran it — and
every mirror went on telling agents a manually-reviewed key was mandatory.

Both failure modes are now tests, not surprises, and the length check runs again
inside `build-server-json.mjs` immediately before a publish.

## Prerequisites (do these first)
1. **Deploy the promo page first.** `server.json`'s `websiteUrl` points at
   `https://cars-data.com/en/api/for-ai-agents`; publish the listing only after
   that page is live, so the link resolves.
2. **Confirm the MCP endpoint answers.** `https://api.cars-data.com/mcp` must be
   reachable (streamable HTTP). The check below is a real handshake, because a
   HEAD probe cannot tell a routed endpoint from a missing one:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.cars-data.com/mcp \
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}'
   ```

   `200` means it is routed AND speaks MCP — and since 2026-10-06 it means that
   **without a key**, because an anonymous caller gets the 40-car demo. A
   Cloudflare `403`/`1xxx` means the WAF is blocking it: fix before listing, per
   the 2026-07-13 lesson.

   The old check here was `curl -sI` (a HEAD) expecting `200`/`405`/`406`. HEAD
   returned **404** until 2026-10-06 — so following this file would have
   concluded the endpoint was broken while it was answering POSTs perfectly.
   HEAD now returns `405` with `Allow: POST, OPTIONS`, which is honest, but the
   handshake above is the check that proves something.

---
## OWNER STEPS (need credentials — agent cannot run these)

### 1. Install the publisher CLI
```bash
brew install mcp-publisher     # or: download the latest release binary from
                               # github.com/modelcontextprotocol/registry/releases
```

### 2. Authenticate — pick ONE namespace

**Option A — domain namespace `com.cars-data/*`.** This is what we use, and it
is **already set up**: the keypair is `.secrets/mcp-registry-key.pem` and its
TXT record has been on the apex since July. Nothing below needs redoing.

```bash
KEY=../.secrets/mcp-registry-key.pem     # from api/ or any api-wt-* worktree

# Confirm the key on disk is the one the apex publishes, BEFORE trusting a login.
# These two must be byte-identical:
openssl pkey -in "$KEY" -pubout -outform DER | tail -c 32 | base64
dig +short TXT cars-data.com | tr -d '"' | grep v=MCPv1 | sed 's/.*p=//'

mcp-publisher login dns --domain cars-data.com \
  --private-key "$(openssl pkey -in "$KEY" -outform DER | tail -c 32 | xxd -p -c 64)"
```

> **`--private-key` takes the 32-byte seed as hex, not a path.** This file said
> `--private-key-file <path>` until 2026-10-12; that flag does not exist in the
> installed CLI, which rejects it with `flag provided but not defined`. If you
> hit that, the command is stale, not your key.

Only if the key is ever lost: `openssl genpkey -algorithm Ed25519 -out
mcp-registry-key.pem`, publish `v=MCPv1; k=ed25519; p=<pubkey base64>` as a TXT
record on the apex (Cloudflare DNS → `@`), wait for `dig +short TXT
cars-data.com` to show it, then log in as above. The key is the publish
credential — it stays in `.secrets/`, which is gitignored.

**Option B (fastest fallback) — GitHub namespace.** If you'd rather skip DNS,
change `server.json`'s `name` to `io.github.mariusmmmmm/car-specs-api` (the repo
owner), then:
```bash
mcp-publisher login github     # opens a device-code login for the mariusmmmmm account
```

### 3. Publish
```bash
npm run server:check           # REFUSES a stale or over-length manifest. Not optional.
mcp-publisher publish          # reads ./server.json, prints the stored metadata on success
```
A version number is spent the moment the registry accepts it and can never be
reused, so the check comes first. Versions served so far: 1.0.0, 1.0.1, 1.0.2.
**1.0.3 is burned deliberately** — it exists in git, with different content, and
was never published; 1.0.4 is the next number.
Verify it's live:
```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=cars-data" | jq .
```

### 4. Smithery + other directories
- Most directories (Glama, PulseMCP, mcp.so) **auto-index the official registry** —
  once step 3 succeeds they pick it up with no extra action.
- **Smithery**: if you want an explicit listing sooner, add it via
  `smithery.ai` → *Add Server* → paste the remote URL
  `https://api.cars-data.com/mcp` + the GitHub repo. Smithery lists remote
  servers by URL; no code change to this repo is required.

### 5. After it's listed
- Add the registry badge/link to the GitHub repo README and to the promo page's
  "Built to be read by machines" section (currently it says the MCP endpoint
  exists; upgrade the copy to "listed on the official MCP registry as
  `com.cars-data/car-specs-api`" — only after it's actually live, verify first).
- Re-publish (`mcp-publisher publish`) whenever `server.json` changes (new
  version, description, etc.).

## Keeping metadata in sync
- Coverage numbers come from `src/lib/catalogue-facts.ts` and nowhere else —
  that is why `server.json` is generated. Do not copy a number out of
  `llms.txt`, the README or this file; all three have been stale before. The
  figures are true only after `npm run verify:catalogue` (which reads
  `cars_prod`, not the local replica) passes.
- The rate limits shown here and on the promo page must match
  `src/lib/quota.ts`: **20/min** for the anonymous no-key MCP demo
  (`ANON_DEMO_PER_MINUTE`) and **10/min** for an issued demo key
  (`PLAN_QUOTAS.demo.perMinute`). There is no free tier to quote any more
  (D-01, 2026-10-08).
