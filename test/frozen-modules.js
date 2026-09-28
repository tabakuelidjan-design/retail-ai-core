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

function frKeys(src, file) {
  const ctx = { window: { FINANCE_LANG: {} } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: file });
  const d = file.includes('/finance/') ? ctx.window.FINANCE_LANG.fr.messages : ctx.window.NORDLA_DICTS.fr;
  return Object.keys(d).sort();
}

/** Returns the list of violations (empty = the freeze holds). */
export function frozenViolations() {
  const changed = git(['diff', '--name-only', BASELINE, '--', 'src/finance', 'src/analytics-premium', 'src/shared']).trim().split('\n').filter(Boolean);
  const out = changed.filter((f) => !LABEL_FILES.includes(f) && !APPEND_ONLY_FILES.includes(f)).map((f) => `${f}: frozen file changed`);
  const norm = (x) => x.replace(/\r\n/g, '\n');
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
