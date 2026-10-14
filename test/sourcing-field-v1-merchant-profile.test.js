// Field V1 - the merchant profile is chosen explicitly (environment), never defaulted in code; HABB is data under config/merchants/habb/, and the generic sourcing source names no merchant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMerchantProfilePath, loadMerchantProfile } from '../src/sourcing/server/merchant-profile.js';
import { startSourcingServer } from '../src/sourcing/server/index.js';

const ROOT = new URL('..', import.meta.url).pathname;
test('no environment, no profile: nothing is defaulted', async () => {
  assert.deepEqual(resolveMerchantProfilePath({}, ROOT), { path: null, source: 'NONE' }); const r = await loadMerchantProfile({}, ROOT); assert.equal(r.profile, null);
});
test('a merchant id maps to config/merchants/<id>/sourcing-fit.json; a file path wins; a bad id is refused', async () => {
  assert.equal(resolveMerchantProfilePath({ SOURCING_MERCHANT_ID: 'habb' }, '/r').path, '/r/config/merchants/habb/sourcing-fit.json');
  assert.equal(resolveMerchantProfilePath({ SOURCING_MERCHANT_ID: 'habb', SOURCING_MERCHANT_PROFILE: '/x/p.json' }, '/r').path, '/x/p.json');
  for (const bad of ['../etc', 'A B', 'x/y', '.hidden']) { const r = resolveMerchantProfilePath({ SOURCING_MERCHANT_ID: bad }, '/r'); assert.equal(r.path, null); assert.match(r.error, /lowercase/); }
  const habb = await loadMerchantProfile({ SOURCING_MERCHANT_ID: 'habb' }, ROOT); assert.equal(habb.profile.merchantId, 'habb'); assert.equal(habb.source, 'MERCHANT_ID');
});
test('a missing or invalid profile gives null and a reason, never a crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mp-')); try {
    assert.match((await loadMerchantProfile({ SOURCING_MERCHANT_ID: 'nobody' }, ROOT)).error, /not found/);
    const bad = join(dir, 'bad.json'); await writeFile(bad, '{ nope'); assert.match((await loadMerchantProfile({ SOURCING_MERCHANT_PROFILE: bad }, ROOT)).error, /unreadable/);
    const wrong = join(dir, 'wrong.json'); await writeFile(wrong, JSON.stringify({ schema: 2 })); assert.match((await loadMerchantProfile({ SOURCING_MERCHANT_PROFILE: wrong }, ROOT)).error, /schema 1/);
    const other = join(dir, 'other.json'); await writeFile(other, JSON.stringify({ schema: 1, merchantId: 'acme', displayName: 'Acme' })); assert.equal((await loadMerchantProfile({ SOURCING_MERCHANT_PROFILE: other }, ROOT)).profile.merchantId, 'acme');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('the running server serves the profile only when one was chosen (any merchant, not just the pilot)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mp-srv-')); const TOKEN = 'merchant-profile-token-0123456789-abc'; const run = async (env) => { const s = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN, ...env }, log: () => {}, port: 0, dir, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}) }); const r = await fetch(`http://127.0.0.1:${s.port}/api/field/merchant-profile`, { headers: { 'x-sourcing-token': TOKEN } }); const out = { status: r.status, body: await r.json() }; await new Promise((x) => s.server.close(x)); s.server.closeAllConnections?.(); return out; };
  try {
    assert.equal((await run({})).status, 404);
    const f = join(dir, 'acme.json'); await writeFile(f, JSON.stringify({ schema: 1, merchantId: 'acme' })); const a = await run({ SOURCING_MERCHANT_PROFILE: f }); assert.equal(a.status, 200); assert.equal(a.body.merchantId, 'acme');
    assert.equal((await run({ SOURCING_MERCHANT_ID: 'habb' })).body.merchantId, 'habb');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('the generic sourcing source names no merchant: HABB lives only under config/merchants/habb/', async () => {
  const walk = async (d) => { const out = []; for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) out.push(...await walk(p)); else if (/\.(js|css|html|json|webmanifest)$/.test(e.name)) out.push(p); } return out; };
  const hits = []; for (const f of await walk(join(ROOT, 'src', 'sourcing'))) if (/habb/i.test(await readFile(f, 'utf8'))) hits.push(f.replace(ROOT, ''));
  assert.deepEqual(hits, [], `merchant name found in generic code: ${hits.join(', ')}`);
});
