import { Hono } from "hono";
import type { Env, Variables } from "../types";
import spec from "../../openapi.json";

/**
 * Public API documentation: the spec itself, and a page that renders it.
 *
 * The spec has existed in the repo since the API was built and was served
 * NOWHERE — 606 lines of accurate OpenAPI that no caller could reach. Checked
 * before publishing it, because documentation that disagrees with the code is
 * worse than none: every one of the 15 documented paths is implemented, with
 * the mount prefixes applied (`/variants/{id}` is `/:id` inside variants.ts,
 * mounted at `/variants`). The only implemented route NOT in the spec is
 * POST /v1/keys, documented below rather than hidden — since T73 it issues a
 * PENDING key that a human approves, and a caller who does not know that will
 * read their 401 as a bug in our auth.
 *
 * Mounted BEFORE requireApiKey on purpose. Documentation behind a key is a
 * door that opens only for people who already came in.
 *
 * Scalar is loaded from a CDN rather than bundled: the Worker ships on every
 * deploy and there is no reason to carry a documentation UI in it.
 */
export const docs = new Hono<{ Bindings: Env; Variables: Variables }>();

docs.get("/openapi.json", (c) =>
  c.json(spec as unknown as Record<string, unknown>, 200, {
    "Cache-Control": "public, max-age=3600",
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
    <meta name="description" content="REST API for car specifications: brands, models, generations, variants and their specs." />
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
