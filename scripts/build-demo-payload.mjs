#!/usr/bin/env node
// T107 — renders the demo tier into KV, one blob per locale.
//
// The demo tier is served from these blobs and never from Postgres, which is
// what makes its scope structural rather than a check (see src/routes/demo.ts).
// This script is the only thing that reads the database for the demo, and it
// runs offline, after a pipeline run.
//
//   node scripts/build-demo-payload.mjs                 # build, write files, no upload
//   node scripts/build-demo-payload.mjs --put            # also upload to KV (--remote)
//   node scripts/build-demo-payload.mjs --locale en      # one locale, for a quick look
//
// REFUSES TO RUN while the monthly pipeline is going. `cars_v3` is rewritten in
// place during a run — on 2026-10-04 `Mild Hybrid` read 1.252 active variants
// at 22:20 and 37 at 23:05 — so a blob built mid-run ships half-imported data
// to exactly the audience that is evaluating whether our data is any good.
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { pipelineRunning } from "./pipeline-running.mjs";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The localisation and image logic is REUSED from the Worker source, not
// reimplemented. A second implementation would be free to drift from what the
// API actually returns, and a demo blob that disagrees with the live API is the
// same defect class as prices typed twice (T73) or llms.txt numbers drifting
// from the catalogue — both of which happened here.
//
// The Worker source uses extensionless relative imports (correct for
// moduleResolution "Bundler"), which Node's ESM loader will not resolve, so the
// libs are compiled to CommonJS first:
//   npx tsc -p tsconfig.build-scripts.json
const require_ = createRequire(import.meta.url);
const BUILD = "../.tsbuild/lib";
let localizeVariantSpecs, getVariantImages, DEMO_VARIANT_IDS, DEMO_SET_SIZE, DEMO_SET_DESCRIPTION, demoSetReady, SUPPORTED_LOCALES;
try {
  ({ localizeVariantSpecs } = require_(`${BUILD}/localize-variant.js`));
  ({ getVariantImages } = require_(`${BUILD}/queries.js`));
  ({ DEMO_VARIANT_IDS, DEMO_SET_SIZE, DEMO_SET_DESCRIPTION, demoSetReady } = require_(`${BUILD}/demo-set.js`));
  ({ SUPPORTED_LOCALES } = require_(`${BUILD}/locale.js`));
} catch (e) {
  console.error(`Compiled libs missing (${e.code ?? e.message}).\nRun: npx tsc -p tsconfig.build-scripts.json`);
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(here, "../.demo-payload");
const DSN = process.env.DEMO_SET_DSN ?? "postgresql://localhost:5432/cars_v3";
const PUT = process.argv.includes("--put");
const ONE = process.argv.includes("--locale") ? process.argv[process.argv.indexOf("--locale") + 1] : null;
const KV_NAMESPACE = "4bfd13f1489b4e1482f441f4fcf33a3f"; // API_KEYS, per wrangler.toml

// DERIVED from the Worker's own list, never retyped. The first draft of this
// script carried a hand-written list that included `nl` — a locale the site
// deliberately never publishes — and omitted `sv` and `da`. A blob built from
// it would have been a fourth place these 20 strings are written down.
const LOCALES = [...SUPPORTED_LOCALES];

const busy = await pipelineRunning(DSN);
if (busy.running) {
  console.error(`cars_v3 is being written right now (${busy.what}).\nA blob built mid-import carries half-finished data to exactly the audience judging whether\nour data is any good. Wait for the run and the three data gates, then retry.`);
  process.exit(1);
}

if (!demoSetReady()) {
  console.error(`The frozen demo set is not generated (${DEMO_VARIANT_IDS.size} of ${DEMO_SET_SIZE} ids).\nRun: node scripts/build-demo-set.mjs --write`);
  process.exit(1);
}

const sql = postgres(DSN, { max: 4, idle_timeout: 10 });
const ids = [...DEMO_VARIANT_IDS];

/** Everything about the set that does not depend on locale. */
const base = await sql`
  SELECT v.public_id AS variant_id, g.public_id AS generation_id, m.public_id AS model_id,
         b.display_name AS brand, m.display_name AS model, g.display_name AS generation,
         v.display_name, v.fuel_type_en AS fuel, v.body_type_en AS body_type,
         g.years_start, g.years_end, v.power_hp, v.battery_kwh, v.price_new_eur
  FROM variants v
  JOIN generations g ON g.id = v.generation_id
  JOIN models m ON m.id = g.model_id
  JOIN brands b ON b.id = m.brand_id
  WHERE v.is_active AND v.public_id = ANY(${ids})
  ORDER BY b.display_name, m.display_name, g.public_id, v.public_id
`;

if (base.length !== ids.length) {
  console.error(`Refusing to build: the frozen set names ${ids.length} variants but only ${base.length} are active.\nThe set was frozen against different data — regenerate it after the pipeline run.`);
  await sql.end();
  process.exit(1);
}

const images = Object.fromEntries(
  await Promise.all(ids.map(async (id) => [id, await getVariantImages(sql, id)])),
);

fs.mkdirSync(OUT_DIR, { recursive: true });
const built = [];

for (const locale of ONE ? [ONE] : LOCALES) {
  const variants = [];
  for (const r of base) {
    const localized = await localizeVariantSpecs(sql, locale, Number(r.variant_id));
    variants.push({
      variant_id: Number(r.variant_id),
      generation_id: Number(r.generation_id),
      model_id: Number(r.model_id),
      brand: r.brand, model: r.model, generation: r.generation,
      display_name: r.display_name,
      fuel: r.fuel, body_type: r.body_type,
      // `years_end = 0` is how this schema says "still in production" — 531
      // generations carry it. `filter(Boolean)` dropped it by luck, which
      // rendered an ongoing generation as a single year ("2026") instead of an
      // open range. Spelled out rather than left to coincidence.
      years: r.years_start
        ? r.years_end && Number(r.years_end) > 0
          ? `${r.years_start}–${r.years_end}`
          : `${r.years_start}–`
        : null,
      power_hp: r.power_hp,
      battery_kwh: r.battery_kwh !== null ? Number(r.battery_kwh) : null,
      price_new_eur: r.price_new_eur,
      // VERBATIM. Reshaping here is how the demo's response shape would drift
      // from the live API's.
      specs: localized?.specs ?? {},
      images: (images[Number(r.variant_id)] ?? []).map((i) => ({
        url: i.cdn_url, variant: i.role === "hero" ? "hero" : "card",
      })),
    });
  }

  const emptySpecs = variants.filter((v) => Object.keys(v.specs).length === 0);
  if (emptySpecs.length) {
    console.error(`! ${locale}: ${emptySpecs.length} variants have NO localised specs — a demo blob with empty cars is worse than no demo. Not writing ${locale}.`);
    continue;
  }

  const payload = {
    schema: 1,
    locale,
    built_at: new Date().toISOString(),
    set_description: DEMO_SET_DESCRIPTION,
    variants,
  };
  const file = path.join(OUT_DIR, `demo-${locale}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  built.push({ locale, file, kb });
  console.log(`  ${locale}: ${variants.length} variants, ${variants.reduce((n, v) => n + Object.keys(v.specs).length, 0)} spec values, ${kb} KB`);
}

await sql.end();

if (!PUT) {
  console.log(`\n${built.length} blobs in ${path.relative(process.cwd(), OUT_DIR)} — pass --put to upload to KV.`);
  process.exit(built.length === (ONE ? 1 : LOCALES.length) ? 0 : 1);
}

for (const { locale, file } of built) {
  execFileSync("npx", ["wrangler", "kv", "key", "put", `demo:v1:${locale}`,
    "--path", file, "--namespace-id", KV_NAMESPACE, "--remote"], { stdio: "inherit" });
}
console.log(`\nUploaded ${built.length} blobs. The demo tier is live for those locales.`);
