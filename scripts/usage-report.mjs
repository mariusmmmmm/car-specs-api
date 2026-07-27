#!/usr/bin/env node
// BIZ-D7 §5 — the Phase-1 "dashboard": a plain-text 7-day usage report over the
// Workers Analytics Engine SQL API. No Grafana, no SaaS.
//
//   CF_ACCOUNT_ID=...  CF_ANALYTICS_TOKEN=...  node scripts/usage-report.mjs [days]
//
// CF_ANALYTICS_TOKEN = a Cloudflare API token with **Account Analytics: Read**
// (owner-created, passed via env, never committed). CF_ACCOUNT_ID = the account
// the Worker is deployed to. `days` defaults to 7.

const ACCOUNT = process.env.CF_ACCOUNT_ID;
const TOKEN = process.env.CF_ANALYTICS_TOKEN;
const DATASET = "cars_data_api_usage";
const DAYS = Number(process.argv[2] ?? 7);

if (!ACCOUNT || !TOKEN) {
  console.error("Set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN (token needs Account Analytics: Read).");
  process.exit(1);
}

const SINCE = `timestamp > NOW() - INTERVAL '${DAYS}' DAY`;

async function q(sql) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL API ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).data ?? [];
}

function table(title, rows, cols) {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log("  (no data)");
    return;
  }
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) => "  " + cells.map((v, i) => String(v).padEnd(widths[i])).join("  ");
  console.log(line(cols.map((c) => c.label)));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(cols.map((c) => c.get(r))));
}

const n = (v) => Math.round(Number(v ?? 0)).toLocaleString("en-US");

(async () => {
  console.log(`cars-data-api — usage, last ${DAYS} days (UTC ${new Date().toISOString().slice(0, 10)})`);

  const bySurface = await q(
    `SELECT blob1 AS surface, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${SINCE} GROUP BY surface ORDER BY n DESC`,
  );
  table("Calls by surface", bySurface, [
    { label: "surface", get: (r) => r.surface || "-" },
    { label: "calls", get: (r) => n(r.n) },
  ]);

  const topNames = await q(
    `SELECT blob1 AS surface, blob2 AS name, SUM(_sample_interval) AS n FROM ${DATASET}
     WHERE ${SINCE} AND blob1 IN ('mcp','rest') GROUP BY surface, name ORDER BY n DESC LIMIT 10`,
  );
  table("Top 10 tools / routes", topNames, [
    { label: "surface", get: (r) => r.surface || "-" },
    { label: "name", get: (r) => r.name || "-" },
    { label: "calls", get: (r) => n(r.n) },
  ]);

  const byClient = await q(
    `SELECT blob4 AS client, SUM(_sample_interval) AS n FROM ${DATASET}
     WHERE ${SINCE} AND blob1 = 'mcp' GROUP BY client ORDER BY n DESC LIMIT 15`,
  );
  table("MCP calls by client (clientInfo.name)", byClient, [
    { label: "client", get: (r) => r.client || "-" },
    { label: "calls", get: (r) => n(r.n) },
  ]);

  const topIps = await q(
    `SELECT blob5 AS ip, SUM(_sample_interval) AS n FROM ${DATASET}
     WHERE ${SINCE} AND blob1 IN ('mcp','mcp-throttled') GROUP BY ip ORDER BY n DESC LIMIT 10`,
  );
  const ipTotal = topIps.reduce((s, r) => s + Number(r.n ?? 0), 0);
  table("Top 10 IP hashes (MCP), share of shown total", topIps, [
    { label: "ip_hash", get: (r) => r.ip || "-" },
    { label: "calls", get: (r) => n(r.n) },
    { label: "share", get: (r) => (ipTotal ? `${((Number(r.n) / ipTotal) * 100).toFixed(1)}%` : "-") },
  ]);

  const [{ d } = { d: 0 }] = await q(
    `SELECT COUNT(DISTINCT blob5) AS d FROM ${DATASET} WHERE ${SINCE} AND blob1 IN ('mcp','mcp-throttled')`,
  );
  const [{ t } = { t: 0 }] = await q(
    `SELECT SUM(_sample_interval) AS t FROM ${DATASET} WHERE ${SINCE} AND blob1 = 'mcp-throttled'`,
  );
  console.log(`\nDistinct MCP IP hashes: ${n(d)}`);
  console.log(`Anonymous 429s (mcp-throttled): ${n(t)}`);
  console.log("\nTripwires (BIZ-D7 §4): one IP > ~30% of MCP volume, or > ~50k tool-calls/day, or DB-connection pressure.");
})().catch((e) => {
  console.error("report failed:", e.message);
  process.exit(1);
});
