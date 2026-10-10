import { describe, test, expect } from "vitest";
import { CATALOGUE, CATALOGUE_AS_OF } from "../src/lib/catalogue-facts";

// D-06 (owner, 2026-10-10): `/v1/health` publică acum numărul din `catalogue-facts.ts`
// în loc să-l numere la fiecare apel. Asta închide dezacordul cu `src/mcp.ts`, care
// citea deja constanta — dar mută riscul: un număr greșit nu mai e o nepotrivire între
// două rute, e o cifră greșită servită public de amândouă.
//
// Verifierul care prinde deriva (`npm run verify:catalogue`) cere ssh la `cars_prod`,
// deci nu poate rula în suita asta. Dar ACEST test poate rula oriunde, și forțează
// rularea lui: dacă stampila a rămas în urmă, suita pică și spune exact ce comandă
// repară.
//
// De ce există: pe 2026-10-10 constanta era în derivă pe CINCI cifre (variants
// 103.099 vs 103.372 reale) fiindcă verifierul ei nu pornea deloc — emitea CommonJS
// într-un pachet ESM. A stat stricat luni de zile, tăcut, exact fiindcă nimic nu
// depindea de el. Acum depinde asta.

const MAX_AGE_DAYS = 45;

describe("catalogue facts — prospețime", () => {
  test(`stampila nu e mai veche de ${MAX_AGE_DAYS} de zile`, () => {
    const asOf = new Date(`${CATALOGUE_AS_OF}T00:00:00Z`);
    expect(Number.isNaN(asOf.getTime()), `CATALOGUE_AS_OF nu e o dată validă: ${CATALOGUE_AS_OF}`).toBe(false);

    const ageDays = Math.floor((Date.now() - asOf.getTime()) / 86_400_000);
    expect(
      ageDays,
      `CATALOGUE_AS_OF e ${CATALOGUE_AS_OF}, adică ${ageDays} zile vechime.\n` +
        `  /v1/health și /mcp publică aceste cifre ca fapte despre catalog.\n` +
        `  Rulează:  npm run verify:catalogue\n` +
        `  apoi actualizează src/lib/catalogue-facts.ts cu ce raportează, și NUMAI acolo.`,
    ).toBeLessThanOrEqual(MAX_AGE_DAYS);
  });

  test("stampila nu e în viitor", () => {
    const asOf = new Date(`${CATALOGUE_AS_OF}T00:00:00Z`);
    expect(asOf.getTime()).toBeLessThanOrEqual(Date.now() + 86_400_000);
  });

  test("cifrele publicate sunt coerente între ele", () => {
    // Nu pot verifica adevărul fără DB, dar pot verifica relațiile care trebuie să
    // țină ORICÂND. O editare manuală greșită le rupe înainte să ajungă pe prod.
    expect(CATALOGUE.variantsWithSpecs).toBeLessThanOrEqual(CATALOGUE.variants);
    expect(CATALOGUE.specTypesPresent).toBeLessThanOrEqual(CATALOGUE.specTypesDefined);
    expect(CATALOGUE.brands).toBeGreaterThan(0);
    expect(CATALOGUE.generations).toBeGreaterThan(CATALOGUE.brands);
    expect(CATALOGUE.variants).toBeGreaterThan(CATALOGUE.generations);
  });
});
