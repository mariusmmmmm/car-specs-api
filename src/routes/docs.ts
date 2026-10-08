import { Hono } from "hono";
import type { Env, Variables } from "../types";
import spec from "../../openapi.json";

/**
 * The public API reference: the spec itself, and a page that renders it.
 *
 * Mounted BEFORE `requireApiKey` on purpose. A reference behind an API key is
 * a door that opens only for people who already came in — and the first thing
 * someone needs the docs for is finding out how to get a key.
 *
 * The spec is served as JSON rather than YAML because a Worker cannot parse
 * YAML without carrying a parser it has no other use for; `openapi.json` is
 * generated from `openapi.yaml` by scripts/build-openapi-json.mjs, and
 * lib/openapi-sync.test.ts fails if the two drift from each other OR from the
 * routes this Worker actually mounts. That last check is the point: the
 * previous attempt at these docs (T29) sat on a branch for five days while the
 * Worker moved on under it, and ended up describing a key-issuing flow that
 * T111 had already deleted.
 *
 * Scalar is loaded from a CDN rather than bundled: the Worker ships on every
 * deploy and there is no reason to carry a documentation UI in it.
 */
export const docs = new Hono<{ Bindings: Env; Variables: Variables }>();

docs.get("/openapi.json", (c) =>
  c.json(spec as unknown as Record<string, unknown>, 200, {
    "Cache-Control": "public, max-age=3600",
    // A spec nobody can fetch from a browser is a spec nobody reads.
    "Access-Control-Allow-Origin": "*",
  }),
);

docs.get("/docs", (c) =>
  c.html(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>cars-data.com API reference</title>
    <meta name="description" content="REST API for car specifications: brands, models, generations, variants and their specs, in 20 languages. Self-serve demo key over 40 cars; the full catalogue is a licensed export." />
    <link rel="canonical" href="https://api.cars-data.com/v1/docs" />
  </head>
  <body>
    <script id="api-reference" data-url="/v1/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`,
    200,
    { "Cache-Control": "public, max-age=3600" },
  ),
);
