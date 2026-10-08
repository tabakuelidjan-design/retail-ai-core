import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCandidateManifest } from '../src/branding/candidate-manifest.js';
import { opaqueRef } from '../src/branding/hard-rules.js';

// A candidate manifest carries controlled Nordla references only: never inline media, a raw provider URL, a signed or credentialed URL
// or a filesystem location. The global opaqueRef() (shared with other Branding contracts) is intentionally not hardened.

const BACKSLASH = String.fromCharCode(92);
const assets = (...values) => ({ content_kind: 'IMAGE', assets: [{ subject: 'primary', coverage: 'COMPLETE', values, evidence_refs: [] }] });
const withEvidence = (...refs) => ({ content_kind: 'IMAGE', colors: [{ subject: 'logo.color', coverage: 'COMPLETE', values: ['#112233'], evidence_refs: refs }] });
const gateWithEvidence = (...refs) => ({ content_kind: 'IMAGE', external_gates: [{ subject: 'product_fidelity', coverage: 'COMPLETE', status: 'PASS', evidence_refs: refs }] });

test('manifest refs: asset:// and evidence:// references are accepted', () => {
  const manifest = normalizeCandidateManifest({ ...assets('asset://out-1'), colors: withEvidence('evidence://run-1').colors });
  assert.deepEqual([...manifest.assets[0].values], ['asset://out-1']);
  assert.deepEqual([...manifest.colors[0].evidence_refs], ['evidence://run-1']);
  assert.equal(normalizeCandidateManifest(gateWithEvidence('fidelity://run-1')).external_gates[0].evidence_refs[0], 'fidelity://run-1');
});

for (const ref of [
  'data:image/png;base64,AAAA', 'blob:https://x.test/uuid', 'file:///etc/passwd', 'FILE:///C:/secret.png', 'https://provider.test/a.png',
  'http://provider.test/a.png', 'https://signed.test/a.png?token=abc', 'https://user:pass@provider.example/a.png', `C:${BACKSLASH}secret${BACKSLASH}a.png`, '/var/data/a.png',
]) {
  test(`manifest refs: ${ref.slice(0, 40)} is refused as an asset value and as evidence`, () => {
    assert.throws(() => normalizeCandidateManifest(assets(ref)), /controlled Nordla reference/);
    assert.throws(() => normalizeCandidateManifest(withEvidence(ref)), /controlled Nordla reference/);
    assert.throws(() => normalizeCandidateManifest(gateWithEvidence(ref)), /controlled Nordla reference/);
  });
}

test('manifest refs: the global opaqueRef() is untouched (other Branding contracts keep their behaviour)', () => {
  assert.equal(opaqueRef('https://example.test', 'ref'), 'https://example.test');
  assert.equal(opaqueRef('data:text/plain;x', 'ref'), 'data:text/plain;x');
});
