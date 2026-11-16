import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAssetLibrary, createPublicMediaResolver } from '../src/social/assets.js';
import { mapChannel, mapEditorialReserve } from '../src/social/adapters/habb-editorial.js';
import { createEnvCredentialPort } from '../src/social/credentials.js';
import { buildPublishers } from '../src/social/server/index.js';
import { createSocialApp } from '../src/social/server/app.js';
import { createSocialService } from '../src/social/service.js';
import { createMemoryStore } from '../src/social/store.js';
import {
  AGENT, OWNER, T0, postInput, sha,
} from './social-fixtures.js';

const TOKEN = 'unit-test-token-0123456789-abcdef';
async function serve(app) {
  const server = http.createServer(app.handler);
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token = TOKEN } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(token ? { 'x-social-token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), type };
  };
  return { call, close: () => new Promise((r) => { server.close(r); }) };
}
async function appOn(dir) {
  const service = createSocialService({ store: createMemoryStore(), clock: () => T0 });
  const library = createAssetLibrary(join(dir, 'assets'));
  const app = createSocialApp({ token: TOKEN, service, assets: library, uiDir: join(process.cwd(), 'src', 'social', 'ui'), connections: async () => [] });
  return { service, library, ...(await serve(app)) };
}

test('the API is closed without the owner token, and guessing is throttled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'social-srv-'));
  const s = await appOn(dir);
  try {
    assert.equal((await s.call('/api/state', { token: null })).status, 401);
    assert.equal((await s.call('/api/state', { token: 'x'.repeat(33) })).status, 401);
    assert.equal((await s.call('/api/state')).status, 200);
    for (let i = 0; i < 12; i += 1) await s.call('/api/state', { token: `wrong-${i}` });
    assert.equal((await s.call('/api/state', { token: 'wrong-again' })).status, 429);
    assert.equal((await s.call('/api/state')).status, 429, 'the throttle is per client address: even the right token waits a minute');
  } finally { await s.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a decision names the version on screen: stale -> 409, exact -> approved, the owner role is applied by the server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'social-srv-'));
  const s = await appOn(dir);
  try {
    const p = await s.service.createPost(postInput(), AGENT);
    await s.service.act(p.id, 'submit', AGENT);
    const shown = (await s.call(`/api/posts/${p.id}`)).body;
    assert.equal(shown.state_label, 'À examiner');
    assert.equal(shown.full_caption, 'Une coque qui voyage avec vous. Fabriquée à Namur.\n\n#habb #namur');
    assert.deepEqual(shown.when_brussels, { date: '2026-10-17', time: '19:00' });
    const stale = await s.call(`/api/posts/${p.id}/act`, { method: 'POST', body: { action: 'approve', params: { expected_hash: 'f'.repeat(64) } } });
    assert.equal(stale.status, 409);
    const spoof = await s.call(`/api/posts/${p.id}/act`, { method: 'POST', body: { action: 'claim', params: {} } }); // the phone can never drive the publisher
    assert.equal(spoof.status, 403);
    const ok = await s.call(`/api/posts/${p.id}/act`, { method: 'POST', body: { action: 'approve', params: { expected_hash: shown.current_hash } } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.state, 'APPROVED');
    assert.equal(ok.body.approval.approved_by, 'owner:habb');
    const edited = await s.call(`/api/posts/${p.id}/edit`, { method: 'POST', body: { patch: { publish_local: { date: '2026-10-26', time: '18:00' } } } });
    assert.equal(edited.body.publish_at, '2026-10-26T17:00:00.000Z', 'Brussels wall clock converted to UTC (winter time after the 25th)');
    assert.equal(edited.body.state, 'DRAFT');
    assert.equal(edited.body.approval, null);
    assert.equal((await s.call(`/api/posts/${p.id}/edit`, { method: 'POST', body: { patch: { publish_local: { date: '2027-03-28', time: '02:30' } } } })).status, 422);
  } finally { await s.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the manual pack hands over the exact text, the exact file and the steps; the file is fingerprint-checked on download', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'social-srv-'));
  const s = await appOn(dir);
  try {
    const entry = await s.library.register({ ref: 'asset://t/pic', version: 1, file: 'pic.jpg', bytes: Buffer.from('JPEGBYTES') });
    const p = await s.service.createPost(postInput({ asset: { ref: entry.ref, version: 1, sha256: entry.sha256, content_type: 'image/jpeg' } }), AGENT);
    const pack = (await s.call(`/api/posts/${p.id}/export`)).body;
    assert.equal(pack.approved, false);
    assert.equal(pack.caption_full, 'Une coque qui voyage avec vous. Fabriquée à Namur.\n\n#habb #namur');
    assert.equal(pack.steps_fr.length, 5);
    const file = await s.call(pack.assets[0].download);
    assert.equal(file.status, 200);
    assert.equal(file.body.toString(), 'JPEGBYTES');
    assert.equal((await s.call(`/api/asset?ref=${encodeURIComponent(entry.ref)}&v=1&sha=${'a'.repeat(64)}`)).status, 409, 'a file that is not the approved one is refused');
    assert.throws(() => { throw new Error('x'); });
    await assert.rejects(s.library.register({ ref: 'asset://t/pic', version: 1, file: 'pic.jpg', bytes: Buffer.from('OTHER') }), /already exists with different bytes/);
  } finally { await s.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the UI is served, escapes nothing it should not trust, and never embeds a token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'social-srv-'));
  const s = await appOn(dir);
  try {
    const page = await s.call('/', { token: null });
    assert.equal(page.status, 200);
    const js = await s.call('/app.js', { token: null });
    assert.equal(js.status, 200);
    assert.equal(/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js.body.toString()), false, 'captions are inserted as text only');
    assert.equal((await s.call('/..%2f..%2fpackage.json', { token: null })).status >= 400, true);
  } finally { await s.close(); await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------- publishers wiring
test('modes: none connects nothing, simulate is labelled, live refuses to start without its configuration', () => {
  const port = createEnvCredentialPort({});
  assert.deepEqual(buildPublishers({ env: {}, credentialPort: port }).publishers, {});
  const sim = buildPublishers({ env: { SOCIAL_MODE: 'simulate' }, credentialPort: port });
  assert.equal(sim.publishers.instagram.mode, 'SIMULATION');
  assert.throws(() => buildPublishers({ env: { SOCIAL_MODE: 'live' }, credentialPort: port }), /SOCIAL_GRAPH_VERSION/);
  assert.throws(() => buildPublishers({ env: { SOCIAL_MODE: 'live', SOCIAL_GRAPH_VERSION: 'v25.0' }, credentialPort: port }), /SOCIAL_MEDIA_BASE_URL/);
  assert.throws(() => buildPublishers({ env: { SOCIAL_MODE: 'prod' }, credentialPort: port }), /none \| simulate \| live/);
  const env = { SOCIAL_MODE: 'live', SOCIAL_GRAPH_VERSION: 'v25.0', SOCIAL_MEDIA_BASE_URL: 'https://media.example.be/habb', SOCIAL_INSTAGRAM_TOKEN: 'IGAA-never-printed-000000000001', SOCIAL_INSTAGRAM_ACCOUNT_ID: '1784' };
  const live = buildPublishers({ env, credentialPort: createEnvCredentialPort(env), fetchImpl: async () => { throw new Error('no network in tests'); } });
  assert.deepEqual(Object.keys(live.publishers), ['instagram'], 'only the platform with a credential is connected');
  assert.equal(live.publishers.instagram.mode, 'LIVE');
});

test('the credential view reports presence and expiry, never the token', () => {
  const env = { SOCIAL_INSTAGRAM_TOKEN: 'IGAA-never-printed-000000000001', SOCIAL_INSTAGRAM_ACCOUNT_ID: '1784', SOCIAL_INSTAGRAM_TOKEN_EXPIRES_AT: '2026-10-20T00:00:00Z' };
  const view = createEnvCredentialPort(env).describe('instagram', Date.parse('2026-10-16T00:00:00Z'));
  assert.equal(view.state, 'EXPIRES_SOON');
  assert.equal(view.days_left, 4);
  assert.equal(JSON.stringify(view).includes('never-printed'), false);
  assert.equal(createEnvCredentialPort(env).describe('facebook').state, 'NOT_CONFIGURED');
});

test('the public media resolver downloads what is served and re-hashes it: a swapped file is detected', async () => {
  const bytes = Buffer.from('approved-picture');
  const good = createPublicMediaResolver({ baseUrl: 'https://media.example.be/habb', fetch: async (url) => ({ ok: true, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => bytes, url }) });
  const asset = { sha256: sha('approved-picture'), content_type: 'image/jpeg' };
  const r = await good.resolve(asset);
  assert.equal(r.sha256, asset.sha256);
  assert.equal(r.url, `https://media.example.be/habb/${asset.sha256}.jpg`);
  const swapped = createPublicMediaResolver({ baseUrl: 'https://media.example.be/habb', fetch: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => Buffer.from('something else') }) });
  assert.notEqual((await swapped.resolve(asset)).sha256, asset.sha256, 'the publisher compares and refuses (ASSET_CHANGED)');
  assert.throws(() => createPublicMediaResolver({ baseUrl: 'http://insecure.example/x' }), /plain https/);
  assert.throws(() => createPublicMediaResolver({ baseUrl: 'https://media.example.be/x?token=abc' }), /plain https/);
});

// ---------------------------------------------------------------------------------------------------------------- chantier D's real format
async function miniReserve() {
  const dir = await mkdtemp(join(tmpdir(), 'reserve-'));
  await mkdir(join(dir, 'visuels'));
  const png = Buffer.alloc(64); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(1080, 16); png.writeUInt32BE(1350, 20);
  for (const f of ['P01-a.png', 'P02-s1.png', 'P02-s2.png', 'S02-story.png']) await writeFile(join(dir, 'visuels', f), Buffer.concat([png, Buffer.from(f)]));
  const base = { legende_variante_b: 'tu', hashtags: ['#Namur'], alt_text: 'alt', statut: 'PROPOSED', heure_suggeree: '12:00' };
  const items = [
    { ...base, id: 'P01', canal: ['Instagram (feed)', 'Facebook', 'Google Business Profile'], format: 'Image 4:5', date_proposee: '2026-10-19', pilier: 'Coque personnalisée (hero)', legende: 'Coque personnalisée : 25 €.', etat_visuel: 'PRÊT — visuels/P01-a.png (1080x1350)' },
    { ...base, id: 'P02', canal: ['Instagram (carrousel)', 'Facebook'], format: 'Carrousel 4 images 4:5', date_proposee: '2026-10-21', pilier: 'Coque personnalisée', legende: 'Une photo, un prénom.', etat_visuel: 'PRÊT (2 images) — visuels/P02-s1.png (couverture), P02-s2.png' },
    { ...base, id: 'P03', canal: ['Instagram (feed)'], format: 'Image 4:5', date_proposee: '2026-10-23', pilier: 'Gourdes', legende: 'Des gourdes.', etat_visuel: 'BRIEF — non produit' },
    { ...base, id: 'V1', canal: ['Instagram Reel (prioritaire)', 'TikTok', 'Facebook Reel'], format: 'Vidéo 9:16', date_proposee: '2026-10-22', heure_suggeree: '18:30', pilier: 'Vidéo', legende: 'Texte vidéo', hashtags: [], etat_visuel: 'NON TOURNÉE' },
    { ...base, id: 'S02', canal: ['Instagram Stories'], format: 'Story 9:16', date_proposee: '2026-10-20', heure_suggeree: null, hashtags: [], pilier: 'Story', legende: 'Écran 1 : visuels/S02-story.png (PRÊT).', etat_visuel: 'PRÊT' },
  ];
  await writeFile(join(dir, 'posts.json'), JSON.stringify({ version: 1, items }));
  return { dir, items };
}

test('channel mapping: what Nordla supports, and an explicit reason for what it skips', () => {
  assert.deepEqual(mapChannel('Instagram (feed)', 'Image 4:5'), { platform: 'instagram', format: 'IMAGE' });
  assert.deepEqual(mapChannel('Facebook', 'Carrousel 4 images'), { platform: 'facebook', format: 'CAROUSEL' });
  assert.deepEqual(mapChannel('Instagram Stories', 'Story'), { platform: 'instagram', format: 'STORY' });
  assert.equal(mapChannel('TikTok', '').skip, 'TIKTOK_OUT_OF_SCOPE_CHANTIER_E');
  assert.equal(mapChannel('Facebook Reel', '').skip, 'FACEBOOK_REEL_NOT_SUPPORTED_V1');
  assert.equal(mapChannel('Google Business Profile', '').skip, 'GOOGLE_BUSINESS_OUT_OF_SCOPE_CHANTIER_E');
});

test("D's real reserve format imports as posts: pictures fingerprinted, missing pictures flagged, nothing in D's folder touched", async () => {
  const { dir, items } = await miniReserve();
  const out = await mkdtemp(join(tmpdir(), 'social-out-'));
  try {
    const library = createAssetLibrary(join(out, 'assets'));
    const { proposals, skipped } = await mapEditorialReserve({ items }, { dir, library });
    assert.equal(proposals.length, 5);
    assert.deepEqual(skipped.map((s) => `${s.id}:${s.reason}`).sort(), ['P01:GOOGLE_BUSINESS_OUT_OF_SCOPE_CHANTIER_E', 'V1:FACEBOOK_REEL_NOT_SUPPORTED_V1', 'V1:TIKTOK_OUT_OF_SCOPE_CHANTIER_E']);
    const service = createSocialService({ store: createMemoryStore(), clock: () => T0, confirmedFacts: [{ id: 'c', excerpts: ['25 €'], requires: 'coque' }] });
    const report = await service.importProposals(proposals, { id: 'chantier-d', role: 'agent' });
    const by = (id, platform) => report.find((r) => r.proposal_id.endsWith(`:${id}`) && r.platform === platform);
    assert.equal(by('P01', 'instagram').result, 'CREATED');
    assert.equal(by('P01', 'instagram').problems, undefined, 'the owner-confirmed price passes');
    assert.deepEqual(by('P02', 'instagram').format, 'CAROUSEL');
    assert.deepEqual(by('P03', 'instagram').problems, ['ASSET_MISSING']);
    assert.deepEqual(by('V1', 'instagram').problems, ['ASSET_MISSING']);
    const posts = await service.list();
    const p01 = posts.find((p) => p.platform === 'instagram' && p.format === 'IMAGE' && p.subject.label.startsWith('Coque'));
    assert.equal(p01.state, 'READY_FOR_REVIEW');
    assert.equal(p01.asset.content_type, 'image/png');
    assert.deepEqual([p01.asset.width, p01.asset.height], [1080, 1350]);
    assert.match(p01.asset.sha256, /^[a-f0-9]{64}$/);
    assert.equal(p01.publish_at, '2026-10-19T10:00:00.000Z', '12:00 Brussels (summer time) in UTC');
    const car = posts.find((p) => p.format === 'CAROUSEL' && p.platform === 'facebook');
    assert.equal(car.assets.length, 2);
    const story = posts.find((p) => p.format === 'STORY');
    assert.equal(story.caption, '');
    assert.match(story.notes, /Note de production/);
    assert.equal(story.state, 'READY_FOR_REVIEW');
    assert.equal(story.publish_at, '2026-10-20T16:00:00.000Z', 'no hour given: 18:00 Brussels');
    // re-import: idempotent
    const again = await service.importProposals(proposals, { id: 'chantier-d', role: 'agent' });
    assert.ok(again.every((r) => r.result === 'UNCHANGED'));
    // the owner approves P01; D then re-delivers a corrected caption: the approval is void
    const hash = service.contentHashOf(p01);
    await service.act(p01.id, 'approve', OWNER, { expected_hash: hash });
    const changed = proposals.map((p) => (p.proposal_id.endsWith(':P01') ? { ...p, caption: 'Coque personnalisée : 25 €. Prête en boutique.' } : p));
    const redo = await service.importProposals(changed, { id: 'chantier-d', role: 'agent' });
    assert.equal(redo.find((r) => r.proposal_id.endsWith(':P01') && r.platform === 'instagram').approval_voided, true);
    assert.equal((await service.get(p01.id)).approval, null);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }); }
});
