// The numbers we publish about the catalogue, in ONE place.
//
// They were typed into ten: the two MCP tool descriptions, server.json (which
// the MCP registry serves to agents), README.md four times, and openapi.yaml
// three times. By 2026-10-05 every copy was stale — "102,191 variants" against
// 103,099 live, "116 brands" against 119, "19 languages" against 20 — and the
// MCP description is the shop window an agent reads before deciding whether to
// call us at all. Same defect class as llms.txt drifting from the catalogue
// (31 numbers wrong, one read "277" where the answer was 105).
//
// Verified against the database by scripts/verify-catalogue-facts.mjs, which
// refuses to run while the monthly pipeline is rewriting cars_v3. A number
// here without a passing check is a claim, not a fact.

/** Measured 2026-10-04 against cars_v3, BEFORE the October pipeline run
 *  finished. Re-run scripts/verify-catalogue-facts.mjs once the run and the
 *  three data gates are through, and update here if any of them moved. */
export const CATALOGUE_AS_OF = "2026-10-04";

export const CATALOGUE = {
  /** Active variants. SELECT count(*) FROM variants WHERE is_active. */
  variants: 103_099,
  /** Variants that actually carry a spec document. 909 active variants have no
   *  `variant_doc` row and would answer with empty specs — which is also where
   *  the old published "102,191 variants" came from: it was this number wearing
   *  the other one's label. */
  variantsWithSpecs: 102_190,
  /** Brands with at least one active variant — NOT the 527-row master list. */
  brands: 119,
  generations: 5_395,
  /** Spec types DEFINED in specs_catalog (all 224 are is_active). */
  specTypesDefined: 224,
  /** Spec types that actually appear in the data:
   *  SELECT count(DISTINCT k) FROM variant_doc, jsonb_object_keys(specs) k.
   *  Published separately from the definitions on purpose — "224 spec types"
   *  as a promise of what you GET is an overclaim, and the "180" it replaced
   *  was simply wrong in both directions. */
  specTypesPresent: 163,
  specCategories: 21,
  /** Site locales. Derived from SUPPORTED_LOCALES, never typed. */
  get locales(): number {
    return SUPPORTED_LOCALES_COUNT;
  },
} as const;

// Imported as a number rather than the array to keep this module free of
// cycles (locale.ts imports nothing).
import { SUPPORTED_LOCALES } from "./locale";
const SUPPORTED_LOCALES_COUNT = SUPPORTED_LOCALES.length;

/** For prose: "103,099" in the one grouping we publish in. */
export const n = (v: number) => v.toLocaleString("en-US");
