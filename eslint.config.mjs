// Configurația ESLint pentru Worker-ul `api/`. Adăugată la T284, 2026-10-13.
//
// De ce exista `npm run lint` fără ESLint: scriptul `"lint": "eslint src"` era în
// package.json de la începutul repo-ului, dar nici pachetul, nici o configurație
// n-au existat vreodată — `git log --all -- '*eslint*'` întoarce zero commituri.
// Deci `npm run lint` ieșea cu 127 („eslint: command not found"), iar
// `enqueue-delivery.sh`, care rulează poarta și refuză coada dacă pică, raporta
// „lint rupt repo-wide, PREEXISTENT" în fiecare livrare din api/: T157, T178,
// T192, T199. O poartă care nu poate trece nu e o poartă, e o notă de subsol.
//
// Regula de alegere a regulilor: ce prinde defecte reale din acest repo, nu ce
// produce un raport lung. Repo-ul are deja tsc --noEmit curat și 178 de teste,
// deci lint-ul NU repetă verificarea de tipuri; acoperă ce scapă amândurora —
// `await` uitat, variabile nefolosite, `catch` care înghite eroarea.
//
// Fără `recommendedTypeChecked`: ar cere program TypeScript complet la fiecare
// rulare și ar transforma poarta într-un al doilea tsc, mai lent. Dacă vreodată
// se adaugă, se adaugă cu măsurătoarea de timp alături.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Ieșiri de build și dependențe. `.tsbuild/` e produs de `npm run
    // build:scripts`, deci ar fi raportat ca sursă dacă nu e exclus.
    ignores: ["node_modules/**", "dist/**", ".tsbuild/**", ".wrangler/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // Un `catch (e) {}` gol e exact clasa pe care repo-ul a plătit-o de două
      // ori: `google_auth` a ținut garda AdSense moartă trei zile, și șase
      // data-fetchers au dat 404 false, ISR-uite 24 de ore. Avertisment, nu
      // eroare, fiindcă un `catch` deliberat gol există legitim pe căi de
      // fallback — dar trebuie să se vadă.
      "no-empty": ["warn", { allowEmptyCatch: false }],

      // Argumentele nefolosite se iartă dacă sunt prefixate cu `_`; restul se
      // raportează. Convenția e deja folosită în repo.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // Testele au voie cu `any` și cu aserțiuni non-null: un fixture care
    // construiește un răspuns parțial n-are de ce să satisfacă tipul întreg.
    files: ["**/*.test.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
