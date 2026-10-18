# cars-data.com — Car Specs API + MCP server

REST API and remote MCP server over cars-data.com's multilingual vehicle-specs
database: **103,372 vehicle variants**, **1,357 models**, **5,428 generations**,
**232 spec types defined** (230 present in the data), in **20 languages**
(including Arabic, RTL).

- REST API: `https://api.cars-data.com/v1`
- MCP server (streamable HTTP): `https://api.cars-data.com/mcp`
- API reference: <https://api.cars-data.com/v1/docs> — the spec itself at `/v1/openapi.json`, both public, no key
- OpenAPI source of truth: [`openapi.yaml`](./openapi.yaml) (`openapi.json` is generated — `npm run openapi:build`)
- Also distributed as an [Apify Actor](https://apify.com/carsdatacom/car-specs-api) (pay-per-event, no API key needed)

## MCP server

Connect directly from Claude, ChatGPT connectors, Cursor, or Windsurf:

```json
{
  "mcpServers": {
    "cars-data": {
      "type": "http",
      "url": "https://api.cars-data.com/mcp",
      "headers": { "Authorization": "Bearer cd_demo_..." }
    }
  }
}
```

Tools exposed:

| Tool | What it does |
|---|---|
| `search_cars` | Free-text search across 103,372 variants, 120 brands, 20 languages |
| `get_specs` | Full localized specs for one variant — 232 spec types across 21 categories (safety, comfort/interior, engine & fuel, performance, EV/hybrid, chassis, exterior, dimensions & weights, WLTP/NEDC consumption, and more), with a confidence score and `last_synced_at` freshness timestamp |
| `compare_variants` | Side-by-side localized specs for 2-4 variants |
| `list_generations` | Generations/facelifts of a model, with production years |
| `filter_cars` | Structured filter: fuel, body, drive, power/price range, year, EV-only |
| `get_images` | Image URLs (own CDN) for a vehicle variant |
| `search_catalogue` · `filter_catalogue` · `get_specs_full` · `compare_full` | The same four operations over the **full** catalogue, paid per call with x402 (T216, T334); every demo answer names its paid pair in `full_catalogue` |

Every tool declares an `outputSchema` and is annotated read-only. A successful call returns the result as `structuredContent` and, for clients without structured output, the same object serialized in the text block. Lists come wrapped as `{ "data": [...] }` — the shape the REST envelope uses; until 2026-10 `search_cars`, `list_generations` and `get_images` returned a bare array. Errors are `isError: true` with `{ "error": "..." }` and no `structuredContent`.

Without a key the MCP server answers anonymously **on the demo scope** — the same 40 cars, rate-limited per IP. With a key it answers on that key's tier: send it as `Authorization: Bearer <key>` or `X-Api-Key`, or, where a client takes only a URL (claude.ai and ChatGPT custom connectors), as `https://api.cars-data.com/mcp?key=<key>`. A key that is present but invalid, revoked or over quota gets its 401/403/429 — it is never quietly downgraded to the demo.

## REST API

Base URL: `https://api.cars-data.com/v1`. Rendered reference at
[`/v1/docs`](https://api.cars-data.com/v1/docs); the spec is at `/v1/openapi.json`.
Both are public — a reference behind an API key only opens for people who already got in.

```bash
curl 'https://api.cars-data.com/v1/variants/v_1a2b3c4d/specs?locale=de' \
  -H "X-Api-Key: cd_demo_..."
```

Ids are **opaque tokens**, not integers — `v_…` variant, `g_…` generation,
`m_…` model, `c_…` pagination cursor — and they are domain-separated, so a
variant token is refused where a model token is expected. Only the `apify`
plan receives raw integer ids, because the published Actor's input schema
declares `variantId` as an integer.

| Endpoint | Description |
|---|---|
| `GET /brands`, `/brands/{slug}`, `/brands/{slug}/models` | Catalog: brands and models |
| `GET /models/{id}/generations` | Generations for a model |
| `GET /generations/{id}/variants` | Variants for a generation |
| `GET /variants`, `/variants/{id}` | Filterable variant listing / single variant |
| `GET /variants/{id}/specs?locale=` | Full localized specs (232 types defined, 230 present; 20 languages) |
| `GET /variants/{id}/images` | Image URLs |
| `GET /variants/{id}/prices` | Price snapshot (single point-in-time, not a history) |
| `GET /search?q=` | Free-text search |
| `GET /compare?ids=` | Side-by-side specs for 2-4 variants |
| `GET /specs/catalog` | The full spec-type catalog (categories + counts) |
| `GET /usage` | Self-check current quota usage for your key |
| `GET /export` | Always 403 — bulk data is licensed, not served |
| `GET /demo` | The whole 40-car demo set in one call (demo keys) |
| `GET /health` | Liveness + active variant count — no key |
| `GET /docs`, `GET /openapi.json` | The reference and the spec — no key |

### Request a demo key

Self-serve and immediate — nothing is reviewed. Post the form (every field is
required), click the link in the email, and the key is active. The response to
the POST is `202 verification_sent`; **no key exists until the click**.

```bash
curl -X POST https://api.cars-data.com/v1/keys \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "name": "Your Name", "company": "Your company", "website": "https://example.com", "role": "Developer", "use_case": "What you are building, in a sentence or two", "accept_tos": true}'
```

Limits: 5 requests per IP per day, one key per email address, and the domain
must have an MX record. `POST /v1/keys` is an alias of `POST /v1/keys/demo` so
copied curl lines keep working — it does **not** issue a reviewed key; that tier
no longer exists.

The issued key covers the 40-car demo set with every spec, every image and all
20 languages. Bulk data is licensed separately: <https://cars-data.com/en/api>.

### Key administration (owner)

`node scripts/keys-admin.mjs keys | grant <email> <demo|apify> | approve-key <prefix> | revoke-key <prefix>`
— needs the `ADMIN_TOKEN` Worker secret (also in `../.secrets/api-admin.env`).
The `/v1/admin` surface answers 404 without that secret, and is deliberately
absent from the published OpenAPI spec. The old `requests / approve / reject`
review commands are gone: nothing creates a request record any more.
Worker secrets for the flow: `ADMIN_TOKEN`, `BREVO_API_KEY`, `NOTIFY_TO`, `NOTIFY_FROM`.

## Three ways in

There is **no free tier**. Two ways take a key; the third takes a payment.

- **Demo** — self-serve, free, 40 cars (5 brands x 2 models x 2 generations x 2
  variants, all 10 fuel types) with every spec, every image and all 20
  languages. Issued automatically on an email click.

  It cannot reach the catalogue, and that is structural rather than a quota: a
  request carrying a demo key is dispatched — before any catalogue route runs —
  into `src/routes/demo.ts`, which answers entirely from a pre-rendered blob in
  Workers KV. That module and `src/lib/demo-set.ts` contain **zero** references
  to Hyperdrive or Postgres, so there is no code path from a demo request to a
  database connection. A leaked demo key cannot walk the catalogue, no matter
  how many requests it makes.

- **Paid** — arranged by hand, no instant checkout:
  - the [Apify Actor](https://apify.com/carsdatacom/car-specs-api) — the same
    four operations over the full catalogue, metered and billed per event by
    Apify; its prices are set by hand in the Apify Console and published on its
    Store page, so they are not quoted here. (The owner decided on 2026-10-16
    that they should equal the x402 prices below — one row of data, one price,
    whichever door. The Console refuses any price change before 2026-10-23, so
    until then they do not, and nothing here claims they do. T335.);
  - a **licensed data export** — the modules you need as CSV and JSON, with a
    field dictionary, a per-field coverage sheet and an optional update
    subscription. Module list, prices and terms are published on
    <https://cars-data.com/en/api>; nothing is quoted here that is not on that
    page.

- **Pay per request, x402 (T216, T334)** — no key, no account. `GET /v1/variants/:id/specs`
  ($0.05), `GET /v1/search` ($0.005), `GET /v1/variants` ($0.005, the filter) and
  `GET /v1/compare` ($0.10 flat) answer a keyless caller `402` with the
  price; an x402 client pays in USDC on Base and retries. Only a successful
  response is settled. MCP has the same four as paid tools. **Live on Base
  mainnet since 2026-10-11 (T231)**, settled through the PayAI facilitator; the
  switch is `X402_PAY_TO` in `wrangler.toml` — remove it and those routes
  answer `401` like every other (`src/lib/x402-config.ts`).

## Data & attribution

Data comes from cars-data.com's multilingual vehicle-specs database. See
[cars-data.com/en/api/terms](https://cars-data.com/en/api/terms) for the API Terms
of Service (attribution required; no bulk extraction / resale).

## License

The API and its documentation in this repository are provided as-is. Access
to the underlying dataset is governed by the [API Terms of Service](https://cars-data.com/en/api/terms),
not an open-source license — this repo documents and hosts the server
implementation, not a redistributable dataset.
