#!/usr/bin/env node
// Checks every number in src/lib/catalogue-facts.ts against the database THE
// API SERVES — which is cars_prod, not the local replica.
//
// Run it against local and you verify the wrong thing: the replica runs ahead on
// variant counts (it gets each import first) and behind on enrichment. Checked
// that way, these numbers went live claiming 103.372 variants and 163 spec types
// present while prod served 103.099 and 221.
//
//   node scripts/verify-catalogue-facts.mjs --prod     # over ssh, the real check
//   node scripts/verify-catalogue-facts.mjs            # local replica, for a dry look
//
// Run it after a pipeline run, before a deploy. It exits non-zero on drift, so
// it can sit in front of `wrangler deploy` the way the three data gates sit in
// front of an import. A number nobody checks is a claim.
import postgres from "postgres";
import { pipelineRunning } from "./pipeline-running.mjs";
import { createRequire } from "node:module";

const PROD = process.argv.includes("--prod");
const DSN = process.env.DEMO_SET_DSN ?? "postgresql://localhost:5432/cars_v3";
const busy = PROD ? { running: false } : await pipelineRunning(DSN);
if (busy.running) {
  console.error(`cars_v3 is being written right now (${busy.what}) — these counts are a moving target. Retry after the run.`);
  process.exit(1);
}

const require_ = createRequire(import.meta.url);
let CATALOGUE, SUPPORTED_LOCALES;
try {
  ({ CATALOGUE } = require_("../.tsbuild/lib/catalogue-facts.js"));
  ({ SUPPORTED_LOCALES } = require_("../.tsbuild/lib/locale.js"));
} catch (e) {
  console.error(`Compiled libs missing (${e.code ?? e.message}).\nRun: npx tsc -p tsconfig.build-scripts.json`);
  process.exit(1);
}

const sql = PROD ? null : postgres(DSN, { max: 2 });

/** One ssh round trip for all of them when --prod: the queries are cheap but the
 *  connection is not, and `jsonb_object_keys` over variant_doc is the slow one. */
async function prodCounts() {
  const { execFileSync } = await import("node:child_process");
  const q = `select
    (select count(*) from variants where is_active),
    (select count(*) from variant_doc),
    (select count(distinct b.id) from brands b join models m on m.brand_id=b.id
       join generations g on g.model_id=m.id join variants v on v.generation_id=g.id and v.is_active),
    (select count(*) from generations),
    (select count(*) from specs_catalog where is_active),
    (select count(distinct k) from variant_doc, jsonb_object_keys(specs) k),
    (select count(*) from spec_categories)`;
  const out = execFileSync("ssh", ["-o", "ConnectTimeout=20", "cars-data-prod",
    `sudo -u postgres psql -d cars_prod -At -F'|' -c "${q.replace(/\n/g, " ")}"`], { encoding: "utf8" });
  const [variants, withSpecs, brands, generations, defined, present, cats] =
    out.trim().split("\n").pop().split("|").map(Number);
  return { variants, withSpecs, brands, generations, defined, present, cats };
}

let checks;
if (PROD) {
  const p = await prodCounts();
  checks = [
    ["variants", CATALOGUE.variants, p.variants],
    ["brands", CATALOGUE.brands, p.brands],
    ["generations", CATALOGUE.generations, p.generations],
    ["specTypesDefined", CATALOGUE.specTypesDefined, p.defined],
    ["specTypesPresent", CATALOGUE.specTypesPresent, p.present],
    ["specCategories", CATALOGUE.specCategories, p.cats],
    ["variantsWithSpecs", CATALOGUE.variantsWithSpecs, p.withSpecs],
  ].map(([n, claimed, actual]) => [n, claimed, Promise.resolve([{ n: actual }])]);
} else {
  checks = [
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
}

let bad = 0;
console.log(`catalogue facts — checked against ${PROD ? "cars_prod (what the API serves)" : "the LOCAL replica"} on ${new Date().toISOString().slice(0, 10)}\n`);
for (const [name, claimed, query] of checks) {
  const [{ n }] = await query;
  const ok = n === claimed;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "DRIFT"} ${name.padEnd(12)} published ${String(claimed).padStart(7)}   actual ${String(n).padStart(7)}`);
}
const localeOk = CATALOGUE.locales === SUPPORTED_LOCALES.length;
if (!localeOk) bad++;
console.log(`  ${localeOk ? "ok  " : "DRIFT"} ${"locales".padEnd(12)} published ${String(CATALOGUE.locales).padStart(7)}   actual ${String(SUPPORTED_LOCALES.length).padStart(7)}`);

if (sql) await sql.end();
if (bad) {
  console.error(`\n${bad} number(s) drifted. Update src/lib/catalogue-facts.ts — and only there.`);
  process.exit(1);
}
console.log("\nAll published numbers match the catalogue.");
