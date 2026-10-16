// The HTTP face of the Core reliability fixes: a decision that is not durable is answered with an ERROR, never with a success; simultaneous taps record one decision; a damaged
// campaign history answers 503 with the reason, never "no campaigns". Real HTTP servers over the real runtime and file journal; synthetic cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { createCoreRuntime } from '../src/core-pilot/runtime.js';
import { createCoreHttp } from '../src/core-pilot/http.js';
import { createFileJournal } from '../src/core-pilot/journal.js';
import { validateCoreConfig } from '../src/core-pilot/config.js';
import { createCampaignService } from '../src/core-pilot/campaign.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { NOW, LIVE_CLEAN, ident, traits, importer, commercial } from './sourcing-fixtures.js';

const MID = 'merchant-test'; const TOKEN = 't'.repeat(32); const H = { 'x-sourcing-token': TOKEN };
const CONFIG = validateCoreConfig({ schema: 1, merchantId: 'test', currency: 'EUR', gates: { materialityThreshold: 0, maxPrioritySubjects: 10, cooldownDays: 14, aggravationFactor: 1.5 }, testSmall: { budget: null }, ownerRules: [] });
const goCase = (id = 'case-go') => { let c = newCase({ id, name: 'x', now: NOW }); for (const e of [...ident({ name: 'Bamboo kitchen organiser', category: 'household_general' }), ...traits({}), ...importer, { type: 'SUPPLIER', supplier: { name: 'Yiwu Greenline' } }, ...commercial({ unitPrice: 4.2, qty: 1000 })]) c = dispatch(c, e, NOW); return c; };
const serve = (app) => { const s = http.createServer(app.handler); return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s))); };
const req = (port, method, path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers, ...(data ? { 'content-length': data.length } : {}) } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null })); });
  r.on('error', reject); if (data) r.write(data); r.end();
});
const withDir = async (fn) => { const dir = await mkdtemp(join(tmpdir(), 'core-rel-http-')); try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } };

test('HTTP: a decision whose write failed is answered 503 JOURNAL_WRITE_FAILED (never 200), later writes 503 JOURNAL_PROTECTED, and reads still answer', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'core', 'decision-journal.jsonl'); let fail = false;
    const rt = createCoreRuntime({ merchantId: MID, config: CONFIG, journal: createFileJournal({ merchantId: MID, file, hooks: { beforeWrite: async () => { if (fail) throw new Error('EIO'); } } }), now: () => NOW });
    const store = createMemoryStore(); await store.save(goCase());
    const s = await serve(createSourcingApp({ token: TOKEN, core: createCoreHttp({ runtime: rt, store, externals: async () => ({ safety: LIVE_CLEAN }) }), store, uiDir: '.', coreDir: '.' })); const port = s.address().port;
    try {
      const a = await req(port, 'POST', '/api/core/cases/case-go/analyse', { headers: H }); assert.equal(a.status, 200);
      const id = a.body.decision.id; fail = true;
      const h = await req(port, 'POST', `/api/core/decisions/${id}/human`, { headers: H, body: { decision: 'REJECTED', reason: 'x' } });
      assert.equal(h.status, 503); assert.equal(h.body.error, 'JOURNAL_WRITE_FAILED'); assert.equal(h.body.decision, undefined, 'no decision object is returned as if it were recorded');
      fail = false;
      const again = await req(port, 'POST', `/api/core/decisions/${id}/human`, { headers: H, body: { decision: 'REJECTED', reason: 'x' } });
      assert.equal(again.status, 503); assert.equal(again.body.error, 'JOURNAL_PROTECTED');
      const read = await req(port, 'GET', '/api/core/decisions?case=case-go', { headers: H }); assert.equal(read.status, 200); assert.equal(read.body.decisions[0].human_decision, null, 'the list does not show a decision that was not recorded');
      assert.equal((await readFile(file, 'utf8')).split('\n').filter(Boolean).length, 1);
    } finally { s.close(); }
  });
});

test('HTTP: three simultaneous taps on "Approve / Reject" return ONE success and the others 409; the journal holds one decision', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'core', 'decision-journal.jsonl');
    const rt = createCoreRuntime({ merchantId: MID, config: CONFIG, journal: createFileJournal({ merchantId: MID, file }), now: () => NOW });
    const store = createMemoryStore(); await store.save(goCase());
    const s = await serve(createSourcingApp({ token: TOKEN, core: createCoreHttp({ runtime: rt, store, externals: async () => ({ safety: LIVE_CLEAN }) }), store, uiDir: '.', coreDir: '.' })); const port = s.address().port;
    try {
      const id = (await req(port, 'POST', '/api/core/cases/case-go/analyse', { headers: H })).body.decision.id;
      const rs = await Promise.all([1, 2, 3].map((i) => req(port, 'POST', `/api/core/decisions/${id}/human`, { headers: H, body: { decision: 'REJECTED', reason: `tap ${i}` } })));
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
      assert.equal((await readFile(file, 'utf8')).split('\n').filter(Boolean).length, 2, 'ANALYSED + ONE human decision');
    } finally { s.close(); }
  });
});

test('HTTP: a damaged campaign history answers 503 with its code, never an empty list', async () => {
  await withDir(async (dir) => {
    const rt = createCoreRuntime({ merchantId: MID, config: CONFIG, journal: createFileJournal({ merchantId: MID, file: join(dir, 'd.jsonl') }), now: () => NOW });
    const campaigns = createCampaignService({ merchantId: MID, branding: null, file: join(dir, 'campaigns.jsonl'), env: {} });
    await campaigns.prepare({ product: 'Mug', objective: 'boutique', audience: 'parents', channel: 'Instagram', copy: 'Un cadeau.' }, { role: 'OWNER' });
    const { appendFile } = await import('node:fs/promises'); await appendFile(join(dir, 'campaigns.jsonl'), '{"kind":"DECISION","id":"x","dec');
    const store = createMemoryStore();
    const s = await serve(createSourcingApp({ token: TOKEN, core: createCoreHttp({ runtime: rt, store, campaigns, externals: async () => ({}) }), store, uiDir: '.', coreDir: '.' })); const port = s.address().port;
    try {
      const r = await req(port, 'GET', '/api/core/campaigns', { headers: H });
      assert.equal(r.status, 503); assert.equal(r.body.error, 'CAMPAIGN_JOURNAL_TORN_TAIL');
    } finally { s.close(); }
  });
});
