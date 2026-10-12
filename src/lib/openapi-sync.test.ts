import { describe, expect, test } from "vitest";
import yamlSource from "../../openapi.yaml?raw";
import spec from "../../openapi.json";

/**
 * openapi.json is GENERATED from openapi.yaml, and the Worker serves the JSON
 * because a Worker cannot parse YAML without carrying a parser it has no other
 * use for. Two files holding the same truth is the setup this project keeps
 * paying for, so this is the test that stops them drifting.
 *
 * Regenerate with:  python3 -c "import yaml,json;json.dump(yaml.safe_load(open('openapi.yaml')),open('openapi.json','w'),indent=2,ensure_ascii=False,sort_keys=True)"
 */
describe("the served spec matches the source of truth", () => {
  test("every path in openapi.yaml is in openapi.json, and vice versa", () => {
    const yaml = yamlSource;
    // Top-level keys under `paths:` are two-space indented and start with a slash.
    const inYaml = new Set(
      [...yaml.matchAll(/^ {2}(\/[^\s:]*):/gm)].map((m) => m[1]),
    );
    const inJson = new Set(Object.keys((spec as { paths: Record<string, unknown> }).paths));
    expect(inYaml.size, "no paths found in openapi.yaml — the matcher broke, not the spec").toBeGreaterThan(5);
    expect([...inJson].filter((p) => !inYaml.has(p)), "in JSON but not YAML — regenerate").toEqual([]);
    expect([...inYaml].filter((p) => !inJson.has(p)), "in YAML but not JSON — regenerate").toEqual([]);
  });

  test("the spec names a server and a version", () => {
    const s = spec as { openapi?: string; servers?: unknown[] };
    expect(s.openapi).toMatch(/^3\./);
    expect(s.servers?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("the docs routes answer", () => {
  test("GET /openapi.json serves the spec, publicly", async () => {
    const { docs } = await import("../routes/docs");
    const res = await docs.request("/openapi.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(body.paths).length).toBeGreaterThan(10);
    // Documentation behind CORS nobody can call is documentation nobody reads.
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

/**
 * T264. Testul de mai sus compară CĂILE din openapi.yaml cu cele din openapi.json.
 * Nu compară niciodată CÂMPURILE unui răspuns cu ce întoarce codul — iar exact acolo
 * s-a rupt contractul: `localizeVariantSpecs` a căpătat un `summary` de unsprezece
 * câmpuri, împrăștiat în răspunsurile `/variants/{id}/specs`, `/compare` și ale celor
 * două unelte MCP, în timp ce schema `VariantSpecs` rămăsese la trei câmpuri. Codul a
 * stat necomis opt zile, trecea `tsc` și toate testele, și nimic nu spunea că API-ul
 * ar fi răspuns altceva decât promitea specul lui publicat.
 *
 * Garda e textuală, ca şi cea de deasupra: citeşte lista de chei din sursă, nu rulează
 * interogarea. Un câmp adăugat în `summary` fără să ajungă în schemă înroşeşte suita.
 */
describe("the summary fields the code returns are the ones the spec promises", () => {
  test("every key of localizeVariantSpecs().summary is in the VariantSpecs schema", async () => {
    const src = (await import("./localize-variant.ts?raw")).default as string;
    const block = src.match(/summary:\s*\{([\s\S]*?)\n\s*\},/);
    expect(block, "n-am găsit blocul `summary: {` în localize-variant.ts — s-a redenumit?").toBeTruthy();

    const keys = [...block![1].matchAll(/^\s*([a-z_0-9]+)\s*:/gm)].map((m) => m[1]);
    expect(keys.length, "zero chei extrase — regexul s-a rupt, nu codul").toBeGreaterThan(5);

    const props = Object.keys(
      (spec as { components: { schemas: { VariantSpecs: { properties: Record<string, unknown> } } } })
        .components.schemas.VariantSpecs.properties,
    );
    expect(keys.filter((k) => !props.includes(k)), "câmpuri întoarse de cod, absente din schemă").toEqual([]);
  });
});
