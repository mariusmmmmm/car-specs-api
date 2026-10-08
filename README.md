# cars-data.com — Car Specs API + MCP server

REST API and remote MCP server over cars-data.com's multilingual vehicle-specs
database: **103,099 vehicle variants**, **1,300+ models**, **5,395 generations**,
**224 spec types defined** (221 present in the data), in **20 languages**
(including Arabic, RTL).

- REST API: `https://api.cars-data.com/v1`
- MCP server (streamable HTTP): `https://api.cars-data.com/mcp`
- OpenAPI spec: [`openapi.yaml`](./openapi.yaml)
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
| `search_cars` | Free-text search across 103,099 variants, 119 brands, 20 languages |
| `get_specs` | Full localized specs for one variant — 224 spec types across 21 categories (safety, comfort/interior, engine & fuel, performance, EV/hybrid, chassis, exterior, dimensions & weights, WLTP/NEDC consumption, and more), with a confidence score and `last_synced_at` freshness timestamp |
| `compare_variants` | Side-by-side localized specs for 2-4 variants |
| `list_generations` | Generations/facelifts of a model, with production years |
| `filter_cars` | Structured filter: fuel, body, drive, power/price range, year, EV-only |
| `get_images` | Image URLs (own CDN) for a vehicle variant |

The MCP server needs an API key, like the REST API — send it as `Authorization: Bearer <key>` or `X-Api-Key`. Where a client takes only a URL (claude.ai and ChatGPT custom connectors), use `https://api.cars-data.com/mcp?key=<key>`. Calls count against the same monthly quota.

## REST API

Base URL: `https://api.cars-data.com/v1`. Full reference in [`openapi.yaml`](./openapi.yaml).

```bash
curl https://api.cars-data.com/v1/variants/42164/specs?locale=de \
  -H "X-Api-Key: cd_demo_..."
```

| Endpoint | Description |
|---|---|
| `GET /brands`, `/brands/{slug}`, `/brands/{slug}/models` | Catalog: brands and models |
| `GET /models/{id}/generations` | Generations for a model |
| `GET /generations/{id}/variants` | Variants for a generation |
| `GET /variants`, `/variants/{id}` | Filterable variant listing / single variant |
| `GET /variants/{id}/specs?locale=` | Full localized specs (224 types defined, 221 present; 20 languages) |
| `GET /variants/{id}/images` | Image URLs |
| `GET /variants/{id}/prices` | Price snapshot (single point-in-time, not a history) |
| `GET /search?q=` | Free-text search |
| `GET /compare?ids=` | Side-by-side specs for 2-4 variants |
| `GET /specs/catalog` | The full spec-type catalog (categories + counts) |
| `GET /usage` | Self-check current quota usage for your key |

### Request a demo API key

The demo is the only self-serve key, and it is not reviewed. Send a request;
click the link in the email and the key is emailed to you.

```bash
curl -X POST https://api.cars-data.com/v1/keys \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "name": "Your Name", "company": "Your company", "website": "https://example.com", "role": "Developer", "use_case": "What you are building, in a sentence or two", "accept_tos": true}'
```

Returns `202 verification_sent`. The key covers the 40-car demo set, 20 req/min,
attribution required. Bulk data is licensed separately: https://cars-data.com/en/api.

### Key administration (owner)

`node scripts/keys-admin.mjs keys | grant <email> <demo|apify> | approve-key <prefix> | revoke-key <prefix>`
— needs the `ADMIN_TOKEN` Worker secret (also in `../.secrets/api-admin.env`).
Worker secrets for the flow: `ADMIN_TOKEN`, `BREVO_API_KEY`, `NOTIFY_TO`, `NOTIFY_FROM`.

## Pricing

- **Demo** — 40 cars with every spec and photo, 20 languages. Issued automatically on an email click. The ONLY self-serve tier: nothing reaches the full catalogue without a licence.
- **Apify** — pay-per-event, billed through the [Apify Store listing](https://apify.com/carsdatacom/car-specs-api), no API key needed.
- **x402** — per-call USDC payment on Base for agents that want to pay without an account (not yet live — see the project roadmap).

There is no subscription/Stripe tier, and no free tier: Apify (and, later, x402) is the paid path, and the demo is the only thing issued without one.

## Data & attribution

Data comes from cars-data.com's multilingual vehicle-specs database. See
[cars-data.com/en/api/terms](https://cars-data.com/en/api/terms) for the API Terms
of Service (attribution required; no bulk extraction / resale).

## License

The API and its documentation in this repository are provided as-is. Access
to the underlying dataset is governed by the [API Terms of Service](https://cars-data.com/en/api/terms),
not an open-source license — this repo documents and hosts the server
implementation, not a redistributable dataset.
