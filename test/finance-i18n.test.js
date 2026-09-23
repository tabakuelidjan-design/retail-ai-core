import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractStrings, looksLikeMessage } from './ui-strings-helper.js';

const read = (f) => readFileSync(new URL(`../src/finance/ui/${f}`, import.meta.url), 'utf8');
function loadLang() {
  const win = {};
  for (const f of ['lang-fr.js', 'lang-nl.js']) new Function('window', read(f))(win);
  return win.FINANCE_LANG;
}
function loadI18n(stored) {
  const store = new Map(stored ? [['finance.lang', stored]] : []);
  const win = { FINANCE_LANG: loadLang(), localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
  const attrs = {};
  const doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
  new Function('window', 'document', read('i18n.js'))(win, doc);
  return { I18N: win.I18N, win, attrs, store };
}

// Strings in app.js that look like text but are not merchant-facing (keys, CSS, headers, keyboard names, file names, debug).
const NOT_UI = new Set(['Content-Type', 'X-CSRF-Token', 'UI error:', 'currentColor', '--accent', 'Enter', 'ArrowDown', 'ArrowUp', 'Escape', 'image/png,image/jpeg', 'pack.json', '60_plus', 'accounts@company.example', 'INV-2026-0001', '_MISSING', '_blank', 'YYYY-MM-DD']);
const isNotUi = (s) => NOT_UI.has(s) || /^(chip|dot2) /.test(s) || /^[\w.+-]+@[\w.-]+$/.test(s) || /^[a-z-]+:[^\s]/.test(s) || /^[a-z]+[A-Za-z0-9]*$/.test(s) || /^[a-z-]+ \{\}$/.test(s) || /[:;]\s?[\w{}.-]+;?$/.test(s) && /^(margin|flex|grid|--)/.test(s) || /^\[data-/.test(s) || /^(banner|toast|badge|pill|acard|kpi|seg|dot|avatar|navitem|lrow|basis|picker-row|card stat) /.test(s) || /^\{\}/.test(s) && !/[A-Za-z]{4,}\s/.test(s.replace(/\{\}/g, ''));

test('COVERAGE: every merchant-facing message of the dashboard exists in French AND Dutch', () => {
  const lang = loadLang();
  const src = `${read('app.js')}
${read('views-workspace.js')}
${read('views-contacts.js')}`;
  const messages = [...extractStrings(src)].map((s) => s.trim()).filter(looksLikeMessage).filter((s) => !isNotUi(s));
  // every literal handed to tt() / tr() must be translated whatever its shape (short, lowercase or upper-case labels included)
  for (const m of src.matchAll(/\b(?:tt|tr)\('((?:[^'\\]|\\.)*)'/g)) messages.push(m[1].replace(/\\'/g, "'"));
  for (const k of ['VAT']) messages.push(k);
  const dynamic = messages.map((s) => s.replace(/\{\}/g, '{0}'));
  const missing = { fr: [], nl: [] };
  for (const m of new Set(dynamic)) for (const l of ['fr', 'nl']) if (!(m in lang[l].messages) && !lang[l].patterns.some(([re]) => re.test(m))) missing[l].push(m);
  assert.deepEqual(missing.fr, [], `French translations missing:\n${missing.fr.join('\n')}`);
  assert.deepEqual(missing.nl, [], `Dutch translations missing:\n${missing.nl.join('\n')}`);
});
test('French and Dutch cover the same message ids (no orphan)', () => {
  const lang = loadLang();
  const fr = Object.keys(lang.fr.messages); const nl = Object.keys(lang.nl.messages);
  assert.deepEqual(fr.filter((k) => !(k in lang.nl.messages)), []); assert.deepEqual(nl.filter((k) => !(k in lang.fr.messages)), []);
  assert.ok(fr.length > 400);
  for (const l of ['fr', 'nl']) for (const [k, v] of Object.entries(lang[l].messages)) { assert.ok(typeof v === 'string' && v.length, `${l}: ${k}`); assert.equal((k.match(/\{\d\}/g) || []).length, (v.match(/\{\d\}/g) || []).length, `${l}: placeholders differ for "${k}"`); }
});
test('proper Belgian French terminology', () => {
  const fr = loadLang().fr.messages;
  const expect = { Invoices: 'Factures', Quotes: 'Devis', Companies: 'Sociétés', Payments: 'Paiements', 'Accountant pack': 'Pack comptable', Draft: 'Brouillon', 'Ready for approval': 'À approuver', Issued: 'Émise', Sent: 'Envoyée', Paid: 'Payée', Overdue: 'En retard', 'Credit note': 'Avoir', 'excl. VAT': 'HTVA', 'incl. VAT': 'TVAC', 'Enterprise number': 'Numéro d\'entreprise', 'VAT number': 'Numéro de TVA' };
  for (const [k, v] of Object.entries(expect)) assert.equal(fr[k], v);
});
test('runtime: French is the default, NL/EN can be chosen and the choice persists; parameters, whitespace, patterns and sentences translate', () => {
  const a = loadI18n();
  assert.equal(a.I18N.getLang(), 'fr'); assert.equal(a.attrs.lang, 'fr');
  assert.equal(a.I18N.tt('Due in {0} days', 5), 'Échéance dans 5 jours');
  assert.equal(a.I18N.tr('  Invoices  '), '  Factures  ');
  assert.equal(a.I18N.tr('3 companies found. Choose the right one.'), '3 sociétés trouvées. Choisissez la bonne.');
  assert.match(a.I18N.tr('Filled in from the Belgian company register. No active VAT registration was found in VIES, so the VAT number was left empty.'), /^Renseigné depuis le registre belge des sociétés\. Aucun assujettissement actif/);
  assert.equal(a.I18N.tr('A customer called Something Unknown'), 'A customer called Something Unknown');
  assert.equal(a.I18N.tr(42), 42);
  a.I18N.setLang('nl'); assert.equal(a.I18N.tr('Invoices'), 'Facturen'); assert.equal(a.store.get('finance.lang'), 'nl'); assert.equal(a.attrs.lang, 'nl');
  a.I18N.setLang('en'); assert.equal(a.I18N.tr('Invoices'), 'Invoices'); assert.equal(a.I18N.tt('Due in {0} days', 5), 'Due in 5 days');
  a.I18N.setLang('xx'); assert.equal(a.I18N.getLang(), 'en', 'an unknown language is ignored');
  assert.equal(loadI18n('nl').I18N.getLang(), 'nl', 'the stored choice is used on the next load');
  assert.equal(loadI18n('zz').I18N.getLang(), 'fr', 'a corrupted stored value falls back to French');
});
test('runtime: a missing translation falls back to English and is recorded for review', () => {
  const a = loadI18n();
  assert.equal(a.I18N.tt('Brand new message {0}', 1), 'Brand new message 1');
  assert.ok(a.I18N.missing.has('Brand new message {0}'));
});
test('UI language is separate from the document language: the language switch never touches document settings, and documents keep their own language', () => {
  const app = read('app.js');
  assert.match(app, /Document language/); assert.match(app, /model\.language/);
  assert.ok(!/setLang\([^)]*\)[^;]*language:/.test(app));
  const i18n = read('i18n.js');
  assert.ok(!/fetch|XMLHttpRequest/.test(i18n), 'the language choice is a browser preference, not sent anywhere');
});
test('scripts are served and loaded in the right order', () => {
  const html = read('index.html');
  const order = ['/lang-fr.js', '/lang-nl.js', '/i18n.js', '/app.js', '/views-workspace.js'].map((s) => html.indexOf(s));
  assert.ok(order.every((n) => n > 0) && [...order].sort((x, y) => x - y).join() === order.join());
  const server = readFileSync(new URL('../src/finance/server/app.js', import.meta.url), 'utf8');
  for (const f of ['/i18n.js', '/lang-fr.js', '/lang-nl.js', '/views-workspace.js']) assert.ok(server.includes(`'${f}'`), f);
});
// Regression: a message string returned by the SERVER (e.g. analytics.js's own English "note" field) is
// rendered via tt()/tr() at runtime just like any UI literal, but the static COVERAGE test above only scans
// the client .js files - it can never see a string that only exists in a backend module. Found missing in
// practice (the Achats analytics limitation note stayed in English under the French UI) - this closes that
// specific gap by checking backend "note"-style message literals against both dictionaries directly.
test('server-provided message strings (e.g. analytics.js "note" fields) are also translated in both languages', () => {
  const lang = loadLang();
  const src = readFileSync(new URL('../src/finance/analytics.js', import.meta.url), 'utf8');
  const notes = [...src.matchAll(/\bnote:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
  assert.ok(notes.length > 0, 'at least one server-provided note string is checked');
  for (const n of notes) for (const l of ['fr', 'nl']) assert.ok(n in lang[l].messages, `${l} translation missing for server note: ${n}`);
});
