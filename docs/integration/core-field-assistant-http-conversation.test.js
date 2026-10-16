// PROPOSED test for the owner of src/core-pilot/http.js (kept under docs/ so it does not run until adopted: copy it to test/core-http-conversation.test.js
// together with docs/integration/core-field-assistant-http-conversation.patch). Verified against feature/core-field-assistant by applying both temporarily.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { createCoreRuntime } from '../src/core-pilot/runtime.js';
import { createMemoryJournal } from '../src/core-pilot/journal.js';
import { validateCoreConfig } from '../src/core-pilot/config.js';
import { createCoreHttp } from '../src/core-pilot/http.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { NOW, LIVE_CLEAN, ident, traits, importer, commercial, extraTraits } from './sourcing-fixtures.js';

const TOKEN = 't'.repeat(32); const H = { 'x-sourcing-token': TOKEN };
const CONFIG = validateCoreConfig({ schema: 1, merchantId: 'test', currency: 'EUR', gates: { materialityThreshold: 0, maxPrioritySubjects: 10, cooldownDays: 14, aggravationFactor: 1.5 }, testSmall: { budget: null }, ownerRules: [] });
const mk = (events, id) => { let c = newCase({ id, name: 'x', now: NOW }); for (const e of events) c = dispatch(c, e, NOW); return c; };
const blocked = (id) => mk([...ident({ name: 'USB charger', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({})], id);
const req = (port, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port, path: '/api/core/ask', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, ...H } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t) })); });
  r.on('error', reject); r.write(data); r.end();
});

test('HTTP /api/core/ask: stateless by default; multi-turn only when the client sends its state; a forged, foreign or oversized state starts afresh', async () => {
  const store = createMemoryStore(); await store.save(blocked('case-a')); await store.save(blocked('case-b'));
  const rt = createCoreRuntime({ merchantId: 'm-test', config: CONFIG, journal: createMemoryJournal({ merchantId: 'm-test' }), now: () => NOW });
  const core = createCoreHttp({ runtime: rt, store, externals: async () => ({ safety: LIVE_CLEAN }) });
  const s = http.createServer(createSourcingApp({ token: TOKEN, core, store, uiDir: '.', coreDir: '.' }).handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r)); const port = s.address().port;
  try {
    const plain = await req(port, { text: 'quelle est la marge ?', caseId: 'case-a' });
    assert.equal(plain.body.status, 'ANSWERED'); assert.equal('conversation' in plain.body, false, 'no state key without opt-in');
    const t1 = await req(port, { text: 'quelle est la marge ?', caseId: 'case-a', conversation: null }); assert.equal(t1.body.conversation.caseId, 'case-a');
    const t2 = await req(port, { text: 'et ensuite ?', caseId: 'case-a', conversation: t1.body.conversation }); assert.equal(t2.body.intent, 'NEXT_STEP'); assert.equal(t2.body.conversation.turns.length, 2);
    const switched = await req(port, { text: 'quelle est la marge ?', caseId: 'case-b', conversation: t2.body.conversation }); assert.match(switched.body.notice, /n’est pas réutilisé/);
    const foreign = await req(port, { text: 'et ensuite ?', caseId: 'case-a', conversation: { ...t2.body.conversation, merchantId: 'other' } }); assert.equal(foreign.body.status, 'NOT_UNDERSTOOD', 'another merchant\'s state gives no reading');
    const forged = await req(port, { text: 'et ensuite ?', caseId: 'case-a', conversation: { v: 1, merchantId: 'm-test', caseId: 'case-a', caseVersion: null, turns: [{ intent: 'DROP', at: 'x', sources: [] }] } }); assert.equal(forged.body.status, 'NOT_UNDERSTOOD');
    const huge = await req(port, { text: 'et ensuite ?', caseId: 'case-a', conversation: { ...t2.body.conversation, pad: 'z'.repeat(6000) } }); assert.equal(huge.body.status, 'NOT_UNDERSTOOD');
    assert.equal((await rt.overview()).decisions.length, 0, 'no question wrote to the journal');
  } finally { s.close(); }
});
