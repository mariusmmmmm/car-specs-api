# cars-data.com — Car Specs API + MCP server

REST API and remote MCP server over cars-data.com's multilingual vehicle-specs
database: **102,190+ vehicle variants**, **1,300+ models**, **5,299+
generations**, **180 spec types across 19 categories**, in **19 languages**
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
      "url": "https://api.cars-data.com/mcp"
    }
  }
}
```

Tools exposed:

| Tool | What it does |
|---|---|
| `search_cars` | Free-text search across 102k+ variants, 115+ brands, 19 languages |
| `get_specs` | Full localized specs for one variant — 180 spec types across 19 categories (safety, comfort/interior, engine & fuel, performance, EV/hybrid, chassis, exterior, dimensions & weights, WLTP/NEDC consumption, and more), with a confidence score and `last_synced_at` freshness timestamp |
| `compare_variants` | Side-by-side localized specs for 2-4 variants |
| `list_generations` | Generations/facelifts of a model, with production years |
| `filter_cars` | Structured filter: fuel, body, drive, power/price range, year, EV-only |
| `get_images` | Image URLs (own CDN) for a vehicle variant |

The MCP server is unauthenticated for discovery (rate-limited per IP). No signup required to try it.

## REST API

Base URL: `https://api.cars-data.com/v1`. Full reference in [`openapi.yaml`](./openapi.yaml).

```bash
curl https://api.cars-data.com/v1/variants/42164/specs?locale=de \
  -H "X-Api-Key: cd_free_..."
```

| Endpoint | Description |
|---|---|
| `GET /brands`, `/brands/{slug}`, `/brands/{slug}/models` | Catalog: brands and models |
| `GET /models/{id}/generations` | Generations for a model |
| `GET /generations/{id}/variants` | Variants for a generation |
| `GET /variants`, `/variants/{id}` | Filterable variant listing / single variant |
| `GET /variants/{id}/specs?locale=` | Full localized specs (180 types, 19 languages) |
| `GET /variants/{id}/images` | Image URLs |
| `GET /variants/{id}/prices` | Price snapshot (single point-in-time, not a history) |
| `GET /search?q=` | Free-text search |
| `GET /compare?ids=` | Side-by-side specs for 2-4 variants |
| `GET /specs/catalog` | The full spec-type catalog (categories + counts) |
| `GET /usage` | Self-check current quota usage for your key |

### Get a free API key

```bash
curl -X POST https://api.cars-data.com/v1/keys \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "accept_tos": true}'
```

Free tier: 1,000 requests/month, 30 req/min.

## Pricing

- **Free** — 1,000 req/month, instant self-serve key, no payment.
- **Apify** — pay-per-event, billed through the [Apify Store listing](https://apify.com/carsdatacom/car-specs-api), no API key needed.
- **x402** — per-call USDC payment on Base for agents that want to pay without an account (not yet live — see the project roadmap).

There is no subscription/Stripe tier — Free and Apify (and, later, x402) are the only paid paths.

## Data & attribution

Data comes from cars-data.com's multilingual vehicle-specs database. See
[cars-data.com/api/terms](https://cars-data.com/api/terms) for the API Terms
of Service (attribution required on Free tier; no bulk extraction / resale).

## License

The API and its documentation in this repository are provided as-is. Access
to the underlying dataset is governed by the [API Terms of Service](https://cars-data.com/api/terms),
not an open-source license — this repo documents and hosts the server
implementation, not a redistributable dataset.
