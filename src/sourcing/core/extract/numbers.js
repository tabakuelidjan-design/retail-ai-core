// Number safety for supplier text. Money, MOQ and dimensions are never "helpfully" reinterpreted: a token is either unambiguous (and then kept as written, as a string, so
// 6.80 stays 6.80) or AMBIGUOUS (no value: a person decides). Isomorphic and pure.

/**
 * @param {string} raw the digits exactly as the supplier wrote them (no currency symbol, no unit)
 * @param {'price'|'quantity'|'measure'} kind
 * @returns {{ raw: string, value: string|null, ambiguous: boolean, flags: string[], suggestion?: string }}
 */
export function parseNumberToken(raw, kind = 'price') {
  const r = String(raw);
  const ok = (value, flags = []) => ({ raw: r, value, ambiguous: false, flags });
  const amb = (suggestion) => ({ raw: r, value: null, ambiguous: true, flags: ['AMBIGUOUS_NUMBER'], ...(suggestion ? { suggestion } : {}) });
  if (/^\d+$/.test(r)) return ok(r);
  if (/^\d+\.\d+$/.test(r)) return ok(r);
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(r)) { // 1,200 / 1,200.50
    if (/\./.test(r)) return ok(r.replace(/,/g, ''), ['THOUSANDS_COMMA_REMOVED']);
    return kind === 'quantity' ? ok(r.replace(/,/g, ''), ['THOUSANDS_COMMA_REMOVED']) : amb(r.replace(/,/g, '')); // a price 1,200 may be 1200 or 1.2
  }
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(r)) return ok(r.replace(/\./g, '').replace(',', '.'), ['EU_NUMBER_FORMAT']); // 1.200,50: unambiguous European format
  if (/^\d+,\d{1,2}$/.test(r)) return amb(r.replace(',', '.')); // 6,8 / 6,80: a decimal comma or a typo: ask
  return amb(null);
}

/** Chinese 万 (ten thousand): an EXPLICIT, reversible conversion (the original token is kept by the caller). Returns null when the result is not a whole number. */
export function wanToNumber(raw) {
  const m = /^(\d+(?:\.\d+)?)万$/.exec(String(raw)); if (!m) return null;
  const v = Math.round(Number(m[1]) * 10000 * 1e6) / 1e6; return Number.isInteger(v) ? String(v) : null;
}
