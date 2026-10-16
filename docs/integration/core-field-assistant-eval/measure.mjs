// Measures Parle à Nordla on a fixed question set against ANY checkout of the repository (so the same questions can be run before and after the change).
//   node docs/integration/core-field-assistant-eval/measure.mjs <repo-root> [--json out.json]
// Synthetic data only. "pass" = the status is one of the expected ones and, when the checkout reports an intent, it is the expected intent.
// The old code reports no intent, so it is judged on status alone (generous to it). "figureLeak" = a monetary figure appears where the case has no data.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const root = resolve(process.argv[2] ?? '.');
const outIdx = process.argv.indexOf('--json'); const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
const imp = (rel) => import(pathToFileURL(join(root, rel)).href);
const [{ newCase, dispatch }, { askNordla }, { createCoreRuntime }, { createMemoryJournal }, { validateCoreConfig }, fx] = await Promise.all([
  imp('src/sourcing/core/case.js'), imp('src/core-pilot/ask.js'), imp('src/core-pilot/runtime.js'), imp('src/core-pilot/journal.js'), imp('src/core-pilot/config.js'), imp('test/sourcing-fixtures.js'),
]);
const { NOW, LIVE_CLEAN, ident, traits, importer, commercial, extraTraits } = fx;
const mk = (events, id) => { let c = newCase({ id, name: 'x', now: NOW }); for (const e of events) c = dispatch(c, e, NOW); return c; };
const cases = {
  blocked: mk([...ident({ name: 'USB charger', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ unitPrice: 4.2, qty: 1000, moq: 500, price: 24.99, target: 30, duty: 2.7 })], 'blocked'),
  bare: mk([...ident({ name: 'Mug', category: 'household_general' })], 'bare'),
};
const config = validateCoreConfig({ schema: 1, merchantId: 'test', currency: 'EUR', gates: { materialityThreshold: 0, maxPrioritySubjects: 10, cooldownDays: 14, aggravationFactor: 1.5 }, testSmall: { budget: null }, ownerRules: [] });
const questions = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'questions.json'), 'utf8'));
const FIGURE = /[0-9]+[.,][0-9]{2}\s?(€|EUR|USD)/;
const rows = [];
for (const item of questions) {
  const rt = createCoreRuntime({ merchantId: 'm', config, journal: createMemoryJournal({ merchantId: 'm' }), now: () => NOW });
  const caseId = item.noCase ? null : (item.case ?? 'blocked');
  if (item.analysed) await rt.analyseCase(cases.blocked, { externals: { safety: LIVE_CLEAN }, actor: { userId: 'u', role: 'OWNER' } });
  const before = (await rt.overview()).decisions.length;
  const r = await askNordla({ text: item.q, caseId }, { runtime: rt, getCase: async (id) => cases[id] ?? null, externals: { safety: LIVE_CLEAN }, actor: { userId: 'u', role: 'OWNER' }, now: NOW });
  const after = (await rt.overview()).decisions.length;
  const statusOk = item.expect.includes(r.status);
  const pass = statusOk && (!item.intent || r.intent === undefined || r.intent === item.intent);
  const existingBuy = /acheter ce produit/i.test(item.q) && !/peux/i.test(item.q); // the existing "dois-je acheter" flow journals its analysis by design
  rows.push({ cat: item.cat, q: item.q, expected: item.expect.join('|'), got: `${r.status}${r.intent ? `/${r.intent}` : ''}`, pass, statusOk, figureLeak: item.noFigure ? FIGURE.test(r.answer) : false, wrote: after !== before && !existingBuy, sources: r.sources?.length ?? 0 });
}
const byCat = {};
for (const r of rows) { const c = (byCat[r.cat] ??= { total: 0, pass: 0 }); c.total += 1; c.pass += r.pass ? 1 : 0; }
const summary = { root, total: rows.length, pass: rows.filter((r) => r.pass).length, figureLeaks: rows.filter((r) => r.figureLeak).length, unexpectedWrites: rows.filter((r) => r.wrote).length, byCat };
if (outFile) writeFileSync(outFile, JSON.stringify({ summary, rows }, null, 2));
for (const r of rows) console.log(`${r.pass ? 'OK ' : 'KO '} [${r.cat}] ${r.q}  =>  ${r.got}  (attendu ${r.expected})${r.figureLeak ? '  CHIFFRE INVENTE' : ''}${r.wrote ? '  ECRITURE' : ''}`);
console.log(JSON.stringify(summary, null, 1));
