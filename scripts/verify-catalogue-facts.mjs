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
  // T253: `tsc` singur NU e de ajuns. Emite CommonJS, iar `api/package.json` are
  // "type": "module", deci Node citeşte `.tsbuild/**/*.js` ca ESM şi cade cu
  // „exports is not defined in ES module scope". Marcatorul din `.tsbuild/package.json`
  // e ce lipsea — de aceea verificatorul nu putea rula dintr-o stare curată.
  console.error(`Compiled libs missing (${e.code ?? e.message}).\nRun: npm run build:scripts`);
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
    (select count(*) from spec_categories),
    (select count(distinct m.id) from models m join generations g on g.model_id=m.id
       join variants v on v.generation_id=g.id and v.is_active)`;
  const out = execFileSync("ssh", ["-o", "ConnectTimeout=20", "cars-data-prod",
    `sudo -u postgres psql -d cars_prod -At -F'|' -c "${q.replace(/\n/g, " ")}"`], { encoding: "utf8" });
  const [variants, withSpecs, brands, generations, defined, present, cats, models] =
    out.trim().split("\n").pop().split("|").map(Number);
  return { variants, withSpecs, brands, generations, defined, present, cats, models };
}

let checks;
if (PROD) {
  const p = await prodCounts();
  checks = [
    ["variants", CATALOGUE.variants, p.variants],
    ["brands", CATALOGUE.brands, p.brands],
    ["models", CATALOGUE.models, p.models],
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
    ["models", CATALOGUE.models, sql`
        SELECT count(DISTINCT m.id)::int n FROM models m
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

// ── T253: suprafeţele PUBLICATE din afara acestui repo ──────────────────────
// `catalogue-facts.ts` există fiindcă aceleaşi cifre erau tastate în zece locuri. Dar
// listarea Apify trăieşte în ALT repo, deci verificatorul nu se uita acolo niciodată —
// şi pe 2026-10-12 publica `5,299+ generations`, `1,300+ models` şi `180 spec types`
// în timp ce canonicul spunea 5.428 / 1.357 / 222.
//
// Calea e CONFIGURABILĂ, nu presupusă: cele două repo-uri sunt fraţi azi, dar nimic nu
// garantează layout-ul. `APIFY_ACTOR_DIR` o schimbă; lipsa directorului e un SKIP
// explicit, nu o trecere tăcută.
// `(?<![\d-])` scoate intervalele: „compare 2-4 variants" e o limită de unealtă, nu o
// afirmaţie despre catalog. Fără excluderea asta, verificatorul compara 4 cu 103.372.
const CLAIM = /(?<![\d-])([\d][\d,.]*)\s*\+?\s*(spec types?|models?|generations?|variants?|languages?)/gi;
const CANON = {
  "spec type": CATALOGUE.specTypesPresent, "spec types": CATALOGUE.specTypesPresent,
  model: CATALOGUE.models, models: CATALOGUE.models,
  generation: CATALOGUE.generations, generations: CATALOGUE.generations,
  variant: CATALOGUE.variants, variants: CATALOGUE.variants,
  language: CATALOGUE.locales, languages: CATALOGUE.locales,
};
const actorDir = process.env.APIFY_ACTOR_DIR
  ?? new URL("../../apify-actor/", import.meta.url).pathname;
const { existsSync, readFileSync, readdirSync } = await import("node:fs");
if (!existsSync(actorDir)) {
  console.log(`\n  skip  listarea Apify — ${actorDir} nu există (setează APIFY_ACTOR_DIR)`);
} else {
  const fisiere = ["README.md", ".actor/actor.json"].filter((f) => existsSync(actorDir + "/" + f));
  if (fisiere.length === 0) {
    console.error(`\n  DRIFT listarea Apify — ${actorDir} există, dar n-are README.md sau .actor/actor.json`);
    bad++;
  }
  let claims = 0;
  for (const f of fisiere) {
    const text = readFileSync(actorDir + "/" + f, "utf8");
    for (const m of text.matchAll(CLAIM)) {
      const n = Number(m[1].replace(/[,.]/g, ""));
      const canon = CANON[m[2].toLowerCase()];
      if (canon === undefined || !Number.isFinite(n)) continue;
      claims++;
      const ok = n === canon;
      if (!ok) bad++;
      console.log(`  ${ok ? "ok  " : "DRIFT"} apify:${f.padEnd(17)} „${m[0].trim()}" vs ${canon}`);
    }
  }
  // Zero afirmaţii găsite înseamnă că regexul nu mai prinde forma textului, nu că
  // listarea e curată. Un verificator care trece pe zero intrări nu verifică nimic.
  if (claims === 0) {
    console.error("\n  DRIFT listarea Apify — ZERO afirmaţii numerice găsite. Un pass pe zero intrări nu e un pass.");
    bad++;
  }
}

if (bad) {
  console.error(`\n${bad} number(s) drifted. Update src/lib/catalogue-facts.ts — and only there.`);
  process.exit(1);
}
console.log("\nAll published numbers match the catalogue.");
