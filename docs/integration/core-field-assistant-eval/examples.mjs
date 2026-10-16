// Prints real answers (synthetic cases) as Markdown: the question -> intent -> answer matrix of the report is generated from this, never typed by hand.
//   node docs/integration/core-field-assistant-eval/examples.mjs <repo-root> > examples.md
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
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
const rt = createCoreRuntime({ merchantId: 'm', config, journal: createMemoryJournal({ merchantId: 'm' }), now: () => NOW });
const ctx = { runtime: rt, getCase: async (id) => cases[id] ?? null, externals: { safety: LIVE_CLEAN }, actor: { userId: 'u', role: 'OWNER' }, now: NOW };
const script = [
  ['blocked', 'Qu’est-ce qu’on sait sur ce fournisseur ?'], ['blocked', 'Qu’est-ce qui manque ?'], ['blocked', 'Quels sont les risques ?'], ['blocked', 'Quelle est la marge estimée ?'],
  ['blocked', 'Est-ce que je peux commander ce produit ?'], ['blocked', 'Et si j’achète seulement la quantité minimale ?'], ['blocked', 'Est-ce que ce prix est bon ?'], ['blocked', 'Quelles questions dois-je poser avant de signer ?'],
  ['blocked', 'Quelle est la prochaine étape ?'], ['blocked', 'Pourquoi cette recommandation ?'], ['blocked', 'Dois-je acheter ce produit ?'], ['blocked', 'Pourquoi cette recommandation ?'],
  ['bare', 'Quelle est la marge estimée ?'], ['bare', 'Quel prix manque pour calculer la rentabilité ?'],
  ['blocked', 'Quelle est la marge de ce fournisseur sur mes ventes ?'],
];
const out = ['# Exemples réels de réponses (données synthétiques)', '', 'Généré par `examples.mjs` : rien n’est tapé à la main. Dossier `blocked` = chargeur USB sans documents de conformité ; dossier `bare` = mug sans devis ni coûts.', ''];
for (const [caseId, q] of script) {
  const r = await askNordla({ text: q, caseId }, ctx);
  out.push(`## [${caseId}] « ${q} »`, '', `Statut : \`${r.status}\`${r.intent ? ` · intention : \`${r.intent}\`` : ''}`, '', '```text', r.answer, '```', '');
}
console.log(out.join(String.fromCharCode(10)));
