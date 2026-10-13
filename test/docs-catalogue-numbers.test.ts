import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CATALOGUE, n } from "../src/lib/catalogue-facts";

// README.md and openapi.yaml are the last two places that published catalogue
// numbers by hand (T290). On 2026-10-13 both still said 103,099 variants,
// 5,395 generations and 221 spec types present, the README said 119 brands,
// and both said "1,300+ models" — figures from before catalogue-facts.ts was
// re-verified against cars_prod on 10-10. /mcp, /v1/health and server.json
// had been corrected; the two documents a human reads first had not.
//
// This does not check that the facts are TRUE (`npm run verify:catalogue`
// owns that, over ssh). It checks that every document says what the facts say,
// so the next time catalogue-facts.ts moves, this suite names every stale copy.
//
// It reads PATTERNS, not a list of known sentences: a list would miss the copy
// added next month. Small numbers (the 40-car demo: 5 brands, 2 generations,
// 2-4 variants to compare) are not catalogue numbers and are left alone.

const DOCS = ["README.md", "openapi.yaml"] as const;
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf-8");

/** "noun → the one value it may be published with", for any number >= 100. */
const RULES: [RegExp, number, string][] = [
  [/(\d[\d,]*)\+?\**\s+(?:vehicle\s+)?variants/gi, CATALOGUE.variants, "variants"],
  [/(\d[\d,]*)\+?\**\s+brands/gi, CATALOGUE.brands, "brands"],
  [/(\d[\d,]*)\+?\**\s+models/gi, CATALOGUE.models, "models"],
  [/(\d[\d,]*)\+?\**\s+generations/gi, CATALOGUE.generations, "generations"],
  [/(\d[\d,]*)\+?\**\s+(?:spec\s+)?types(?:\s+defined)?/gi, CATALOGUE.specTypesDefined, "specTypesDefined"],
  [/(\d[\d,]*)\s+present/gi, CATALOGUE.specTypesPresent, "specTypesPresent"],
  [/(\d[\d,]*)\s+categories/gi, CATALOGUE.specCategories, "specCategories"],
  [/(\d[\d,]*)\**\s+languages/gi, CATALOGUE.locales, "locales"],
];

/** Every "<number> <noun>" in a doc whose number disagrees with the fact. */
function staleIn(text: string): string[] {
  const out: string[] = [];
  for (const [re, fact, name] of RULES) {
    for (const m of text.matchAll(re)) {
      const raw = m[1];
      const value = Number(raw.replace(/,/g, ""));
      // Demo-set arithmetic ("5 brands x 2 models") is not a catalogue claim —
      // except for languages and categories, which are small AND catalogue-wide.
      if (value < 100 && name !== "locales" && name !== "specCategories") continue;
      const exact = raw === (value >= 1000 ? n(fact) : String(fact));
      const rounded = /\+/.test(m[0]);
      if (!exact || rounded) out.push(`"${m[0].trim()}" — ${name} is ${n(fact)}`);
    }
  }
  return out;
}

describe("README.md and openapi.yaml publish the numbers in catalogue-facts.ts (T290)", () => {
  for (const doc of DOCS) {
    test(`${doc}: no stale or rounded catalogue number`, () => {
      expect(staleIn(read(doc)), `${doc} disagrees with src/lib/catalogue-facts.ts — edit the doc, never the fact`).toEqual([]);
    });
  }

  test("the headline facts are actually published, not just not-contradicted", () => {
    for (const doc of DOCS) {
      const text = read(doc);
      expect(text, doc).toContain(n(CATALOGUE.variants));
      expect(text, doc).toContain(n(CATALOGUE.models));
      expect(text, doc).toContain(n(CATALOGUE.generations));
    }
  });

  test("the guard catches the exact copies it was written for", () => {
    // Red on the 2026-10-13 text, so a regex that matches nothing cannot pass.
    for (const stale of [
      "**103,099 vehicle variants**, **1,300+ models**, **5,395 generations**",
      "224 spec types defined (221 present in the data)",
      "across 103,099 variants, 119 brands, 20 languages",
      "across 103,372 variants, 120 brands, 19 languages",
      "224 spec types across 19 categories",
    ]) {
      expect(staleIn(stale), stale).not.toEqual([]);
    }
    expect(staleIn("5 brands x 2 models x 2 generations x 2 variants")).toEqual([]);
    expect(staleIn(`${n(CATALOGUE.variants)} variants, ${CATALOGUE.brands} brands, ${CATALOGUE.locales} languages`)).toEqual([]);
  });
});
