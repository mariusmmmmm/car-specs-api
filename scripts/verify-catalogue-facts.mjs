#!/usr/bin/env node
// Checks every number in src/lib/catalogue-facts.ts against the database.
//
// Run it after a pipeline run, before a deploy. It exits non-zero on drift, so
// it can sit in front of `wrangler deploy` the way the three data gates sit in
// front of an import. A number nobody checks is a claim.
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

try {
  execFileSync("pgrep", ["-f", "run-monthly.sh"], { stdio: "pipe" });
  console.error("The monthly pipeline is running — cars_v3 is mid-rewrite, so these counts are a moving target. Retry after the run.");
  process.exit(1);
} catch { /* pgrep exits 1 when nothing matches: good */ }

const require_ = createRequire(import.meta.url);
let CATALOGUE, SUPPORTED_LOCALES;
try {
  ({ CATALOGUE } = require_("../.tsbuild/lib/catalogue-facts.js"));
  ({ SUPPORTED_LOCALES } = require_("../.tsbuild/lib/locale.js"));
} catch (e) {
  console.error(`Compiled libs missing (${e.code ?? e.message}).\nRun: npx tsc -p tsconfig.build-scripts.json`);
  process.exit(1);
}

const sql = postgres(process.env.DEMO_SET_DSN ?? "postgresql://localhost:5432/cars_v3", { max: 2 });

const checks = [
  ["variants", CATALOGUE.variants, sql`SELECT count(*)::int n FROM variants WHERE is_active`],
  ["brands", CATALOGUE.brands, sql`
      SELECT count(DISTINCT b.id)::int n FROM brands b
      JOIN models m ON m.brand_id = b.id
      JOIN generations g ON g.model_id = m.id
      JOIN variants v ON v.generation_id = g.id AND v.is_active`],
  ["generations", CATALOGUE.generations, sql`SELECT count(*)::int n FROM generations`],
  ["specTypesDefined", CATALOGUE.specTypesDefined, sql`SELECT count(*)::int n FROM specs_catalog WHERE is_active`],
  ["specTypesPresent", CATALOGUE.specTypesPresent, sql`
      SELECT count(DISTINCT k)::int n FROM variant_doc, jsonb_object_keys(specs) k`],
  ["specCategories", CATALOGUE.specCategories, sql`SELECT count(*)::int n FROM spec_categories`],
  ["variantsWithSpecs", CATALOGUE.variantsWithSpecs, sql`SELECT count(*)::int n FROM variant_doc`],
];

let bad = 0;
console.log(`catalogue facts — checked against cars_v3 on ${new Date().toISOString().slice(0, 10)}\n`);
for (const [name, claimed, query] of checks) {
  const [{ n }] = await query;
  const ok = n === claimed;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "DRIFT"} ${name.padEnd(12)} published ${String(claimed).padStart(7)}   actual ${String(n).padStart(7)}`);
}
const localeOk = CATALOGUE.locales === SUPPORTED_LOCALES.length;
if (!localeOk) bad++;
console.log(`  ${localeOk ? "ok  " : "DRIFT"} ${"locales".padEnd(12)} published ${String(CATALOGUE.locales).padStart(7)}   actual ${String(SUPPORTED_LOCALES.length).padStart(7)}`);

await sql.end();
if (bad) {
  console.error(`\n${bad} number(s) drifted. Update src/lib/catalogue-facts.ts — and only there.`);
  process.exit(1);
}
console.log("\nAll published numbers match the catalogue.");
