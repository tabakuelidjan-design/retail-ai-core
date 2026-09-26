// Secret hygiene for everything that can be logged, reported or stored. Two layers:
//   scrubSecrets(text, secrets)   removes a key WHOLE OR IN PART: the exact value, any long prefix/suffix of it, the masked echoes providers send back
//                                 ("Incorrect API key provided: sk-proj-****abcd"), key-shaped tokens of any vendor, Authorization / x-api-key values;
//   findKeyFragments(text, key)   the last line of defence: reports whether a text still holds any exploitable piece of a known key.

const ELLIPSIS_MASK = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]*\.{3}[A-Za-z0-9_-]*/g;
const STAR_MASK = /[A-Za-z0-9_.-]*\*{3,}[A-Za-z0-9_.-]*/g;      // prefix + stars + suffix: how a provider echoes a wrong key
const ECHO = /((?:incorrect|invalid|wrong|bad|unknown|revoked|expired|missing)\s+(?:api[ _-]?)?(?:key|token|credential)s?\b[^:"\n]{0,40}:\s*)"?[^\s"',}]+/gi;   // "Incorrect API key provided: <anything>"
const KEY_SHAPES = [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, /\bAIza[A-Za-z0-9_-]{20,}/g, /\b(?:ghp|gho|xox[bap])[-_A-Za-z0-9]{12,}/g];
const HEADER = /(authorization|x-api-key|api[_-]?key)["']?\s*[:=]\s*["']?(?:Bearer\s+)?[^\s"',}]+/gi;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
const MIN_PREFIX = 10;   // beyond the generic vendor prefix ("sk-proj-", "sk-ant-api03-")
const MIN_SUFFIX = 6;

// Short pieces (a 4-5 character suffix, a 6-9 character prefix) are only removed as STANDALONE tokens - next to no letter or digit - so that a provider's
// "...ending in ab12" is caught without touching ordinary words.
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
const standalone = (frag) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(frag)}(?![A-Za-z0-9])`, 'g');

/** Replace every whole or partial occurrence of the known secrets, then every key-shaped or masked-key-shaped fragment. */
export function scrubSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (!s || s.length < 6) continue;
    out = out.split(s).join('[redacted]');
    for (let k = s.length - 1; k >= MIN_PREFIX; k -= 1) out = out.split(s.slice(0, k)).join('[redacted]');       // long prefixes (longest first)
    for (let k = s.length - 1; k >= MIN_SUFFIX; k -= 1) out = out.split(s.slice(s.length - k)).join('[redacted]'); // long suffixes
    for (let k = 9; k >= 6; k -= 1) if (s.length > k) out = out.replace(standalone(s.slice(0, k)), '[redacted]');      // short prefixes, standalone only
    for (let k = 5; k >= 4; k -= 1) if (s.length > k) out = out.replace(standalone(s.slice(s.length - k)), '[redacted]'); // 4-5 character suffixes, standalone only
  }
  out = out.replace(ECHO, '$1[redacted]').replace(STAR_MASK, '[redacted]').replace(ELLIPSIS_MASK, '[redacted]');
  for (const re of KEY_SHAPES) out = out.replace(re, '[redacted]');
  return out.replace(HEADER, '$1: [redacted]').replace(BEARER, 'Bearer [redacted]');
}

/** Pieces of `key` still present in `text`: the whole key, a prefix beyond the vendor prefix, a long suffix, or a masked-key pattern. */
export function findKeyFragments(text, key) {
  const found = []; const s = String(text ?? '');
  if (key && key.length >= 6) {
    if (s.includes(key)) found.push('the full key');
    for (let k = key.length - 1; k >= MIN_PREFIX; k -= 1) if (s.includes(key.slice(0, k))) { found.push(`a ${k}-character prefix`); break; }
    for (let k = key.length - 1; k >= MIN_SUFFIX; k -= 1) if (s.includes(key.slice(key.length - k))) { found.push(`a ${k}-character suffix`); break; }
    for (let k = 5; k >= 4; k -= 1) if (standalone(key.slice(key.length - k)).test(s)) { found.push(`a ${k}-character suffix`); break; }
    for (let k = 9; k >= 6; k -= 1) if (standalone(key.slice(0, k)).test(s)) { found.push(`a ${k}-character prefix`); break; }
  }
  if (/[A-Za-z0-9_.-]*\*{3,}[A-Za-z0-9_.-]+/.test(s)) found.push('a masked-key echo');
  if (/api key provided:\s*(?!\[redacted\])\S/i.test(s)) found.push('a provider key-echo message');
  return found;
}
