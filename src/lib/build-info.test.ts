import { describe, test, expect } from "vitest";
import mcpSource from "../mcp.ts?raw";
import serverJson from "../../server.json";
import { buildShaMeta } from "./build-info";
import { MANIFEST_VERSION } from "./server-manifest";

// T1200 — decizia D-75: UN număr de versiune pentru clienți, derivat; și un câmp
// separat care spune ce build rulează, omis când nu se știe.

describe("build_sha în /v1/health — omis, niciodată gol (D-75 §2)", () => {
  test("lipsă → cheia nu există deloc", () => {
    const m = buildShaMeta({});
    expect("build_sha" in m).toBe(false);
    // Și la serializare: un `undefined` ar dispărea din JSON, dar un `null` nu.
    expect(JSON.stringify(m)).toBe("{}");
  });

  test("șir gol sau doar spații → tot omis, nu publicat gol", () => {
    for (const v of ["", "   ", "\t", "\n"]) {
      expect("build_sha" in buildShaMeta({ BUILD_SHA: v })).toBe(false);
    }
  });

  test("valoare reală → prezentă, fără spațiile din jur", () => {
    expect(buildShaMeta({ BUILD_SHA: "  39ee866abc12  " })).toEqual({ build_sha: "39ee866abc12" });
  });

  // Un `build_sha: null` arată ca un răspuns. Asta e chiar defectul pe care
  // omisiunea previne, deci se probează că NU poate apărea.
  test("nicio intrare nu produce null sau empty în JSON", () => {
    for (const v of [undefined, "", " "]) {
      expect(JSON.stringify(buildShaMeta({ BUILD_SHA: v }))).not.toContain("build_sha");
    }
  });
});

describe("serverInfo.version e DERIVAT, nu un literal (D-75 §1)", () => {
  // `?raw`, nu `node:fs`: tiparul sancționat pentru testele din `src/`, unde
  // tsconfig-ul e al Worker-ului și n-are tipurile de Node (vezi
  // openapi-sync.test.ts, care citește openapi.yaml la fel).
  const MCP: string = mcpSource;

  test("McpServer primește MANIFEST_VERSION, nu un șir", () => {
    const line = MCP.split("\n").find((l) => l.includes("new McpServer({"));
    expect(line, "declarația McpServer a dispărut — testul are nevoie de rescriere, nu de ștergere").toBeTruthy();
    expect(line).toContain("version: MANIFEST_VERSION");
    expect(line).not.toMatch(/version:\s*["'`]/);
  });

  test("niciun literal de versiune semver nu mai stă în CODUL din src/mcp.ts", () => {
    // Pe COD, nu pe fișier: antetul lui `server` CITEAZĂ literalul „1.0.0" ca
    // istorie — de ce a fost greșit și ce a costat. O verificare pe tot textul
    // ar cere ștergerea explicației ca să treacă, adică ar pedepsi exact proza
    // care împiedică regresia. Aceeași regulă ca în qa-client-literal-text:
    // liniile de comentariu se taie înainte de test.
    const code = MCP.split("\n")
      .filter((l: string) => {
        const t = l.trimStart();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toContain('"1.0.0"');
    expect(code).not.toMatch(/version:\s*["']\d+\.\d+\.\d+["']/);
    // Şi proba inversă, ca testul să nu treacă pe un fişier gol: codul chiar
    // conţine declaraţia pe care o păzeşte.
    expect(code).toContain("new McpServer({");
  });

  test("și constanta derivată e chiar cea publicată în server.json", () => {
    expect((serverJson as { version: string }).version).toBe(MANIFEST_VERSION);
  });
});
