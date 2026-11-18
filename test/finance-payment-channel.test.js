import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInStorePayment, imputedFees, dedupeOrders, normalizeGatewayLabel } from '../src/finance/payment-channel.js';
import { cleanPaymentInput } from '../src/finance/input.js';

// Historical HABB POS sales (labels as Shopify returned them, 2026-11-17 read).
const HISTORICAL_QR_NOTED_SUMUP = { id: 'gid://shopify/Order/1125', gatewayLabel: 'sumup', amount: '29.90' }; // #1125, 2026-11-05
const REAL_SUMUP = { id: 'gid://shopify/Order/1123', gatewayLabel: 'sumup', amount: '109.70' }; // #1123, 2026-11-05 (fixture: justificatif to be added by the owner)

test('QR KBC historically noted SumUp: keeps the original label, counted once when confirmed by KBC evidence', () => {
  const r = resolveInStorePayment({
    gatewayLabel: HISTORICAL_QR_NOTED_SUMUP.gatewayLabel,
    confirmation: { method: 'qr_kbc', evidence: 'KBC_STATEMENT', reference: 'KBC-2026-11-05-29.90' },
  });
  assert.equal(r.gateway_label, 'sumup', 'original Shopify label is preserved');
  assert.equal(r.method, 'qr_kbc');
  assert.equal(r.status, 'CONFIRMED');
  assert.equal(r.evidence, 'KBC_STATEMENT');
});

test('real SumUp sale: confirmed as sumup only with a SumUp receipt', () => {
  const r = resolveInStorePayment({
    gatewayLabel: REAL_SUMUP.gatewayLabel,
    confirmation: { method: 'sumup', evidence: 'SUMUP_RECEIPT', reference: 'SUMUP-TX-000123' },
  });
  assert.equal(r.method, 'sumup');
  assert.equal(r.status, 'CONFIRMED');
});

test('a SumUp label without justificatif is ambiguous, never confirmed as either method', () => {
  const r = resolveInStorePayment({ gatewayLabel: 'sumup' });
  assert.equal(r.status, 'AMBIGUOUS');
  assert.equal(r.reason, 'SUMUP_LABEL_WITHOUT_JUSTIFICATIF');
  assert.equal(r.method, 'sumup');
});

test('a justificatif that does not match the claimed method is rejected', () => {
  const r = resolveInStorePayment({
    gatewayLabel: 'sumup',
    confirmation: { method: 'qr_kbc', evidence: 'SUMUP_RECEIPT', reference: 'X' },
  });
  assert.equal(r.status, 'REJECTED');
  assert.equal(r.reason, 'EVIDENCE_DOES_NOT_MATCH_METHOD');
});

test('a confirmation without reference is rejected', () => {
  const r = resolveInStorePayment({ gatewayLabel: 'sumup', confirmation: { method: 'qr_kbc', evidence: 'KBC_STATEMENT', reference: '' } });
  assert.equal(r.status, 'REJECTED');
});

test('unknown or missing Shopify label stays ambiguous (no invented method)', () => {
  assert.equal(resolveInStorePayment({ gatewayLabel: 'qr kbc' }).status, 'AMBIGUOUS');
  assert.equal(resolveInStorePayment({ gatewayLabel: 'qr kbc' }).method, null);
  assert.equal(resolveInStorePayment({ gatewayLabel: null }).reason, 'NO_GATEWAY_LABEL');
});

test('cash label is confirmed by Shopify', () => {
  assert.equal(resolveInStorePayment({ gatewayLabel: 'cash' }).method, 'cash');
});

test('label normalisation is case and whitespace tolerant', () => {
  assert.equal(normalizeGatewayLabel('  SumUp '), 'sumup');
  assert.equal(normalizeGatewayLabel('   '), null);
});

test('same Shopify order received twice is counted once', () => {
  const { orders, duplicates } = dedupeOrders([
    HISTORICAL_QR_NOTED_SUMUP,
    REAL_SUMUP,
    { ...HISTORICAL_QR_NOTED_SUMUP },
  ]);
  assert.equal(orders.length, 2);
  assert.deepEqual(duplicates, [HISTORICAL_QR_NOTED_SUMUP.id]);
  const total = orders.reduce((a, o) => a + Math.round(Number(o.amount) * 100), 0);
  assert.equal(total, 2990 + 10970);
});

test('fees: only what Shopify reported is imputed; QR/SumUp without a reported fee gets zero, not an estimate', () => {
  assert.deepEqual(imputedFees({ reportedFees: undefined }), { fee_cents: 0, fee_status: 'NOT_VISIBLE' });
  assert.deepEqual(imputedFees({ reportedFees: null }), { fee_cents: 0, fee_status: 'NOT_VISIBLE' });
  assert.deepEqual(imputedFees({ reportedFees: 1.25 }), { fee_cents: 125, fee_status: 'REPORTED' });
  assert.throws(() => imputedFees({ reportedFees: -1 }));
});

test('manual payment entry accepts qr_kbc as a distinct method', () => {
  const ok = cleanPaymentInput({ amount: '29.90', paidOn: '2026-11-05', method: 'qr_kbc' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.payment.method, 'qr_kbc');
  const bad = cleanPaymentInput({ amount: '29.90', paidOn: '2026-11-05', method: 'qr kbc' });
  assert.equal(bad.errors[0].code, 'METHOD_INVALID');
});
