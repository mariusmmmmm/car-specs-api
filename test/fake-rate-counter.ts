/**
 * T1194 — un `RATE_COUNTER` fals pentru teste, care rulează CLASA REALĂ.
 *
 * Nu re-implementează decizia: `RateCounter` din `src/rate-counter.ts` e instanţiat ca
 * atare, peste un storage în memorie. Deci testele probează chiar logica livrată —
 * plafonul, refuzul fără increment, măturarea ferestrelor vechi — şi un mutant plantat
 * în clasă pică, ceea ce n-ar fi adevărat despre o imitaţie scrisă în test.
 *
 * ── CE EMULEAZĂ, ŞI CE NU DOVEDEŞTE ────────────────────────────────────────
 *
 * Un DO real SERIALIZEAZĂ cererile către aceeaşi instanţă; de aici îi vine
 * atomicitatea. Un stub naiv nu o face — fiecare `await` din handler cedează coada de
 * microtask-uri, deci 60 de apeluri prin `Promise.all` se întreţes şi pierd incremente
 * exact ca vechiul KV. Prima versiune a fixturii ăsteia era aşa, iar testul de
 * concurenţă a picat: măsura FIXTURA, nu codul.
 *
 * Deci stub-ul ţine o coadă per instanţă, ca platforma. Ce probează suita e că LOGICA
 * e corectă dacă serializarea ţine — N cereri consumă N unităţi, refuzul nu
 * incrementează, ferestrele vechi se mătură. Că serializarea ţine e o garanţie a
 * Cloudflare, nu ceva ce demonstrăm aici, şi e declarată ca nemăsurată în livrare.
 *
 * Testul rămâne totuşi discriminant: pe un substrat `get`-apoi-`put` fără serializare
 * (adică întoarcerea la KV) coada nu există, întreţeserea revine şi testul cade.
 */
import { RateCounter } from "../src/rate-counter";

type Fake = DurableObjectNamespace & { _instances: Map<string, RateCounter> };

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string) { return m.get(k) as T | undefined; },
    async put(k: string, v: unknown) { m.set(k, v); },
    async delete(k: string | string[]) {
      for (const key of Array.isArray(k) ? k : [k]) m.delete(key);
      return true;
    },
    async list<T>({ prefix }: { prefix?: string } = {}) {
      const out = new Map<string, T>();
      for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) out.set(k, v as T);
      return out;
    },
    _raw: m,
  };
}

/** Un namespace fals. `onFetch` permite injectarea unui eşec de storage/transport. */
export function fakeRateCounter(opts: { fail?: boolean } = {}): Fake {
  const instances = new Map<string, RateCounter>();
  const queues = new Map<string, Promise<void>>();
  const ns = {
    idFromName(name: string) { return { toString: () => name, name } as unknown as DurableObjectId; },
    get(id: DurableObjectId) {
      const name = String(id);
      if (!instances.has(name)) {
        const st = fakeStorage() as unknown as DurableObjectState["storage"];
        instances.set(name, new RateCounter({ storage: st } as unknown as DurableObjectState));
      }
      const inst = instances.get(name)!;
      return {
        async fetch(input: RequestInfo) {
          if (opts.fail) throw new Error("rate counter down");
          // Coada per instanţă = serializarea platformei. Fiecare cerere aşteaptă
          // precedenta, deci read-modify-write-ul din clasă nu se poate întreţese.
          const anterior = queues.get(name) ?? Promise.resolve();
          const al_meu = anterior.then(() => inst.fetch(new Request(String(input))));
          queues.set(name, al_meu.then(() => undefined, () => undefined));
          return al_meu;
        },
      } as unknown as DurableObjectStub;
    },
    _instances: instances,
  };
  return ns as unknown as Fake;
}

/** Legătura completă pe care o aşteaptă `checkAndConsume`. */
export function bind(kv: KVNamespace, opts: { fail?: boolean } = {}) {
  return { API_KEYS: kv, RATE_COUNTER: fakeRateCounter(opts) };
}
