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

/** Measured against **cars_prod** — the database the API actually serves.
 *
 *  Verified by scripts/verify-catalogue-facts.mjs --prod. The first version of
 *  this file was verified against the LOCAL replica and was wrong in both
 *  directions: the replica runs ahead on variant counts (it had the October
 *  import, prod does not) and behind on enrichment. Published that way, /mcp
 *  told agents "103,372 variants" while /v1/health answered 103,099 — two
 *  numbers from the same API disagreeing, which is the exact defect this file
 *  exists to prevent, recreated one database over.
 *
 *  Re-run the verifier after every prod data deploy, not after every import. */
export const CATALOGUE_AS_OF = "2026-10-10";

export const CATALOGUE = {
  /** Active variants in prod. */
  variants: 103_372,
  /** Variants carrying a spec document — 103.371 of 103.372 in prod, i.e. all
   *  but one. The "909 missing" noted earlier was a local-replica artifact:
   *  mid-import the replica had fewer spec docs than live. */
  variantsWithSpecs: 103_371,
  /** Brands with at least one active variant — NOT the 527-row master list. */
  brands: 120,
  generations: 5_428,
  /** Spec types DEFINED in specs_catalog (all active). */
  specTypesDefined: 224,
  /** Spec types that actually appear in prod data. Published separately from
   *  the definitions because 224 as a promise of what you GET is an overclaim —
   *  but the honest figure is 222, not the 163 the local replica showed. */
  specTypesPresent: 222,
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
