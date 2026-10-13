import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CATALOGUE } from "../src/lib/catalogue-facts";
import { buildManifest, serialize, MANIFEST_LIMITS, MANIFEST_VERSION } from "../src/lib/server-manifest";

// server.json is the one file agents read BEFORE deciding whether to call this
// server, and until T251 it was the one file nothing checked.
//
// Two defects it had at the same time, both invisible to every existing gate:
//
//   1. 106 characters of `description` against a schema limit of 100 — the
//      registry would have refused it. The draft sat unpublished for eight days
//      recorded as "blocked on owner credentials" (T111 §10.4) while the
//      credentials were already in place.
//   2. 103,099 variants, hand-typed, against the 103,372 that /mcp and
//      /v1/health both answer from catalogue-facts.ts.
//
// The freshness test guards the CONSTANT. This one guards the one copy of it
// that lives outside TypeScript. `npm run verify:catalogue --prod` still owns
// the question of whether the constant is TRUE; this test only owns whether
// every surface says the same thing and whether the registry would take it.

const onDisk = readFileSync(new URL("../server.json", import.meta.url), "utf-8");

describe("server.json — manifestul din registrul MCP", () => {
  test("fișierul de pe disc e exact ce generează sursa", () => {
    expect(
      onDisk,
      "server.json e scris de mână sau în urmă. Rulează: node scripts/build-server-json.mjs",
    ).toBe(serialize());
  });

  test("intră în limitele schemei 2025-12-11 (altfel registrul refuză publicarea)", () => {
    const m = buildManifest() as Record<string, string>;
    for (const [field, limit] of Object.entries(MANIFEST_LIMITS)) {
      const len = [...m[field]].length;
      expect(
        len,
        `${field} are ${len} caractere, schema permite ${limit}. Exact asta a ținut 1.0.3 nepublicat.`,
      ).toBeLessThanOrEqual(limit);
    }
  });

  test("cifrele vin din catalogue-facts, nu din tastatură", () => {
    const d = buildManifest().description;
    expect(d).toContain(CATALOGUE.variants.toLocaleString("en-US"));
    expect(d).toContain(String(CATALOGUE.specTypesDefined));
    expect(d).toContain(String(CATALOGUE.locales));
    // Numerele vechi, fiecare publicat cândva ca adevăr despre catalog.
    for (const stale of ["102,191", "103,099", "180 specs", "19 languages"]) {
      expect(d, `${stale} e o cifră moartă, revenită în manifest`).not.toContain(stale);
    }
  });

  test("cheia e OPȚIONALĂ — demo-ul anonim e motivul pentru care versiunea asta există", () => {
    const header = buildManifest().remotes[0].headers[0];
    expect(header.name).toBe("Authorization");
    // 1.0.0-1.0.2 au declarat-o obligatorie; fiecare director care oglindește
    // registrul spune și acum agenților că trebuie o cheie aprobată manual.
    expect(header.isRequired).toBe(false);
    expect(header.isSecret).toBe(true);
  });

  test("x402 e numit — e viu pe mainnet și niciun registru nu l-a pomenit vreodată", () => {
    const m = buildManifest();
    expect(m.description.toLowerCase()).toContain("x402");
    expect(m.remotes[0].headers[0].description).toContain("x402");
  });

  test("versiunea e peste tot ce a servit registrul", () => {
    // Publicate: 1.0.0 (07-26), 1.0.1 (07-27), 1.0.2 (10-04, isLatest).
    // 1.0.3 e ars deliberat: există în git, cu alt conținut, nepublicat.
    const parts = MANIFEST_VERSION.split(".").map(Number);
    expect(parts).toHaveLength(3);
    expect(parts.every(Number.isInteger)).toBe(true);
    const cmp = (a: number[], b: number[]) => a.findIndex((x, i) => x !== b[i]);
    for (const served of [[1, 0, 0], [1, 0, 1], [1, 0, 2], [1, 0, 3]]) {
      const i = cmp(parts, served);
      expect(i, `${MANIFEST_VERSION} nu e peste ${served.join(".")}`).not.toBe(-1);
      expect(parts[i]).toBeGreaterThan(served[i]);
    }
    expect(buildManifest().version).toBe(MANIFEST_VERSION);
  });
});
