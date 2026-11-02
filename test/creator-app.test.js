// Nordla Créateur: the screen's API over the integration hub. Fast tests use a hub double; the last test starts the REAL local
// demonstration (scripts/creator-demo.mjs: real hub, real photo selection, real ledger rules, real Python engines, SIMULATED
// providers) and walks the customer flow through HTTP. No network, no credential, no cost, nothing published.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCreatorApp } from '../src/creative-autonomy/creator/app.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PID = 'gid://shopify/Product/1'; const V1 = 'gid://shopify/ProductVariant/11'; const V2 = 'gid://shopify/ProductVariant/12';
const catalog = async () => [{ product_id: PID, title: 'TEST produit', variants: [{ variant_id: V1, title: 'Noir', price: '19,90 €' }, { variant_id: V2, title: 'Blanc', price: '19,90 €' }] }];
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function hubDouble() {
  const calls = [];
  return { calls, async call(module, command, args, ctx) {
    calls.push({ module, command, args, ctx });
    if (args.variant_id === V2) return { ok: false, code: 'HANDOFF_INVALID', reason: 'NO_VERIFIED_SOURCE_IMAGE: no unambiguous image' };
    return { ok: true, status: 'REVIEW_REQUIRED', result: { run_id: args.run_id, published: false, live_provider: false, media_id: 'gid://shopify/MediaImage/1', source_sha256: 'a'.repeat(64), policy_version: 1, withheld: 0,
      results: [{ image: `/private/${args.run_id}.png`, technical: 'PASS' }], reservation: { status: 'RESERVED', ceiling_eur: 0.5, closing: { status: 'SETTLED', settled_eur: 0.1282 } } } };
  } };
}
async function serve(handler) {
  const s = http.createServer(handler); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (path, body) => { const r = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: r.status, type: r.headers.get('content-type'), body: r.headers.get('content-type')?.startsWith('application/json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };
  return { req, close: () => new Promise((r) => s.close(r)) };
}
const actor = { id: 'user-owner-1', role: 'OWNER' };

test('Creator refuses to start in any mode but SIMULATED (NDR-D02)', () => {
  assert.throws(() => createCreatorApp({ integration: hubDouble(), catalog, mode: 'LIVE', actor }), /NDR-D02/);
});

test('Creator: product + variant + objective -> the hub route runs -> the result image is shown -> accept records it, never publishes', async () => {
  const hub = hubDouble(); const read = []; const app = createCreatorApp({ integration: hub, catalog, actor, readImage: async (p) => { read.push(p); return PNG; } });
  const s = await serve(app);
  try {
    assert.deepEqual((await s.req('/api/creator/status')).body, { mode: 'SIMULATED', live_provider: false, auto_publish: false, tenant: null });
    assert.equal((await s.req('/api/creator/products')).body.products[0].variants.length, 2);
    const c = (await s.req('/api/creator/creations', { product_id: PID, variant_id: V1, objective: 'Faire découvrir' })).body;
    assert.equal(c.status, 'RUNNING'); assert.equal(c.simulated, true); assert.equal(c.published, false);
    await app.idle();
    const r = (await s.req(`/api/creator/creations/${c.creation_id}`)).body;
    assert.equal(r.status, 'READY'); assert.deepEqual(r.result.images, [`/api/creator/creations/${c.creation_id}/images/0.png`]);
    assert.deepEqual(r.result.reservation, { status: 'SETTLED', ceiling_eur: 0.5, settled_eur: 0.1282 });
    // the hub was called with the exact product/variant, the run id and the human actor; no source-photo choice exists in the request
    assert.equal(hub.calls[0].module, 'CREATIVE'); assert.equal(hub.calls[0].command, 'produce_product_visual');
    assert.deepEqual(Object.keys(hub.calls[0].args).sort(), ['expected_variant_title', 'objective', 'product_id', 'run_id', 'variant_id']);
    assert.equal(hub.calls[0].args.run_id, c.creation_id); assert.equal(hub.calls[0].ctx.initiated_by.id, 'user-owner-1');
    const img = await s.req(r.result.images[0]); assert.equal(img.status, 200); assert.equal(img.type, 'image/png'); assert.deepEqual(read, [`/private/${c.creation_id}.png`]);
    assert.equal((await s.req(`/api/creator/creations/${c.creation_id}/images/1.png`)).status, 404, 'only the pipeline’s own results, by index');
    const d = (await s.req(`/api/creator/creations/${c.creation_id}/decision`, { decision: 'ACCEPT' })).body;
    assert.equal(d.creation.decision.decision, 'ACCEPTED'); assert.equal(d.creation.decision.published, false); assert.equal(d.creation.published, false); assert.equal(d.revision, null);
    assert.equal((await s.req(`/api/creator/creations/${c.creation_id}/decision`, { decision: 'REJECT' })).status, 409, 'one decision per result');
  } finally { await s.close(); }
});

test('Creator: a revision needs a note and starts a NEW creation linked to the first; reject is recorded; invalid input is refused', async () => {
  const hub = hubDouble(); const app = createCreatorApp({ integration: hub, catalog, actor, readImage: async () => PNG }); const s = await serve(app);
  try {
    const a = (await s.req('/api/creator/creations', { product_id: PID, variant_id: V1, objective: 'Objectif' })).body; await app.idle();
    assert.equal((await s.req(`/api/creator/creations/${a.creation_id}/decision`, { decision: 'REVISE' })).status, 400);
    assert.equal((await s.req(`/api/creator/creations/${a.creation_id}/decision`, { decision: 'PUBLISH' })).status, 400, 'there is no publish decision');
    const r = (await s.req(`/api/creator/creations/${a.creation_id}/decision`, { decision: 'REVISE', note: 'Fond plus clair' })).body;
    assert.equal(r.creation.decision.decision, 'REVISION_REQUESTED'); assert.equal(r.revision.revision_of, a.creation_id); assert.equal(r.revision.revision_note, 'Fond plus clair');
    await app.idle();
    assert.match(hub.calls[1].args.objective, /Objectif\nRévision demandée : Fond plus clair/);
    const b = (await s.req(`/api/creator/creations/${r.revision.creation_id}/decision`, { decision: 'REJECT' })).body;
    assert.equal(b.creation.decision.decision, 'REJECTED');
    assert.equal((await s.req('/api/creator/creations', { product_id: PID, variant_id: V1, objective: '  ' })).status, 400);
    assert.equal((await s.req('/api/creator/creations', { product_id: PID, variant_id: 'gid://shopify/ProductVariant/999', objective: 'x' })).status, 400);
  } finally { await s.close(); }
});

test('Creator: a variant without a verified photo is REFUSED with the reason; nothing is asked of the user and there is nothing to decide', async () => {
  const app = createCreatorApp({ integration: hubDouble(), catalog, actor }); const s = await serve(app);
  try {
    const c = (await s.req('/api/creator/creations', { product_id: PID, variant_id: V2, objective: 'x' })).body; await app.idle();
    const r = (await s.req(`/api/creator/creations/${c.creation_id}`)).body;
    assert.equal(r.status, 'REFUSED'); assert.match(r.error.reason, /NO_VERIFIED_SOURCE_IMAGE/); assert.equal(r.result, null);
    assert.equal((await s.req(`/api/creator/creations/${c.creation_id}/decision`, { decision: 'ACCEPT' })).status, 409);
  } finally { await s.close(); }
});

test('Creator screen: never asks to select, confirm or approve the source photo, never shows it, and labels every result as simulated', () => {
  const ui = readFileSync(new URL('../src/creative-autonomy/creator/ui/creator.js', import.meta.url), 'utf8');
  assert.ok(!/confirm(ez|er)? la photo|choisi(ssez|r) la photo|valide(z|r) la photo|approuve(z|r) la photo|sélectionne(z|r) la photo/i.test(ui));
  assert.ok(!/cdn\.shopify|source_url|photo_url/.test(ui), 'the source photo is never displayed for review');
  assert.match(ui, /Démonstration simulée/); assert.match(ui, /SIMULÉ/); assert.match(ui, /pas une image d’un fournisseur réel/);
  assert.ok(!/publier|Publish/.test(ui.replace(/n’est pas publié|non publié|Il n’est pas publié|publication automatique|rien n’est publié|pas publié/g, '')), 'no publish action exists');
});

const PY = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pythonReady = (() => { try { execFileSync(PY, ['-c', 'import numpy, PIL, scipy'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('Creator demo (REAL hub, photo selection, ledger rules and engines; SIMULATED providers): create -> result PNG -> revision -> accept; Blanc refused', { skip: !pythonReady && `needs Python with numpy, Pillow and scipy (NORDLA_PYTHON=${PY})`, timeout: 600_000 }, async () => {
  const port = 4600 + Math.floor(Math.random() * 300);
  const env = { ...process.env, CREATOR_PORT: String(port), NORDLA_PYTHON: PY }; delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, [`${ROOT}scripts/creator-demo.mjs`], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const B = `http://127.0.0.1:${port}`;
  const j = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  const until = async (id) => { for (let i = 0; i < 300; i += 1) { const c = await j(`/api/creator/creations/${id}`); if (c.status !== 'RUNNING') return c; await new Promise((r) => setTimeout(r, 1000)); } throw new Error('timeout'); };
  try {
    for (let i = 0; i < 60 && !log.includes(`127.0.0.1:${port}`); i += 1) await new Promise((r) => setTimeout(r, 500));
    assert.match(log, /DÉMONSTRATION SIMULÉE/);
    const [p] = (await j('/api/creator/products')).products; const noir = p.variants.find((v) => v.title === 'Noir'); const blanc = p.variants.find((v) => v.title === 'Blanc');
    const c = await until((await j('/api/creator/creations', { product_id: p.product_id, variant_id: noir.variant_id, objective: 'Faire découvrir la gourde' })).creation_id);
    assert.equal(c.status, 'READY', JSON.stringify(c.error)); assert.equal(c.published, false); assert.equal(c.result.reservation.status, 'SETTLED'); assert.ok(c.result.reservation.settled_eur <= 0.5);
    const png = Buffer.from(await (await fetch(B + c.result.images[0])).arrayBuffer()); assert.deepEqual(png.subarray(0, 8), PNG);
    // LOCAL revision (exact headline): same scene, no provider call, verified change located in the text area, product re-proven
    const lv = await j(`/api/creator/creations/${c.creation_id}/decision`, { decision: 'REVISE', note: 'Remplace le titre par « Noir de nuit, ligne nette »' });
    assert.equal(lv.plan.method, 'LOCAL_RECOMPOSE'); assert.equal(lv.plan.estimated_cost_eur, 0);
    const c2 = await until(lv.revision.creation_id); assert.equal(c2.status, 'READY');
    assert.equal(c2.verification.outcome, 'APPLIED'); assert.equal(c2.verification.scene_identical, true); assert.equal(c2.verification.product_pixels_proven_authentic, true);
    assert.ok(c2.verification.changed_share > 0 && c2.verification.changed_share < 0.1, 'only the text area changed');
    // SCENE revision: priced and CONFIRMED first; the simulated provider returns the same scene -> UNCHANGED, never claimed as applied
    const sv = await j(`/api/creator/creations/${c2.creation_id}/decision`, { decision: 'REVISE', note: 'Un fond plus clair' });
    assert.equal(sv.revision, null); assert.equal(sv.plan.method, 'NEW_SCENE_GENERATION'); assert.ok(sv.plan.estimated_cost_eur > 0); assert.equal(sv.plan.needs_confirmation, true);
    const cf = await j(`/api/creator/creations/${c2.creation_id}/revision/confirm`, {});
    const c3 = await until(cf.revision.creation_id); assert.equal(c3.status, 'READY', 'a second production in the same server works');
    assert.equal(c3.verification.scene_changed, false); assert.equal(c3.verification.outcome, 'UNCHANGED');
    assert.deepEqual(c3.verification.unrequested_changes.map((u) => u.field), ['headline'], 'the approved headline was not kept by a full re-run: reported');
    assert.equal((await j(`/api/creator/creations/${c3.creation_id}/decision`, { decision: 'ACCEPT' })).creation.decision.published, false);
    const w = await until((await j('/api/creator/creations', { product_id: p.product_id, variant_id: blanc.variant_id, objective: 'x' })).creation_id);
    assert.equal(w.status, 'REFUSED'); assert.match(w.error.reason, /NO_VERIFIED_SOURCE_IMAGE/);
  } finally { child.kill('SIGTERM'); }
});
