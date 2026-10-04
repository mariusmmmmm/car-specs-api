// Opaque public identifiers (T92, owner decision 2026-10-04).
//
// WHY: `variants.public_id` is a sequential integer. Measured on 2026-10-04 it
// runs 4 → 115.170 with 103.099 rows active, so **89,5% of the integer range is
// a hit**: anyone can walk `1…115170` and harvest the catalogue without ever
// touching a list endpoint. The 6.067 enumeration calls in the 30–31 August
// extraction were a convenience, not a necessity. Hiding the list of ids is
// therefore worth nothing while the ids themselves are guessable.
//
// WHAT: every id the API hands out is a token. Guessing one is a 1-in-2^32
// shot (103.099 valid variants ⇒ ~0,0024% hit rate, down from 89,5%), and
// tokens are domain-separated: a variant token cannot be replayed as a model
// token.
//
// HOW: a 6-round Feistel network over the 32-bit domain, round function
// HMAC-SHA256 keyed per entity kind. A Feistel network is a bijection on its
// domain for ANY round function, so this is exactly reversible — no lookup
// table, no KV read, no DB round-trip. Most of the 2^32 tokens decode to
// integers that are not live ids; those simply 404, which is what makes
// guessing useless rather than merely slow.
//
// Deliberately NOT a hash with a stored map: that would put a KV read on every
// id in every response (a list page carries 50) and a 103k-row build artifact
// in the way of every import.

export type IdKind = "variant" | "generation" | "model";

/** Short prefix so a token says what it addresses when it shows up in a log or
 *  a bug report. Part of the contract: `v_…` is never accepted where a model
 *  is expected, even before the cipher runs. */
const PREFIX: Record<IdKind, string> = { variant: "v", generation: "g", model: "m" };

const ROUNDS = 6;
const HALF_BITS = 16;
const HALF_MASK = 0xffff;

/** One imported CryptoKey per kind, derived once per isolate. The kind is
 *  mixed into the key material, which is what domain-separates the tokens. */
const keyCache = new Map<IdKind, Promise<CryptoKey>>();

function keyFor(secret: string, kind: IdKind): Promise<CryptoKey> {
  let k = keyCache.get(kind);
  if (!k) {
    const material = new TextEncoder().encode(`cars-data/id/v1/${kind}/${secret}`);
    k = crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(kind, k);
  }
  return k;
}

/** Round function: 16 bits out of HMAC(key, round || half). */
async function f(key: CryptoKey, round: number, half: number): Promise<number> {
  const input = new Uint8Array([round, half >>> 8, half & 0xff]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
  return ((mac[0] << 8) | mac[1]) & HALF_MASK;
}

async function feistel(key: CryptoKey, value: number, reverse: boolean): Promise<number> {
  let left = (value >>> HALF_BITS) & HALF_MASK;
  let right = value & HALF_MASK;
  for (let i = 0; i < ROUNDS; i++) {
    const round = reverse ? ROUNDS - 1 - i : i;
    if (reverse) {
      // invert: right was the previous left
      const prevRight = left;
      const prevLeft = right ^ (await f(key, round, prevRight));
      left = prevLeft;
      right = prevRight;
    } else {
      const nextLeft = right;
      const nextRight = left ^ (await f(key, round, right));
      left = nextLeft;
      right = nextRight;
    }
  }
  return ((left << HALF_BITS) | right) >>> 0;
}

/** Thrown when the signing secret is missing. Deliberately fatal: serving
 *  tokens derived from a built-in default would make every one of them
 *  guessable, which is the whole thing this module exists to prevent. */
export class MissingIdSecret extends Error {
  constructor() {
    super("ID_TOKEN_KEY is not set — refusing to mint guessable identifiers.");
  }
}

function requireSecret(secret: string | undefined): string {
  if (!secret || secret.length < 16) throw new MissingIdSecret();
  return secret;
}

export async function encodeId(secret: string | undefined, kind: IdKind, id: number): Promise<string> {
  const key = await keyFor(requireSecret(secret), kind);
  const token = await feistel(key, id >>> 0, false);
  return `${PREFIX[kind]}_${token.toString(16).padStart(8, "0")}`;
}

/** null for anything that is not a well-formed token of this kind. Callers turn
 *  that into the same 404 an unknown id gets, so a malformed token and a
 *  non-existent car are indistinguishable from outside. */
export async function decodeId(secret: string | undefined, kind: IdKind, token: string): Promise<number | null> {
  const m = new RegExp(`^${PREFIX[kind]}_([0-9a-f]{8})$`).exec(token.trim());
  if (!m) return null;
  const key = await keyFor(requireSecret(secret), kind);
  const id = await feistel(key, parseInt(m[1], 16) >>> 0, true);
  // Nothing in this catalogue has id 0 or a negative id; anything outside a
  // plausible range is a guess, and saying so here saves a DB round-trip.
  return id > 0 && id <= 0x7fffffff ? id : null;
}

/** Batch helpers — a list page carries up to 50 ids and each token costs 6
 *  HMACs, so the rounds are issued in parallel rather than one id at a time. */
export function encodeIds(secret: string | undefined, kind: IdKind, ids: number[]): Promise<string[]> {
  return Promise.all(ids.map((id) => encodeId(secret, kind, id)));
}

export function decodeIds(secret: string | undefined, kind: IdKind, tokens: string[]): Promise<(number | null)[]> {
  return Promise.all(tokens.map((t) => decodeId(secret, kind, t)));
}

/** Test seam only: the key cache is per-isolate and per-secret-by-construction,
 *  but a test that swaps secrets in one process needs it cleared. */
export function __resetIdKeyCache(): void {
  keyCache.clear();
}
