// Is cars_v3 being rewritten right now?
//
// The obvious check — `pgrep -f run-monthly.sh`, which is what this project's
// own note recommends — MATCHES ITS OWN CALLER: the string sits in the invoking
// shell's command line, so any process that merely MENTIONS the script counts
// as a running pipeline. Measured on 2026-10-06: it reported the pipeline
// running with the pipeline long finished, which would have blocked an enqueue
// indefinitely. Narrowing the pattern did not fix it either — a sibling shell
// quoting the string still matched. Text-matching command lines cannot work
// when the caller's own text names the target.
//
// So this measures the HAZARD instead of a proxy for it: is anything other than
// us holding a working connection to cars_v3? During a run the stages keep
// long-lived writer backends open, and between statements they sit in
// `idle in transaction` — which is exactly as dangerous to read as `active`.
import postgres from "postgres";

const WRITING_STATES = ["active", "idle in transaction", "idle in transaction (aborted)"];

export async function pipelineRunning(dsn = process.env.DEMO_SET_DSN ?? "postgresql://localhost:5432/cars_v3") {
  const sql = postgres(dsn, { max: 1, idle_timeout: 3 });
  try {
    const rows = await sql`
      SELECT pid, state, application_name,
             left(coalesce(query, ''), 80) AS query,
             round(extract(epoch FROM now() - coalesce(xact_start, query_start)))::int AS age_s
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = ANY(${WRITING_STATES})
      ORDER BY age_s DESC NULLS LAST
    `;
    return rows.length > 0
      ? { running: true, what: `${rows.length} backend(s); oldest ${rows[0].age_s}s: ${rows[0].state} — ${rows[0].query}` }
      : { running: false, what: null };
  } finally {
    await sql.end();
  }
}

if (process.argv[2] === "--check") {
  const r = await pipelineRunning();
  console.log(r.running ? `WRITING: ${r.what}` : "cars_v3 is quiet");
  process.exit(r.running ? 1 : 0);
}
