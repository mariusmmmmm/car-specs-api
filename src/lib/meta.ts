// Every response carries last_synced_at per L2a acceptance criteria. Falls
// back to "now" only when a table has no rows with a timestamp at all
// (empty result set), never to mask genuinely missing sync data.
export function maxSyncedAt(rows: Array<{ last_synced_at: Date | string | null }>): string {
  let max: Date | null = null;
  for (const r of rows) {
    if (!r.last_synced_at) continue;
    const d = r.last_synced_at instanceof Date ? r.last_synced_at : new Date(r.last_synced_at);
    if (!max || d > max) max = d;
  }
  return (max ?? new Date()).toISOString();
}
