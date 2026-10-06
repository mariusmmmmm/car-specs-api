// Who may have a demo key, decided from the address alone (T111 R1–R3).
//
// The demo is scoped to 40 cars, so these rules are NOT defending the
// catalogue — scope does that, and a hundred demo keys expose the same 40 cars
// as one. What they defend is the inventory: 184 key records exist today and
// 135 of them came from five disposable-mail domains over two days, which is
// what made the August extraction cheap to set up and the aftermath tedious to
// read. Keeping that list honest is worth a DNS lookup.

/** Disposable / throwaway mail. The first five are measured, not guessed: they
 *  issued 135 of the 184 keys that exist (73,4%). The rest are the common ones.
 *  Extend by adding a line — never by adding a regex that guesses. */
const DISPOSABLE = new Set([
  // observed on this API, 2026-08-30/31
  "1secmail.com", "1secmail.net", "1secmail.org", "esiix.com", "wwjmp.com",
  // the usual suspects
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com",
  "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org",
  "throwawaymail.com", "yopmail.com", "yopmail.net", "dispostable.com",
  "maildrop.cc", "getnada.com", "trashmail.com", "trashmail.de", "mytemp.email",
  "fakeinbox.com", "mailnesia.com", "tempinbox.com", "spamgourmet.com",
  "mohmal.com", "emailondeck.com", "burnermail.io", "mailcatch.com",
  "inboxbear.com", "tempr.email", "discard.email", "spam4.me", "grr.la",
  "mailsac.com", "harakirimail.com", "tmpmail.org", "mintemail.com",
]);

/** Our own and obviously-synthetic domains. Twenty of the 184 keys came from
 *  these — they are test rows, and they are the reason any count of "real
 *  users" taken from the key table has been wrong. */
const NOT_A_USER = new Set([
  "cars-data.com", "example.com", "example.org", "example.net",
  "test.com", "test.local", "hermes-test.local", "localhost", "invalid",
]);

export type DomainVerdict =
  | { ok: true }
  | { ok: false; code: "disposable" | "internal" | "no_mx" | "malformed"; detail: string };

export function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const d = email.slice(at + 1).toLowerCase().trim();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

/** The checks that need no network. Split out so they can be tested without one
 *  and so a DNS outage cannot turn a disposable address into an accepted one. */
export function checkDomainOffline(email: string): DomainVerdict {
  const d = domainOf(email);
  if (!d) return { ok: false, code: "malformed", detail: "That does not look like an email address." };
  if (NOT_A_USER.has(d)) return { ok: false, code: "internal", detail: `${d} is not a deliverable address.` };
  if (DISPOSABLE.has(d)) {
    return {
      ok: false,
      code: "disposable",
      detail:
        "Demo keys are not issued to disposable mail. Use an address we can reach you at — " +
        "the demo is free and covers 40 cars either way.",
    };
  }
  return { ok: true };
}

/** Does the domain accept mail at all? Workers have no DNS module, so this goes
 *  through Cloudflare's DNS-over-HTTPS resolver.
 *
 *  FAILS OPEN on a resolver error, deliberately, and opposite to how metering
 *  fails (lib/quota.ts refuses when it cannot count). The asymmetry is the
 *  point: there, failing open hands out the catalogue unmetered; here, the worst
 *  case is one more row in a key table for a surface that exposes 40 cars.
 *  Turning away a real evaluator because 1.1.1.1 hiccuped is the worse error. */
export async function hasMailExchanger(domain: string): Promise<boolean> {
  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`;
    const res = await fetch(url, { headers: { accept: "application/dns-json" } });
    if (!res.ok) return true; // fail open
    const body = (await res.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
    if (body.Status !== 0) return false; // NXDOMAIN and friends: a real answer, and it is "no"
    const mx = (body.Answer ?? []).filter((a) => a.type === 15);
    if (mx.length > 0) return true;
    // No MX is not proof: RFC 5321 §5.1 lets a bare A record take mail.
    const a = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`, {
      headers: { accept: "application/dns-json" },
    });
    if (!a.ok) return true;
    const ab = (await a.json()) as { Answer?: unknown[] };
    return (ab.Answer ?? []).length > 0;
  } catch {
    return true; // fail open
  }
}
