import { describe, expect, test } from "vitest";
import yamlSource from "../../openapi.yaml?raw";
import spec from "../../openapi.json";
import { v1 } from "../routes/v1";
import { demo } from "../routes/demo";

/**
 * The test that stops the documentation from lying.
 *
 * T29 — the first attempt at these docs — sat on a branch for five days while
 * the Worker moved on underneath it. By the time anyone looked, its spec
 * described `POST /v1/keys` as issuing a PENDING key that 403s until a human
 * approves it; T111 had already replaced that with an auto-issued demo key.
 * The branch also carried a path-set test, but it only compared openapi.yaml
 * against openapi.json — two documents that drifted together, in step, away
 * from the code. Comparing a spec to its own copy cannot catch that.
 *
 * So this file checks three things, in increasing order of what they are worth:
 *
 *   1. openapi.yaml and openapi.json agree       (they are one truth, two files)
 *   2. the spec and the ROUTES agree             (the check T29 did not have)
 *   3. the public endpoints are mounted publicly (the check its deploy needed)
 *
 * Check 2 reads the routes out of Hono itself, with mount prefixes already
 * applied, so it cannot be fooled by `/variants/{id}` being written `/:id`
 * inside variants.ts. A naive textual comparison reports nine false mismatches
 * on this router; that is why the old delivery verified by hand instead, once,
 * and then went stale.
 *
 * Regenerate the JSON with:  node scripts/build-openapi-json.mjs
 */

type HonoRoute = { method: string; path: string };

/** Hono writes params as `:id` and may carry a regex, `:action{approve|revoke}`. */
function toOpenApiPath(honoPath: string): string {
  return honoPath.replace(/:(\w+)(\{[^}]*\})?/g, "{$1}");
}

/**
 * Owner-only key administration. Deliberately absent from the public spec: the
 * whole surface answers 404 unless ADMIN_TOKEN is presented, and publishing it
 * would advertise a door rather than document a contract. Excluded by prefix,
 * not by listing each route, so a NEW admin route needs no spec entry — while a
 * new PUBLIC route still fails this test until it is documented.
 */
const UNDOCUMENTED_PREFIXES = ["/admin"] as const;

const isUndocumented = (p: string) => UNDOCUMENTED_PREFIXES.some((u) => p === u || p.startsWith(`${u}/`));

/** Every endpoint the Worker actually serves under /v1, as `GET /brands`.
 *
 *  Two routers, because a demo key never reaches the first one: v1 holds the
 *  catalogue surface, and routes/demo.ts is dispatched in its place at the /v1
 *  root. `/demo` lives only in the second, which is exactly why it has to be
 *  read from there rather than assumed. */
function implementedRoutes(): Set<string> {
  const out = new Set<string>();
  for (const r of [...(v1.routes as HonoRoute[]), ...(demo.routes as HonoRoute[])]) {
    // `ALL /*`, `ALL /keys/*` … are middleware (CORS, auth, the demo dispatch,
    // telemetry), not endpoints.
    if (r.method === "ALL" || r.path.includes("*")) continue;
    const path = toOpenApiPath(r.path);
    if (isUndocumented(path)) continue;
    out.add(`${r.method.toUpperCase()} ${path}`);
  }
  return out;
}

/** Every operation the published spec claims, in the same shape. */
function documentedRoutes(): Set<string> {
  const out = new Set<string>();
  const paths = (spec as { paths: Record<string, Record<string, unknown>> }).paths;
  for (const [path, item] of Object.entries(paths)) {
    for (const method of Object.keys(item)) {
      if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
      out.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return out;
}

describe("openapi.json is a faithful copy of openapi.yaml", () => {
  test("the two files carry the same set of paths", () => {
    // Top-level keys under `paths:` are two-space indented and start with a slash.
    const inYaml = new Set([...yamlSource.matchAll(/^ {2}(\/[^\s:]*):/gm)].map((m) => m[1]));
    const inJson = new Set(Object.keys((spec as { paths: Record<string, unknown> }).paths));
    expect(inYaml.size, "no paths found in openapi.yaml — the matcher broke, not the spec").toBeGreaterThan(5);
    expect([...inJson].filter((p) => !inYaml.has(p)), "in JSON but not YAML — run scripts/build-openapi-json.mjs").toEqual([]);
    expect([...inYaml].filter((p) => !inJson.has(p)), "in YAML but not JSON — run scripts/build-openapi-json.mjs").toEqual([]);
  });

  test("the spec names a version and a server", () => {
    const s = spec as { openapi?: string; servers?: unknown[] };
    expect(s.openapi).toMatch(/^3\./);
    expect(s.servers?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("the spec matches the routes the Worker mounts", () => {
  test("the route table is readable at all", () => {
    // If Hono ever stops exposing `.routes`, every comparison below would pass
    // vacuously. Fail loudly instead.
    expect(implementedRoutes().size, "no routes read from Hono — the introspection broke, not the spec").toBeGreaterThan(15);
  });

  test("every implemented endpoint is documented", () => {
    const missing = [...implementedRoutes()].filter((r) => !documentedRoutes().has(r)).sort();
    expect(missing, "implemented but undocumented — add it to openapi.yaml, or to UNDOCUMENTED_PREFIXES with a reason").toEqual([]);
  });

  test("every documented endpoint is implemented", () => {
    const phantom = [...documentedRoutes()].filter((r) => !implementedRoutes().has(r)).sort();
    expect(phantom, "documented but not implemented — this is the failure mode that made T29 undeployable").toEqual([]);
  });

  test("the admin surface is excluded on purpose, not by accident", () => {
    const adminRoutes = (v1.routes as HonoRoute[])
      .filter((r) => r.method !== "ALL" && !r.path.includes("*") && isUndocumented(r.path));
    expect(adminRoutes.length, "no admin routes found — the exclusion prefix no longer matches anything").toBeGreaterThan(0);
    for (const r of adminRoutes) expect(r.path.startsWith("/admin")).toBe(true);
  });
});

describe("what the spec calls public really is public", () => {
  /** Paths the spec declares as needing no key (`security: []`). */
  function declaredPublic(): string[] {
    const paths = (spec as { paths: Record<string, Record<string, { security?: unknown[] }>> }).paths;
    const out: string[] = [];
    for (const [path, item] of Object.entries(paths)) {
      for (const op of Object.values(item)) {
        if (op && typeof op === "object" && Array.isArray(op.security) && op.security.length === 0) out.push(path);
      }
    }
    return [...new Set(out)];
  }

  test("the spec declares the no-key endpoints as no-key", () => {
    expect(declaredPublic().sort()).toEqual(
      ["/docs", "/health", "/keys", "/keys/demo", "/keys/demo/verify", "/openapi.json"].sort(),
    );
  });

  test("they are mounted BEFORE the key gate, not after", () => {
    // Hono keeps `.routes` in registration order, and requireApiKey arrives as
    // the first catch-all `ALL /*` on the router. Anything registered after it
    // answers 401 instead of serving — which is precisely how a documentation
    // route gets published behind the key it exists to explain.
    const routes = v1.routes as HonoRoute[];
    const gateAt = routes.findIndex((r) => r.method === "ALL" && r.path === "/*");
    expect(gateAt, "no catch-all middleware found on /v1 — this test's assumption broke").toBeGreaterThan(-1);
    for (const path of declaredPublic()) {
      const at = routes.findIndex((r) => toOpenApiPath(r.path) === path && r.method !== "ALL");
      expect(at, `${path} is documented as public but is not mounted on /v1 at all`).toBeGreaterThan(-1);
      expect(at, `${path} is mounted AFTER requireApiKey — it will answer 401, not serve`).toBeLessThan(gateAt);
    }
  });
});

describe("the docs routes answer", () => {
  test("GET /openapi.json serves the spec, CORS-open", async () => {
    const { docs } = await import("../routes/docs");
    const res = await docs.request("/openapi.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(body.paths).length).toBeGreaterThan(15);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("GET /docs serves a page that points at the spec", async () => {
    const { docs } = await import("../routes/docs");
    const res = await docs.request("/docs");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The reference is useless if the data-url does not match the route above.
    expect(html).toContain('data-url="/v1/openapi.json"');
  });
});

describe("the spec tells the truth about the two tiers", () => {
  const described = JSON.stringify(spec);

  test("it does not advertise a free tier", () => {
    const d = (spec as { info: { description: string } }).info.description;
    expect(d).toMatch(/no free tier/i);
    // `free` survives in one place only: the deprecated plan value on /usage.
    const plan = (spec as { components: { schemas: { Usage: { properties: { plan: { enum: string[]; description: string } } } } } })
      .components.schemas.Usage.properties.plan;
    expect(plan.enum).toContain("demo");
    expect(plan.enum).toContain("apify");
    expect(plan.description, "if `free` is still listed, the spec must say it is legacy").toMatch(/legacy|deprecated/i);
  });

  test("it states the demo's structural guarantee, not just a quota", () => {
    const d = (spec as { info: { description: string } }).info.description;
    expect(d).toMatch(/Workers KV/);
    expect(d).toMatch(/Hyperdrive/);
    expect(d).toMatch(/no code\s+path/i);
  });

  test("it points at the real paid channels and invents no prices", () => {
    expect(described).toContain("apify.com/carsdatacom/car-specs-api");
    expect(described).toContain("cars-data.com/en/api");
    // Every € figure in the spec must be one that /en/api publishes. Quoting a
    // price the page does not carry is how documentation becomes an offer.
    const PUBLISHED_ON_EN_API = new Set(["€190", "€290", "€390", "€490", "€590", "€990", "€1,490", "€2,900", "€3,900", "€49"]);
    const quoted = [...described.matchAll(/€[\d,.]*\d/g)].map((m) => m[0]);
    expect(quoted.filter((q) => !PUBLISHED_ON_EN_API.has(q)), "a price that is not on https://cars-data.com/en/api").toEqual([]);
  });
});
