// Phase 4 - /version tells which commit runs, from a declared or Git-provided SHA; "unknown" otherwise; never a secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { releaseOf, releaseMatches } from '../src/sourcing/server/release.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';

const SHA = '7deb8822a933b7134eb8c18554ea6541afa1c9a3';

test('a declared SHA wins over the Railway one; a Git deploy shows its SHA; an upload shows unknown', () => {
  assert.deepEqual({ ...releaseOf({ NORDLA_RELEASE_SHA: SHA, RAILWAY_GIT_COMMIT_SHA: 'aaaaaaa1' }) }, { sha: SHA, branch: 'unknown', source: 'declared' });
  assert.equal(releaseOf({ RAILWAY_GIT_COMMIT_SHA: 'ABCDEF1234' }).sha, 'abcdef1234');
  assert.equal(releaseOf({ RAILWAY_GIT_COMMIT_SHA: 'ABCDEF1234' }).source, 'railway-git');
  assert.deepEqual({ ...releaseOf({}) }, { sha: 'unknown', branch: 'unknown', source: 'none' });
});

test('a value that is not a commit is refused (no injected text reaches /version)', () => {
  const r = releaseOf({ NORDLA_RELEASE_SHA: '<script>', NORDLA_RELEASE_BRANCH: 'main; rm -rf /' });
  assert.equal(r.sha, 'unknown');
  assert.equal(r.branch, 'unknown');
});

test('the comparison accepts a short or full expected SHA and refuses any other', () => {
  assert.equal(releaseMatches(SHA, SHA), true);
  assert.equal(releaseMatches(SHA, '7deb882'), true);
  assert.equal(releaseMatches(SHA, '7deb8823'), false);
  assert.equal(releaseMatches('unknown', SHA), false);
  assert.equal(releaseMatches(SHA, '7deb'), false, 'too short to be a commit');
});

test('GET /version answers on the Core server with the release and no other data', async () => {
  const handler = createSourcingApp({ release: { sha: SHA, branch: 'release/sourcing-staging', source: 'declared' }, gate: null, token: 't'.repeat(32), core: null, store: createMemoryStore(), uiDir: '.', coreDir: '.' }).handler;
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/version`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['branch', 'service', 'sha', 'source']);
    assert.equal(body.sha, SHA);
    assert.equal(body.branch, 'release/sourcing-staging');
  } finally { await new Promise((r) => s.close(r)); }
});
