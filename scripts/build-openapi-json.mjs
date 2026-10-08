#!/usr/bin/env node
// openapi.yaml is the source of truth; openapi.json is what the Worker serves.
//
// The Worker serves JSON because it cannot parse YAML without carrying a
// parser it has no other use for. Two files holding one truth is the shape
// this project keeps paying for, so: this generator is the ONLY way the JSON
// is written, and src/lib/openapi-sync.test.ts fails the build if the two
// disagree — or if either disagrees with the routes the Worker actually mounts.
//
//   node scripts/build-openapi-json.mjs          # write openapi.json
//   node scripts/build-openapi-json.mjs --check  # exit 1 if it would change
//
// No YAML dependency: this parses the subset of YAML the spec uses by handing
// it to Python's yaml, which is present on every machine this repo runs on and
// is not a runtime dependency of the Worker.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const yamlPath = join(root, "openapi.yaml");
const jsonPath = join(root, "openapi.json");

const generated = execFileSync(
  "python3",
  ["-I", "-c", "import yaml,json,sys;json.dump(yaml.safe_load(open(sys.argv[1],encoding='utf-8')),sys.stdout,indent=2,ensure_ascii=False,sort_keys=True)", yamlPath],
  { encoding: "utf-8" },
) + "\n";

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(jsonPath, "utf-8"); } catch { /* missing counts as different */ }
  if (current !== generated) {
    console.error("openapi.json is stale — run: node scripts/build-openapi-json.mjs");
    process.exit(1);
  }
  console.log("openapi.json is in sync with openapi.yaml");
} else {
  writeFileSync(jsonPath, generated, "utf-8");
  console.log(`wrote openapi.json (${generated.length} bytes)`);
}
