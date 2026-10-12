#!/usr/bin/env node
// src/lib/server-manifest.ts is the source of truth; server.json is what
// `mcp-publisher publish` uploads to the official MCP registry.
//
// Same shape as build-openapi-json.mjs, and for the same reason: two files
// holding one truth is what this project keeps paying for. This generator is
// the ONLY way server.json is written, and test/server-json.test.ts fails the
// suite if the file on disk disagrees with it — or if the manifest would be
// refused by the registry schema.
//
//   node scripts/build-server-json.mjs          # write server.json
//   node scripts/build-server-json.mjs --check  # exit 1 if it would change
//
// Needs the compiled libs (npm run build:scripts), like
// verify-catalogue-facts.mjs — the numbers come from catalogue-facts.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonPath = join(root, "server.json");

const require_ = createRequire(import.meta.url);
let serialize, buildManifest, MANIFEST_LIMITS;
try {
  ({ serialize, buildManifest, MANIFEST_LIMITS } = require_("../.tsbuild/lib/server-manifest.js"));
} catch (e) {
  console.error(`Compiled libs missing (${e.code ?? e.message}).\nRun: npx tsc -p tsconfig.build-scripts.json`);
  process.exit(1);
}

// Checked here as well as in the test, because this script is what runs right
// before a publish — and a publish-time rejection costs a version number.
const m = buildManifest();
let bad = 0;
for (const [field, limit] of Object.entries(MANIFEST_LIMITS)) {
  const len = [...m[field]].length;
  if (len > limit) {
    console.error(`${field} is ${len} characters; the registry schema allows ${limit}.`);
    bad++;
  }
}
if (bad) process.exit(1);

const generated = serialize();

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(jsonPath, "utf-8"); } catch { /* missing counts as different */ }
  if (current !== generated) {
    console.error("server.json is stale — run: node scripts/build-server-json.mjs");
    process.exit(1);
  }
  console.log(`server.json is in sync with src/lib/server-manifest.ts (v${m.version})`);
} else {
  writeFileSync(jsonPath, generated, "utf-8");
  console.log(`wrote server.json (v${m.version}, description ${[...m.description].length}/${MANIFEST_LIMITS.description} chars)`);
}
