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
