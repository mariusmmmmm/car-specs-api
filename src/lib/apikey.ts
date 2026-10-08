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
export const isUsable = (r: KeyRecord): boolean =>
  !r.revoked_at && (!isLegacyPlan(r.plan) || r.approved === true);
