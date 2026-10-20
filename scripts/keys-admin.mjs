#!/usr/bin/env node
// Owner tool for API keys. Talks to the Worker's /v1/admin routes.
//
// There is no review queue any more (owner, 2026-10-06). The only self-serve
// key is the demo, issued automatically when the requester clicks the link in
// their email, and the lead — name, company, website, role, use case — lands in
// the site inbox at that moment. So `requests`, `approve` and `reject` are gone:
// nothing creates the records they read.
//
// `grant` replaces them, and is the ONLY way a key on a non-demo plan comes
// into being — the deliberate path for saying yes to someone who needs the full
// catalogue, which the public cannot self-serve at any price in requests.
//
// The `free` plan is GONE (owner decision D-01, 2026-10-08: only DEMO and
// paid exist). `grant` will not send it and the Worker would refuse it anyway.
// `plan` is now required: it used to default to free, so the retired tier was
// what you got by stopping typing one word early.
//
//   node scripts/keys-admin.mjs keys                        every key that exists, with status
//   node scripts/keys-admin.mjs grant <email> <plan>        plan: demo | apify
//   node scripts/keys-admin.mjs approve-key <hash-prefix>   approve a key (REFUSES a revoked one)
//   node scripts/keys-admin.mjs revoke-key  <hash-prefix> [reason...]
//   node scripts/keys-admin.mjs unrevoke-key <hash-prefix>  shows the row; --confirm <prefix> sends it
//   node scripts/keys-admin.mjs sweep                       DRY-RUN: what a mass revocation would touch
//   node scripts/keys-admin.mjs sweep --apply --reason "…"  …and actually revoke them
//
// `approve-key` no longer un-revokes (T944). Until 2026-10-20 it wrote
// `revoked_at: undefined` in the same breath as `approved: true`, so each of
// the 186 revoked keys in production — 183 of them on the retired `free`
// plan, which still resolves the WHOLE catalogue — was one mistyped row away
// from working again. Coming back is now `unrevoke-key`, which needs the
// key's own prefix echoed in `--confirm`, and which does NOT approve: a free
// key restored that way is still inert until someone approves it too.
//
// Needs ADMIN_TOKEN (the Worker secret of the same name), read from the
// environment or from ../.secrets/api-admin.env. API_BASE overrides the URL
// (e.g. http://localhost:8790 for wrangler dev).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const secrets = path.resolve(here, "../../.secrets/api-admin.env");
if (!process.env.ADMIN_TOKEN && fs.existsSync(secrets)) {
  for (const line of fs.readFileSync(secrets, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
const TOKEN = process.env.ADMIN_TOKEN;
const BASE = process.env.API_BASE ?? "https://api.cars-data.com";
if (!TOKEN) {
  console.error(`Set ADMIN_TOKEN (or put it in ${secrets}).`);
  process.exit(1);
}

/** Sends the request and hands back the status as well as the body. Used by
 *  everything that must REACT to a refusal rather than die on it — the
 *  capability probe below, and `approve-key` meeting a revoked key. */
async function raw(method, p) {
  const res = await fetch(`${BASE}/v1/admin${p}`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

async function call(method, p) {
  const r = await raw(method, p);
  if (!r.ok) {
    console.error(`${r.status} ${r.body.title ?? ""} — ${r.body.detail ?? ""}`);
    process.exit(1);
  }
  return r.body.data;
}

// ── the classification is the Worker's own, never a copy ───────────────────
// Two decisions could have been re-implemented here and both would have been
// wrong the moment the Worker changed. Neither is:
//   · USABLE comes from the listing, which the Worker computes with the real
//     lib/apikey.ts `isUsable`. This script never decides it.
//   · DISPOSABLE / NOT-A-USER comes from lib/email-domain.ts through
//     .tsbuild, the same way verify-catalogue-facts.mjs reads the catalogue
//     constants. A hard-coded copy of that 41-domain list would drift
//     silently, and a sweep reading a stale list is a sweep that misses rows.
const require_ = createRequire(import.meta.url);
let checkDomainOffline = null;
try {
  ({ checkDomainOffline } = require_("../.tsbuild/lib/email-domain.js"));
} catch {
  // Left null on purpose. The sweep still works — it just labels every row
  // "unclassified" and SAYS SO, instead of quietly labelling a temp-mail
  // address as an ordinary one.
}
const domainLabel = (email) => {
  if (!checkDomainOffline) return "unclassified";
  const v = checkDomainOffline(String(email ?? ""));
  return v.ok ? "ordinary" : v.code; // disposable | internal | malformed
};

// ── sweep: the mass-revocation mechanism, dry by default ───────────────────
// T944 asked for three things and this is all three in one command:
//   · the MECHANISM — one pass over every key, revoking the class that is
//     stopped only by the absence of `approved`;
//   · a DRY-RUN that says exactly how many keys it would touch and WHICH,
//     and which is what you get unless you type `--apply`;
//   · REVERSIBILITY written before anything is written — `--apply` lays down
//     a snapshot and an undo script FIRST, and refuses to touch a single key
//     if it cannot.
//
// The candidate predicate is exactly one line, and it is deliberately the
// narrowest one that satisfies the task: NOT revoked AND NOT usable. On the
// current Worker that resolves to legacy `free` keys with no `approved` —
// the 182-key class T111 §10.2 measured — because for demo/apify plans
// `isUsable` is just "not revoked". A usable key is never a candidate; an
// already-revoked key is never re-revoked.
const OUT_DIR = path.resolve(here, "../../reports/t944");

/** Is the DEPLOYED Worker the post-T944 one? Measured, not assumed, and
 *  without mutating anything: `unrevoke` with a deliberately wrong `confirm`
 *  is a 400 on the new Worker and a 404 (no such route) on the old one. The
 *  prefix given is a key that exists, so a 404 cannot mean "unknown key". */
async function probeIrreversibility(prefix) {
  const r = await raw("POST", `/keys/${prefix}/unrevoke?confirm=__probe_not_a_prefix__`);
  if (r.status === 400) return { fixed: true, detail: `unrevoke answered 400 on key ${prefix}` };
  // 401 as well as 404, and the difference is not cosmetic: an admin action
  // the router does not know falls PAST /v1/admin into requireApiKey, which
  // reads the admin token as an API key and rejects it. Measured on prod
  // 2026-10-20, where the probe answered 401 with "Invalid API key". Both
  // codes mean the same thing — there is no `unrevoke` route on that Worker.
  // Pinned against the real app in test/keys-revocation.test.ts.
  if (r.status === 401 || r.status === 404) {
    return { fixed: false, detail: `unrevoke answered ${r.status} on key ${prefix} — no such admin route` };
  }
  return { fixed: null, detail: `unrevoke answered ${r.status} on key ${prefix} — inconclusive` };
}

const tally = (rows, f) => {
  const m = new Map();
  for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

async function sweep() {
  const APPLY = process.argv.includes("--apply");
  const ri = process.argv.indexOf("--reason");
  if (ri > -1 && !process.argv[ri + 1]) { console.error("--reason needs a value."); process.exit(1); }
  const reason = ri > -1 ? process.argv[ri + 1] : "";
  if (APPLY && !reason) {
    console.error("--apply needs --reason \"<why>\": an unrecorded reason is what the 2026-10-08 sweep left on 186 records.");
    process.exit(1);
  }

  const rows = await call("GET", "/keys");
  const usable = rows.filter((k) => k.usable);
  const revoked = rows.filter((k) => k.revoked);
  const candidates = rows.filter((k) => !k.revoked && !k.usable);

  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — ${BASE}  (${new Date().toISOString()})`);
  console.log(`\nINVENTORY: ${rows.length} keys — ${usable.length} usable, ${revoked.length} revoked, ` +
    `${candidates.length} stopped ONLY by the absence of \`approved\``);
  if (!checkDomainOffline) {
    console.log("  (domain classification unavailable — run `npm run build:scripts` first; rows read \"unclassified\")");
  }

  console.log(`\nPROTECTED — ${usable.length} usable key(s), NEVER touched by this command:`);
  for (const k of usable) {
    console.log(`  ${k.key_hash_prefix}  ${String(k.plan).padEnd(5)}  ${k.created_at.slice(0, 10)}  ${k.email}` +
      `  [${domainLabel(k.email)}]${k.approved ? "" : "  (plan needs no approval)"}`);
  }

  console.log(`\nCANDIDATES — ${candidates.length} key(s) this command would revoke:`);
  if (candidates.length === 0) {
    // Silence is not success. An empty set is a FINDING here, and it has to
    // say which measurement makes it empty, or the next reader assumes the
    // tool did not run.
    console.log("  none. Every key is either usable or already revoked, so there is no");
    console.log("  key left whose only brake is a missing `approved` field.");
    console.log(`  (${revoked.length} already revoked + ${usable.length} usable = ${revoked.length + usable.length} of ${rows.length})`);
  } else {
    for (const k of candidates) {
      console.log(`  ${k.key_hash_prefix}  ${String(k.plan).padEnd(5)}  ${k.created_at.slice(0, 10)}  ${k.email}  [${domainLabel(k.email)}]`);
    }
    console.log(`  by domain class: ${tally(candidates, (k) => domainLabel(k.email)).map(([a, b]) => `${a}=${b}`).join(", ")}`);
    console.log(`  by plan:         ${tally(candidates, (k) => k.plan).map(([a, b]) => `${a}=${b}`).join(", ")}`);
  }

  // ── the exposure the revocation was supposed to remove ───────────────────
  console.log(`\nRESURRECTION EXPOSURE — ${revoked.length} revoked key(s):`);
  console.log(`  by plan:         ${tally(revoked, (k) => k.plan).map(([a, b]) => `${a}=${b}`).join(", ")}`);
  console.log(`  by domain class: ${tally(revoked, (k) => domainLabel(k.email)).map(([a, b]) => `${a}=${b}`).join(", ")}`);
  console.log(`  with a recorded reason: ${revoked.filter((k) => k.revoked_reason).length} of ${revoked.length}`);
  let probe = { fixed: null, detail: "not probed — no revoked key to probe with" };
  if (revoked.length) {
    probe = await probeIrreversibility(revoked[0].key_hash_prefix);
    if (probe.fixed === true) {
      console.log(`  deployed Worker: POST-T944 — \`approve\` refuses a revoked key. 0 of the ${revoked.length} can be restored by one command. [${probe.detail}]`);
    } else if (probe.fixed === false) {
      console.log(`  deployed Worker: PRE-T944 — \`approve\` still clears \`revoked_at\`, so ALL ${revoked.length} are ONE \`approve-key\` away from working again. [${probe.detail}]`);
    } else {
      console.log(`  deployed Worker: could not tell. [${probe.detail}]`);
    }
  }

  if (!APPLY) {
    console.log(`\nNothing was written. To act: node scripts/keys-admin.mjs sweep --apply --reason "<why>"`);
    return;
  }
  if (candidates.length === 0) {
    console.log("\nNothing to apply.");
    return;
  }

  // The undo written below calls `unrevoke`, which only exists on a post-T944
  // Worker. On an older one the only way back would be `approve` — and that
  // does NOT restore these keys, it makes them USABLE, which is the opposite
  // of where they started. So a sweep whose undo would not be exact does not
  // run at all.
  if (probe.fixed !== true) {
    console.error(`\nREFUSING to apply: this Worker has no \`unrevoke\` route (${probe.detail}),`);
    console.error("so the undo below could not be exact — on a pre-T944 Worker the only way back is");
    console.error("`approve`, which would leave these keys USABLE rather than inert. Deploy T944 first.");
    process.exit(1);
  }

  // ── reversibility, on disk, BEFORE the first write ───────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const snapPath = path.join(OUT_DIR, `sweep-${stamp}.json`);
  const undoPath = path.join(OUT_DIR, `sweep-${stamp}-undo.sh`);
  fs.writeFileSync(snapPath, JSON.stringify({ base: BASE, at: new Date().toISOString(), reason, before: candidates }, null, 2));
  // Self-contained curl, deliberately NOT `node scripts/keys-admin.mjs`: the
  // undo must work from a checkout that does not have this script, which is
  // exactly the situation after a rollback of the deploy that introduced it.
  fs.writeFileSync(undoPath,
    `#!/usr/bin/env bash\n` +
    `# Undo for the sweep of ${stamp} on ${BASE}. Snapshot: ${snapPath}\n` +
    `#\n` +
    `# PREDICATE, exactly: every key below satisfied revoked=false AND usable=false\n` +
    `# in GET /v1/admin/keys immediately before the sweep — inert because \`approved\`\n` +
    `# was absent, NOT because it was revoked. \`unrevoke\` removes revoked_at and\n` +
    `# revoked_reason and grants nothing, so it restores precisely that state.\n` +
    `# Running this whole file therefore cannot make any key usable. Verify after:\n` +
    `#   node scripts/keys-admin.mjs sweep   # candidates must be back to ${candidates.length}\n` +
    `#\n` +
    `# Needs a post-T944 Worker (the \`unrevoke\` route). Idempotent: a key that is\n` +
    `# already un-revoked answers 409 and the line below reports it without failing.\n` +
    `set -uo pipefail\n` +
    `BASE="\${API_BASE:-${BASE}}"\n` +
    `SECRETS="$(cd "$(dirname "$0")/../.." && pwd)/.secrets/api-admin.env"\n` +
    `[ -n "\${ADMIN_TOKEN:-}" ] || { set -a; . "$SECRETS"; set +a; }\n` +
    `[ -n "\${ADMIN_TOKEN:-}" ] || { echo "ADMIN_TOKEN missing (looked in $SECRETS)" >&2; exit 1; }\n` +
    `fail=0\n` +
    `undo() { # <prefix> <email>\n` +
    `  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \\\n` +
    `    -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/v1/admin/keys/$1/unrevoke?confirm=$1")\n` +
    `  case "$code" in\n` +
    `    200) echo "restored $1  $2" ;;\n` +
    `    409) echo "already un-revoked $1  $2" ;;\n` +
    `    *)   echo "FAILED $1  $2  (HTTP $code)" >&2; fail=1 ;;\n` +
    `  esac\n` +
    `}\n` +
    candidates.map((k) => `undo ${k.key_hash_prefix} ${JSON.stringify(k.email)}`).join("\n") +
    `\nexit $fail\n`);
  fs.chmodSync(undoPath, 0o755);
  console.log(`\nSnapshot: ${snapPath}\nUndo:     ${undoPath}`);

  let done = 0, failed = 0;
  for (const k of candidates) {
    const r = await raw("POST", `/keys/${k.key_hash_prefix}/revoke?reason=${encodeURIComponent(reason)}`);
    if (r.ok) { done++; console.log(`  revoked ${k.key_hash_prefix}  ${k.email}`); }
    else { failed++; console.error(`  FAILED  ${k.key_hash_prefix}  ${k.email}  — ${r.status} ${r.body.detail ?? ""}`); }
  }
  console.log(`\n${done} revoked, ${failed} failed. Undo: ${undoPath}`);
  if (failed) process.exit(1);
}

const [cmd, arg, arg2] = process.argv.slice(2);
switch (cmd) {
  case "grant": {
    const plan = arg2;
    if (!arg || !plan) { console.error("usage: keys-admin.mjs grant <email> <demo|apify>"); process.exit(1); }
    if (plan === "free") {
      console.error("The `free` plan was retired on 2026-10-08 (D-01): only DEMO and paid exist.\n  Use `demo` for an evaluation key, or `apify` for the paid channel.");
      process.exit(1);
    }
    if (plan !== "demo" && plan !== "apify") { console.error(`Unknown plan "${plan}" — must be demo or apify.`); process.exit(1); }
    const r = await call("POST", `/grant?email=${encodeURIComponent(arg)}&plan=${encodeURIComponent(plan)}`);
    console.log(r.emailed
      ? `Granted ${plan} to ${r.email}: key ${r.key_hash_prefix}… emailed.`
      : `Granted ${plan} to ${r.email}: key ${r.key_hash_prefix}…\n  EMAIL FAILED — send it yourself, it cannot be shown again:\n  ${r.api_key}`);
    break;
  }
  case "keys": {
    const rows = await call("GET", "/keys");
    console.log(`${rows.length} keys — ${rows.filter((k) => k.usable).length} usable`);
    for (const k of rows) console.log(`${k.key_hash_prefix}  ${k.plan.padEnd(5)}  ${k.usable ? "ACTIVE " : k.revoked ? "revoked" : "pending"}  ${k.created_at.slice(0, 10)}  ${k.email}`);
    break;
  }
  case "approve-key": {
    if (!arg) { console.error("usage: keys-admin.mjs approve-key <hash-prefix>"); process.exit(1); }
    const r = await raw("POST", `/keys/${arg}/approve`);
    if (r.status === 409) {
      // The one refusal this tool must not flatten into a generic error: it
      // is the T944 guard doing its job, and it carries the way forward.
      console.error(`REFUSED — ${r.body.detail ?? "that key is revoked."}`);
      console.error(`\n  To restore it deliberately, in two steps:\n` +
        `    node scripts/keys-admin.mjs unrevoke-key ${arg} --confirm ${arg}\n` +
        `    node scripts/keys-admin.mjs approve-key ${arg}`);
      process.exit(2);
    }
    if (!r.ok) { console.error(`${r.status} ${r.body.title ?? ""} — ${r.body.detail ?? ""}`); process.exit(1); }
    const d = r.body.data;
    console.log(`${d.key_hash_prefix}… ${d.email}: ${d.usable ? "ACTIVE" : "inactive"}`);
    break;
  }

  case "revoke-key": {
    if (!arg) { console.error("usage: keys-admin.mjs revoke-key <hash-prefix> [reason...]"); process.exit(1); }
    const reason = process.argv.slice(4).join(" ").trim();
    const q = reason ? `?reason=${encodeURIComponent(reason)}` : "";
    const r = await call("POST", `/keys/${arg}/revoke${q}`);
    console.log(`${r.key_hash_prefix}… ${r.email}: ${r.usable ? "ACTIVE" : "inactive"}` +
      `${r.revoked_reason ? ` — ${r.revoked_reason}` : reason ? "" : " (no reason recorded)"}`);
    break;
  }

  // Deliberately two-step, and the first step is a READ. Typing the command
  // shows you the row; only `--confirm <the key's own prefix>` sends it. That
  // is the same shape as `sweep` below: you cannot act before you have seen
  // what you are acting on.
  case "unrevoke-key": {
    if (!arg) { console.error("usage: keys-admin.mjs unrevoke-key <hash-prefix> [--confirm <hash-prefix>]"); process.exit(1); }
    const ci = process.argv.indexOf("--confirm");
    const confirm = ci > -1 ? process.argv[ci + 1] : undefined;
    if (ci > -1 && !confirm) { console.error("--confirm needs the key's hash prefix as its value."); process.exit(1); }

    if (!confirm) {
      const rows = await call("GET", "/keys");
      const hit = rows.filter((k) => k.key_hash_prefix.startsWith(arg));
      if (hit.length !== 1) {
        console.error(hit.length ? `"${arg}" matches ${hit.length} keys — give more of the prefix.` : `No key matches "${arg}".`);
        process.exit(1);
      }
      const k = hit[0];
      console.log(`${k.key_hash_prefix}  ${k.plan}  ${k.email}`);
      console.log(`  revoked:  ${k.revoked ? (k.revoked_at ?? "yes, date not recorded") : "NO — nothing to undo"}`);
      console.log(`  reason:   ${k.revoked_reason ?? "not recorded"}`);
      console.log(`  approved: ${k.approved}`);
      if (!k.revoked) process.exit(1);
      console.log(`\nUn-revoking does NOT approve it. On plan "${k.plan}" it would come back ` +
        `${k.plan === "free" && !k.approved ? "STILL INERT (it is not approved)" : "USABLE"}.`);
      console.log(`\nTo send it:\n  node scripts/keys-admin.mjs unrevoke-key ${k.key_hash_prefix} --confirm ${k.key_hash_prefix}`);
      break;
    }

    const r = await raw("POST", `/keys/${arg}/unrevoke?confirm=${encodeURIComponent(confirm)}`);
    if (!r.ok) { console.error(`${r.status} ${r.body.title ?? ""} — ${r.body.detail ?? ""}`); process.exit(1); }
    const d = r.body.data;
    console.log(`${d.key_hash_prefix}… ${d.email}: revocation lifted — ${d.usable ? "ACTIVE" : "still inactive (not approved)"}`);
    break;
  }

  case "sweep": {
    await sweep();
    break;
  }

  default:
    // Everything from line 2 to the end of the header comment: anchored on the
    // comment itself, not a hard-coded length, which had already drifted and
    // was hiding `grant` from its own --help.
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    const end = src.findIndex((l, i) => i > 1 && !l.startsWith("//"));
    console.log(src.slice(1, end).join("\n"));
}
