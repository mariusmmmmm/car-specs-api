/**
 * T1194 — contorul de rată, ATOMIC, pe un Durable Object.
 *
 * ── CE REPARĂ (D-64, owner 2026-11-16: B+D+E) ───────────────────────────────
 *
 * Plafoanele per-minut erau ţinute cu `get`-apoi-`put` pe KV (`quota.ts`, vechiul
 * `perMinute()`), deci se aplicau INVERS decât intenţia: clientul politicos, care
 * trimite 20 de cereri secvenţiale, era refuzat la a 21-a, în timp ce 60 de cereri
 * CONCURENTE în acelaşi minut treceau toate — toate citesc aceeaşi valoare şi scriu
 * valoare+1, deci 60 de cereri mişcă contorul cu ~6. Limita efectivă era ~6× nominala.
 *
 * Aceeaşi clasă e măsurată pe familia per-cheie în antetul lui `checkAndConsume`:
 * **≥42,6%** din incremente pierdute, median 0,526 per cheie, pe 138 de chei reale.
 *
 * Un plafon care se aplică invers decât intenţia nu se reglează prin schimbarea
 * numărului — de asta (E) vine împreună cu (B) şi (D), şi de asta (E) SINGUR ar fi
 * înăsprit uşa brusc, exact pe populaţia care decide dacă apărem în directoare.
 *
 * ── DE CE UN DURABLE OBJECT, ŞI DE CE E DE AJUNS ────────────────────────────
 *
 * Un DO e SINGLE-THREADED pe instanţă: cererile către aceeaşi instanţă se serializează,
 * deci un `storage.get` urmat de `storage.put` în acelaşi handler e atomic faţă de
 * oricare altă cerere către ea. Asta e exact proprietatea care lipseşte la KV, şi se
 * obţine fără `blockConcurrencyWhile` — acela apără construcţia instanţei, nu un
 * read-modify-write dintr-un handler.
 *
 * Instanţa e per (uşă, identitate): `idFromName(`${door}:${who}`)`. Deci cererile unui
 * IP pe uşa anonimă se serializează între ele şi NU se ating de alt IP — contorul e
 * exact acolo unde trebuie să fie, şi nu se creează un punct de serializare global.
 *
 * Nu se face un DO per MINUT: ar fabrica o instanţă nouă la fiecare fereastră, pentru
 * un contor care trăieşte 60 de secunde. Minutul e CHEIE în storage-ul instanţei, iar
 * ferestrele vechi se şterg leneş la prima atingere de după expirare (vezi `sweep`).
 *
 * ── FAIL-CLOSED, care e un invariant TESTAT ─────────────────────────────────
 *
 * Regula din `quota.ts` (T79, după incidentul 889ca1e): **dacă nu putem număra, nu
 * servim** — 503 cu `Retry-After`, nu 429, fiindcă e defectul nostru, nu al apelantului.
 * Patru teste o fixează. Deci orice eroare de aici întoarce `"metering"`, nu `"rate"`,
 * şi NU se degradează la „serveşte nemăsurat" — uşa care se deschide singură exact când
 * ceva e rupt e chiar ce T79 a venit să repare.
 *
 * ── CE NU DOVEDIM AICI ──────────────────────────────────────────────────────
 *
 * Atomicitatea reală a unui DO e o garanţie a platformei Cloudflare, nu ceva ce
 * demonstrează testele noastre. Ele dovedesc că LOGICA e corectă dacă serializarea
 * ţine, şi că N cereri secvenţiale mişcă contorul cu N. Comportamentul pe infrastructura
 * reală cere `wrangler deploy` sau `wrangler dev --remote`, niciunul în scopul livrării.
 */

/** Răspunsul uşii: servim, refuzăm pe plafon, sau nu putem număra. */
export type RateVerdict =
  | { ok: true; used: number }
  | { ok: false; reason: "rate"; used: number }
  | { ok: false; reason: "metering" };

/** Cât ţinem o fereastră după ce a expirat, înainte de a o mătura. */
const SWEEP_AFTER_BUCKETS = 3;

export class RateCounter implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const bucket = url.searchParams.get("bucket");
    const limit = Number(url.searchParams.get("limit"));

    // Un parametru lipsă sau absurd NU se rotunjeşte la o valoare „rezonabilă":
    // ar inventa un plafon. Se refuză, şi apelantul îl citeşte ca `metering`.
    if (!bucket || !Number.isFinite(limit) || limit <= 0) {
      return Response.json({ error: "bucket and a positive limit are required" }, { status: 400 });
    }

    const key = `b:${bucket}`;
    const used = Number((await this.state.storage.get<number>(key)) ?? 0);

    if (used >= limit) {
      // Refuz pe plafon: NU se incrementează. Altfel o rafală de cereri respinse ar
      // ţine fereastra deschisă la infinit, iar `Retry-After: 60` ar fi o minciună.
      return Response.json({ ok: false, used }, { status: 200 });
    }

    const acum = used + 1;
    await this.state.storage.put(key, acum);
    await this.sweep(bucket);
    return Response.json({ ok: true, used: acum }, { status: 200 });
  }

  /**
   * Ferestrele expirate se şterg leneş, la o atingere de după ele. Nu există alarm:
   * un alarm per IP ar costa o trezire pentru fiecare client care a trecut o dată
   * pe aici, iar storage-ul unei instanţe inactive nu deranjează pe nimeni.
   */
  private async sweep(bucketCurent: string): Promise<void> {
    const prag = Number(bucketCurent) - SWEEP_AFTER_BUCKETS;
    if (!Number.isFinite(prag)) return;
    const toate = await this.state.storage.list<number>({ prefix: "b:" });
    const vechi: string[] = [];
    for (const k of toate.keys()) {
      const b = Number(k.slice(2));
      if (Number.isFinite(b) && b < prag) vechi.push(k);
    }
    if (vechi.length) await this.state.storage.delete(vechi);
  }
}

/** Ce are nevoie o uşă ca să numere. Îngust deliberat: nu tot `Env`. */
export type RateBinding = { RATE_COUNTER: DurableObjectNamespace };

/**
 * Numără o cerere pe o uşă, atomic.
 *
 * `door` separă uşile ca să nu împartă contorul (`anon`, `x402`, `demo-key`), iar
 * `who` e identitatea deja hash-uită — un hash de IP sau de cheie. Niciuna nu e
 * interpolată într-un URL de reţea: `idFromName` ia şirul ca nume de instanţă, iar
 * parametrii pleacă prin `URLSearchParams`, deci nu există cale de injecţie.
 */
export async function countAtomic(
  env: RateBinding,
  door: string,
  who: string,
  limit: number,
  bucket: number,
): Promise<RateVerdict> {
  try {
    const id = env.RATE_COUNTER.idFromName(`${door}:${who}`);
    const stub = env.RATE_COUNTER.get(id);
    const qs = new URLSearchParams({ bucket: String(bucket), limit: String(limit) });
    const res = await stub.fetch(`https://rate-counter.internal/incr?${qs}`);
    if (!res.ok) {
      console.error(`${door} rate counter HTTP ${res.status} — refusing`);
      return { ok: false, reason: "metering" };
    }
    const body = (await res.json()) as { ok?: boolean; used?: number };
    if (typeof body.ok !== "boolean" || typeof body.used !== "number") {
      // Un răspuns pe care nu-l putem citi e o numărătoare pe care nu o avem.
      console.error(`${door} rate counter returned an unreadable body — refusing`);
      return { ok: false, reason: "metering" };
    }
    return body.ok ? { ok: true, used: body.used } : { ok: false, reason: "rate", used: body.used };
  } catch (e) {
    console.error(`${door} rate counter threw — refusing:`, e);
    return { ok: false, reason: "metering" };
  }
}
