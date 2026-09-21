// Document numbering. Numbers are allocated ONLY when a document is issued (invoice / credit note) or sent (quote),
// never for drafts, so a cancelled draft leaves no gap. Allocation itself is atomic in the store (a DB function in
// production); this module only formats and validates. The scheme is merchant configuration.

export const DEFAULT_NUMBERING = {
  invoice: { prefix: 'INV', pad: 4 },
  credit_note: { prefix: 'CN', pad: 4 },
  quote: { prefix: 'QT', pad: 4 },
  format: '{prefix}-{year}-{seq}', // year comes from the document's issue date, so a sequence restarts each year
};

export function formatNumber(numbering, type, year, seq) {
  const n = { ...DEFAULT_NUMBERING, ...(numbering ?? {}) };
  const t = n[type];
  if (!t) throw new Error(`no numbering configured for ${type}`);
  if (!Number.isInteger(seq) || seq < 1) throw new Error('sequence must be a positive integer');
  return n.format.replace('{prefix}', t.prefix).replace('{year}', String(year)).replace('{seq}', String(seq).padStart(t.pad, '0'));
}

/** Sequence key for a document: one counter per merchant, document type and issue year. */
export const sequenceKey = (type, issueDate) => ({ type, year: Number(issueDate.slice(0, 4)) });

/** Check that a list of issued numbers of one type/year is consecutive and duplicate-free. */
export function findNumberingGaps(seqs) {
  const sorted = [...seqs].sort((a, b) => a - b);
  const duplicates = sorted.filter((v, i) => i > 0 && v === sorted[i - 1]);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) for (let v = sorted[i - 1] + 1; v < sorted[i]; v++) gaps.push(v);
  if (sorted.length && sorted[0] !== 1) for (let v = 1; v < sorted[0]; v++) gaps.push(v);
  return { gaps, duplicates };
}
