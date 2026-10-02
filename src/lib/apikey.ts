export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateApiKey(prefix = "cd_free"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${token}`;
}

export type KeyRecord = {
  email: string;
  plan: "free" | "apify";
  tos_version: string;
  tos_accepted_at: string;
  created_at: string;
  email_verified: boolean;
  // Manual approval (T73, owner decision 2026-10-02). A Free key works only
  // when `approved` is true: on 30–31 Aug 138 self-issued keys pulled the whole
  // catalogue, each stopping just under its 1,000/month quota. Keys issued
  // before this field existed have no `approved` and stay off until the owner
  // approves them (scripts/keys-admin.mjs). Apify keys are not self-issued and
  // are exempt.
  approved?: boolean;
  approved_at?: string;
  revoked_at?: string;
  request_id?: string;
  name?: string;
};

/** A request for a Free key, waiting for the owner. No key exists until approval. */
export type KeyRequest = {
  id: string;
  email: string;
  name: string;
  company: string | null;
  use_case: string;
  tos_version: string;
  tos_accepted_at: string;
  created_at: string;
  ip_hash: string;
  status: "pending" | "approved" | "rejected";
  decided_at?: string;
  key_hash_prefix?: string;
};

export const isUsable = (r: KeyRecord): boolean =>
  !r.revoked_at && (r.plan !== "free" || r.approved === true);
