import { isLegacyPlan, type StoredPlan } from "./quota";

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `prefix` is REQUIRED — it defaulted to `cd_free` until T166, which meant
 *  the retired tier was what you got by forgetting to say. A missing argument
 *  is now a compile error instead of a free key. */
export function generateApiKey(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${token}`;
}

export type KeyRecord = {
  email: string;
  // One source for the plan names: lib/quota.ts owns them, because that is
  // where their limits live. Typed separately until 2026-10-04, which is how a
  // `demo` plan could exist in the quota table and be unrepresentable on a key.
  //
  // `StoredPlan`, not `Plan`: a record read back from KV may still say `free`
  // (T166 / D-01). Nothing may WRITE one — see routes/admin.ts grant.
  plan: StoredPlan;
  tos_version: string;
  tos_accepted_at: string;
  created_at: string;
  email_verified: boolean;
  // Manual approval (T73, owner decision 2026-10-02). A legacy free key works
  // only when `approved` is true: on 30–31 Aug 138 self-issued keys pulled the
  // whole catalogue, each stopping just under its 1,000/month quota. Keys
  // issued before this field existed have no `approved` and stay off for good
  // — since T166 nothing can grant that plan, so there is no longer any way
  // to turn one on. Apify and demo keys are exempt.
  approved?: boolean;
  approved_at?: string;
  revoked_at?: string;
  // Why it was revoked, in the owner's words (T944). Optional and additive:
  // the 186 records revoked on 2026-10-08 predate it and read back
  // `undefined`, which is why no migration is needed to deploy this — a
  // missing reason is "not recorded", never "no reason".
  revoked_reason?: string;
  // Set by /unrevoke, kept forever. A key that has been round-tripped is not
  // the same object as one that was never revoked, and the listing has to be
  // able to say so.
  unrevoked_at?: string;
  request_id?: string;
  name?: string;
};

/** A request waiting for the owner. No key exists until approval.
 *  Nothing writes these any more (owner, 2026-10-06); kept for the records
 *  already in KV. */
export type KeyRequest = {
  id: string;
  email: string;
  name: string;
  // company/website/role are required since T90 (2026-10-04); requests made
  // before that may lack website/role and have company null.
  company: string | null;
  website?: string;
  role?: string;
  use_case: string;
  tos_version: string;
  tos_accepted_at: string;
  created_at: string;
  ip_hash: string;
  status: "pending" | "approved" | "rejected";
  decided_at?: string;
  key_hash_prefix?: string;
};

// The approval gate survives T166 and applies to the legacy plan only. It is
// what keeps the one live free key alive (it is approved) while every
// never-approved one stays inert — belt and braces, since all 182 of those
// were revoked on 2026-10-08 too. Goes when LegacyPlan goes.
//
// T944 measured what that "belt and braces" was actually worth on 2026-10-20:
// 192 keys, 186 revoked, 183 of them on `free`. Both halves were true — and
// both were erased by ONE admin call, because `approve` set `approved: true`
// AND cleared `revoked_at` in the same write. The two guards were never
// independent. They are now: see routes/admin.ts, where `approve` refuses a
// revoked record outright and coming back is a differently-named, confirmed
// `unrevoke` that does not grant approval.
export const isUsable = (r: KeyRecord): boolean =>
  !r.revoked_at && (!isLegacyPlan(r.plan) || r.approved === true);

// ── "one demo key per address" (T111) — the index is a POINTER ───────────────
// `demokey-email:<sha256(email)>` holds the 8-char hash prefix of the demo key
// issued to that address. It is a denormalised index, NOT the authority: the
// authority is the `key:` record, which already carries email, plan and
// revoked_at.
//
// T1034 (2026-10-22) made that distinction load-bearing, because treating the
// entry's mere EXISTENCE as the answer was wrong in both directions at once:
//
//   * `routes/admin.ts` grant never wrote it, so a demo key the owner granted
//     did not stop that address from self-serving a second one;
//   * nothing ever cleared it, so a revoked demo key left the address barred
//     for good — answering a request with "a key was already issued … write to
//     office@cars-data.com and we will replace it" when no usable key existed
//     and the one it pointed at had been killed on purpose.
//
// The second one is the one that costs a person, and it is why this resolves
// the pointer instead of trusting it: ANY stale entry — missing key, revoked
// key — now reads as "this address is free", so the addresses barred today
// un-bar themselves on deploy, with no migration.
//
// Deliberately NOT fixed by syncing the write sites: there were two of those
// when the index was written (mint, revoke) and T944 added a third (`unrevoke`)
// without touching it. A fourth will arrive the same way. Resolving on read
// removes the drift surface rather than adding places to keep in step.
export const demoKeyEmailIndex = (emailHash: string): string => `demokey-email:${emailHash}`;

/** The prefix of the still-usable demo key for this address, or null — in
 *  which case the address may be issued one. Two KV ops, both scoped: the
 *  index lookup, then the pointed-at record. Never a full scan. */
export async function usableDemoKeyFor(kv: KVNamespace, emailHash: string): Promise<string | null> {
  const prefix = await kv.get(demoKeyEmailIndex(emailHash));
  // `{8,64}`, matching routes/admin.ts findKey: the index has always stored 8
  // chars, but a longer value must resolve rather than be rejected as junk.
  if (!prefix || !/^[0-9a-f]{8,64}$/.test(prefix)) return null;
  const page = await kv.list({ prefix: `key:${prefix}` });
  if (page.keys.length !== 1) return null; // gone, or ambiguous — not a bar
  const raw = await kv.get(page.keys[0].name);
  if (!raw) return null;
  return isUsable(JSON.parse(raw) as KeyRecord) ? prefix : null;
}
