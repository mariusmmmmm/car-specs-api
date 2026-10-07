#!/usr/bin/env node
// Dogfood harness (BIZ-L2a-openapi-readmodel.md §4 step 5): exercises /v1 the
// way a real internal surface would, to validate the read-model on
// realistic traffic before any external client touches it — no v3/ changes
// needed for this pass. Mirrors v3/app/api/topbar-search/route.ts's job
// (typeahead across brand/model/variant names) since that's the closest
// real internal consumer, and that route is mid-incident-fix on another
// branch right now, so this dogfooding intentionally stays out of v3/.
//
// ── T135: why this script stopped working, and what changed here ────────────
//
// It had been broken since August and stayed broken through T111. Two separate
// defects, both of which made it die before it exercised anything:
//
//  1. It used to POST /v1/keys and read `data.api_key` off the response. That
//     field is gone. Post-T73 the route answered `pending_review`; post-T111 it
//     is an alias of POST /v1/keys/demo, which only records the request and
//     emails a one-click activation link — `api_key` appears in the response to
//     GET /v1/keys/demo/verify (routes/keys-demo.ts), not at request time. A
//     harness cannot click a link in an inbox, so it does not ask for a key at
//     all any more: it TAKES one from DOGFOOD_API_KEY.
//
//  2. The drill-down constructed URLs out of raw integer ids. T111 made every
//     id the API hands out an opaque, domain-separated token (lib/public-id.ts),
//     so `/v1/generations/5395/variants` is now a 404 by design. Every id this
//     script sends is now one the API handed back, verbatim — and the shape is
//     asserted, so a regression that reverts an id to an integer is a loud
//     failure here rather than a silent re-leak of the id space.
//
// ── The key ────────────────────────────────────────────────────────────────
//
// DOGFOOD_API_KEY must be a key on a plan that reaches the CATALOGUE — `free`
// or `apify`. The only self-serve key is `demo`, and a demo key never reaches
// routes/catalog.ts at all: routes/v1.ts dispatches it to the 40-car blob in
// routes/demo.ts, which does not serve /brands/:slug/models or
// /generations/:id/variants. So this script checks the plan first and refuses
// to pretend, rather than reporting hundreds of 404s.
//
//   prod  : node scripts/keys-admin.mjs grant dogfood@cars-data.com free
//           (owner-only; writes to the production KV namespace)
//   local : ADMIN_TOKEN=<.dev.vars value> API_BASE=http://localhost:8790 \
//             node scripts/keys-admin.mjs grant dogfood@cars-data.com free
//
// Prereq: a server to talk to. `npm run dev` (wrangler dev --local) on :8790 by
// default; API_BASE overrides it.
//
// Usage: DOGFOOD_API_KEY=cd_free_… node scripts/dogfood.mjs
//
// Exit codes: 0 all green · 1 the API misbehaved · 2 the harness was not given
// what it needs (no key / wrong plan) — a distinct code so CI can tell "the API
// is broken" from "nobody set the variable".

const BASE = process.env.API_BASE ?? "http://localhost:8790";
const SLOW_MS = 500; // topbar-search's own incident was queries taking 3000ms+; this is the bar /v1 must clear.

const apiKey = process.env.DOGFOOD_API_KEY;
if (!apiKey) {
  console.error(
    [
      "",
      "DOGFOOD_API_KEY is not set — refusing to run.",
      "",
      "This harness no longer issues its own key: POST /v1/keys stopped returning one",
      "in August and now only emails a one-click activation link (routes/keys-demo.ts).",
      "",
      "Give it a key on a catalogue plan (free or apify — NOT demo):",
      "",
      "  node scripts/keys-admin.mjs grant dogfood@cars-data.com free",
      "  DOGFOOD_API_KEY=cd_free_… node scripts/dogfood.mjs",
      "",
    ].join("\n"),
  );
  process.exit(2);
}
const headers = { "X-Api-Key": apiKey };

let failures = 0;

async function timed(label, fn) {
  const start = performance.now();
  const result = await fn();
  const ms = Math.round(performance.now() - start);
  const flag = ms > SLOW_MS ? " SLOW" : "";
  console.log(`${ms.toString().padStart(5)}ms${flag}  ${label}`);
  if (ms > SLOW_MS) failures++;
  return result;
}

const get = (path) => fetch(`${BASE}${path}`, { headers }).then((r) => r.json());

/** Every id below is one the API handed back. This asserts it actually IS a
 *  token before it is sent anywhere, so the day a route starts projecting a
 *  bare integer again the harness says so instead of quietly working. */
const TOKEN_RE = { variant: /^v_[0-9a-f]{8}$/, generation: /^g_[0-9a-f]{8}$/, model: /^m_[0-9a-f]{8}$/ };
function expectToken(kind, value, where) {
  if (typeof value === "string" && TOKEN_RE[kind].test(value)) return value;
  console.error(`  FAIL: ${where} is not an opaque ${kind} id: ${JSON.stringify(value)}`);
  failures++;
  return value;
}

async function main() {
  const health = await timed("GET /v1/health", () => fetch(`${BASE}/v1/health`).then((r) => r.json()));
  if (health?.data?.status !== "ok") throw new Error("health check failed");
  console.log(`  active_variants: ${health.data.active_variants}`);

  // Plan first: a demo key is dispatched to the 40-car blob before it ever
  // reaches the catalogue routes below, so running on one would produce a wall
  // of 404s that say nothing about the read-model.
  const whoami = await timed("GET /v1/usage (plan check)", () => get("/v1/usage"));
  const plan = whoami?.data?.plan;
  if (!plan) {
    console.error(`  FAIL: /v1/usage did not answer — key rejected? ${JSON.stringify(whoami)}`);
    process.exit(2);
  }
  console.log(`  plan: ${plan}`);
  if (plan === "demo") {
    console.error(
      "\nDOGFOOD_API_KEY is a DEMO key. It is answered entirely from the 40-car blob and\n" +
        "never reaches the catalogue, so this harness cannot exercise the read-model with\n" +
        "it. Mint a catalogue key: node scripts/keys-admin.mjs grant <email> free",
    );
    process.exit(2);
  }
  // The apify plan keeps RAW integer ids in both directions, by measured
  // exception (middleware/opaque-ids.ts). The token assertions below would all
  // fire on it and mean the opposite of what they say.
  const idsAreOpaque = plan !== "apify";

  // Realistic typeahead queries — same shape of input topbar-search handles.
  const queries = ["bmw", "corolla", "3 series", "tesla model", "golf gti"];
  let seed = null; // first hit of the first query — the drill-down starts here.
  for (const q of queries) {
    const res = await timed(`GET /v1/search?q=${JSON.stringify(q)}`, () =>
      get(`/v1/search?q=${encodeURIComponent(q)}&locale=en`),
    );
    const n = res?.data?.length ?? 0;
    console.log(`  -> ${n} hits`);
    if (n === 0) {
      console.error(`  FAIL: expected hits for "${q}"`);
      failures++;
    } else if (!seed) {
      seed = res.data[0];
    }
  }
  if (!seed) throw new Error("no search hit to drill down from");

  // Full drill-down a real page would do: brand -> models -> generations -> variants -> localized specs.
  const brands = await timed("GET /v1/brands", () => get("/v1/brands"));
  const bmw = brands.data.find((b) => b.slug === "bmw");
  if (!bmw) throw new Error("bmw not found in /v1/brands");

  const models = await timed("GET /v1/brands/bmw/models", () => get("/v1/brands/bmw/models"));
  const model = models.data[0];
  if (!model) throw new Error("no models for bmw");
  console.log(`  -> ${models.data.length} models, first: ${model.slug}`);

  // The brand -> model -> generation leg is BROKEN API-SIDE, and this is where
  // a real client finds out. /v1/brands/:slug/models projects the model's
  // public_id as `id`, which middleware/opaque-ids.ts does not rewrite (its
  // field table is variant_id / generation_id / model_id), while
  // /v1/models/:id/generations strictly decodes an `m_…` token. So the list
  // hands out an id its own successor route refuses, and nothing else in /v1
  // emits a model token. Not fixable from this script: the fix is projecting
  // the field as `model_id` in routes/catalog.ts. Reported, not routed around —
  // a harness that skipped it is how this stayed invisible for two months.
  const modelIdIsToken = typeof model.id === "string" && TOKEN_RE.model.test(model.id);
  const genStep = await timed(`GET /v1/models/${model.id}/generations`, () =>
    get(`/v1/models/${encodeURIComponent(model.id)}/generations`),
  );
  if (genStep?.status === 404 || !genStep?.data) {
    failures++;
    if (idsAreOpaque && !modelIdIsToken) {
      console.error(
        `  FAIL (API defect, not this script): /v1/brands/bmw/models returned id=${JSON.stringify(model.id)},\n` +
          "        a raw public_id. /v1/models/:id/generations only accepts an m_… token, and no\n" +
          "        /v1 route emits one — so brand -> model -> generation is unreachable for every\n" +
          "        client. Fix: project the column as `model_id` in routes/catalog.ts so the one\n" +
          "        gate in middleware/opaque-ids.ts rewrites it. (It also leaks the raw id space.)",
      );
    } else {
      console.error(`  FAIL: /v1/models/${model.id}/generations: ${JSON.stringify(genStep)}`);
    }
  } else {
    console.log(`  -> ${genStep.data.length} generations`);
    for (const g of genStep.data) if (idsAreOpaque) expectToken("model", g.model_id, "generations[].model_id");
  }

  // Carry on down the legs that ARE reachable, using the generation token the
  // search result handed back rather than one built out of an integer.
  if (idsAreOpaque) expectToken("generation", seed.generation_id, "search[0].generation_id");
  console.log(`  drill-down seed: ${seed.brand_slug}/${seed.model_slug} generation ${seed.generation_id}`);

  const variantsList = await timed(`GET /v1/generations/${seed.generation_id}/variants`, () =>
    get(`/v1/generations/${encodeURIComponent(seed.generation_id)}/variants`),
  );
  const variant = variantsList?.data?.[0];
  if (!variant) throw new Error(`no variants for generation ${seed.generation_id}: ${JSON.stringify(variantsList)}`);
  console.log(`  -> ${variantsList.data.length} variants, first: ${variant.display_name}`);
  if (idsAreOpaque) {
    expectToken("variant", variant.variant_id, "variants[0].variant_id");
    expectToken("generation", variant.generation_id, "variants[0].generation_id");
  }

  for (const locale of ["en", "ro", "de", "ar"]) {
    const specs = await timed(`GET /v1/variants/${variant.variant_id}/specs?locale=${locale}`, () =>
      get(`/v1/variants/${encodeURIComponent(variant.variant_id)}/specs?locale=${locale}`),
    );
    const specCount = Object.keys(specs?.data?.specs ?? {}).length;
    console.log(`  -> ${specCount} localized specs`);
    if (specCount === 0) {
      console.error(`  FAIL: 0 specs for variant ${variant.variant_id} locale ${locale}`);
      failures++;
    }
  }

  const usage = await timed("GET /v1/usage", () => get("/v1/usage"));
  console.log(`  -> used ${usage.data.used}/${usage.data.quota}`);

  console.log(failures === 0 ? "\nDogfood PASS" : `\nDogfood: ${failures} issue(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Dogfood harness crashed:", err);
  process.exit(1);
});
