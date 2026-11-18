import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEpcPayload, epcQrPng } from '../src/finance/epc-qr.js';

// Synthetic IBAN (valid checksum, documentation example).
const BASE = { name: 'Example Seller SRL', iban: 'BE68 5390 0754 7034', bic: 'kredbebb', amountCents: 47290, communication: '+++002/0260/00196+++' };

test('EPC payload: fixed lines, amount with two decimals, structured communication in the unstructured remittance line', () => {
  const { payload, errors } = buildEpcPayload(BASE);
  assert.deepEqual(errors, []);
  const lines = payload.split('\n');
  assert.equal(lines.length, 12);
  assert.deepEqual(lines.slice(0, 5), ['BCD', '002', '1', 'SCT', 'KREDBEBB']);
  assert.equal(lines[5], 'Example Seller SRL');
  assert.equal(lines[6], 'BE68539007547034');
  assert.equal(lines[7], 'EUR472.90');
  assert.equal(lines[9], '', 'no structured RF reference');
  assert.equal(lines[10], '+++002/0260/00196+++');
});

test('EPC payload: refuses a non-Belgian IBAN, a zero amount, a missing name, an amount above the limit', () => {
  assert.deepEqual(buildEpcPayload({ ...BASE, iban: 'FR1420041010050500013M02606' }).errors, ['IBAN_NOT_BELGIAN_FORMAT']);
  assert.deepEqual(buildEpcPayload({ ...BASE, amountCents: 0 }).errors, ['AMOUNT_MUST_BE_POSITIVE']);
  assert.deepEqual(buildEpcPayload({ ...BASE, name: '  ' }).errors, ['BENEFICIARY_NAME_MISSING']);
  assert.deepEqual(buildEpcPayload({ ...BASE, amountCents: 100000000000 }).errors, ['AMOUNT_TOO_LARGE']);
});

test('EPC payload: a long beneficiary name is cut to 70 characters and the communication to 140', () => {
  const { payload } = buildEpcPayload({ ...BASE, name: 'N'.repeat(90), communication: 'C'.repeat(200) });
  const lines = payload.split('\n');
  assert.equal(lines[5].length, 70);
  assert.equal(lines[10].length, 140);
});

test('QR image is generated as PNG', async () => {
  const { payload } = buildEpcPayload(BASE);
  const png = await epcQrPng(payload);
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
});
