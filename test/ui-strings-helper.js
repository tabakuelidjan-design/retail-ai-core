// Extracts the static string literals of a browser script (comments skipped), so tests can prove that every merchant-facing message
// has a translation. Template literals contribute their static text with {} for each interpolation.

export function extractStrings(src) {
  const out = new Set();
  const n = src.length; let i = 0;
  const BS = String.fromCharCode(92);
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') { i = src.indexOf('*/', i) + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1; let s = '';
      while (j < n && src[j] !== c) { if (src[j] === BS) { s += src[j + 1]; j += 2; } else { s += src[j]; j += 1; } }
      out.add(s); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1; let s = '';
      while (j < n) {
        if (src[j] === BS) { s += src[j + 1]; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') { s += '{}'; let k = j + 2; let dep = 1; while (k < n && dep) { if (src[k] === '{') dep += 1; else if (src[k] === '}') dep -= 1; k += 1; } j = k; continue; }
        if (src[j] === '`') break;
        s += src[j]; j += 1;
      }
      out.add(s); i = j + 1; continue;
    }
    i += 1;
  }
  return out;
}

/** Strings that look like text a person reads (not CSS classes, keys, paths, codes). */
export function looksLikeMessage(s) {
  if (!/[A-Za-z]{3,}/.test(s)) return false;
  if (/^[a-z][a-z0-9_-]*( [a-z][a-z0-9_-]*)*$/.test(s)) return false; // css classes / ids / single lowercase words
  if (/^[A-Z][A-Z0-9_]+$/.test(s)) return false; // status / error codes
  if (/^(#|\/|\.|https?:|data:|application\/|text\/)/.test(s)) return false;
  if (/^[\w.-]+:[\w.-]+/.test(s) && !/\s/.test(s)) return false;
  return true;
}
