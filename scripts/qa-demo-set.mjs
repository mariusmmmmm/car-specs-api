#!/usr/bin/env node
// Gate on the frozen demo set (T111 criterion 14).
//
//   node scripts/qa-demo-set.mjs --self-test
//
// The set is DATA, and the thing that breaks it is an import, not a commit: a
// variant goes inactive, loses its images, or the 2x2x2 shape stops holding,
// and the demo starts answering 404 for a car it promises — to exactly the
// audience deciding whether to pay us. Nothing in the test suite can see that,
// because the suite mocks the set on purpose.
//
// --self-test plants each defect and requires the rule to catch it. A gate that
// has never been shown failing is a gate nobody has tested.
import postgres from "postgres";
import { createRequire } from "node:module";
import { pipelineRunning } from "./pipeline-running.mjs";

const DSN = process.env.DEMO_SET_DSN ?? "postgresql://localhost:5432/cars_v3";
const SELF_TEST = process.argv.includes("--self-test");

const require_ = createRequire(import.meta.url);
let DEMO_VARIANT_IDS, DEMO_GENERATION_IDS, DEMO_MODEL_IDS, DEMO_SET_SIZE, DEMO_SET_DESCRIPTION;
try {
  ({ DEMO_VARIANT_IDS, DEMO_GENERATION_IDS, DEMO_MODEL_IDS, DEMO_SET_SIZE, DEMO_SET_DESCRIPTION } =
    require_("../.tsbuild/lib/demo-set.js"));
} catch (e) {
  console.error(`Compiled libs missing (${e.code ?? e.message}).\nRun: npx tsc -p tsconfig.build-scripts.json`);
  process.exit(1);
}

const MIN_FUELS = 9;       // 10 are reachable; 9 leaves room for one to go inactive
const MIN_SPECS = 100;
const MIN_IMAGES = 1;
const BRANDS = 5, MODELS_PER_BRAND = 2, GENS_PER_MODEL = 2, VARS_PER_GEN = 2;

const busy = await pipelineRunning(DSN);
if (busy.running) {
  console.error(`cars_v3 is being written right now (${busy.what}) — run this after the import, not during it.`);
  process.exit(1);
}

const sql = postgres(DSN, { max: 4, idle_timeout: 10 });
const ids = [...DEMO_VARIANT_IDS];

const rows = await sql`
  SELECT v.public_id AS variant_id, v.display_name AS variant, v.is_active,
         v.fuel_type_en AS fuel,
         g.public_id AS generation_id, m.public_id AS model_id,
         b.display_name AS brand, m.display_name AS model
  FROM variants v
  JOIN generations g ON g.id = v.generation_id
  JOIN models m ON m.id = g.model_id
  JOIN brands b ON b.id = m.brand_id
  WHERE v.public_id = ANY(${ids})
`;
const [specs, images] = await Promise.all([
  sql`SELECT entity_id, count(*)::int n FROM spec_values
       WHERE entity_kind::text = 'variant' AND entity_id = ANY(${ids}) GROUP BY 1`,
  sql`SELECT entity_id, count(*)::int n FROM entity_media
       WHERE entity_kind::text = 'variant' AND entity_id = ANY(${ids}) GROUP BY 1`,
]);
await sql.end();

const specBy = new Map(specs.map((r) => [Number(r.entity_id), r.n]));
const imgBy = new Map(images.map((r) => [Number(r.entity_id), r.n]));

/** Each rule takes the facts and returns null (pass) or a reason (fail). The
 *  shape is what lets --self-test feed them doctored facts. */
const RULES = [
  {
    name: `the set holds exactly ${DEMO_SET_SIZE} variants`,
    run: (f) => (f.ids.length === DEMO_SET_SIZE ? null : `${f.ids.length} ids, expected ${DEMO_SET_SIZE}`),
  },
  {
    name: "every variant in the set still exists and is active",
    run: (f) => {
      const found = new Set(f.rows.filter((r) => r.is_active).map((r) => Number(r.variant_id)));
      const gone = f.ids.filter((id) => !found.has(id));
      return gone.length === 0 ? null : `${gone.length} variant(s) missing or inactive`;
    },
  },
  {
    name: `at least ${MIN_FUELS} distinct fuel types`,
    run: (f) => {
      const fuels = new Set(f.rows.filter((r) => r.is_active).map((r) => r.fuel));
      return fuels.size >= MIN_FUELS ? null : `${fuels.size} fuels: ${[...fuels].sort().join(", ")}`;
    },
  },
  {
    name: `every variant carries >= ${MIN_SPECS} spec values`,
    run: (f) => {
      const thin = f.ids.filter((id) => (f.specBy.get(id) ?? 0) < MIN_SPECS);
      return thin.length === 0 ? null : `${thin.length} variant(s) below ${MIN_SPECS} specs`;
    },
  },
  {
    name: `every variant carries >= ${MIN_IMAGES} image`,
    run: (f) => {
      const bare = f.ids.filter((id) => (f.imgBy.get(id) ?? 0) < MIN_IMAGES);
      return bare.length === 0 ? null : `${bare.length} variant(s) with no image`;
    },
  },
  {
    name: `the shape is ${BRANDS}x${MODELS_PER_BRAND}x${GENS_PER_MODEL}x${VARS_PER_GEN}`,
    run: (f) => {
      const live = f.rows.filter((r) => r.is_active);
      const brands = new Set(live.map((r) => r.brand));
      if (brands.size !== BRANDS) return `${brands.size} brands, expected ${BRANDS}`;
      for (const b of brands) {
        const models = new Set(live.filter((r) => r.brand === b).map((r) => r.model));
        if (models.size !== MODELS_PER_BRAND) return `${b}: ${models.size} models, expected ${MODELS_PER_BRAND}`;
        for (const mo of models) {
          const gens = new Set(live.filter((r) => r.brand === b && r.model === mo).map((r) => Number(r.generation_id)));
          if (gens.size !== GENS_PER_MODEL) return `${b} ${mo}: ${gens.size} generations, expected ${GENS_PER_MODEL}`;
          for (const g of gens) {
            const vs = live.filter((r) => Number(r.generation_id) === g);
            if (vs.length !== VARS_PER_GEN) return `${b} ${mo} gen: ${vs.length} variants, expected ${VARS_PER_GEN}`;
          }
        }
      }
      return null;
    },
  },
  {
    // Written as global uniqueness first, and the data said no: "Hyundai Nexo
    // FCEV" genuinely exists in two generations (2018–2026 and 2026–), and the
    // API's own contract is that same-named variants are told apart by
    // generation and years. A rule stricter than the data model is a rule that
    // will be widened under pressure, so it is correct here instead: confusing
    // means two identical names in ONE list, and a cross-generation pair must
    // be distinguishable.
    name: "no two variants share a name within a generation, and cross-generation twins are distinguishable",
    run: (f) => {
      const live = f.rows.filter((r) => r.is_active);
      const byGen = new Map();
      for (const r of live) {
        const k = Number(r.generation_id);
        if (!byGen.has(k)) byGen.set(k, []);
        byGen.get(k).push(r);
      }
      for (const [gen, rs] of byGen) {
        if (new Set(rs.map((r) => r.variant)).size !== rs.length) {
          return `generation ${gen} lists the same name twice`;
        }
      }
      const seen = new Map();
      for (const r of live) {
        const prev = seen.get(r.variant);
        if (prev !== undefined && prev === Number(r.generation_id)) return `${r.variant} repeats inside one generation`;
        seen.set(r.variant, Number(r.generation_id));
      }
      return null;
    },
  },
  {
    name: "the generation and model id sets agree with the variants",
    run: (f) => {
      const live = f.rows.filter((r) => r.is_active);
      const gens = new Set(live.map((r) => Number(r.generation_id)));
      const models = new Set(live.map((r) => Number(r.model_id)));
      if (gens.size !== f.genIds.length) return `${f.genIds.length} frozen generations vs ${gens.size} in the data`;
      if (models.size !== f.modelIds.length) return `${f.modelIds.length} frozen models vs ${models.size} in the data`;
      return null;
    },
  },
];

const facts = {
  ids,
  rows,
  specBy,
  imgBy,
  genIds: [...DEMO_GENERATION_IDS],
  modelIds: [...DEMO_MODEL_IDS],
};

console.log(`demo set — ${DEMO_SET_DESCRIPTION}\n`);
let failed = 0;
for (const rule of RULES) {
  const why = rule.run(facts);
  if (why) { failed++; console.log(`FAIL   ${rule.name}  (${why})`); }
  else console.log(`PASS   ${rule.name}`);
}

if (SELF_TEST) {
  // Each entry breaks one thing and names the rule that must notice.
  const clone = () => ({ ...facts, ids: [...facts.ids], rows: facts.rows.map((r) => ({ ...r })), specBy: new Map(facts.specBy), imgBy: new Map(facts.imgBy) });
  const planted = [
    ["a variant dropped from the set", (f) => { f.ids.pop(); }],
    ["a variant went inactive", (f) => { f.rows[0].is_active = false; }],
    ["every car is the same fuel", (f) => { f.rows.forEach((r) => { r.fuel = "Petrol"; }); }],
    ["a variant lost its specs", (f) => { f.specBy.set(f.ids[0], 3); }],
    ["a variant lost its images", (f) => { f.imgBy.delete(f.ids[0]); }],
    ["a brand lost a model", (f) => { f.rows.forEach((r) => { if (r.brand === "Ford") r.model = "Focus"; }); }],
    ["two cars in ONE generation share a name", (f) => {
      const g = Number(f.rows[0].generation_id);
      const sib = f.rows.find((r) => Number(r.generation_id) === g && r !== f.rows[0]);
      if (sib) sib.variant = f.rows[0].variant;
    }],
  ];
  let missed = 0;
  console.log("\nself-test — each planted defect must be caught:");
  for (const [what, breakIt] of planted) {
    const f = clone();
    breakIt(f);
    const caught = RULES.some((r) => r.run(f) !== null);
    if (!caught) { missed++; console.log(`  MISSED  ${what}`); }
    else console.log(`  caught  ${what}`);
  }
  if (missed) { console.error(`\n${missed} planted defect(s) slipped through — the gate does not do what it claims.`); process.exit(1); }
}

if (failed) {
  console.error(`\n${failed} blocking check(s) failed.\n\n  The remedy is DATA, not code: regenerate the set from the current catalogue\n  with \`node scripts/build-demo-set.mjs --write\`, then rebuild the blobs with\n  \`node scripts/build-demo-payload.mjs --put\`. Do not widen the rules to fit.`);
  process.exit(1);
}
console.log("\nAll blocking checks passed.");
