# Publishing the MCP server to registries

Goal: get `com.cars-data/car-specs-api` into the **official MCP registry** (and,
by extension, the directories that mirror it — Smithery, Glama, PulseMCP,
mcp.so). This is how humans/agents *discover* the server and then connect it —
models do not auto-discover MCP endpoints from the open web.

The manifest is [`server.json`](./server.json) (validated against the official
`2025-12-11` schema). Everything below the "OWNER STEPS" line needs the owner's
GitHub/DNS credentials, so it can't be run by an agent — the files are ready;
these are the clicks.

## Prerequisites (do these first)
1. **Deploy the promo page first.** `server.json`'s `websiteUrl` points at
   `https://cars-data.com/en/api/for-ai-agents`; publish the listing only after
   that page is live, so the link resolves.
2. **Confirm the MCP endpoint answers.** `https://api.cars-data.com/mcp` must be
   reachable (streamable HTTP). Quick check:
   `curl -sI -H "Accept: text/event-stream" https://api.cars-data.com/mcp` (a
   `200`/`405`/`406` proves it's routed; a Cloudflare `403`/`1xxx` means the WAF
   is blocking it — fix before listing, per the 2026-07-13 lesson).

---
## OWNER STEPS (need credentials — agent cannot run these)

### 1. Install the publisher CLI
```bash
brew install mcp-publisher     # or: download the latest release binary from
                               # github.com/modelcontextprotocol/registry/releases
```

### 2. Authenticate — pick ONE namespace

**Option A (recommended) — domain namespace `com.cars-data/*`** (branded; matches
`server.json` as written). Proves you own cars-data.com via a DNS TXT record:
```bash
# generate an ed25519 keypair
openssl genpkey -algorithm Ed25519 -out mcp-registry-key.pem

# print the TXT record value to add
echo "v=MCPv1; k=ed25519; p=$(openssl pkey -in mcp-registry-key.pem -pubout -outform DER | tail -c 32 | base64)"
```
Add that as a **TXT record on `cars-data.com`** (Cloudflare DNS → apex `@`),
wait for propagation (`dig +short TXT cars-data.com` shows it), then:
```bash
mcp-publisher login dns --domain cars-data.com --private-key-file mcp-registry-key.pem
```
Keep `mcp-registry-key.pem` out of git (it's the publish credential).

**Option B (fastest fallback) — GitHub namespace.** If you'd rather skip DNS,
change `server.json`'s `name` to `io.github.mariusmmmmm/car-specs-api` (the repo
owner), then:
```bash
mcp-publisher login github     # opens a device-code login for the mariusmmmmm account
```

### 3. Publish
```bash
cd api
mcp-publisher publish          # reads ./server.json, prints the stored metadata on success
```
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
- Coverage numbers in `server.json`/`README.md` mirror the site
  (`cars-data.com/llms.txt`: 102,191 variants / 116 brands / 19 languages).
- The Free-tier rate limit shown here and on the promo page must match
  `src/lib/quota.ts` (`free.perMinute`). Currently **20/min**.
