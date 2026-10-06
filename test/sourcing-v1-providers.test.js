// Conversation First, step 4: the PROVIDER BOUNDARY (speech-to-text, translation, OCR) and the provenance rules around it. No provider exists in V1: the registry is empty and the product works without
// any. A provider is selected EXPLICITLY by the owner (no automatic routing by cost or quality), needs consent, costs nothing recurring unless the owner approved, and never sends confidential data to a
// China-hosted service without permission. Its output only ever enters the case as a DERIVED item (provider + version + review MACHINE) next to the untouched original. A fact extracted from a
// machine transcription or translation is capped at MEDIUM confidence, can never join a grouped confirmation, and is confirmed individually. Test doubles only: nothing is downloaded or called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/sourcing/core/case.js';
import { createRegistry, registerProvider, runStage, deriveEvent, PROVIDER_KIND, RESULT } from '../src/sourcing/core/providers.js';
import { classifyCandidates } from '../src/sourcing/core/understanding.js';
import { NOW, build, run, importer } from './sourcing-fixtures.js';

const at = (n = 0) => new Date(NOW.getTime() + n * 1000);
const caps = (o = {}) => ({ langs: ['zh', 'en'], offline: true, recurringCostEur: 0, license: 'Apache-2.0 (test double)', dataClass: 'LOCAL', region: 'LOCAL', ...o });
const fake = (id, kind, o = {}) => { const calls = { run: 0, inputs: [] }; return { id, kind, version: '1.0-test', capabilities: caps(o.caps), calls, status: () => o.status ?? RESULT.OK, run: async (input) => { calls.run += 1; calls.inputs.push(input); if (o.throws) throw new Error('boom'); return o.result ?? { status: RESULT.OK, text: 'MOQ is 50 pcs. Price is USD 8 for 50 pcs. We have CE.', lang: 'en', confidence: 0.9 }; } }; };
const sel = (id, kind = PROVIDER_KIND.STT, extra = {}) => ({ selected: { [kind]: id }, consent: { [id]: true }, online: true, ...extra });
const base = () => { let s = build([{ type: 'NAME', name: 'Power bank' }, { type: 'CATEGORY', category: 'power_bank' }, ...importer]); s = dispatch(s, { type: 'CONVERSATION_START', supplierRef: 'x', lang: 'auto' }, at(1)); return dispatch(s, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'supplier', lang: 'zh', text: '(audio recorded at the booth)' }, at(2)); };

test('V1: the registry is empty and every stage says UNAVAILABLE (never simulated)', async () => {
  const reg = createRegistry(); for (const k of Object.values(PROVIDER_KIND)) { const r = await runStage(reg, k, { text: 'x' }, {}); assert.equal(r.status, RESULT.UNAVAILABLE); assert.equal(r.code, 'NO_PROVIDER'); assert.ok(r.reason.fr.length > 5); assert.equal(r.text, undefined, 'no invented text'); }
});

test('a provider must declare what it is: kind, version, languages, cost, licence, data class, region, a status and a run', () => {
  const reg = createRegistry(); assert.throws(() => registerProvider(reg, { id: 'x' }), /kind/); assert.throws(() => registerProvider(reg, { ...fake('a', 'STT'), kind: 'MAGIC' }), /kind/);
  assert.throws(() => registerProvider(reg, { ...fake('a', 'STT'), capabilities: caps({ license: '' }) }), /licen/i); assert.throws(() => registerProvider(reg, { ...fake('a', 'STT'), capabilities: caps({ recurringCostEur: undefined }) }), /cost/i);
  registerProvider(reg, fake('a', 'STT')); assert.throws(() => registerProvider(reg, fake('a', 'STT')), /already/);
});

test('NO routing: nothing is chosen for the owner; only the explicitly selected provider is ever used, and a failure never falls back to another', async () => {
  const reg = createRegistry(); const a = fake('a', 'STT'); const b = fake('b', 'STT'); registerProvider(reg, a); registerProvider(reg, b);
  assert.equal((await runStage(reg, 'STT', { text: 'x' }, { consent: { a: true, b: true } })).code, 'NO_PROVIDER', 'two exist, none selected: nothing runs'); assert.equal(a.calls.run + b.calls.run, 0);
  const r = await runStage(reg, 'STT', { text: 'x' }, sel('b')); assert.equal(r.status, RESULT.OK); assert.equal(r.provider, 'b'); assert.equal(b.calls.run, 1); assert.equal(a.calls.run, 0);
  const reg2 = createRegistry(); const bad = fake('bad', 'STT', { status: RESULT.UNAVAILABLE }); const good = fake('good', 'STT'); registerProvider(reg2, bad); registerProvider(reg2, good);
  assert.equal((await runStage(reg2, 'STT', { text: 'x' }, { ...sel('bad'), consent: { bad: true, good: true } })).status, RESULT.UNAVAILABLE); assert.equal(good.calls.run, 0, 'no silent fallback');
});

test('policy, checked BEFORE any call: consent, no recurring cost, no confidential data to a China-hosted service, no remote provider offline', async () => {
  const reg = createRegistry(); const local = fake('loc', 'STT'); const paid = fake('paid', 'TRANSLATE', { caps: { recurringCostEur: 5, dataClass: 'REMOTE', region: 'EU', offline: false } }); const cn = fake('cn', 'TRANSLATE', { caps: { dataClass: 'REMOTE', region: 'CN', offline: false } }); const remote = fake('rem', 'OCR', { caps: { dataClass: 'REMOTE', region: 'EU', offline: false } });
  for (const p of [local, paid, cn, remote]) registerProvider(reg, p);
  assert.equal((await runStage(reg, 'STT', { text: 'x' }, { selected: { STT: 'loc' } })).code, 'CONSENT_MISSING');
  assert.equal((await runStage(reg, 'TRANSLATE', { text: 'x' }, sel('paid', 'TRANSLATE'))).code, 'PAID_NOT_APPROVED'); assert.equal((await runStage(reg, 'TRANSLATE', { text: 'x' }, sel('paid', 'TRANSLATE', { allowPaid: { paid: true } }))).status, RESULT.OK);
  assert.equal((await runStage(reg, 'TRANSLATE', { text: 'x' }, sel('cn', 'TRANSLATE'))).code, 'REGION_BLOCKED'); assert.equal((await runStage(reg, 'TRANSLATE', { text: 'x' }, sel('cn', 'TRANSLATE', { allowChina: true }))).status, RESULT.OK);
  assert.equal((await runStage(reg, 'OCR', { text: 'x' }, sel('rem', 'OCR', { online: false }))).code, 'OFFLINE'); assert.equal((await runStage(reg, 'STT', { text: 'x' }, sel('loc', 'STT', { online: false }))).status, RESULT.OK, 'a local provider works offline');
  assert.equal(paid.calls.run + cn.calls.run + remote.calls.run, 1 + 1, 'refused providers were never called (only the two approved calls ran)');
});

test('what the provider receives: emails and phone numbers are removed from confidential text; public text is unchanged', async () => {
  const reg = createRegistry(); const p = fake('loc', 'TRANSLATE'); registerProvider(reg, p); const t = 'Contact Li at li.wei@supplier.example or +86 138 0013 8000, price USD 8.';
  await runStage(reg, 'TRANSLATE', { text: t }, sel('loc', 'TRANSLATE')); assert.doesNotMatch(p.calls.inputs[0].text, /supplier.example|138 0013/); assert.match(p.calls.inputs[0].text, /price USD 8/);
  await runStage(reg, 'TRANSLATE', { text: t }, sel('loc', 'TRANSLATE'), { dataClass: 'PUBLIC' }); assert.equal(p.calls.inputs[1].text, t);
});

test('a provider that is unsure, fails or answers nothing yields UNKNOWN: no text, nothing for the case', async () => {
  const reg = createRegistry(); registerProvider(reg, fake('t', 'STT', { throws: true })); registerProvider(reg, fake('e', 'TRANSLATE', { result: { status: RESULT.OK, text: '   ' } })); registerProvider(reg, fake('u', 'OCR', { result: { status: RESULT.UNKNOWN, reason: 'low confidence' } }));
  for (const [id, k] of [['t', 'STT'], ['e', 'TRANSLATE'], ['u', 'OCR']]) { const r = await runStage(reg, k, { text: 'x' }, sel(id, k)); assert.equal(r.status, RESULT.UNKNOWN, id); assert.equal(deriveEvent(r, { convId: 'conv-1', itemId: 'conv-1-i1', kind: 'TRANSCRIPTION' }), null); }
});

test('an OK result enters the case ONLY as a derived item (provider, version, MACHINE) beside the untouched original, and proposes no fact by itself', async () => {
  const reg = createRegistry(); registerProvider(reg, fake('loc', 'STT')); let s = base(); const original = s.conversations[0].items[0].original;
  const r = await runStage(reg, 'STT', { audioRef: 'blob:1' }, sel('loc')); const ev = deriveEvent(r, { convId: 'conv-1', itemId: 'conv-1-i1', kind: 'TRANSCRIPTION' }); assert.equal(ev.type, 'CONVERSATION_DERIVE');
  const n = s.candidates.length; s = dispatch(s, ev, at(3)); const it = s.conversations[0].items[0];
  assert.equal(it.original, original, 'the original is never replaced'); assert.equal(it.derived.length, 1); assert.equal(it.derived[0].provider, 'loc'); assert.equal(it.derived[0].version, '1.0-test'); assert.equal(it.derived[0].review, 'MACHINE'); assert.equal(s.candidates.length, n, 'no fact without extract');
});

test('PROVENANCE: a fact from a machine transcription is capped at MEDIUM, tagged, never grouped, never a document claim, and needs an individual confirmation', async () => {
  const reg = createRegistry(); registerProvider(reg, fake('loc', 'STT')); let s = base(); const r = await runStage(reg, 'STT', { audioRef: 'blob:1' }, sel('loc'));
  s = dispatch(s, { ...deriveEvent(r, { convId: 'conv-1', itemId: 'conv-1-i1', kind: 'TRANSCRIPTION', extract: true }) }, at(3));
  const d = s.candidates.filter((c) => c.basis === 'TRANSCRIPTION'); assert.ok(d.length >= 3, 'moq, price, claim extracted from the transcription');
  for (const c of d) { assert.notEqual(c.confidence, 'HIGH', `${c.key} capped`); assert.ok(c.flags.includes('MACHINE_DERIVED')); assert.equal(c.state, 'PROPOSED'); }
  const cls = classifyCandidates(s); assert.equal(cls.group.length, 0, 'nothing machine-derived in the group'); assert.equal(cls.claims.length, 0, 'not even a document statement');
  assert.ok(cls.attention.filter((a) => d.some((c) => c.id === a.candidate.id)).every((a) => a.reason === 'MACHINE_DERIVED'));
  assert.throws(() => dispatch(s, { type: 'CANDIDATES_CONFIRM_BATCH', via: 'GROUP', ids: d.map((c) => c.id) }, at(4)), /not eligible/); assert.throws(() => dispatch(s, { type: 'CANDIDATES_CONFIRM_BATCH', via: 'CLAIMS', ids: d.filter((c) => c.key.startsWith('docClaim.')).map((c) => c.id) }, at(4)), /not eligible/);
  const moq = d.find((c) => c.key === 'quote.moq'); s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: moq.id }, at(5)); const led = s.ledger.at(-1);
  assert.equal(led.status, 'SUPPLIER_CLAIM', 'a confirmed machine fact is still only a supplier claim'); assert.equal(led.basis, 'TRANSCRIPTION'); assert.equal(led.userConfirmed, true);
});

test('translation is kept apart too: basis TRANSLATION, same caps; original-extracted facts are marked ORIGINAL and keep their confidence', async () => {
  const reg = createRegistry(); registerProvider(reg, fake('tr', 'TRANSLATE')); let s = base(); const r = await runStage(reg, 'TRANSLATE', { text: '(zh)' }, sel('tr', 'TRANSLATE'));
  s = dispatch(s, deriveEvent(r, { convId: 'conv-1', itemId: 'conv-1-i1', kind: 'TRANSLATION', extract: true }), at(3)); assert.ok(s.candidates.some((c) => c.basis === 'TRANSLATION' && c.key === 'quote.moq'));
  s = dispatch(s, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'supplier', lang: 'en', text: 'MOQ is 50 pcs.' }, at(6)); const o = s.candidates.find((c) => c.itemId === 'conv-1-i2' && c.key === 'quote.moq'); assert.equal(o.basis, 'ORIGINAL'); assert.equal(o.confidence, 'HIGH');
  assert.ok(classifyCandidates(s).group.some((c) => c.id === o.id), 'an original statement can still be grouped');
});
