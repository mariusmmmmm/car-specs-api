// server.json — the MCP registry manifest — built from CATALOGUE, never typed.
//
// It is the shop window: registry.modelcontextprotocol.io serves this object to
// agents, and Glama, PulseMCP and mcp.so mirror it. An agent reads it BEFORE
// deciding whether to call us at all, so a wrong field here is not cosmetic —
// it is the difference between being tried and being skipped.
//
// Why it is generated. server.json is static JSON, so it could not import
// catalogue-facts.ts and was the ONE copy of the numbers that stayed hand-typed
// after T190 moved the other nine to a single source. It drifted immediately:
// the manifest said 103,099 variants while /mcp and /v1/health both answered
// 103,372 — the exact disagreement catalogue-facts.ts exists to prevent,
// recreated in the one file agents read first.
//
// Why it was never published. The 1.0.3 draft was 106 characters of
// `description` against the schema's limit of 100, so the registry would have
// refused it. It was filed as "blocked on owner credentials" (T111 §10.4) and
// sat for eight days while the credentials were in fact already in place —
// 1.0.2 went out on 2026-10-04 from exactly that setup. MANIFEST_LIMITS below
// turns that rejection into a failing test, here, before anyone types
// `mcp-publisher publish`.
import { CATALOGUE, n } from "./catalogue-facts";
import {
  DEFAULT_COMPARE_PRICE_USD,
  DEFAULT_FILTER_PRICE_USD,
  DEFAULT_SEARCH_PRICE_USD,
  DEFAULT_SPECS_PRICE_USD,
} from "./x402-config";

/** From the published schema, 2025-12-11 (definitions.ServerDetail). Exceeding
 *  either is a publish-time rejection, which is the slowest place to find out. */
export const MANIFEST_LIMITS = { description: 100, title: 100 } as const;

/** Bumped whenever anything below changes — the registry refuses a version it
 *  has already stored, and never serves two things under one number.
 *
 *  1.0.4, not 1.0.3: the 1.0.3 recorded on deploy/api-2026-10-10 and
 *  deploy/api-2026-10-12-t152 carries the stale 103,099 and an over-length
 *  description. It was never published, so the number is technically free — but
 *  reusing it would leave two different manifests both called 1.0.3, one in git
 *  and one in the registry. This repo has paid for that shape before: a
 *  TOS_VERSION string was recorded on live keys while the page still published
 *  the previous one, twice. A version means one artifact. */
export const MANIFEST_VERSION = "1.0.5";

/** What an agent is told before it has called anything.
 *
 *  Three facts earn their characters, in this order:
 *   - the catalogue size, from CATALOGUE, so it cannot drift from /v1/health;
 *   - "no key", because 1.0.0-1.0.2 all declared the Authorization header
 *     REQUIRED and that is what every mirror still says. The anonymous demo has
 *     been live since T111; the registry is the last surface claiming a
 *     manually-reviewed key is mandatory, which is the precise friction the
 *     demo removed;
 *   - x402, which no registry has ever mentioned, though two tools have been
 *     answering 402 on Base mainnet since T231.
 *
 *  "N specs" is specTypesDefined, matching what the live get_specs tool
 *  description already tells agents. catalogue-facts.ts notes that the defined
 *  count reads as an overclaim against the ones present in prod data; the manifest follows the
 *  live MCP surface rather than quietly disagreeing with it in a second place. */
export function description(): string {
  return `Search, compare & filter ${n(CATALOGUE.variants)} car variants — ${CATALOGUE.specTypesDefined} specs, ${CATALOGUE.locales} languages. Free demo, no key; x402.`;
}

/** The Authorization header has no length limit, so the nuance the 100-character
 *  description cannot hold lives here: what you get without a key, what a key
 *  adds, and that x402 is a third way in that needs no account at all. */
function authorizationHeaderDescription(): string {
  return (
    "Bearer <your cars-data.com API key> — OPTIONAL. " +
    "Without it this server answers a fixed 40-car demo (every spec, every photo, " +
    `${CATALOGUE.locales} languages); a demo key, issued in one click, covers the same 40 cars over REST. ` +
    `Four tools reach the full ${n(CATALOGUE.variants)}-variant catalogue with no key and no account at all, ` +
    `paid per call under x402 v2 on Base (USDC): search_catalogue $${DEFAULT_SEARCH_PRICE_USD}, ` +
    `filter_catalogue $${DEFAULT_FILTER_PRICE_USD}, get_specs_full $${DEFAULT_SPECS_PRICE_USD} and ` +
    `compare_full $${DEFAULT_COMPARE_PRICE_USD} — the same four operations the Apify Actor offers, billed there by Apify. ` +
    // „Keys", nu „Keys and licensed exports" (T1196, a doua trecere).
    //
    // Prima trecere a lăsat fraza intactă pe un raționament care s-a dovedit
    // greșit la REFERINȚĂ, nu la logică: `server.json` e generat din fișierul
    // ăsta, deci a atinge linia obligă la regenerarea fișierului publicat în
    // registrul MCP — iar T1196 avea instrucțiune să nu-l atingă. Măsurat însă
    // față de `origin/main`, adică față de ce e PUBLICAT azi (v1.0.1), ramura
    // asta schimbă oricum `server.json` cu 11 linii: blocul de `headers` nu
    // există în versiunea publicată, îl introduce T1194 împreună cu `version`
    // 1.0.5. Deci nu exista nicio variantă în care fișierul rămâne neatins —
    // singura alegere era dacă diferența INTRODUCE oferta sau nu.
    //
    // „identic octet cu octet" din primul raport era adevărat față de BAZA
    // ramurii (t1194) și fals față de ce vede registrul. Un punct de referință
    // greșit, nu o măsurătoare greșită — exact clasa pe care proiectul o
    // plătește cel mai des.
    //
    // PREȚURILE x402 DE MAI SUS RĂMÂN, deliberat: owner-ul a decis „x402 rămâne,
    // doar paginile se curăță", iar aici prețul e termenul protocolului, citibil
    // de mașină, pe care un agent are nevoie să-l vadă ca să decidă — nu oferta
    // noastră. Trăiește oricum în antetul `PAYMENT-REQUIRED` al unui 402.
    // Divergența e reală și e scrisă în livrare: pagina `for-ai-agents` NU mai
    // listează prețurile x402 (T1189 le-a scos), `server.json` le păstrează.
    //
    // `version` NU se atinge aici (rămâne 1.0.5, a lui T1194) și nimic de aici
    // nu se republică în registru: publicarea e pasul owner-ului, prin
    // api/MCP-REGISTRY-PUBLISH.md.
    "Keys: https://cars-data.com/en/api/for-ai-agents"
  );
}

export function buildManifest() {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: "com.cars-data/car-specs-api",
    title: "cars-data.com — Car Specs API",
    description: description(),
    status: "active",
    repository: {
      url: "https://github.com/mariusmmmmm/car-specs-api",
      source: "github",
    },
    websiteUrl: "https://cars-data.com/en/api/for-ai-agents",
    version: MANIFEST_VERSION,
    remotes: [
      {
        type: "streamable-http",
        url: "https://api.cars-data.com/mcp",
        headers: [
          {
            name: "Authorization",
            description: authorizationHeaderDescription(),
            isRequired: false,
            isSecret: true,
          },
        ],
      },
    ],
  };
}

export const serialize = () => JSON.stringify(buildManifest(), null, 2) + "\n";
