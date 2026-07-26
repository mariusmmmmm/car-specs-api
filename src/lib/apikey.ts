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
  // Real verification needs an email-sending credential (see the "Brevo"
  // reference in project memory) — not wired in this Phase 1 scaffold.
  // Key works immediately; this just tracks whether verification happened.
  email_verified: boolean;
};
