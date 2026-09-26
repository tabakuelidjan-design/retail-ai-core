// Batched writes for the sync modules. The sync used to send one Supabase request per row; each round trip
// costs ~180 ms from Railway to Supabase, so a 15-minute cycle spent most of its time waiting on the network.
// These helpers send many rows per request while writing exactly the rows the one-by-one code wrote.

export const WRITE_CHUNK_SIZE = 500; // rows per request: keeps each POST body well under PostgREST/proxy limits

// PostgREST builds a bulk write's column list from the rows' keys: a key missing from one row is written as
// NULL instead of being left untouched. Rows with different key sets therefore never share a request.
function groupByKeySet(rows) {
  const groups = new Map();
  for (const row of rows) {
    const signature = Object.keys(row).sort().join(',');
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(row);
  }
  return [...groups.values()];
}

function chunks(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Upserts many rows in as few requests as possible. Postgres refuses an ON CONFLICT statement that touches
 * the same row twice, so rows sharing a conflict key are collapsed to the last one - the row that one-by-one
 * upserts would have left in the table.
 * @returns {Promise<object[]>} the upserted rows as returned by the database (order not guaranteed)
 */
export async function upsertInChunks(supabase, table, rows, { onConflict, chunkSize = WRITE_CHUNK_SIZE }) {
  const keys = onConflict.split(',');
  const lastByConflictKey = new Map();
  for (const row of rows) {
    const conflictKey = JSON.stringify(keys.map((k) => row[k]));
    lastByConflictKey.delete(conflictKey); // re-insert so the surviving row keeps the position of its last occurrence
    lastByConflictKey.set(conflictKey, row);
  }
  const returned = [];
  for (const group of groupByKeySet([...lastByConflictKey.values()])) {
    for (const chunk of chunks(group, chunkSize)) {
      returned.push(...(await supabase.upsert(table, chunk, { onConflict })));
    }
  }
  return returned;
}

/** Plain inserts (append-only history tables), many rows per request, in the order given. */
export async function insertInChunks(supabase, table, rows, { chunkSize = WRITE_CHUNK_SIZE } = {}) {
  const returned = [];
  for (const group of groupByKeySet(rows)) {
    for (const chunk of chunks(group, chunkSize)) {
      returned.push(...(await supabase.insert(table, chunk)));
    }
  }
  return returned;
}
