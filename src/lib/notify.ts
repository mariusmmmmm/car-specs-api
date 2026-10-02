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
