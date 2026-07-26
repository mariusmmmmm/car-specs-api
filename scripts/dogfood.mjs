#!/usr/bin/env node
// Dogfood harness (BIZ-L2a-openapi-readmodel.md §4 step 5): exercises /v1 the
// way a real internal surface would, to validate the read-model on
// realistic traffic before any external client touches it — no v3/ changes
// needed for this pass. Mirrors v3/app/api/topbar-search/route.ts's job
// (typeahead across brand/model/variant names) since that's the closest
// real internal consumer, and that route is mid-incident-fix on another
// branch right now, so this dogfooding intentionally stays out of v3/.
//
// Prereq: `npm run dev` (wrangler dev --local) running on :8790.
//
// Usage: node scripts/dogfood.mjs

const BASE = process.env.API_BASE ?? "http://localhost:8790";
const SLOW_MS = 500; // topbar-search's own incident was queries taking 3000ms+; this is the bar /v1 must clear.

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

async function main() {
  const health = await timed("GET /v1/health", () => fetch(`${BASE}/v1/health`).then((r) => r.json()));
  if (health?.data?.status !== "ok") throw new Error("health check failed");
  console.log(`  active_variants: ${health.data.active_variants}`);

  const keyResp = await timed("POST /v1/keys (issue dogfood key)", () =>
    fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dogfood@cars-data.com", accept_tos: true }),
    }).then((r) => r.json()),
  );
  const apiKey = keyResp.data.api_key;
  const headers = { "X-Api-Key": apiKey };

  // Realistic typeahead queries — same shape of input topbar-search handles.
  const queries = ["bmw", "corolla", "3 series", "tesla model", "golf gti"];
  for (const q of queries) {
    const res = await timed(`GET /v1/search?q=${JSON.stringify(q)}`, () =>
      fetch(`${BASE}/v1/search?q=${encodeURIComponent(q)}&locale=en`, { headers }).then((r) => r.json()),
    );
    const n = res?.data?.length ?? 0;
    console.log(`  -> ${n} hits`);
    if (n === 0) {
      console.error(`  FAIL: expected hits for "${q}"`);
      failures++;
    }
  }

  // Full drill-down a real page would do: brand -> models -> generations -> variants -> localized specs.
  const brands = await timed("GET /v1/brands", () => fetch(`${BASE}/v1/brands`, { headers }).then((r) => r.json()));
  const bmw = brands.data.find((b) => b.slug === "bmw");
  if (!bmw) throw new Error("bmw not found in /v1/brands");

  const models = await timed(`GET /v1/brands/bmw/models`, () =>
    fetch(`${BASE}/v1/brands/bmw/models`, { headers }).then((r) => r.json()),
  );
  const model = models.data[0];

  const generations = await timed(`GET /v1/models/${model.id}/generations`, () =>
    fetch(`${BASE}/v1/models/${model.id}/generations`, { headers }).then((r) => r.json()),
  );
  const generation = generations.data[0];

  const variantsList = await timed(`GET /v1/generations/${generation.id}/variants`, () =>
    fetch(`${BASE}/v1/generations/${generation.id}/variants`, { headers }).then((r) => r.json()),
  );
  const variant = variantsList.data[0];

  for (const locale of ["en", "ro", "de", "ar"]) {
    const specs = await timed(`GET /v1/variants/${variant.variant_id}/specs?locale=${locale}`, () =>
      fetch(`${BASE}/v1/variants/${variant.variant_id}/specs?locale=${locale}`, { headers }).then((r) => r.json()),
    );
    const specCount = Object.keys(specs?.data?.specs ?? {}).length;
    console.log(`  -> ${specCount} localized specs`);
    if (specCount === 0) {
      console.error(`  FAIL: 0 specs for variant ${variant.variant_id} locale ${locale}`);
      failures++;
    }
  }

  const usage = await timed("GET /v1/usage", () => fetch(`${BASE}/v1/usage`, { headers }).then((r) => r.json()));
  console.log(`  -> used ${usage.data.used}/${usage.data.quota}`);

  console.log(failures === 0 ? "\nDogfood PASS" : `\nDogfood: ${failures} issue(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Dogfood harness crashed:", err);
  process.exit(1);
});
