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
//   node scripts/keys-admin.mjs keys                       every key that exists, with status
//   node scripts/keys-admin.mjs grant <email> [plan]       plan: free (default) | demo | apify
//   node scripts/keys-admin.mjs approve-key <hash-prefix>   re-enable a key
//   node scripts/keys-admin.mjs revoke-key  <hash-prefix>
//
// Needs ADMIN_TOKEN (the Worker secret of the same name), read from the
// environment or from ../.secrets/api-admin.env. API_BASE overrides the URL
// (e.g. http://localhost:8790 for wrangler dev).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

async function call(method, p) {
  const res = await fetch(`${BASE}/v1/admin${p}`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${res.status} ${body.title ?? ""} — ${body.detail ?? ""}`);
    process.exit(1);
  }
  return body.data;
}

const [cmd, arg, arg2] = process.argv.slice(2);
switch (cmd) {
  case "grant": {
    if (!arg) { console.error("usage: keys-admin.mjs grant <email> [free|demo|apify]"); process.exit(1); }
    const plan = arg2 ?? "free";
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
  case "approve-key":
  case "revoke-key": {
    const r = await call("POST", `/keys/${arg}/${cmd === "approve-key" ? "approve" : "revoke"}`);
    console.log(`${r.key_hash_prefix}… ${r.email}: ${r.usable ? "ACTIVE" : "inactive"}`);
    break;
  }
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 14).join("\n"));
}
