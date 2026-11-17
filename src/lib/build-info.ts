/**
 * „Ce build rulează acum" — un singur câmp, cu o singură regulă (T1200, D-75 §2).
 *
 * DE CE EXISTĂ. Ca să se publice v1.0.5 în registrul MCP a trebuit aflat ce commit
 * rulează, și nicio sondă nu o spunea: `serverInfo.version` zicea `1.0.0` (nebumpat din
 * iulie), checkout-ul `api/` stătea pe `deploy/api-2026-10-16` cu 224 de tipuri de spec,
 * ramura de publicat avea 232, baza 258. Răspunsul a venit din descrierile uneltelor din
 * `tools/list` — un canal care există pentru altceva. Cinci sonde pentru o întrebare pe
 * care un câmp o răspunde.
 *
 * REGULA, și e singurul motiv pentru care asta e o funcție și nu un ternar inline:
 * câmpul e OMIS când nu avem valoare. Niciodată `null`, niciodată `""`, niciodată
 * `undefined` serializat. Un `build_sha: null` în `/v1/health` arată ca un răspuns și e
 * mai rău decât absența — absența SPUNE „build-ul nu s-a identificat", ceea ce e adevărat
 * când nimeni n-a trecut flagul la deploy.
 *
 * De unde vine valoarea, și capcana: vezi `BUILD_SHA` în src/types.ts. Pe scurt —
 * `wrangler deploy --var BUILD_SHA:$(git rev-parse --short=12 HEAD)`, iar un deploy fără
 * flag o șterge, fiindcă `wrangler deploy` înlocuiește vars-urile cu ce e în fișier.
 */

/** `{ build_sha }` dacă avem o valoare ne-goală, altfel `{}` — nimic intermediar. */
export function buildShaMeta(env: { BUILD_SHA?: string }): { build_sha?: string } {
  // `trim()` înaintea testului: `--var BUILD_SHA:` fără valoare ajunge șir gol, iar un
  // câmp gol e exact ce omisiunea trebuie să prevină. Şi un SHA cu spaţii nu e un SHA.
  const sha = env.BUILD_SHA?.trim();
  return sha ? { build_sha: sha } : {};
}
