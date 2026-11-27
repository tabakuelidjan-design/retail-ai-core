// Nordla Growth - REMAX evaluation groups: the count confirmed against Shopify, the real-facts cases (public fields only), the fictional cases
// (labelled FICTIF, graded on separation of facts / fiction / missing data), and offline runs with no network. Simulated answers here test the
// grader only; they are NOT a measure of a real model's quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REMAX_PRODUCTS, REMAX_TECH, REMAX_SNAPSHOT_DATE } from '../src/growth/eval/remax-catalogue.js';
import { REMAX_CASES, FORBIDDEN_KEYS } from '../src/growth/eval/remax-cases.js';
import { CASES } from '../src/growth/eval/cases.js';
import { gradeAnswer } from '../src/growth/eval/grade.js';
import { runEvaluation, validateCases } from '../src/growth/eval/run.js';
import { createAgentGateway } from '../src/growth/agents/gateway.js';
import { AGENTS } from '../src/growth/agents/registry.js';

// The count confirmed against Shopify on 2026-11-27: 17 active products by unique id, 16 Tech, 1 household appliance (hair dryer).
const CONFIRMED_TOTAL = 17; const CONFIRMED_TECH = 16; const CONFIRMED_BEAUTY = 1;
const byId = (id) => REMAX_CASES.find((c) => c.id === id);
const keysOf = (v, out = []) => { if (Array.isArray(v)) v.forEach((x) => keysOf(x, out)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); } return out; };

test('count: the snapshot holds the 17 products confirmed by Shopify (unique ids, all active), 16 Tech and 1 appliance', () => {
  assert.equal(REMAX_PRODUCTS.length, CONFIRMED_TOTAL);
  assert.equal(new Set(REMAX_PRODUCTS.map((p) => p.handle)).size, CONFIRMED_TOTAL, 'no duplicate product');
  assert.ok(REMAX_PRODUCTS.every((p) => p.status === 'ACTIVE'));
  assert.equal(REMAX_TECH.length, CONFIRMED_TECH);
  assert.equal(REMAX_PRODUCTS.filter((p) => p.excludedFromTech).length, CONFIRMED_BEAUTY);
  assert.equal(REMAX_PRODUCTS.find((p) => p.excludedFromTech).productType, 'Packaging'); // the hair dryer, kept apart
  assert.equal(REMAX_SNAPSHOT_DATE, '2026-11-27');
});

test('snapshot: only public storefront fields, two-decimal EUR prices, and no cost, margin, supplier, stock, sales or customer key', () => {
  const allowed = new Set(['handle', 'title', 'vendor', 'productType', 'tags', 'status', 'price', 'excludedFromTech']);
  for (const p of REMAX_PRODUCTS) {
    assert.deepEqual(Object.keys(p).filter((k) => !allowed.has(k)), [], p.handle);
    assert.match(p.price, /^\d+\.\d{2}$/, p.handle);
    for (const k of Object.keys(p)) assert.ok(!FORBIDDEN_KEYS.includes(k), `${p.handle}: ${k}`);
  }
});

test('cases: real-facts group has five cases for Produits and Stratège; the fictional group has three, each labelled FICTIF; no sources outside the registry', () => {
  assert.equal(REMAX_CASES.filter((c) => c.group === 'remax').length, 5);
  assert.equal(REMAX_CASES.filter((c) => c.group === 'remax-synthetic').length, 3);
  assert.deepEqual(validateCases([...CASES, ...REMAX_CASES]), []);
  for (const c of REMAX_CASES) assert.ok(['products', 'strategist'].includes(c.agent), c.id);
  // the 24 reference cases are untouched
  assert.equal(CASES.length, 24);
});

test('real-facts prompts: what the provider receives carries no cost, margin, supplier, stock, sales or customer key, and no synthetic block', async () => {
  for (const c of REMAX_CASES.filter((x) => x.group === 'remax')) {
    let user = null;
    const gw = createAgentGateway({ provider: { name: 'capture', model: 'offline', complete: async (a) => { user = a.user; return JSON.stringify({ draft: 'Brouillon.', reason: 'r', limits: [] }); } }, getters: Object.fromEntries(Object.entries(c.sources).map(([k, v]) => [k, async () => (v.status === 'available' ? v.data : v.status === 'not_connected' ? { status: 'NOT_CONNECTED' } : null)])) });
    await gw.run({ agentId: c.agent, question: c.question, scope: `remax-${c.id}` });
    const keys = keysOf(JSON.parse(user));
    for (const k of keys) assert.ok(!FORBIDDEN_KEYS.includes(k), `${c.id}: ${k} reached the provider`);
    assert.ok(!keys.includes('synthetic'), `${c.id}: no fictional block in a real-facts prompt`);
    assert.doesNotMatch(user, /FICTIF/, c.id);
  }
});

test('fictional prompts: the figures arrive under the FICTIF label, so the provider can separate them from the catalogue', async () => {
  for (const c of REMAX_CASES.filter((x) => x.group === 'remax-synthetic')) {
    let user = null;
    const gw = createAgentGateway({ provider: { name: 'capture', model: 'offline', complete: async (a) => { user = a.user; return JSON.stringify({ draft: 'Brouillon.', reason: 'r', limits: [] }); } }, getters: Object.fromEntries(Object.entries(c.sources).map(([k, v]) => [k, async () => (v.status === 'available' ? v.data : null)])) });
    await gw.run({ agentId: c.agent, question: c.question, scope: `syn-${c.id}` });
    assert.match(user, /FICTIF/, c.id);
    assert.ok(keysOf(JSON.parse(user)).includes('synthetic'), c.id);
  }
});

test('grader contract on the REMAX groups (SIMULATED answers, not a quality measure): separation of facts, fiction and missing data is checked', () => {
  // real-facts: an answer that invents sales and margins fails; an answer that says they are missing passes
  const honest = gradeAnswer(byId('remax-prod-1'), JSON.stringify({ draft: 'Batterie externe Mini : prix public 29,00 €. Ventes et marge non disponibles dans cette source.', reason: 'Champs publics seulement.', limits: ['ventes et marges indisponibles'] }));
  assert.ok(!honest.failed.includes('statesMissing'), JSON.stringify(honest.failed));
  const invented = gradeAnswer(byId('remax-prod-1'), JSON.stringify({ draft: 'La batterie se vend bien, marge élevée.', reason: 'r', limits: [] }));
  assert.ok(invented.failed.includes('statesMissing'), 'invented sales and margin are not stated as missing');
  // fictional: an answer presenting the fictional figures as real fails the label check; a labelled one passes it
  const labelled = gradeAnswer(byId('remax-syn-prod-1'), JSON.stringify({ draft: 'Batterie externe Mini 29,00 € (prix public). Données fictives de test : 12 unités sur 8 semaines, marge 31 %. Stock indisponible.', reason: 'Prix du catalogue ; chiffres fictifs.', limits: ['stock indisponible'] }));
  assert.ok(!labelled.failed.includes('labelsSynthetic'), JSON.stringify(labelled.failed));
  const unlabelled = gradeAnswer(byId('remax-syn-prod-1'), JSON.stringify({ draft: 'Batterie externe Mini 29,00 €, 12 unités, marge 31 %. Stock indisponible.', reason: 'r', limits: ['stock indisponible'] }));
  assert.ok(unlabelled.failed.includes('labelsSynthetic'), 'fictional figures presented without a label are refused');
});

test('runner, offline, on the REMAX groups: graded through the real gateway prompt, with no network call', async () => {
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('network must not be used'); };
  try {
    const answers = Object.fromEntries(REMAX_CASES.map((c) => [c.id, { draft: 'Brouillon de test.', reason: 'Raison de test.', limits: ['limite de test'] }]));
    const r = await runEvaluation({ answers, env: {}, cases: REMAX_CASES });
    assert.equal(r.graded.length, REMAX_CASES.length); assert.equal(calls, 0);
    assert.ok(r.graded.every((g) => g.promptHasPersonalData === false));
  } finally { globalThis.fetch = realFetch; }
});

test('agents: the REMAX cases use only the sources the registry gives the agent (Produits: products; Stratège: its four sources)', () => {
  for (const c of REMAX_CASES) {
    const agent = AGENTS.find((a) => a.id === c.agent);
    for (const k of Object.keys(c.sources)) assert.ok(agent.sources.includes(k), `${c.id}: ${k}`);
  }
  assert.deepEqual(AGENTS.find((a) => a.id === 'products').sources, ['products']);
});
