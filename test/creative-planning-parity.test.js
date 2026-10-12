import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { auditSpecStage } from '../src/creative-brain/parity.js';
import {
  auditPlanningParity, COPY_ADAPT_RULES, createContentFormatPlanner, createCopyAdapter, PLANNING_STAGE_CONTRACTS, renderPlanningContractMatrix,
} from '../src/creative-planning/index.js';
import { BrainError } from '../src/creative-brain/validation.js';
import { copy, request, scriptedCopyPort } from './creative-planning-world.js';

// PARITY AND CONTRACT WORDING OF THE PLANNING STAGES (`// PP-N` markers).

test('PP-1 the planning stages that may ask a model agree with their validators, mechanically', () => {
  const audit = auditPlanningParity();
  assert.deepEqual(audit.failures, []); assert.ok(audit.ready);
  assert.deepEqual(audit.stages.map((s) => s.stage), ['COPY_ADAPT', 'COPY_WRITE', 'INPUT_UNDERSTANDING', 'CONTENT_ANALYSIS', 'FORMAT_PLAN']);
  for (const s of audit.stages.filter((x) => x.model)) assert.ok(s.rows >= 10, `${s.stage} has ${s.rows} rows`);
  assert.ok(audit.stages.filter((x) => !x.model).every((s) => s.derivation));
});

test('PP-2 the audit is not decorative: an instruction that forgets a rule, a key or the shape fails it', () => {
  for (const c of PLANNING_STAGE_CONTRACTS) {
    const real = c.instruction().system;
    for (const r of c.rules) assert.ok(auditSpecStage({ ...c, instruction: () => ({ system: real.replace(r.statement, 'omitted') }) }).failures.some((f) => f.includes(r.id)), `${c.stage}: ${r.id}`);
    assert.ok(auditSpecStage({ ...c, instruction: () => ({ system: real.replace(/answer\.rationale/g, 'x') }) }).failures.length > 0);
    assert.ok(auditSpecStage({ ...c, instruction: () => ({ system: 'You are a writer.' }) }).failures.length >= 10);
    assert.ok(auditSpecStage({ ...c, rules: [...c.rules, { id: 'GHOST', statement: 'a rule nobody enforces' }] }).failures.length > 0);
  }
});

test('PP-3 the committed planning matrix is the one the code produces', () => {
  const committed = readFileSync(new URL('../docs/architecture/creative-planning-contract-matrix.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, renderPlanningContractMatrix());
  assert.ok(!/\b[0-9a-f]{64}\b/.test(committed));
});

test('PP-4 NUMBERS: a plan holds deterministically measured figures; a model-authored answer holds none', async () => {
  const plan = await createContentFormatPlanner().plan(request({ channel: 'SOCIAL_FEED', copy: [copy({ role: 'HEADLINE', text: 'Vos souvenirs. Votre création.' })] }));
  assert.equal(typeof plan.density.chars, 'number'); assert.equal(typeof plan.assets[0].canvas.width, 'number'); assert.equal(typeof plan.assets[0].slots[0].chars, 'number');
  const port = scriptedCopyPort('adapt', [{ text: 'Court', rationale: 'ok', rating: 9 }, '{"text": "Court", "rationale": "ok", "words": 1}', '{"text": 7, "rationale": "ok"}']);
  const adapter = createCopyAdapter({ complete: port.complete });
  for (let i = 0; i < 3; i += 1) await assert.rejects(adapter.adapt({ source: 'Texte', role: 'HEADLINE', capacityChars: 50, locale: 'fr' }), BrainError);
  assert.ok(COPY_ADAPT_RULES.every((r) => typeof r.check === 'function'));
});

test('PP-5 the validation contract states the rule precisely: measured figures are allowed, invented ones are not', () => {
  const source = readFileSync(new URL('../src/creative-brain/validation.js', import.meta.url), 'utf8');
  assert.match(source, /MEASURED/); assert.match(source, /never a figure a model wrote/i);
});

test('PP-6 the decisions of this phase are in the register, with their wording', () => {
  const register = readFileSync(new URL('../NORDLA-DECISION-REGISTER.md', import.meta.url), 'utf8');
  for (const id of ['NDR-P17', 'NDR-P18', 'NDR-P19', 'NDR-P20', 'NDR-P21']) assert.ok(register.includes(`| ${id} |`), id);
  for (const phrase of ['COPY_LOCKED', 'COPY_ADAPTABLE', 'COPY_GENERATABLE', 'format is decided before the canvas', 'No opaque runtime fallback chain', 'EUR 2.00']) assert.ok(register.includes(phrase), phrase);
  assert.ok(register.includes('| NDR-D01 | Multi-model routing | DECIDED / DEFERRED |'), 'NDR-D01 is untouched');
});
