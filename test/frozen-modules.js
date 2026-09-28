// Test helper (not a test file): Finance, Analytics and shared code are frozen on the Nordla platform baseline (08619d7).
// The only allowed exception is the fr-BE customer-facing label pass (owner decision 2026-09-28): the FR dictionaries and the
// page titles may change their VISIBLE TEXT, never their keys, and no other Finance / Analytics / shared file may change.
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASELINE = '08619d7';
const ROOT = new URL('..', import.meta.url);
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
export const LABEL_FILES = ['src/analytics-premium/ui/index.html', 'src/analytics-premium/ui/lang-fr.js', 'src/finance/ui/index.html', 'src/finance/ui/lang-fr.js'];
// Page-local stylesheet of Analyses > Produits: only an APPENDED rule is allowed (a longer fr-BE label must still fit at 320 px).
export const APPEND_ONLY_FILES = ['src/analytics-premium/ui/products.css'];
// Analyses amounts in fr-BE (owner decision 2026-09-28): in app.js only the money-formatter lines (and their comment) may differ.
// Analyses percentages / numbers / dates in the chosen locale (same decision): the percent, number and date formatter lines, and the
// Parle à Nordla share line in ask.js.
export const LINE_SCOPED_FILES = {
  'src/analytics-premium/ui/app.js': /fmtMoney|fmtPct|fmtNum|fmtDate|fmtSignedPct|rank-share|wc\.bodyText|^\s*\/\/ (Amounts use the same formatters|en-GB\): totals in whole euros|Percentages, numbers and dates follow)/,
  'src/analytics-premium/ui/ask.js': /identified_share/,
};
// Keys the fr-BE pass may ADD to the Analyses dictionaries (NL / EN: same output as before, e.g. "{0}pp"); every other key and every
// NL / EN value stays exactly as on the baseline.
export const ADDED_KEYS = ['common.pp'];
export const KEY_ADD_ONLY_FILES = ['src/analytics-premium/ui/lang-nl.js', 'src/analytics-premium/ui/lang-en.js'];

function dictOf(src, file) {
  const ctx = { window: { FINANCE_LANG: {} } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: file });
  const lang = /lang-(\w+)\.js$/.exec(file)[1];
  return file.includes('/finance/') ? ctx.window.FINANCE_LANG[lang].messages : ctx.window.NORDLA_DICTS[lang];
}
const frKeys = (src, file) => Object.keys(dictOf(src, file)).filter((k) => !ADDED_KEYS.includes(k)).sort();

/** Returns the list of violations (empty = the freeze holds). */
export function frozenViolations() {
  const changed = git(['diff', '--name-only', BASELINE, '--', 'src/finance', 'src/analytics-premium', 'src/shared']).trim().split('\n').filter(Boolean);
  const out = changed.filter((f) => !LABEL_FILES.includes(f) && !APPEND_ONLY_FILES.includes(f) && !LINE_SCOPED_FILES[f] && !KEY_ADD_ONLY_FILES.includes(f)).map((f) => `${f}: frozen file changed`);
  for (const f of changed.filter((x) => KEY_ADD_ONLY_FILES.includes(x))) {
    const before = dictOf(git(['show', `${BASELINE}:${f}`]), f); const now = dictOf(readFileSync(new URL(f, ROOT), 'utf8'), f);
    const extra = Object.keys(now).filter((k) => !(k in before) && !ADDED_KEYS.includes(k));
    const changedValues = Object.keys(before).filter((k) => now[k] !== before[k]);
    if (extra.length || changedValues.length) out.push(`${f}: only ${ADDED_KEYS.join(', ')} may be added (extra: ${extra.length}, changed: ${changedValues.length})`);
  }
  const norm = (x) => x.replace(/\r\n/g, '\n');
  for (const f of changed.filter((x) => LINE_SCOPED_FILES[x])) {
    const lines = git(['diff', '-U0', '--ignore-cr-at-eol', BASELINE, '--', f]).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).map((l) => l.slice(1));
    const foreign = lines.filter((l) => !LINE_SCOPED_FILES[f].test(l));
    if (foreign.length) out.push(`${f}: lines outside the allowed scope changed (${foreign.length})`);
  }
  for (const f of changed.filter((x) => APPEND_ONLY_FILES.includes(x))) {
    if (!norm(readFileSync(new URL(f, ROOT), 'utf8')).startsWith(norm(git(['show', `${BASELINE}:${f}`])))) out.push(`${f}: existing rules changed (append only)`);
  }
  for (const f of changed.filter((x) => LABEL_FILES.includes(x))) {
    const before = git(['show', `${BASELINE}:${f}`]);
    const now = readFileSync(new URL(f, ROOT), 'utf8');
    if (f.endsWith('.js')) {
      if (JSON.stringify(frKeys(before, f)) !== JSON.stringify(frKeys(now, f))) out.push(`${f}: translation keys changed`);
    } else {
      const strip = (s) => s.replace(/\r\n/g, '\n').replace(/<title>[^<]*<\/title>/, '<title></title>');
      if (strip(before) !== strip(now)) out.push(`${f}: more than the <title> changed`);
    }
  }
  return out;
}
