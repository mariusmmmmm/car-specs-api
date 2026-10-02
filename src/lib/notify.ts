import type { Env } from "../types";

// Transactional email through Brevo — the same provider the website's contact
// form uses (v3/lib/email/contact-notify.ts). Worker secrets/vars:
// BREVO_API_KEY, NOTIFY_TO (the owner's inbox, which the daily-report agent
// reads), NOTIFY_FROM. Never throws: a failed email must not fail a request.

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function sendEmail(
  env: Env,
  msg: { to: string; subject: string; text: string; replyTo?: string },
): Promise<boolean> {
  if (!env.BREVO_API_KEY) {
    console.warn("email skipped: BREVO_API_KEY not set");
    return false;
  }
  try {
    const res = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: "cars-data.com API", email: env.NOTIFY_FROM || "noreply@cars-data.com" },
        to: [{ email: msg.to }],
        ...(msg.replyTo ? { replyTo: { email: msg.replyTo } } : {}),
        subject: msg.subject,
        textContent: msg.text,
        htmlContent: `<pre style="font:14px/1.6 system-ui,sans-serif;white-space:pre-wrap">${esc(msg.text)}</pre>`,
      }),
    });
    if (!res.ok) console.error("brevo send failed:", res.status, await res.text().catch(() => ""));
    return res.ok;
  } catch (e) {
    console.error("brevo send threw:", e);
    return false;
  }
}

const DEFAULT_INGEST_URL = "https://cars-data.com/api/inbox/ingest";

/**
 * Hand one inbound message to the website's inbox (T77): the site stores it in
 * contact_messages and emails the owner. Returns false when ingest is not
 * configured or fails, so the caller can fall back to sending the email
 * itself. Never throws.
 */
export async function ingestToInbox(
  env: Env,
  msg: {
    kind: "api_key_request";
    name: string;
    email: string;
    subject: string;
    message: string;
    meta?: Record<string, unknown>;
  },
): Promise<boolean> {
  if (!env.INBOX_INGEST_TOKEN) return false;
  try {
    const res = await fetch(env.INBOX_INGEST_URL || DEFAULT_INGEST_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.INBOX_INGEST_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...msg, locale_code: "en", source_url: "https://api.cars-data.com/v1/keys" }),
    });
    if (!res.ok) console.error("inbox ingest failed:", res.status, await res.text().catch(() => ""));
    return res.ok;
  } catch (e) {
    console.error("inbox ingest threw:", e);
    return false;
  }
}
