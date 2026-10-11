import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  askAndNormalize, buildProtocolRepairInstruction, obj, PROTOCOL_REPAIR, text, validateSpec,
} from '../src/creative-brain/index.js';
import { RESULT_STATE } from '../src/creative-brain-benchmark/index.js';
import { compositionAnswer, CONCEPTS, OTHER_CONCEPTS } from './creative-brain-world.js';
import { live, selectAnswer, world } from './creative-brain-benchmark-world.js';

// THE ONE PROTOCOL REPAIR (`// PR-N` markers): malformed JSON gets exactly one re-ask of the same stage with the same instruction; nothing else ever does. Fakes only, no provider.

const spec = obj({ alpha: text({ min: 1, max: 40 }), beta: text({ min: 1, max: 40 }) });
const GOOD = JSON.stringify({ alpha: 'first value', beta: 'second value' });
const BROKEN = '{"alpha": "first value", "beta": ["second value"}'; // a bracket closed with the wrong character
const INSTRUCTION = { system: 'SYSTEM TEXT of the stage', user: 'USER TEXT of the stage with its creative context' };

const port = (...replies) => {
  const calls = [];
  const complete = async (instruction) => {
    calls.push(instruction);
    const next = replies[calls.length - 1];
    if (next === undefined) throw Object.assign(new Error('no more replies'), { code: 'NO_MORE' });
    if (next instanceof Error) throw next;
    return typeof next === 'string' ? { text: next, model: 'm1', request_id: `req-${calls.length}`, cost_eur: 0.01 * calls.length } : next;
  };
  return { complete, calls };
};
const ask = (p, normalize = (raw) => validateSpec(spec, raw, 'answer')) => askAndNormalize({ complete: p.complete, instruction: INSTRUCTION, stage: 'T', spec, normalize });

test('PR-1 malformed JSON gets exactly ONE repair call, with the same system text and the same user text plus the repair addendum', async () => {
  const p = port(BROKEN, GOOD);
  const { value, meta } = await ask(p);
  assert.deepEqual(value, { alpha: 'first value', beta: 'second value' });
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[1].system, INSTRUCTION.system);
  assert.ok(p.calls[1].user.startsWith(INSTRUCTION.user));
  assert.match(p.calls[1].user, /same intended answer as valid JSON conforming exactly to the contract/);
  assert.match(p.calls[1].user, /Do not add, remove or reconsider any creative decision/);
  assert.ok(p.calls[1].user.endsWith(BROKEN)); // the malformed text is attached as repair evidence only
  assert.deepEqual(p.calls[0], INSTRUCTION); // the first call is untouched
  assert.equal(meta.request_id, 'req-2'); // the repaired answer is the one that stands
});

test('PR-2 the journal keeps the original request id, the malformed response hash, the parse failure, the repair request id, the outcome and the added cost', async () => {
  const { meta } = await ask(port(BROKEN, GOOD));
  const j = meta.protocol_repair;
  assert.equal(j.original_request_id, 'req-1');
  assert.equal(j.malformed_response_sha256, createHash('sha256').update(BROKEN).digest('hex'));
  assert.equal(j.malformed_response_chars, BROKEN.length);
  assert.match(j.parse_failure, /invalid JSON/);
  assert.equal(j.repair_request_id, 'req-2');
  assert.equal(j.outcome, PROTOCOL_REPAIR.outcome.PARSED);
  assert.equal(j.added_cost_eur, 0.02);
  assert.equal(j.original_cost_eur, 0.01);
});

test('PR-3 a valid answer gets ZERO repair calls and carries no repair journal', async () => {
  const p = port(GOOD, GOOD);
  const { meta } = await ask(p);
  assert.equal(p.calls.length, 1);
  assert.equal('protocol_repair' in meta, false);
});

test('PR-4 a parseable answer that breaks the contract (unknown key, missing key, wrong length) gets ZERO repair calls', async () => {
  for (const bad of [JSON.stringify({ alpha: 'a value', beta: 'b value', extra: 'x' }), JSON.stringify({ alpha: 'a value' }), JSON.stringify({ alpha: 'a'.repeat(99), beta: 'b value' })]) {
    const p = port(bad, GOOD);
    await assert.rejects(ask(p), (e) => e.evidence.raw_answer === bad && e.evidence.protocol_repair === undefined);
    assert.equal(p.calls.length, 1, bad);
  }
});

test('PR-5 a creative contradiction (an answer that parses but whose relations conflict) gets ZERO repair calls', async () => {
  const contradictory = { ...compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' } }), hero_relationship: 'PRODUCT_RECEDES_INTO_SCENE', visual_weight: { HEADLINE: 'STRONG', SUBHEADLINE: 'BALANCED', PRICE: 'QUIET', PRODUCT: 'DOMINANT' } };
  const w = world({ answers: { compose: [contradictory, compositionAnswer()] } });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.BLOCKED);
  assert.equal(w.trace.filter((x) => x === 'compose').length, 1);
  const s = await w.store.readJson('summary.json');
  assert.equal(s.error.cause, 'COMPOSITION_RELATIONS_CONTRADICTORY');
  assert.equal(s.provider_calls.text, 5);
});

test('PR-6 a second malformed answer stops the stage after exactly two calls, with the original and the repair evidence preserved', async () => {
  const second = '{"alpha": "still broken';
  const p = port(BROKEN, second, GOOD);
  await assert.rejects(ask(p), (e) => {
    assert.equal(e.code, 'BRAIN_MALFORMED');
    assert.equal(e.evidence.raw_answer, second);
    assert.equal(e.evidence.request_id, 'req-2');
    assert.equal(e.evidence.protocol_repair.original_raw_answer, BROKEN);
    assert.equal(e.evidence.protocol_repair.original_request_id, 'req-1');
    assert.equal(e.evidence.protocol_repair.repair_request_id, 'req-2');
    assert.equal(e.evidence.protocol_repair.outcome, 'STILL_MALFORMED');
    assert.equal(e.evidence.protocol_repair.added_cost_eur, 0.02);
    return true;
  });
  assert.equal(p.calls.length, 2); // never a second repair
});

test('PR-7 repaired JSON still passes through the full canonical validation, and its semantic failure stops normally with both answers kept', async () => {
  const violating = JSON.stringify({ alpha: 'a value', beta: 'b value', extra: 'x' });
  const p = port(BROKEN, violating, GOOD);
  await assert.rejects(ask(p), (e) => {
    assert.equal(e.code, 'BRAIN_UNKNOWN_KEY'); // the semantic failure, not a protocol one
    assert.equal(e.evidence.raw_answer, violating);
    assert.equal(e.evidence.protocol_repair.outcome, 'PARSED');
    assert.equal(e.evidence.protocol_repair.original_raw_answer, BROKEN);
    return true;
  });
  assert.equal(p.calls.length, 2);
  // and the near-miss layer applies to the repaired answer exactly as to any answer
  const typoed = JSON.stringify({ alpah: 'first value', beta: 'second value' });
  const ok = await ask(port(BROKEN, typoed));
  assert.deepEqual(ok.meta.key_repairs, [{ path: 'T', from: 'alpah', to: 'alpha' }]);
});

test('PR-8 no repair without a response body, and none when the provider call itself failed', async () => {
  for (const empty of ['', '   \n']) {
    const p = port(empty, GOOD);
    await assert.rejects(ask(p), (e) => e.code === 'BRAIN_MALFORMED' && !e.evidence.protocol_repair);
    assert.equal(p.calls.length, 1);
  }
  const failing = port(Object.assign(new Error('provider down'), { code: 'HTTP_500', status: 500 }), GOOD);
  await assert.rejects(ask(failing), (e) => e.code === 'BRAIN_PORT_FAILED');
  assert.equal(failing.calls.length, 1);
  // a provider failure DURING the repair stops too, recorded as such
  const dies = port(BROKEN, Object.assign(new Error('provider down'), { code: 'HTTP_500' }));
  await assert.rejects(ask(dies), (e) => e.code === 'BRAIN_PORT_FAILED' && e.evidence.protocol_repair.outcome === 'PORT_FAILED' && e.evidence.protocol_repair.original_raw_answer === BROKEN);
  assert.equal(dies.calls.length, 2);
});

test('PR-9 the malformed text supplied as repair evidence is bounded, and the instruction never changes the contract', () => {
  const long = '{'.repeat(50_000);
  const repair = buildProtocolRepairInstruction(INSTRUCTION, long);
  assert.ok(repair.user.length < INSTRUCTION.user.length + 1500 + PROTOCOL_REPAIR.evidence_chars);
  assert.equal(repair.system, INSTRUCTION.system);
  assert.equal(PROTOCOL_REPAIR.max_reasks_per_stage, 1);
});

test('PR-10 end to end: a malformed IDEATE answer is repaired once, the run continues to READY_FOR_OWNER_REVIEW, and the repair is journaled with its cost bound', async () => {
  const w = world({ answers: { ideate: ['{"concepts": [{"central_idea": "broken', { concepts: CONCEPTS }] } });
  const r = await live(w);
  assert.equal(r.status, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  assert.equal(w.trace.filter((x) => x === 'ideate').length, 2);
  const s = await w.store.readJson('summary.json');
  assert.deepEqual(s.provider_calls, { text: 6, image: 1, vision: 2, total: 9 });
  const entry = s.brain_ledger.find((e) => e.detail?.protocol_repair || e.protocol_repair || JSON.stringify(e).includes('malformed_response_sha256'));
  assert.ok(entry, 'the ledger holds the repair journal');
  assert.match(JSON.stringify(entry), /"outcome":"PARSED"/);
  assert.ok(s.provider_calls.text <= s.worst_case.calls.text);
  // the second round or a second stage may each have its own single repair, never more than one per stage call
  const many = world({ answers: { frame: ['not json', JSON.parse(JSON.stringify((await import('./creative-brain-world.js')).frameAnswer()))], ideate: ['nope', { concepts: CONCEPTS }], select: ['{"evaluations": [', selectAnswer(CONCEPTS)] } });
  const rm = await live(many);
  assert.equal(rm.status, RESULT_STATE.READY_FOR_OWNER_REVIEW);
  assert.equal((await many.store.readJson('summary.json')).provider_calls.text, 8);
});

test('PR-11 a semantically rejected concept round is NOT re-asked: round two is the normal path, not a repair', async () => {
  const rejectAll = [{ DISTINCTIVENESS: 'FAILS' }, { GENERIC_RISK: 'FAILS' }, { FEASIBILITY: 'FAILS' }];
  const w = world({ answers: { ideate: [{ concepts: CONCEPTS }, { concepts: OTHER_CONCEPTS }], select: [selectAnswer(CONCEPTS, rejectAll), selectAnswer(OTHER_CONCEPTS, rejectAll)] } });
  await live(w);
  const s = await w.store.readJson('summary.json');
  assert.equal(JSON.stringify(s.brain_ledger).includes('malformed_response_sha256'), false);
  assert.equal(s.provider_calls.text, 5); // frame, 2 ideate, 2 select: no repair call
});
