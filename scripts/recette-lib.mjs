// Phase 5 - pure helpers for the staging recette (no network, no secret is printed by these functions).
// The accounts and their passwords live OUTSIDE the repository (see scripts/recette-staging.mjs); this file only reads and checks.

/** Parse KEY=VALUE lines. Ignores blanks and comments. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Cookie header from a list of Set-Cookie strings (name=value only). */
export function cookieHeaderOf(setCookies) {
  return (setCookies ?? []).map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
}

/** Compare each check's observed status with its expected one. Returns the table and the failures. */
export function evaluate(checks) {
  const rows = checks.map((c) => {
    const expected = Array.isArray(c.expect) ? c.expect : [c.expect];
    const ok = expected.includes(c.observed);
    return { id: c.id, role: c.role, action: c.action, expected: expected.join('|'), observed: String(c.observed), ok };
  });
  const failures = rows.filter((r) => !r.ok);
  return { rows, failures, passed: rows.length - failures.length, total: rows.length };
}

/** A printable table of the rows (no secret, no cookie, no token). */
export function renderTable(rows) {
  const head = ['#', 'Rôle', 'Action', 'Attendu', 'Observé', 'Résultat'];
  const body = rows.map((r) => [r.id, r.role, r.action, r.expected, r.observed, r.ok ? 'OK' : 'ÉCHEC']);
  const all = [head, ...body];
  const width = head.map((_, i) => Math.max(...all.map((row) => String(row[i]).length)));
  const line = (row) => '| ' + row.map((v, i) => String(v).padEnd(width[i])).join(' | ') + ' |';
  return [line(head), '|' + width.map((w) => '-'.repeat(w + 2)).join('|') + '|', ...body.map(line)].join('\n');
}
