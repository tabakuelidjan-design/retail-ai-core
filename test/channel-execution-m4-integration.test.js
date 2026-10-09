import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as A from '../src/activation/index.js';
import * as m4 from '../src/marketing/m4.js';
import {
  IDS, M1, NOW, advance, jobOf, runtime, tenant, world,
} from './channel-fixtures.js';

const W = world();
const code = (fn) => { try { fn(); } catch (error) { return error.code; } return assert.fail('expected an error'); };
const isDeepFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));

async function published() {
  const rt = await runtime(W);
  for (let i = 0; i < 4; i += 1) { await rt.executor.runDueJobs({ merchantId: M1 }); advance(rt, 120_000); }
  const jobs = rt.store._rows.filter((r) => r.state === 'PUBLISHED');
  return { rt, jobs, receipts: jobs.map((job) => A.buildChannelPublicationReceipt(job)) };
}
const handoff = (receipts, rt, over = {}) => A.buildMarketingExecutionReceiptFromPublications({
  tenant: tenant(), push: W.push, activationManifest: W.activationManifest, authorization: W.execAuthorization, publications: receipts, recordedAt: new Date(rt.clock.t).toISOString(), ...over,
});

test('Publication receipt: produced only from a PUBLISHED job, deterministic, scoped, with the post id and time, no success claim', async () => {
  const { jobs, receipts } = await published();
  assert.equal(receipts.length, 2); // 151
  const [receipt] = receipts;
  const job = jobs.find((j) => j.provider_submission_id === receipt.provider_submission_id);
  assert.match(receipt.receipt_id, /^acr_[0-9a-f]{32}$/);
  assert.equal(A.buildChannelPublicationReceipt(job).receipt_id, receipt.receipt_id); // 152
  assert.notEqual(A.buildChannelPublicationReceipt({ ...job, provider_post_ids: ['another-post'] }).receipt_id, receipt.receipt_id);
  const processing = { ...job, state: 'PROCESSING' }; // 153
  assert.equal(code(() => A.buildChannelPublicationReceipt(processing)), 'ACT_RECEIPT_NOT_PUBLISHED');
  assert.equal(code(() => A.buildChannelPublicationReceipt({ ...job, provider_post_ids: [], provider_submission_id: null })), 'ACT_RECEIPT_PROVIDER_REF_REQUIRED');
  assert.equal(code(() => A.buildChannelPublicationReceipt({ ...job, provider_post_ids: ['bad id with spaces'] })), 'ACT_RECEIPT_PROVIDER_REF_REQUIRED');
  assert.ok(receipt.provider_post_ids.length > 0 && receipt.provider_submission_id);
  assert.deepEqual([receipt.merchant_id, receipt.brand_id], [M1, W.activationManifest.brand_id]); // 154, 155
  assert.equal(receipt.activation_manifest_ref, W.activationManifest.activation_manifest_id); // 156
  assert.ok(W.activationManifest.deliveries.some((d) => d.deliverable_ref === receipt.manifest_delivery_ref)); // 157
  assert.ok([IDS.IG, IDS.GBP].includes(receipt.connector_id)); // 158
  assert.equal(code(() => A.buildChannelPublicationReceipt({ ...job, published_at: null })), 'ACT_RECEIPT_PUBLISHED_AT_REQUIRED'); // 159
  assert.deepEqual(Object.keys(receipt).filter((k) => /success|result|outcome|engagement|score|lift|incremental|causal|roi|revenue/i.test(k)), []); // 160
  assert.ok(isDeepFrozen(receipt));
});

test('M4 handoff: all published -> EXECUTED, a subset -> PARTIAL, nothing -> no receipt; the refs map the internal publication receipts', async () => {
  const { rt, receipts } = await published();
  const executed = handoff(receipts, rt); // 161
  assert.deepEqual([executed.execution_status, executed.delivery_execution_refs.length], ['EXECUTED', 2]);
  const partial = handoff([receipts[0]], rt); // 162
  assert.deepEqual([partial.execution_status, partial.delivery_execution_refs.length], ['PARTIAL', 1]);
  assert.equal(code(() => handoff([], rt)), 'ACT_M4_NOTHING_PUBLISHED'); // 163: no fake PARTIAL
  assert.equal(code(() => handoff(undefined, rt)), 'ACT_M4_NOTHING_PUBLISHED');
  const ids = new Set(receipts.map((r) => r.receipt_id)); // 164
  for (const ref of executed.delivery_execution_refs) {
    assert.ok(ids.has(ref.delivery_execution_ref));
    assert.equal(receipts.find((r) => r.receipt_id === ref.delivery_execution_ref).manifest_delivery_ref, ref.deliverable_ref);
  }
  assert.equal(code(() => handoff([receipts[0], receipts[0]], rt)), 'ACT_ORDER_DUPLICATE_DELIVERY');
  assert.equal(code(() => handoff([{ ...receipts[0], provider_post_ids: ['forged'] }], rt)), 'ACT_M4_RECEIPT_SCOPE_MISMATCH'); // a tampered receipt no longer matches its id
  assert.ok(isDeepFrozen(executed));
});

test('The handoff is an EXISTING M4 receipt: M4 builds its Run from it unchanged, provider ids are evidence refs, nothing is causal', async () => {
  const { rt, receipts } = await published();
  const receipt = handoff(receipts, rt);
  const run = m4.buildMarketingRun({ // 165, 166: M4 accepts the receipt with no change to M4
    tenant: tenant(), push: W.push, activationManifest: W.activationManifest, authorization: W.execAuthorization, receipt, asOf: new Date(rt.clock.t + 60_000).toISOString(),
  });
  assert.deepEqual([run.execution_status, run.merchant_id, run.activation_manifest_ref], ['EXECUTED', M1, W.activationManifest.activation_manifest_id]);
  assert.equal(run.execution_ref, receipt.execution_ref);
  assert.ok(receipt.evidence_refs.every((ref) => /^provider-(post|submission):\/\//.test(ref))); // 167
  for (const r of receipts) for (const id of r.provider_post_ids) assert.ok(receipt.evidence_refs.includes(`provider-post://${r.provider}/${id.replace(/[^A-Za-z0-9:_./#-]/g, '-')}`));
  const partialRun = m4.buildMarketingRun({
    tenant: tenant(), push: W.push, activationManifest: W.activationManifest, authorization: W.execAuthorization, receipt: handoff([receipts[0]], rt), asOf: new Date(rt.clock.t + 60_000).toISOString(),
  });
  assert.ok(partialRun.review_signals.includes('PARTIAL_EXECUTION'));
  const everything = JSON.stringify([receipts, receipt]); // 168
  assert.doesNotMatch(everything, /"causal_claim":true|"evidence_class"|INCREMENTAL|"outcome"/);
  assert.doesNotMatch(await readFile(new URL('../src/marketing/m4.js', import.meta.url), 'utf8'), /activation\//); // M4 knows nothing of this layer
  assert.equal(jobOf(rt, 'instagram').state, 'PUBLISHED');
  assert.equal(NOW.length > 0, true);
});
