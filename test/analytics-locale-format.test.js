// Analyses - percentages, numbers and dates follow the chosen language's Belgian locale (owner decision 2026-09-28):
// fr-BE "12,3 %", nl-BE "12,3%", en-GB "12.3%"; never the English "12.3%" in the French interface, no ISO date shown to the reader.
// The formatters are the real ones from src/analytics-premium/ui/app.js (+ Parle à Nordla in ask.js), run in a sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const UI = new URL('../src/analytics-premium/ui/', import.meta.url);
const src = (f) => readFileSync(new URL(f, UI), 'utf8');
const plain = (s) => String(s).replace(/[  ]/g, ' ');

function sandbox(lang) {
  const ctx = { window: {}, Intl, Math, Number, String, Date };
  vm.createContext(ctx);
  for (const l of ['fr', 'nl', 'en']) vm.runInContext(src(`lang-${l}.js`), ctx);
  const dict = ctx.window.NORDLA_DICTS[lang];
  ctx.t = (k, ...a) => String(dict[k] ?? k).replace(/\{(\d+)\}/g, (_, i) => a[Number(i)]);
  ctx.NORDLA_I18N = { getLang: () => lang };
  const pick = (f, re) => src(f).split('\n').filter((l) => re.test(l)).join('\n');
  vm.runInContext(`${pick('app.js', /^const (LANG_TAG|chartTag|fmtPct|fmtNum|fmtDate|fmtSignedPct) =/)}
${pick('ask.js', /^function askFigureValue|^\s+if \(f\.id === 'identified_share'\)/)} }
this.out = { fmtPct, fmtNum, fmtDate, fmtSignedPct, askFigureValue };`, ctx);
  return ctx.out;
}

test('French interface: "12,3 %", "+12 %", "72,2", "29 juil. 2026" and "+1,2 pts" (fr-BE)', () => {
  const f = sandbox('fr');
  assert.equal(plain(f.fmtPct(0.123)), '12,3 %');
  assert.equal(plain(f.fmtPct(0.12, 0)), '12 %', 'Point du matin ranking share');
  assert.equal(plain(f.fmtSignedPct(0.12)), '+12 %');
  assert.equal(plain(f.fmtSignedPct(-0.05)), '-5 %');
  assert.equal(plain(f.fmtNum(72.2, 1)), '72,2');
  assert.equal(plain(f.fmtDate('2026-07-29')), '29 juil. 2026');
  assert.equal(plain(f.askFigureValue({ id: 'identified_share', value: 0.123 })), '12,3 %', 'Parle à Nordla');
  assert.equal(f.fmtPct(null), '—');
  const dict = (() => { const c = { window: {} }; vm.createContext(c); vm.runInContext(src('lang-fr.js'), c); return c.window.NORDLA_DICTS.fr; })();
  assert.equal(dict['common.pp'].replace('{0}', `+${plain(f.fmtNum(1.2, 1))}`), '+1,2 pts');
});

test('NL and EN keep their own conventions (nl-BE decimal comma, en-GB decimal point), translations unchanged', () => {
  const nl = sandbox('nl'); const en = sandbox('en');
  assert.equal(plain(nl.fmtPct(0.123)), '12,3%');
  assert.equal(plain(en.fmtPct(0.123)), '12.3%');
  assert.equal(plain(en.fmtSignedPct(0.12)), '+12%');
  assert.equal(plain(nl.fmtDate('2026-07-29')), '29 jul 2026');
  assert.equal(plain(en.fmtDate('2026-07-29')), '29 Jul 2026');
});

test('no hardcoded English percentage / decimal format left in the Analyses page code', () => {
  for (const f of ['app.js', 'ask.js']) {
    const s = src(f);
    assert.doesNotMatch(s, /\.toFixed\(1\)\}\s?%|\$\{shareOfTop\}%|\$\{pp\}pp|Math\.round\(v \* 100\)\}%/, f);
  }
});
