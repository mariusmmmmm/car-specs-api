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

// Three wrong signals before this one, so they are written down rather than
// quietly replaced:
//
//   1. `pgrep -f run-monthly.sh` — what this project's own note recommends —
//      MATCHES ITS OWN CALLER: the string sits in the invoking shell's command
//      line. It reported the pipeline running with the pipeline long finished.
//      Narrowing the pattern did not help; a sibling shell quoting the string
//      still matched. Command-line text cannot work when the caller names the
//      target.
//   2. "any non-idle backend" — refused when another session merely READ
//      cars_v3. Reads are not the hazard.
//   3. tuple-write deltas from pg_stat_database — those counters move on
//      COMMIT, so a single long INSERT, which is exactly what the import does,
//      leaves them flat for its whole duration. Looked quiet mid-write.
//
// What holds for the whole duration of a write, and is never taken by a reader,
// is a WRITE LOCK. Readers take AccessShareLock; anything that changes rows
// takes RowExclusiveLock or stronger, from the first row to the commit.
const WRITE_LOCKS = [
  "RowExclusiveLock",
  "ShareRowExclusiveLock",
  "ExclusiveLock",
  "AccessExclusiveLock",
];

export async function pipelineRunning(dsn = process.env.DEMO_SET_DSN ?? "postgresql://localhost:5432/cars_v3") {
  const sql = postgres(dsn, { max: 1, idle_timeout: 5 });
  try {
    const rows = await sql`
      SELECT l.pid, l.mode, c.relname AS rel,
             round(extract(epoch FROM now() - a.xact_start))::int AS age_s
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
      LEFT JOIN pg_class c ON c.oid = l.relation
      WHERE l.granted
        AND l.locktype = 'relation'
        AND l.mode = ANY(${WRITE_LOCKS})
        AND l.pid <> pg_backend_pid()
        AND a.datname = current_database()
        AND coalesce(c.relname, '') NOT LIKE 'pg\\_%'
      ORDER BY age_s DESC NULLS LAST
      LIMIT 5
    `;
    return rows.length > 0
      ? { running: true, what: `${rows.length} write lock(s); ${rows[0].mode} on ${rows[0].rel ?? "?"} for ${rows[0].age_s}s` }
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
