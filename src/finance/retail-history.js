// Retail history marker used by Finance completeness. Locally it is the sync-coverage file written by the backfill; on a host where Core runs as a
// separate service that file is not shared, so the LAST SUCCESSFUL SYNC time comes from the sync run log (Supabase) instead. The backfill facts
// (completeFrom / storeCreatedOn) are never invented: without the file they stay null and the period-start coverage rule simply does not apply.

/** @param {{completeFrom?: string|null, storeCreatedOn?: string|null, lastSyncedAt?: string|null}|null} fileCoverage @param {string|null} lastSuccessFinishedAt */
export function mergeRetailHistory(fileCoverage, lastSuccessFinishedAt) {
  const at = lastSuccessFinishedAt ? new Date(lastSuccessFinishedAt).toISOString() : null;
  if (!fileCoverage && !at) return null;
  return { completeFrom: fileCoverage?.completeFrom ?? null, storeCreatedOn: fileCoverage?.storeCreatedOn ?? null, lastSyncedAt: at ?? fileCoverage?.lastSyncedAt ?? null };
}
