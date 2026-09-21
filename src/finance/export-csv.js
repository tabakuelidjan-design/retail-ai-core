// CSV export for accountants. RFC 4180 quoting; cells that a spreadsheet would execute as a formula are neutralised.
// The delimiter is configurable (Belgian Excel locales commonly expect ';').

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v, delimiter = ',') {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v) : String(v);
  // Negative numbers are legitimate values, not formulas.
  if (typeof v !== 'number' && FORMULA_START.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** @param {Array<object>} rows @param {Array<{key: string, header: string}>} columns */
export function toCsv(rows, columns, { delimiter = ',' } = {}) {
  const head = columns.map((c) => csvCell(c.header, delimiter)).join(delimiter);
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key], delimiter)).join(delimiter));
  return `﻿${[head, ...body].join('\r\n')}\r\n`; // BOM so Excel reads UTF-8 accents correctly
}
