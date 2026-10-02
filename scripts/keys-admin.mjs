#!/usr/bin/env node
// Owner tool for the manual key approval flow (T73). Every Free API key is
// reviewed by hand: a request arrives by email (subject "[cars-data API] Key
// request <id>"), you decide here, and on approval the Worker emails the key
// to the requester. Talks to the Worker's /v1/admin routes.
//
//   node scripts/keys-admin.mjs requests [pending|approved|rejected|all]
//   node scripts/keys-admin.mjs approve <request-id>
//   node scripts/keys-admin.mjs reject  <request-id>
//   node scripts/keys-admin.mjs keys                     every key that exists, with status
//   node scripts/keys-admin.mjs approve-key <hash-prefix>  re-enable a key issued before approval existed
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

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "requests": {
    const rows = await call("GET", `/requests?status=${arg ?? "pending"}`);
    if (!rows.length) console.log("No requests.");
    for (const r of rows) {
      console.log(`\n${r.id}  ${r.status}  ${r.created_at.slice(0, 16)}  ${r.name} <${r.email}>  ${r.company ?? ""}`);
      console.log(`  ${r.use_case.replace(/\n/g, "\n  ")}`);
    }
    break;
  }
  case "approve": {
    const r = await call("POST", `/requests/${arg}/approve`);
    console.log(r.emailed
      ? `Approved ${arg}: key ${r.key_hash_prefix}… emailed to ${r.email}.`
      : `Approved ${arg}, but the email FAILED — send this key to ${r.email} yourself:\n${r.api_key}`);
    break;
  }
  case "reject":
    await call("POST", `/requests/${arg}/reject`);
    console.log(`Rejected ${arg}.`);
    break;
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
