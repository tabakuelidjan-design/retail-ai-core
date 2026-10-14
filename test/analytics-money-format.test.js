// Analyses - customer-facing amounts follow the chosen language's Belgian locale (fr-BE by default): "1 234 €" for totals,
// "1 234,50 €" where cents matter (average basket). Never the English "€ 1,234" again (owner decision 2026-09-28).
// The formatters are the real ones from src/analytics-premium/ui (explorer.js + app.js), run in a sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const UI = new URL('../src/analytics-premium/ui/', import.meta.url);
const src = (f) => readFileSync(new URL(f, UI), 'utf8');
const NBSP = /[  ]/g; // Intl uses (narrow) no-break spaces: compare with plain spaces

function formatters(lang) {
  const ctx = { Intl, Math, Number, String, location: { hash: '' }, NORDLA_I18N: { getLang: () => lang }, t: (k) => (k === 'common.dash' ? '—' : k) };
  vm.createContext(ctx);
  // Only the formatter definitions are evaluated (no DOM): explorer.js's money helpers + app.js's LANG_TAG / chartTag / fmtMoney*.
  const ex = src('explorer.js').split('\n').filter((l) => /^const (exMoney2?|exSigned|exPct|exShare) =/.test(l)).join('\n');
  const app = src('app.js').split('\n').filter((l) => /^const (LANG_TAG|chartTag|fmtCompactMoney|fmtMoney|fmtMoneyCents) =/.test(l)).join('\n');
  vm.runInContext(`${ex}\n${app}\nthis.out = { fmtMoney, fmtMoneyCents, exMoney, exMoney2 };`, ctx);
  const plain = (f) => (v, cur = 'EUR') => f(v, cur).replace(NBSP, ' ');
  return Object.fromEntries(Object.entries(ctx.out).map(([k, f]) => [k, plain(f)]));
}

test('Analyses amounts in fr-BE: "1 234 €" for totals, "1 234,50 €" where cents matter', () => {
  const f = formatters('fr');
  assert.equal(f.fmtMoney(1234), '1 234 €');
  assert.equal(f.fmtMoney(1234.4), '1 234 €', 'totals are whole euros (display only, the value is not changed)');
  assert.equal(f.fmtMoney(-80), '-80 €');
  assert.equal(f.fmtMoneyCents(1234.5), '1 234,50 €');
  assert.equal(f.fmtMoneyCents(52), '52,00 €');
  assert.equal(f.fmtMoney(null), '—');
  // Same output as the formatters Exploration / Clients / Produits already use: one format across the module.
  assert.equal(f.fmtMoney(98765), f.exMoney(98765));
  assert.equal(f.fmtMoneyCents(12.3), f.exMoney2(12.3));
});

test('Analyses amounts follow the chosen language (nl-BE / en-GB), never the old "€ 1,234"', () => {
  assert.equal(formatters('nl').fmtMoney(1234), '€ 1.234');
  assert.equal(formatters('en').fmtMoney(1234), '€1,234');
  assert.doesNotMatch(src('app.js'), /toLocaleString\('en-US'|`€ \$\{/, 'no hardcoded English money format left in app.js');
});
