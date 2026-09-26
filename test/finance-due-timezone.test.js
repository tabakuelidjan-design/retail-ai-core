// Phase 4.7 (correction): the merchant's CIVIL date decides days remaining / due today / overdue / not due. The time zone is a parameter (the merchant's setting);
// nothing depends on the machine or server zone; once the local date is resolved, every calculation is pure. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarOf, civilDateIn, dueViewOf } from '../src/finance/payables/index.js';
import { COMM, OWN, SUPPLIER_IBAN, makePdf, spaced } from './finance-pdf-fixtures.js';
import { startApp } from './finance-dashboard-helpers.js';

const BXL = 'Europe/Brussels';

test('civilDateIn: 23:30 UTC is already the next day in Brussels (winter and summer), not in UTC or New York', () => {
  assert.equal(civilDateIn('2026-10-29T23:30:00Z', BXL), '2026-10-30', 'CET (UTC+1)');
  assert.equal(civilDateIn('2026-07-14T22:30:00Z', BXL), '2026-07-15', 'CEST (UTC+2)');
  assert.equal(civilDateIn('2026-10-29T23:30:00Z', 'UTC'), '2026-10-29');
  assert.equal(civilDateIn('2026-10-29T23:30:00Z', 'America/New_York'), '2026-10-29');
  assert.equal(civilDateIn(new Date('2026-10-29T23:30:00Z'), BXL), '2026-10-30', 'a Date works as well as a string');
  assert.throws(() => civilDateIn('not a date', BXL), RangeError);
});

test('civilDateIn: exactly around local midnight, to the second', () => {
  assert.equal(civilDateIn('2026-09-26T21:59:59Z', BXL), '2026-09-26', '23:59:59 local (UTC+2)');
  assert.equal(civilDateIn('2026-09-26T22:00:00Z', BXL), '2026-09-27', '00:00:00 local');
  assert.equal(civilDateIn('2026-12-15T22:59:59Z', BXL), '2026-12-15', '23:59:59 local (UTC+1)');
  assert.equal(civilDateIn('2026-12-15T23:00:00Z', BXL), '2026-12-16', '00:00:00 local');
});

test('civilDateIn: the daylight-saving changes do not shift the civil date (spring forward 2026-03-29, fall back 2026-10-25)', () => {
  assert.equal(civilDateIn('2026-03-28T22:59:59Z', BXL), '2026-03-28'); assert.equal(civilDateIn('2026-03-28T23:00:00Z', BXL), '2026-03-29', '00:00 local, still UTC+1');
  assert.equal(civilDateIn('2026-03-29T21:59:59Z', BXL), '2026-03-29', '23:59:59 local, now UTC+2'); assert.equal(civilDateIn('2026-03-29T22:00:00Z', BXL), '2026-03-30');
  assert.equal(civilDateIn('2026-10-24T21:59:59Z', BXL), '2026-10-24'); assert.equal(civilDateIn('2026-10-24T22:00:00Z', BXL), '2026-10-25', '00:00 local, still UTC+2');
  assert.equal(civilDateIn('2026-10-25T22:59:59Z', BXL), '2026-10-25', '23:59:59 local, now UTC+1'); assert.equal(civilDateIn('2026-10-25T23:00:00Z', BXL), '2026-10-26');
  const days = []; for (let h = 0; h < 30; h += 1) days.push(civilDateIn(new Date(Date.parse('2026-10-24T20:00:00Z') + h * 3600_000), BXL));
  assert.deepEqual([...new Set(days)], ['2026-10-24', '2026-10-25', '2026-10-26'], 'the 25-hour local day 2026-10-25 is one civil date');
});

test('the same instant gives different civil dates in different zones, and the result does not depend on the machine zone', () => {
  const at = '2026-10-29T23:30:00Z';
  assert.deepEqual(['Pacific/Kiritimati', 'Asia/Tokyo', BXL, 'UTC', 'America/New_York', 'Pacific/Pago_Pago'].map((z) => civilDateIn(at, z)), ['2026-10-30', '2026-10-30', '2026-10-30', '2026-10-29', '2026-10-29', '2026-10-29']);
  const saved = process.env.TZ;
  try { for (const machine of ['Pacific/Kiritimati', 'America/Los_Angeles', 'UTC', 'Asia/Kolkata']) { process.env.TZ = machine; assert.equal(civilDateIn(at, BXL), '2026-10-30', `machine zone ${machine}`); assert.equal(civilDateIn(at, 'UTC'), '2026-10-29'); } }
  finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
});

test('the calculations are stable and pure once the civil date is explicit: same row + same date = same answer, whatever the zone that produced the date', () => {
  const row = { status: 'VALIDATED', documentType: 'INVOICE', grossCents: 12100, dueDate: '2026-10-30', extraction: { provenance: { dueDate: { source: 'PDF_TEXT' } } } };
  const at = (today) => dueViewOf(row, { today });
  assert.deepEqual([at('2026-10-29').calendar, at('2026-10-29').daysRemaining, at('2026-10-29').message.kind], ['NOT_DUE', 1, 'DUE_SOON']);
  assert.deepEqual([at('2026-10-30').calendar, at('2026-10-30').daysRemaining, at('2026-10-30').message.kind], ['DUE_TODAY', 0, 'DUE_TODAY']);
  assert.deepEqual([at('2026-10-31').calendar, at('2026-10-31').daysRemaining], ['OVERDUE', -1]);
  assert.deepEqual(at('2026-10-30'), at('2026-10-30'));
  const viaBrussels = civilDateIn('2026-10-29T23:30:00Z', BXL); const viaUtc = civilDateIn('2026-10-29T23:30:00Z', 'UTC');
  assert.equal(calendarOf({ dueDate: '2026-10-30', settlement: 'UNPAID', today: viaBrussels }).state, 'DUE_TODAY'); assert.equal(calendarOf({ dueDate: '2026-10-30', settlement: 'UNPAID', today: viaUtc }).state, 'NOT_DUE');
});

// ---------- through the server: the merchant's configured zone drives the reading ----------
const invoicePdf = () => makePdf([[
  [50, 30, 'FACTURE', 18], [50, 80, 'Imprimerie Exemple SRL', 12], [50, 96, "Rue de l'Exemple 12"], [50, 110, '5000 Namur'], [50, 124, 'TVA BE 0000.000.196'],
  [330, 64, 'Client :'], [330, 80, OWN.name, 11], [330, 96, 'Rue Exemple 1'], [330, 110, '1000 Bruxelles'], [330, 124, `TVA ${OWN.vat}`],
  [50, 170, 'Facture n° TZ-1'], [50, 185, 'Date de facture : 30/09/2026'], [50, 222, 'Paiement à 30 jours'],
  [50, 240, 'Description'], [300, 240, 'Qté'], [360, 240, 'Prix unitaire'], [460, 240, 'Total HTVA'], [50, 260, 'Gourde'], [300, 260, '4'], [360, 260, '25,00'], [460, 260, '100,00'],
  [330, 320, 'Total HTVA'], [460, 320, '100,00 €'], [330, 336, 'TVA 21 % sur 100,00 €'], [460, 336, '21,00 €'], [330, 352, 'Total TVAC'], [460, 352, '121,00 €'],
  [50, 400, `À payer sur le compte IBAN ${spaced(SUPPLIER_IBAN)}`], [50, 414, `Communication : ${COMM}`],
]]);

test('server: 23:30 UTC on the eve of the due date is already "due today" for a Brussels merchant, and still "due tomorrow" for a UTC one - same document, same instant', async () => {
  const NOW = '2026-10-29T23:30:00.000Z';   // due date 2026-10-30 (30/09 + 30 days)
  const view = async (timeZone) => {
    const a = await startApp({ timeZone, now: NOW }); const c = await a.authed();
    try { const it = (await c.post('/api/inbox/upload', { fileName: 'f.pdf', dataBase64: (await invoicePdf()).toString('base64') })).data.item; assert.equal(it.dueDate, '2026-10-30'); return (await c.get(`/api/inbox/${it.id}`)).data.due; } finally { await a.close(); }
  };
  const brussels = await view(BXL); assert.deepEqual([brussels.calendar, brussels.daysRemaining, brussels.message.kind], ['DUE_TODAY', 0, 'DUE_TODAY']);
  const utc = await view('UTC'); assert.deepEqual([utc.calendar, utc.daysRemaining, utc.message.kind, utc.message.days], ['NOT_DUE', 1, 'DUE_SOON', 1]);
  const tokyo = await view('Asia/Tokyo'); assert.equal(tokyo.calendar, 'DUE_TODAY');
});

test('server: the treasury reference date is the merchant civil date as well, including on the daylight-saving day', async () => {
  const a = await startApp({ timeZone: BXL, now: '2026-10-29T23:30:00.000Z' }); const c = await a.authed();
  try {
    assert.equal((await c.get('/api/treasury')).data.asOf, '2026-10-30');
    a.setNow('2026-10-29T21:30:00.000Z'); assert.equal((await c.get('/api/treasury')).data.asOf, '2026-10-29', '22:30 local on the 29th');
    a.setNow('2026-10-25T23:00:00.000Z'); assert.equal((await c.get('/api/treasury')).data.asOf, '2026-10-26', 'the day after the 25-hour day');
  } finally { await a.close(); }
});
