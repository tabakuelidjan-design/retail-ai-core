import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { brusselsParts, brusselsToUtc } from '../src/social/calendar.js';
import { createFileStore } from '../src/social/store.js';
import { createSocialService } from '../src/social/service.js';
import { createPublisher } from '../src/social/publisher.js';
import { createInstagramPublisher } from '../src/social/providers/meta.js';
import { main } from '../src/social/cli.js';
import {
  AGENT, OWNER, createFakeHttp, credentials, igRoutes, media, postInput,
} from './social-fixtures.js';

test('travel dates in Europe/Brussels, including the change of hour of 25 October', () => {
  const cases = [
    ['2026-10-19', '12:00', '2026-10-19T10:00:00.000Z'], // before the change: UTC+2
    ['2026-10-24', '18:00', '2026-10-24T16:00:00.000Z'], // the day before: UTC+2
    ['2026-10-25', '12:00', '2026-10-25T11:00:00.000Z'], // the day of the change: UTC+1
    ['2026-10-29', '12:00', '2026-10-29T11:00:00.000Z'],
    ['2026-11-01', '18:00', '2026-11-01T17:00:00.000Z'],
  ];
  for (const [date, time, utc] of cases) {
    assert.equal(brusselsToUtc(date, time), utc);
    assert.deepEqual(brusselsParts(utc), { date, time });
  }
});

test('a post scheduled by hand at Meta is never published by Nordla, even after a restart of the whole process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'social-restart-'));
  try {
    let now = Date.parse('2026-10-17T08:00:00Z');
    const mk = () => {
      const http = createFakeHttp(igRoutes());
      const publishers = { instagram: createInstagramPublisher({ http, graphVersion: 'v25.0', credentials: credentials(), timeoutMs: 1000, sleep: async () => {}, settleWaitMs: 0 }) };
      const service = createSocialService({ store: createFileStore(dir), publishers, clock: () => now });
      const publisher = createPublisher({ service, publishers, media: media(), clock: () => now });
      return { http, service, publisher };
    };
    const first = mk();
    const post = await first.service.createPost(postInput(), AGENT);
    await first.service.act(post.id, 'submit', AGENT);
    const hash = first.service.contentHashOf(await first.service.get(post.id));
    await first.service.act(post.id, 'approve', OWNER, { expected_hash: hash });
    await first.service.act(post.id, 'mark_manual_schedule', OWNER, { where: 'Meta Business Suite' });
    const second = mk(); // "restart": a brand new service, publisher and HTTP over the same files
    now = Date.parse('2026-10-17T17:30:00Z'); // 30 minutes after the due time
    for (let i = 0; i < 3; i += 1) { await second.publisher.runDue(); now += 3_600_000; }
    assert.equal(second.http.calls.length, 0, 'no call to Meta at all');
    const cur = await second.service.get(post.id);
    assert.equal(cur.state, 'SCHEDULED');
    assert.ok(cur.publication.manual_schedule, 'the hand-made schedule survived the restart');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const hasPillow = (() => { try { execFileSync('python', ['-c', 'import PIL'], { stdio: 'ignore', cwd: tmpdir() }); return true; } catch { return false; } })();

test('exporting JPEGs for Meta voids an existing approval (new asset = new decision) and keeps the PNG source', { skip: !hasPillow && 'Python + Pillow not installed' }, async () => {
  const reserve = await mkdtemp(join(tmpdir(), 'reserve-'));
  const data = await mkdtemp(join(tmpdir(), 'social-data-'));
  try {
    await mkdir(join(reserve, 'visuels'));
    const pngPath = join(reserve, 'visuels', 'P01-a.png');
    execFileSync('python', ['-c', `from PIL import Image; Image.new("RGB",(32,40),(251,248,243)).save(r"${pngPath}")`], { cwd: tmpdir() });
    await writeFile(join(reserve, 'posts.json'), JSON.stringify({
      version: 1,
      items: [{ id: 'P01', canal: ['Instagram (feed)'], format: 'Image 4:5', date_proposee: '2026-10-19', heure_suggeree: '12:00', pilier: 'Coque', legende: 'Une coque personnalisée, faite à Namur.', hashtags: ['#Namur'], etat_visuel: 'PRÊT — visuels/P01-a.png', statut: 'PROPOSED' }],
    }));
    const quiet = () => {};
    await main(['import-editorial', reserve], { dir: data, log: quiet });
    const service = createSocialService({ store: createFileStore(data) });
    const [before] = await service.list();
    assert.equal(before.asset.content_type, 'image/png');
    await service.act(before.id, 'approve', OWNER, { expected_hash: service.contentHashOf(before) });
    assert.ok((await service.get(before.id)).approval);
    await main(['jpeg-for-meta'], { dir: data, log: quiet });
    const after = await service.get(before.id);
    assert.equal(after.asset.content_type, 'image/jpeg');
    assert.notEqual(after.asset.sha256, before.asset.sha256);
    assert.equal(after.approval, null, 'the approval of the PNG version does not cover the JPEG');
    assert.equal(after.state, 'READY_FOR_REVIEW', 'offered again, awaiting a NEW decision');
    assert.equal((await service.list()).length, 1);
    const kinds = (await import('node:fs/promises').then((m) => m.readdir(join(data, 'assets', 'files')))).sort();
    assert.equal(kinds.some((n) => n.endsWith('.png')), true, 'the PNG source is still in the library');
    assert.equal(kinds.some((n) => n.endsWith('.jpg')), true);
    await main(['jpeg-for-meta'], { dir: data, log: quiet }); // idempotent
    assert.equal((await service.list()).length, 1);
  } finally { await rm(reserve, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); }
});
