// China Sourcing case persistence under CONCURRENT saves (two devices, a sync retry, a double tap): a stale save must be refused with CONFLICT - never silently overwrite a
// supplier note, never crash with a missing temporary file, never leave a half-written case. Found by the 2026-10-18 night audit (8 simultaneous saves: 4 "succeeded" with the
// SAME revision, i.e. 3 notes lost without a word, and 4 failed with ENOENT).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore, createMemoryStore } from '../src/sourcing/store/file-store.js';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { NOW } from './sourcing-fixtures.js';

const note = (base, text) => dispatch(base, { type: 'NOTE', text }, NOW);

test('SC-1 eight simultaneous saves from the same revision: exactly one wins, the others get CONFLICT, nothing is lost silently, no temporary file is left', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sourcing-conc-')); const store = createFileStore(dir);
  const v1 = await store.save(newCase({ id: 'case-r', name: 'x', now: NOW }));
  const texts = Array.from({ length: 8 }, (_, i) => `Note fournisseur ${i} : MOQ 500 pièces, délai 25 jours, prix 4,20 USD ${'é'.repeat(300)}`);
  const results = await Promise.allSettled(texts.map((t) => store.save(note(v1, t))));
  const ok = results.filter((r) => r.status === 'fulfilled'); const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, `exactly one save wins (got ${ok.length}: ${results.map((r) => (r.status === 'fulfilled' ? `ok rev${r.value.rev}` : r.reason.code ?? r.reason.message)).join(', ')})`);
  assert.ok(failed.every((r) => r.reason.code === 'CONFLICT'), `the others are CONFLICT, never ENOENT or a crash: ${failed.map((r) => r.reason.code ?? r.reason.message)}`);
  const final = JSON.parse(await readFile(join(dir, 'case-r.json'), 'utf8'));
  assert.equal(final.rev, 2); assert.equal(final.notes.length, 1);
  assert.ok(texts.includes(final.notes[0].text), 'the stored note is exactly one of the submitted notes, complete');
  assert.deepEqual((await readdir(dir)).filter((f) => f !== 'case-r.json'), [], 'no temporary file left behind');
});

test('SC-2 a client that gets CONFLICT merges on the server copy and its retry succeeds; the earlier note is kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sourcing-conc-')); const store = createFileStore(dir);
  const v1 = await store.save(newCase({ id: 'case-m', name: 'x', now: NOW }));
  const [a, b] = await Promise.allSettled([store.save(note(v1, 'note du téléphone A')), store.save(note(v1, 'note du téléphone B'))]);
  const loser = [a, b].find((r) => r.status === 'rejected'); assert.equal(loser.reason.code, 'CONFLICT');
  const server = loser.reason.server; assert.equal(server.rev, 2);
  const retried = await store.save(note(server, loser === a ? 'note du téléphone A' : 'note du téléphone B'));
  assert.equal(retried.rev, 3); assert.equal(retried.notes.length, 2, 'both notes survive');
});

test('SC-3 many different cases saved at the same time all succeed (the guard is per case, it does not serialise unrelated cases into failures)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sourcing-conc-')); const store = createFileStore(dir);
  const res = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.save(newCase({ id: `case-${i}`, name: `c${i}`, now: NOW }))));
  assert.ok(res.every((r) => r.status === 'fulfilled'));
  assert.equal((await store.list()).length, 12);
});

test('SC-4 the memory store keeps the same rule (a stale save is CONFLICT)', async () => {
  const store = createMemoryStore(); const v1 = await store.save(newCase({ id: 'case-q', name: 'x', now: NOW }));
  await store.save(note(v1, 'a'));
  await assert.rejects(() => store.save(note(v1, 'b')), { code: 'CONFLICT' });
});

// ---- photos of a case (same rule: the first photo under a key is kept; the same bytes again is a no-op; different bytes are CONFLICT) --------------------------------------
import { createFilePhotoStore } from '../src/sourcing/store/photo-store.js';
const dataUrl = (s) => `data:image/jpeg;base64,${Buffer.from(s).toString('base64')}`;

test('SC-5 simultaneous photo uploads under one key: the identical retry never fails, a different photo is CONFLICT and never replaces the first, no temporary file is left', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sourcing-photos-')); const photos = createFilePhotoStore(dir);
  const key = 'photo:case-p.1';
  const same = dataUrl('jpeg-bytes-A'.repeat(50)); const other = dataUrl('jpeg-bytes-B'.repeat(50));
  const results = await Promise.allSettled([same, other, same, same, other, same].map((d) => photos.put('case-p', key, d)));
  const codes = results.map((r) => (r.status === 'fulfilled' ? r.value.status : r.reason.code ?? r.reason.message));
  assert.equal(codes.filter((c) => c !== 'STORED' && c !== 'UNCHANGED' && c !== 'PHOTO_CONFLICT').length, 0, `only STORED / UNCHANGED / PHOTO_CONFLICT: ${codes}`);
  assert.equal(codes.filter((c) => c === 'STORED').length, 1, `exactly one upload is stored: ${codes}`);
  const listed = await photos.list('case-p'); assert.equal(listed.length, 1);
  const files = (await readdir(join(dir, 'case-p'))); assert.deepEqual(files.filter((f) => f.endsWith('.tmp') || f.includes('.tmp')), [], 'no temporary file left');
  const stored = await photos.get('case-p', key);
  const firstWinner = results.findIndex((r) => r.status === 'fulfilled' && r.value.status === 'STORED');
  const winnerData = [same, other, same, same, other, same][firstWinner];
  assert.equal(stored.dataUrl, winnerData, 'the stored photo is the winner, complete and unchanged');
});
