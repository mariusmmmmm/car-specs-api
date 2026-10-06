#!/usr/bin/env node
// T107 — picks the frozen demo set and writes src/lib/demo-set.ts.
//
// The set is 5 brands x 2 models x 2 generations x 2 variants = 40 variants,
// chosen in specs/plans/T107-api-key-abuse-strategy.md §5.1.1. The brands and
// models are a DECISION and live here as names; everything numeric is derived
// from the database, so this script is the only place the real ids are read.
//
//   node scripts/build-demo-set.mjs            # report, write nothing
//   node scripts/build-demo-set.mjs --write    # also write src/lib/demo-set.ts
//
// Reads the LOCAL replica (cars_v3) read-only. Never run against production:
// prod ids and local ids are the same public_id values, but the set must be
// reproducible from the replica the pipeline writes.
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../src/lib/demo-set.ts");
const WRITE = process.argv.includes("--write");
const DSN = process.env.DEMO_SET_DSN ?? "postgresql://localhost:5432/cars_v3";

// The decision from §5.1.1. Order matters only for readable output.
const CHOICE = [
  { brand: "Volkswagen", models: ["Golf", "Transporter"] },
  { brand: "BMW", models: ["3-serie", "i3"] },
  { brand: "Toyota", models: ["Corolla", "Prius"] },
  { brand: "Hyundai", models: ["Tucson", "Nexo"] },
  { brand: "Ford", models: ["Focus", "Mustang"] },
];

const GEN_PER_MODEL = 2;
const VAR_PER_GEN = 2;
const MIN_SPECS = 100;

const sql = postgres(DSN, { max: 4, idle_timeout: 5 });

/** Every candidate variant under one model, with what the guard needs to judge
 *  it: its generation, its fuel, how many specs it carries and whether it has
 *  an image. A generation only counts if it has at least VAR_PER_GEN such
 *  variants — a demo car with no specs or no photo demonstrates nothing. */
async function candidates(brand, model) {
  // Two steps on purpose. A single query with global LEFT JOIN aggregates over
  // spec_values (15,7M rows) and entity_media (2,0M) re-scans both for every
  // model — measured: it does not finish in two minutes. So: pick the candidate
  // variants first (indexed, tens of rows), then count only for those ids.
  const rows = await sql`
    SELECT v.public_id    AS variant_id,
           v.display_name AS variant,
           v.fuel_type_en AS fuel,
           g.public_id    AS generation_id,
           g.display_name AS generation,
           g.years_start  AS year_from,
           m.public_id    AS model_id
    FROM variants v
    JOIN generations g ON g.id = v.generation_id
    JOIN models m      ON m.id = g.model_id
    JOIN brands b      ON b.id = m.brand_id
    WHERE v.is_active AND b.display_name = ${brand} AND m.display_name = ${model}
    ORDER BY g.public_id, v.public_id
  `;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r.variant_id));
  const [specs, images] = await Promise.all([
    sql`SELECT entity_id, count(*)::int n FROM spec_values
         WHERE entity_kind::text = 'variant' AND entity_id = ANY(${ids}) GROUP BY 1`,
    sql`SELECT entity_id, count(*)::int n FROM entity_media
         WHERE entity_kind::text = 'variant' AND entity_id = ANY(${ids}) GROUP BY 1`,
  ]);
  const specBy = new Map(specs.map((r) => [Number(r.entity_id), r.n]));
  const imgBy = new Map(images.map((r) => [Number(r.entity_id), r.n]));
  return rows
    .map((r) => ({
      ...r,
      spec_count: specBy.get(Number(r.variant_id)) ?? 0,
      image_count: imgBy.get(Number(r.variant_id)) ?? 0,
    }))
    .filter((r) => r.spec_count >= MIN_SPECS && r.image_count >= 1);
}

// Selection is greedy on fuel at BOTH levels, and that is not an optimisation —
// it is the only way the two constraints hold at once. The brands make all 10
// fuels REACHABLE (§5.1.1), but a model contributes 2 generations and a
// generation 2 variants, so a first attempt that took "newest + oldest" per
// model came out with 7 fuels: Ethanol, LPG and Mild Hybrid live in the MIDDLE
// generations of Focus and Golf, which that rule never reached.
//
// Models are processed scarce-first: Focus is the only nameplate carrying
// Ethanol, LPG and CNG together, so it has to choose its generations before
// Mustang spends a slot on another petrol car.
const MODEL_ORDER = [
  ["Ford", "Focus"],          // Ethanol + LPG + CNG — the only source of two of them
  ["Volkswagen", "Golf"],     // CNG, LPG, PHEV, Electric in one nameplate
  ["Hyundai", "Tucson"],      // Mild Hybrid + Hybrid + PHEV
  ["BMW", "3-serie"],         // Mild Hybrid + PHEV
  ["Volkswagen", "Transporter"],
  ["BMW", "i3"],              // Electric + range-extender PHEV
  ["Toyota", "Prius"],
  ["Toyota", "Corolla"],
  ["Hyundai", "Nexo"],        // the only FCEV model with two eligible generations
  ["Ford", "Mustang"],
];

const MIN_IMAGES_PREFERRED = 4;

function groupByGeneration(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.generation_id)) by.set(r.generation_id, []);
    by.get(r.generation_id).push(r);
  }
  // A generation qualifies only if it can field VAR_PER_GEN variants with
  // DISTINCT display names. Some nameplates (Mustang) carry several rows whose
  // display_name is identical because the trim differs in a field the name does
  // not show; a demo that lists the same car twice reads as broken even when
  // both rows are real data.
  return [...by.entries()].filter(
    ([, v]) => v.length >= VAR_PER_GEN && new Set(v.map((r) => r.variant)).size >= VAR_PER_GEN,
  );
}

/** The 2 variants of one generation that add the most new fuel, then the most
 *  photos, and never two rows with the same display name — a demo that lists
 *  the same car twice reads as broken even when the data is right. */
function pickVariants(genRows, fuelsSeen) {
  // One pick at a time, re-scoring in between. Scoring the whole generation up
  // front and then taking the top two is WRONG and it showed: the Tucson
  // generation that holds both Hybrid and Mild Hybrid came out as two Hybrids,
  // because the second pick still believed Hybrid was novel.
  const out = [];
  const namesTaken = new Set();
  const score = (r) =>
    (fuelsSeen.has(r.fuel) ? 0 : 1000) +
    (namesTaken.has(r.variant) ? -500 : 0) +
    Math.min(r.image_count, 60) +
    r.spec_count / 100;
  while (out.length < VAR_PER_GEN) {
    const left = genRows.filter((r) => !out.includes(r));
    if (left.length === 0) break;
    const best = left.reduce((a, b) => (score(b) > score(a) ? b : a));
    out.push(best);
    namesTaken.add(best.variant);
    fuelsSeen.add(best.fuel);
  }
  return out;
}

/** The 2 generations of one model that together add the most new fuel. Ties go
 *  to the wider year gap, so the set still shows the historical range, and then
 *  to the generation with more photos. */
function pickGenerations(eligible, fuelsSeen) {
  if (eligible.length < GEN_PER_MODEL) return null;
  const novelFuels = ([, rows]) => new Set(rows.map((r) => r.fuel).filter((f) => !fuelsSeen.has(f))).size;
  const year = ([, rows]) => Math.min(...rows.map((r) => r.year_from ?? 9999));
  const photos = ([, rows]) => Math.max(...rows.map((r) => r.image_count));

  let best = null;
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i], b = eligible[j];
      // Cap each generation's contribution at VAR_PER_GEN distinct new fuels —
      // a generation holding five fuels still only gets to send two variants,
      // and counting all five made the picker choose pairs it could not deliver.
      const novelIn = (g) => [...new Set(g[1].map((r) => r.fuel))].filter((f) => !fuelsSeen.has(f));
      const fa = novelIn(a).slice(0, VAR_PER_GEN);
      const fb = novelIn(b).filter((f) => !fa.includes(f)).slice(0, VAR_PER_GEN);
      const fuels = new Set([...fa, ...fb]);
      const cand = {
        pair: [a, b],
        novel: fuels.size,
        span: Math.abs(year(a) - year(b)),
        photos: Math.min(photos(a), photos(b)),
      };
      if (
        !best ||
        cand.novel > best.novel ||
        (cand.novel === best.novel && cand.span > best.span) ||
        (cand.novel === best.novel && cand.span === best.span && cand.photos > best.photos)
      ) best = cand;
    }
  }
  // newest first, for readable output
  return [...best.pair].sort((x, y) => year(y) - year(x));
}

const fuelsSeen = new Set();
const chosen = [];
const report = [];
let failed = false;

for (const [brand, model] of MODEL_ORDER) {
  const rows = await candidates(brand, model);
  const eligible = groupByGeneration(rows);
  const gens = pickGenerations(eligible, fuelsSeen);
  if (!gens) {
    console.error(`! ${brand} ${model}: fewer than ${GEN_PER_MODEL} generations with ${VAR_PER_GEN}+ usable variants (>=${MIN_SPECS} specs, >=1 image) — the decision in §5.1.1 no longer holds against the data.`);
    failed = true;
    continue;
  }
  for (const [, genRows] of gens) {
    const picked = pickVariants(genRows, fuelsSeen);
    if (picked.length < VAR_PER_GEN) { failed = true; continue; }
    chosen.push(...picked);
    report.push({
      brand, model,
      generation: picked[0].generation,
      variants: picked.map((p) => `${p.variant} [${p.fuel}]`),
      specs: picked.map((p) => Number(p.spec_count)),
      images: picked.map((p) => Number(p.image_count)),
    });
  }
}

console.log(`\nDemo set — ${chosen.length} variants, ${CHOICE.length} brands, ${new Set(chosen.map((c) => c.fuel)).size} distinct fuels\n`);
for (const r of report) {
  console.log(`  ${r.brand} ${r.model} — ${r.generation}`);
  r.variants.forEach((v, i) => console.log(`      ${v}  (${r.specs[i]} specs, ${r.images[i]} images)`));
}
console.log(`\nFuels covered: ${[...new Set(chosen.map((c) => c.fuel))].sort().join(", ")}`);

const variantIds = [...new Set(chosen.map((c) => Number(c.variant_id)))].sort((a, b) => a - b);
const generationIds = [...new Set(chosen.map((c) => Number(c.generation_id)))].sort((a, b) => a - b);
const modelIds = [...new Set(chosen.map((c) => Number(c.model_id)))].sort((a, b) => a - b);

if (failed) {
  console.error("\nRefusing to write: the selection did not come out complete.");
  await sql.end();
  process.exit(1);
}

if (WRITE) {
  const body = `// GENERATED by scripts/build-demo-set.mjs — do not edit by hand.
// The frozen demo set (T107 §5.1.1): ${CHOICE.length} brands x 2 models x 2 generations
// x 2 variants = ${variantIds.length} variants, covering ${new Set(chosen.map((c) => c.fuel)).size} of the 10 fuel types.
//
// FROZEN ON PURPOSE. Reading the set from the database at runtime would let it
// widen silently at the next import; the demo's whole guarantee is that it is
// the same ${variantIds.length} cars no matter how many demo keys exist.
//
// These are internal public_id values. They are never served: the API hands out
// opaque tokens (lib/public-id.ts) and this file is server-side only.
// Regenerate with: node scripts/build-demo-set.mjs --write
// Generated ${new Date().toISOString().slice(0, 10)} from the local cars_v3 replica.

export const DEMO_VARIANT_IDS: ReadonlySet<number> = new Set([
${variantIds.map((i) => `  ${i},`).join("\n")}
]);

export const DEMO_GENERATION_IDS: ReadonlySet<number> = new Set([
${generationIds.map((i) => `  ${i},`).join("\n")}
]);

export const DEMO_MODEL_IDS: ReadonlySet<number> = new Set([
${modelIds.map((i) => `  ${i},`).join("\n")}
]);

/** What the set contains, by name — safe to print in a log or a report. */
export const DEMO_SET_DESCRIPTION = ${JSON.stringify(
  CHOICE.map((c) => `${c.brand}: ${c.models.join(", ")}`).join(" · "),
)};
`;
  fs.writeFileSync(OUT, body);
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)} — ${variantIds.length} variants, ${generationIds.length} generations, ${modelIds.length} models.`);
} else {
  console.log("\n(dry run — pass --write to update src/lib/demo-set.ts)");
}

await sql.end();
