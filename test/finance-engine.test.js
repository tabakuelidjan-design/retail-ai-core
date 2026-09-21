import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTotals, createDraft, normalizeLine, verifyIntegrity, updateDraft, FinanceError } from '../src/finance/document.js';
import { divRound, formatCents, fromScaled, toCents, toScaled } from '../src/finance/money.js';
import { findNumberingGaps, formatNumber } from '../src/finance/numbering.js';
import { validateVat } from '../src/finance/vat.js';
import { AGENT_ACTOR, CUSTOMER, LINES, MERCHANT_ACTOR, VAT_OK, draftInvoice, issueInvoice, makeService } from './finance-fixtures.js';

test('money: exact integer parsing, rounding half away from zero, no silent truncation', () => {
  assert.equal(toCents('12.34'), 1234);
  assert.equal(toCents('12.345'), null); // too many decimals is rejected, never rounded
  assert.equal(toCents('abc'), null);
  assert.equal(toScaled('0.1', 2) + toScaled('0.2', 2), toScaled('0.3', 2)); // no float drift
  assert.equal(divRound(5n, 2n), 3n);
  assert.equal(divRound(-5n, 2n), -3n);
  assert.equal(divRound(4n, 3n), 1n);
  assert.equal(formatCents(-1205), '-12.05');
  assert.equal(fromScaled(1234567, 4), '123.4567');
});

const totalsOf = (lines) => computeTotals(lines.map((l, i) => normalizeLine(l, i + 1).line));

test('calculation: multiple VAT rates and a percentage discount, VAT rounded once per rate group', () => {
  const t = totalsOf(LINES); // A: 2 x 10.00 @21% = 20.00 ; B: 50.00 - 10% = 45.00 @6%
  assert.equal(t.netCents, 6500);
  assert.deepEqual(t.vatBreakdown, [{ vatRateBp: 600, taxableCents: 4500, vatCents: 270 }, { vatRateBp: 2100, taxableCents: 2000, vatCents: 420 }]);
  assert.equal(t.vatCents, 690);
  assert.equal(t.grossCents, 7190);
  assert.equal(t.discountCents, 500);
});

test('calculation: VAT is per rate group, not per line (three 0.10 lines at 21%)', () => {
  const lines = [1, 2, 3].map((n) => ({ description: `L${n}`, quantity: '1', unitPrice: '0.10', vatRate: '21' }));
  const t = totalsOf(lines);
  assert.equal(t.netCents, 30);
  assert.equal(t.vatCents, 6); // round(30 * 21%) = 6.3 -> 6, whereas per-line rounding would give 3 x 2 = 6; check a case that differs below
  const odd = [1, 2, 3].map((n) => ({ description: `L${n}`, quantity: '1', unitPrice: '0.50', vatRate: '21' }));
  assert.equal(totalsOf(odd).vatCents, 32); // round(150 * 21%) = 31.5 -> 32 (per-line would be 3 x 11 = 33)
});

test('calculation: fractional quantities, fixed discount, rounding half up, no negative net', () => {
  const t = totalsOf([{ description: 'x', quantity: '2.5', unitPrice: '3.3333', vatRate: '0' }]);
  assert.equal(t.lines[0].grossCents, 833); // 8.33325 -> 8.33
  const d = totalsOf([{ description: 'x', quantity: '1', unitPrice: '10.00', discountAmount: '2.50', vatRate: '21' }]);
  assert.equal(d.netCents, 750);
  assert.equal(d.vatCents, 158); // 157.5 -> 158
  assert.throws(() => totalsOf([{ description: 'x', quantity: '1', unitPrice: '1.00', discountAmount: '2.00', vatRate: '0' }]), (e) => e.code === 'DISCOUNT_EXCEEDS_LINE_AMOUNT');
});

test('invalid line input is reported, not repaired', () => {
  const { errors } = createDraft({ type: 'invoice', merchantId: 'm', customer: CUSTOMER, lines: [{ description: '', quantity: '0', unitPrice: '1.234567', vatRate: '21' }], vat: VAT_OK });
  assert.ok(errors.includes('LINE_1_QUANTITY_INVALID'));
  assert.ok(errors.includes('LINE_1_UNIT_PRICE_INVALID'));
  assert.ok(errors.includes('LINE_1_DESCRIPTION_MISSING'));
});

test('numbering: configurable format, per-year sequences, gap and duplicate detection', () => {
  assert.equal(formatNumber(null, 'invoice', 2026, 7), 'INV-2026-0007');
  assert.equal(formatNumber({ invoice: { prefix: 'F', pad: 6 }, format: '{year}/{prefix}{seq}' }, 'invoice', 2026, 42), '2026/F000042');
  assert.throws(() => formatNumber(null, 'invoice', 2026, 0));
  assert.deepEqual(findNumberingGaps([1, 2, 4, 4, 7]), { gaps: [3, 5, 6], duplicates: [4] });
  assert.deepEqual(findNumberingGaps([2, 3]).gaps, [1]);
});

test('VAT validation: no default rate, treatment must be confirmed, structural consistency enforced', () => {
  const base = { regime: 'domestic', regimeConfirmed: true, lines: [{ vatRateBp: 2100 }], customer: CUSTOMER, sellerVatNumber: 'BE0000000097', vatConfig: { allowedRatesBp: [2100, 600, 0] } };
  assert.deepEqual(validateVat(base), []);
  assert.ok(validateVat({ ...base, regimeConfirmed: false }).includes('VAT_TREATMENT_NOT_CONFIRMED_BY_MERCHANT'));
  assert.ok(validateVat({ ...base, vatConfig: { allowedRatesBp: [] } }).includes('LINE_1_RATE_NOT_ALLOWED_BY_MERCHANT_CONFIG')); // nothing assumed
  assert.ok(validateVat({ ...base, lines: [{ vatRateBp: null }] }).includes('LINE_1_VAT_RATE_MISSING'));
  const rc = { ...base, regime: 'reverse_charge', lines: [{ vatRateBp: 0 }], mention: 'Reverse charge' };
  assert.deepEqual(validateVat(rc), []);
  assert.ok(validateVat({ ...rc, lines: [{ vatRateBp: 2100 }] }).includes('LINE_1_RATE_MUST_BE_ZERO_FOR_REVERSE_CHARGE'));
  assert.ok(validateVat({ ...rc, mention: '' }).includes('LEGAL_MENTION_REQUIRED_FOR_TREATMENT'));
  assert.ok(validateVat({ ...rc, customer: { ...CUSTOMER, vatNumber: null } }).includes('CUSTOMER_VAT_NUMBER_REQUIRED_FOR_TREATMENT'));
  const eu = { ...rc, regime: 'intra_eu_b2b_exempt' };
  assert.ok(validateVat(eu).includes('INTRA_EU_TREATMENT_INCOMPATIBLE_WITH_BELGIAN_CUSTOMER'));
});

test('missing mandatory fields are all reported and block approval', async () => {
  const { svc } = makeService();
  const d = await svc.create({ type: 'invoice', customer: { kind: 'business', name: 'X' }, lines: LINES, vat: { regime: 'domestic', confirmed: false } }, AGENT_ACTOR);
  const r = await svc.readiness(d);
  assert.equal(r.ready, false);
  for (const code of ['CUSTOMER_ADDRESS_STREET_MISSING', 'CUSTOMER_COMPANY_NUMBER_MISSING', 'VAT_TREATMENT_NOT_CONFIRMED_BY_MERCHANT', 'REVENUE_BASIS_NOT_DECLARED']) assert.ok(r.errors.includes(code), code);
  await assert.rejects(svc.submit(d.id, AGENT_ACTOR), (e) => e.code === 'NOT_READY_FOR_APPROVAL');
});

test('approval: the agent prepares, only a merchant approves; MODIFY and REJECT work; drafts consume no number', async () => {
  const { svc, store } = makeService();
  const d = await svc.create(draftInvoice(), AGENT_ACTOR);
  await svc.submit(d.id, AGENT_ACTOR);
  await assert.rejects(svc.decide(d.id, 'APPROVE', AGENT_ACTOR), (e) => e.code === 'APPROVAL_REQUIRES_A_MERCHANT_ACTOR');
  const back = await svc.decide(d.id, 'MODIFY', MERCHANT_ACTOR, 'change the notes');
  assert.equal(back.status, 'DRAFT');
  await svc.submit(d.id, AGENT_ACTOR);
  const rej = await svc.decide(d.id, 'REJECT', MERCHANT_ACTOR);
  assert.equal(rej.status, 'CANCELLED');
  assert.equal(rej.number, null);
  const issued = await issueInvoice(svc);
  assert.equal(issued.number, 'INV-2026-0001'); // the rejected draft did not consume a number
  assert.equal(issued.status, 'ISSUED');
  assert.ok(issued.lockedAt && issued.snapshotHash);
  assert.equal(store._debug.docs.size, 2);
});

test('issued documents are immutable: code, frozen object, and store all refuse changes', async () => {
  const { svc, store } = makeService();
  const inv = await issueInvoice(svc);
  assert.throws(() => updateDraft(inv, { notes: 'sneaky' }), (e) => e.code === 'DOCUMENT_LOCKED');
  assert.throws(() => { inv.totals.grossCents = 1; }, TypeError); // deep-frozen
  const tampered = { ...structuredClone(inv), totals: { ...inv.totals, grossCents: 1 } };
  await assert.rejects(store.saveDocument(tampered, inv.version), (e) => e.code === 'LOCKED_DOCUMENT_CANNOT_CHANGE');
  await assert.rejects(store.deleteDocument(inv.id), (e) => e.code === 'ISSUED_DOCUMENTS_CANNOT_BE_DELETED');
  await assert.rejects(svc.cancelDraft(inv.id, MERCHANT_ACTOR), (e) => e.code === 'INVALID_TRANSITION');
  assert.equal(verifyIntegrity(await svc.get(inv.id)).ok, true);
  const forged = { ...structuredClone(inv), customer: { ...inv.customer, name: 'Someone Else' } };
  assert.equal(verifyIntegrity(forged).ok, false); // the snapshot hash exposes any tampering
});

test('audit trail: every step is recorded with actor, transition and time, append-only', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc);
  await svc.markSent(inv.id, MERCHANT_ACTOR, 'email');
  const ev = await svc.events(inv.id);
  assert.deepEqual(ev.map((e) => e.action), ['CREATE_DRAFT', 'SUBMIT_FOR_APPROVAL', 'APPROVE_AND_ISSUE', 'MARK_SENT']);
  assert.ok(ev.every((e) => e.actor && e.at));
  assert.equal(ev[2].detail.number, 'INV-2026-0001');
});

test('numbering across types and years is independent and gapless', async () => {
  const { svc } = makeService();
  const a = await issueInvoice(svc);
  const b = await issueInvoice(svc);
  const c = await issueInvoice(svc, { issueDate: '2027-01-02' });
  assert.deepEqual([a.number, b.number, c.number], ['INV-2026-0001', 'INV-2026-0002', 'INV-2027-0001']);
});
