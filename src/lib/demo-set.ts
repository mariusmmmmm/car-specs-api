// PLACEHOLDER — the real file is written by scripts/build-demo-set.mjs --write.
//
// It is NOT generated yet, on purpose: the monthly pipeline was mid-run when
// T92 was implemented (2026-10-04 22:59, stage a1) and `cars_v3` was being
// rewritten under us — `Mild Hybrid` read 1.252 active variants at 22:20 and 37
// at 23:05. A set frozen against half-imported data is a guard that goes red
// the next morning. The set is generated once the run finishes and the three
// data gates pass.
//
// Readiness is DERIVED from the set, not declared beside it: a boolean next to
// the data is one more thing that can disagree with it. An ungenerated set has
// 0 ids, a generated one has DEMO_SET_SIZE, and routes/demo.ts refuses to serve
// anything until they match — a demo key must FAIL rather than quietly serve an
// empty catalogue or, worse, fall through to the full one.

export const DEMO_VARIANT_IDS: ReadonlySet<number> = new Set<number>();
export const DEMO_GENERATION_IDS: ReadonlySet<number> = new Set<number>();
export const DEMO_MODEL_IDS: ReadonlySet<number> = new Set<number>();

/** What the set contains, by name — safe to print in a log or a report.
 *  The brands and models are a decision (T92 §5.1.1); only the ids are derived. */
export const DEMO_SET_DESCRIPTION =
  "Volkswagen: Golf, Transporter · BMW: 3-serie, i3 · Toyota: Corolla, Prius · Hyundai: Tucson, Nexo · Ford: Focus, Mustang";

/** How many variants the generated set must contain, asserted by the guard. */
export const DEMO_SET_SIZE = 40;

export const demoSetReady = (): boolean => DEMO_VARIANT_IDS.size === DEMO_SET_SIZE;
