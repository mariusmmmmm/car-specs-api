#!/usr/bin/env node
// x402 probe (T285) — one verify-shaped payment per paid route, then ask PayAI
// whether the routes are in its Bazaar catalog.
//
//   node scripts/x402-probe.mjs                 # production, throwaway key
//   node scripts/x402-probe.mjs http://localhost:8787
//   node scripts/x402-probe.mjs --status-only   # only read the catalog
//
// What it proves, and what it costs:
//   * By default the payer is a key generated here, in memory, never funded,
//     never printed. Its payment is refused for balance — so NOTHING is paid —
//     but the payload still reaches the facilitator's /verify, which is where
//     PayAI catalogs a resource ("cataloging runs on /verify as well as
//     /settle; verification moves no funds", docs.payai.network/x402/
//     facilitators/bazaar.md). The answer it should print per route is
//     `invalid_exact_evm_insufficient_balance` — any other reason is a real
//     problem in our 402 or in the payload.
//   * X402_PROBE_PRIVATE_KEY (0x…, a FUNDED Base key, set by its owner in the
//     shell, never committed) makes it a real purchase: $0.005 for search,
//     $0.05 for one car's specs, settled to the address in wrangler.toml. Only
//     needed if PayAI turns out not to catalog from a refused verify.
//
// Dependencies: only what api/ already installs (@x402/core, @x402/evm, viem).

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const args = process.argv.slice(2);
const statusOnly = args.includes("--status-only");
const base = (args.find((a) => !a.startsWith("--")) ?? "https://api.cars-data.com").replace(/\/$/, "");
const FACILITATOR = "https://facilitator.payai.network";
// A token from a real search would be better, but any well-formed token is a
// valid resource for the catalog: the listing key is the route TEMPLATE.
const ROUTES = [
  { path: "/v1/search?q=golf", catalog: `${base}/v1/search` },
  { path: "/v1/variants/v_1a2b3c4d/specs", catalog: `${base}/v1/variants/:id/specs` },
];

const funded = process.env.X402_PROBE_PRIVATE_KEY;
const account = privateKeyToAccount(funded ?? generatePrivateKey());
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const http = new x402HTTPClient(client);
const UA = "cars-data-x402-probe/1 (+https://cars-data.com/en/api)";

async function probe(path) {
  const url = base + path;
  const first = await fetch(url, { headers: { "user-agent": UA } });
  if (first.status !== 402) return { path, unpaid: first.status, note: "expected 402 — x402 is off or the route moved" };
  const text = await first.text();
  const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), text ? JSON.parse(text) : undefined);
  const declared = Boolean(required.extensions?.bazaar);
  const payload = await client.createPaymentPayload(required);
  const second = await fetch(url, {
    headers: { "user-agent": UA, ...http.encodePaymentSignatureHeader(payload) },
  });
  const out = { path, unpaid: 402, declaresBazaar: declared, echoed: Boolean(payload.extensions?.bazaar), paid: second.status };
  const pr = second.headers.get("PAYMENT-REQUIRED");
  if (pr) out.facilitatorSays = decodePaymentRequiredHeader(pr).error;
  const ps = second.headers.get("PAYMENT-RESPONSE");
  if (ps) out.settlement = decodePaymentResponseHeader(ps);
  return out;
}

async function listing(resource) {
  const r = await fetch(`${FACILITATOR}/discovery/listing-status?resource=${encodeURIComponent(resource)}`);
  if (r.status === 404) return { resource, listed: false, note: "no catalog row and no recent write" };
  const d = await r.json();
  return { resource, listed: d.listed, hidden: d.hidden, hiddenReason: d.hiddenReason, lastWrite: d.lastWrite, lastProbe: d.lastProbe };
}

console.log(`payer: ${funded ? "FUNDED key from X402_PROBE_PRIVATE_KEY" : "throwaway, unfunded"} ${account.address.slice(0, 10)}…`);
if (!statusOnly) for (const r of ROUTES) console.log(JSON.stringify(await probe(r.path)));
if (!statusOnly) await new Promise((res) => setTimeout(res, 8000)); // cataloging is asynchronous
for (const r of ROUTES) console.log(JSON.stringify(await listing(r.catalog)));
