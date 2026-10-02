// Finance business dates are the merchant's CIVIL dates (MERCHANT_TIMEZONE, here Europe/Brussels), never the UTC day of an instant.
// One primitive (src/finance/civil-date.js) feeds every page; this file proves it at the winter/summer/DST/midnight boundaries, proves the
// pages agree with each other, mirrors the browser helper, and forbids a new rule from converting an instant to a date by truncation.
// Synthetic data only; no clock, network or database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { civilDateIn, createMerchantClock, requireClock } from '../src/finance/civil-date.js';
import { civilDateIn as civilDateInViaPayables, calendarOf, daysRemaining } from '../src/finance/payables/index.js';
import { createFinanceService } from '../src/finance/service.js';
import { createBankService } from '../src/finance/bank-service.js';
import { buildContacts } from '../src/finance/contacts.js';
import { refundRows } from '../src/finance/refund-rows.js';
import { createRetailAccess } from '../src/finance/retail-access.js';
import { startApp, baseSettings, invoiceBody } from './finance-dashboard-helpers.js';

const BRU = 'Europe/Brussels';
const ROOT = fileURLToPath(new URL('../src/finance/', import.meta.url));

// ---------- the primitive ----------
test('winter (CET, UTC+1): 23:59 local is still the day, 00:01 local is the next day while UTC is still the previous one', () => {
  assert.equal(civilDateIn('2026-01-15T22:59:00Z', BRU), '2026-01-15'); // 23:59 local
  assert.equal(civilDateIn('2026-01-15T23:01:00Z', BRU), '2026-01-16'); // 00:01 local, UTC day is still the 15th
  assert.equal(civilDateIn('2026-01-15T23:00:00Z', BRU), '2026-01-16'); // exactly local midnight
  assert.equal(civilDateIn('2026-01-15T22:59:59.999Z', BRU), '2026-01-15');
  assert.equal('2026-01-15T23:01:00Z'.slice(0, 10), '2026-01-15', 'sanity: the UTC day is the earlier one');
});

test('summer (CEST, UTC+2): 23:59 local is still the day, 00:01 local is the next day while UTC is still the previous one', () => {
  assert.equal(civilDateIn('2026-07-15T21:59:00Z', BRU), '2026-07-15'); // 23:59 local
  assert.equal(civilDateIn('2026-07-15T22:01:00Z', BRU), '2026-07-16'); // 00:01 local
  assert.equal(civilDateIn('2026-07-15T22:00:00Z', BRU), '2026-07-16');
  assert.equal(civilDateIn('2026-07-15T21:59:59.999Z', BRU), '2026-07-15');
});

test('DST: the local day changes exactly at local midnight on the 23-hour (29/03) and the 25-hour (25/10) days', () => {
  // spring forward 2026-03-29 (02:00 CET -> 03:00 CEST at 01:00Z): 28/03 ends at 23:00Z, 29/03 ends at 22:00Z
  assert.equal(civilDateIn('2026-03-28T22:59:00Z', BRU), '2026-03-28');
  assert.equal(civilDateIn('2026-03-28T23:00:00Z', BRU), '2026-03-29');
  assert.equal(civilDateIn('2026-03-29T00:30:00Z', BRU), '2026-03-29'); // 01:30 CET, before the jump
  assert.equal(civilDateIn('2026-03-29T01:30:00Z', BRU), '2026-03-29'); // 03:30 CEST, after the jump
  assert.equal(civilDateIn('2026-03-29T21:59:00Z', BRU), '2026-03-29');
  assert.equal(civilDateIn('2026-03-29T22:00:00Z', BRU), '2026-03-30');
  // fall back 2026-10-25 (03:00 CEST -> 02:00 CET at 01:00Z): 24/10 ends at 22:00Z, 25/10 ends at 23:00Z (a 25-hour day)
  assert.equal(civilDateIn('2026-10-24T21:59:00Z', BRU), '2026-10-24');
  assert.equal(civilDateIn('2026-10-24T22:00:00Z', BRU), '2026-10-25');
  assert.equal(civilDateIn('2026-10-25T00:30:00Z', BRU), '2026-10-25'); // 02:30 CEST (first pass)
  assert.equal(civilDateIn('2026-10-25T01:30:00Z', BRU), '2026-10-25'); // 02:30 CET (second pass)
  assert.equal(civilDateIn('2026-10-25T22:59:00Z', BRU), '2026-10-25');
  assert.equal(civilDateIn('2026-10-25T23:00:00Z', BRU), '2026-10-26');
});

test('hour by hour across both DST changes the civil date never goes backwards and changes only at local midnight', () => {
  for (const [from, to] of [['2026-03-27T00:00:00Z', '2026-03-31T00:00:00Z'], ['2026-10-23T00:00:00Z', '2026-10-27T00:00:00Z']]) {
    let prev = null; let changes = 0;
    for (let t = Date.parse(from); t <= Date.parse(to); t += 3600_000) {
      const d = civilDateIn(new Date(t), BRU);
      const hourLocal = Number(new Intl.DateTimeFormat('en-GB', { timeZone: BRU, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)));
      if (prev !== null) { assert.ok(d >= prev, `${d} < ${prev} at ${new Date(t).toISOString()}`); if (d !== prev) { changes += 1; assert.equal(hourLocal, 0, `date changed at local hour ${hourLocal}`); } }
      prev = d;
    }
    assert.equal(changes, 4, 'four days crossed, four changes');
  }
});

test('the primitive refuses an invalid instant or a missing zone, and payables re-exports the SAME function', () => {
  assert.throws(() => civilDateIn('not a date', BRU), RangeError);
  assert.throws(() => civilDateIn('2026-01-01T00:00:00Z', ''), TypeError);
  assert.throws(() => civilDateIn('2026-01-01T00:00:00Z'), TypeError);
  assert.equal(civilDateInViaPayables, civilDateIn);
});

test('the merchant clock derives today from the same now, in the merchant zone; there is no silent UTC default', () => {
  const clock = createMerchantClock({ now: () => '2026-09-26T22:30:00.000Z', timeZone: BRU });
  assert.equal(clock.now(), '2026-09-26T22:30:00.000Z');
  assert.equal(clock.today(), '2026-09-27', '00:30 on the 27th in Brussels, although the UTC day is the 26th');
  assert.throws(() => createMerchantClock({ now: () => '2026-09-26T22:30:00.000Z' }), TypeError);
  assert.throws(() => requireClock(undefined, 'x'), TypeError);
  assert.throws(() => requireClock({ now: () => 'x' }, 'x'), TypeError);
  assert.throws(() => createFinanceService({ store: {}, config: { vat: { allowedRatesBp: [] } } }), /clock/);
  assert.throws(() => createBankService({ store: {}, merchantId: 'm', finance: {}, inbox: {} }), /clock/);
});

// ---------- due today / yesterday / tomorrow ----------
test('due today / yesterday / tomorrow at 23:59 and 00:01 local, winter and summer: the merchant day decides', () => {
  const cases = [
    // [instant, due, expected days remaining, expected calendar state]
    ['2026-01-15T22:59:00Z', '2026-01-15', 0, 'DUE_TODAY'], // 23:59 local winter: due today
    ['2026-01-15T22:59:00Z', '2026-01-14', -1, 'OVERDUE'],
    ['2026-01-15T22:59:00Z', '2026-01-16', 1, 'NOT_DUE'],
    ['2026-01-15T23:01:00Z', '2026-01-15', -1, 'OVERDUE'], // 00:01 local winter: the 15th is already yesterday
    ['2026-01-15T23:01:00Z', '2026-01-16', 0, 'DUE_TODAY'],
    ['2026-01-15T23:01:00Z', '2026-01-17', 1, 'NOT_DUE'],
    ['2026-07-15T21:59:00Z', '2026-07-15', 0, 'DUE_TODAY'], // 23:59 local summer
    ['2026-07-15T22:01:00Z', '2026-07-15', -1, 'OVERDUE'], // 00:01 local summer
    ['2026-07-15T22:01:00Z', '2026-07-16', 0, 'DUE_TODAY'],
    ['2026-07-15T22:01:00Z', '2026-07-17', 1, 'NOT_DUE'],
  ];
  for (const [instant, due, days, state] of cases) {
    const today = createMerchantClock({ now: () => instant, timeZone: BRU }).today();
    assert.equal(daysRemaining(due, today), days, `${instant} due ${due}`);
    assert.equal(calendarOf({ dueDate: due, settlement: 'UNPAID', today }).state, state, `${instant} due ${due}`);
  }
});

// ---------- the same merchant day on every page ----------
const NOW_0030 = '2026-09-26T22:30:00.000Z'; // 00:30 on 27/09 in Brussels; the UTC day is still 26/09
const issue = async (c, over) => {
  const d = (await c.post('/api/documents', invoiceBody(over))).data;
  assert.equal((await c.post(`/api/documents/${d.id}/submit`, {})).status, 200);
  const r = await c.post(`/api/documents/${d.id}/approve`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.doc ?? r.data;
};

test('Overview, documents, receivables, payables (inbox), contacts and the accountant pack all use the merchant day (27/09), not the UTC day (26/09)', async () => {
  const a = await startApp({ timeZone: BRU, today: '2026-09-20' });
  try {
    const c = await a.authed();
    // issued while "today" is 20/09, so the due dates below are in the future at issuance
    const yesterday = await issue(c, { issueDate: '2026-09-10', dueDate: '2026-09-26' }); // due 26/09: merchant says yesterday, UTC says today
    const today = await issue(c, { issueDate: '2026-09-11', dueDate: '2026-09-27' }); // due 27/09: due today for the merchant
    const tomorrow = await issue(c, { issueDate: '2026-09-12', dueDate: '2026-09-28' });
    for (const [n, due] of [[1, '2026-09-26'], [2, '2026-09-27'], [3, '2026-09-28']]) {
      assert.ok([200, 201].includes((await c.post('/api/inbox/manual', { supplierName: `Fournisseur ${n} SRL`, invoiceNumber: `P-${n}`, issueDate: '2026-09-10', dueDate: due, net: '100.00', vat: '21.00', gross: '121.00', currency: 'EUR' })).status));
    }
    a.setNow(NOW_0030);

    // documents (per-document derived status)
    const status = async (d) => (await c.get(`/api/documents/${d.id}`)).data.effectiveStatus;
    assert.equal(await status(yesterday), 'OVERDUE');
    assert.notEqual(await status(today), 'OVERDUE');
    assert.notEqual(await status(tomorrow), 'OVERDUE');

    // receivables and Overview agree: exactly one overdue invoice
    const rec = (await c.get('/api/receivables')).data;
    assert.equal(rec.overdue.count, 1);
    const ov = (await c.get('/api/overview')).data;
    assert.equal(ov.counts.overdue, 1);
    assert.equal(ov.attention.overdue[0].number, yesterday.number);

    // payables (inbox list): days remaining -1 / 0 / 1 relative to 27/09
    const rows = (await c.get('/api/inbox')).data.rows.sort((x, y) => x.dueDate.localeCompare(y.dueDate));
    assert.deepEqual(rows.map((r) => [r.dueDate, r.due.daysRemaining]), [['2026-09-26', -1], ['2026-09-27', 0], ['2026-09-28', 1]]);

    // accountant pack: the period closed on 26/09 IS closed on 27/09 (with UTC "today" = 26/09 it would still be "not closed")
    const pack = (await c.post('/api/pack', { from: '2026-09-01', to: '2026-09-26' })).data.pack;
    assert.ok(!pack.completeness.reasons.includes('PERIOD_NOT_CLOSED'), `reasons: ${pack.completeness.reasons}`);
    const open = (await c.post('/api/pack', { from: '2026-09-01', to: '2026-09-27' })).data.pack;
    assert.ok(open.completeness.reasons.includes('PERIOD_NOT_CLOSED'), 'the 27th is today for the merchant: not closed yet');

    // the session settings tell the browser which zone to use
    assert.equal((await c.get('/api/settings')).data.timeZone, BRU);
  } finally { await a.close(); }
});

test('contacts: the overdue count uses the same merchant day as receivables', async () => {
  const m = (c) => `${(c / 100).toFixed(2)}`;
  const company = { id: 'c1', merchantId: 'm', name: 'Client SA', roles: { customer: true }, kind: 'business' };
  const doc = { id: 'd1', type: 'invoice', status: 'ISSUED', number: 'INV-1', issueDate: '2026-09-10', dueDate: '2026-09-26', lockedAt: '2026-09-10T08:00:00Z', currency: 'EUR', customer: { companyId: 'c1' }, totals: { grossCents: 12100 } };
  const todayMerchant = createMerchantClock({ now: () => NOW_0030, timeZone: BRU }).today();
  const [asMerchant] = buildContacts({ companies: [company], salesDocs: [{ doc, payments: [], creditNotes: [] }], supplierInvoices: [], m, today: todayMerchant, timeZone: BRU });
  const [asUtc] = buildContacts({ companies: [company], salesDocs: [{ doc, payments: [], creditNotes: [] }], supplierInvoices: [], m, today: '2026-09-26', timeZone: BRU });
  assert.equal(todayMerchant, '2026-09-27');
  assert.equal(asMerchant.overdueCount, 1, 'due 26/09 is overdue on the merchant day 27/09');
  assert.equal(asUtc.overdueCount, 0, 'the UTC day would have hidden it for the first hours of the day (the bug this fixes)');
});

// ---------- instants converted to a date are dated in the merchant day ----------
test('a supplier invoice received at 00:30 Brussels is that merchant day\'s activity for the contact, not the previous UTC day', () => {
  const company = { id: 's1', merchantId: 'm', name: 'Fournisseur SA', roles: { supplier: true }, kind: 'business' };
  const inv = { id: 'i1', supplierCompanyId: 's1', status: 'TO_REVIEW', grossCents: 100, receivedAt: '2026-07-14T22:30:00.000Z', issueDate: null };
  const [row] = buildContacts({ companies: [company], salesDocs: [], supplierInvoices: [inv], m: (c) => String(c), today: '2026-07-15', timeZone: BRU });
  assert.equal(row.lastActivityAt ?? row.lastActivity, '2026-07-15');
  assert.throws(() => buildContacts({ companies: [company], salesDocs: [], supplierInvoices: [inv], m: (c) => String(c) }), /time zone/);
});

test('a refund at 00:30 local belongs to the merchant day in the refund file and in the period filter', () => {
  const data = { orders: [{ id: 'o1', order_name: '#1001', taxes_included: true }], refunds: [{ id: 'r1', order_id: 'o1', refunded_at: '2026-07-14T22:30:00.000Z', amount: 10, shipping_subtotal: null }, { id: 'r2', order_id: 'o1', refunded_at: null, amount: 5 }], refundLines: [] };
  const inJuly15 = (d) => d >= '2026-07-15' && d <= '2026-07-15';
  const rows = refundRows(data, inJuly15, BRU);
  assert.deepEqual(rows.map((r) => r.date), ['2026-07-15'], 'dated 15/07 in Brussels (14/07 in UTC); a refund without a date is never invented');
  assert.equal(refundRows(data, inJuly15, 'UTC').length, 0, 'sanity: in UTC it is the 14th');
  assert.throws(() => refundRows(data, () => true), /time zone/);
});

test('order search dates an order by the merchant day and filters on it', async () => {
  const ledger = { orders: [{ id: 'o1', orderedAt: new Date('2026-07-14T22:30:00.000Z') }], lineFacts: [], refundFacts: [], excluded: {} }; // 00:30 on 15/07 in Brussels
  const data = { orders: [{ id: 'o1', channel_handle: 'web' }] };
  const access = (timeZone) => createRetailAccess({ loadRetail: async () => ({ data, ledger }), timeZone, ttlMs: 0 });
  assert.deepEqual((await access(BRU).searchOrders({})).map((r) => r.date), ['2026-07-15']);
  assert.deepEqual((await access('UTC').searchOrders({})).map((r) => r.date), ['2026-07-14'], 'sanity: the UTC day is the 14th');
  assert.equal((await access(BRU).searchOrders({ from: '2026-07-15', to: '2026-07-15' })).length, 1, 'found when filtering on the merchant day');
  assert.equal((await access(BRU).searchOrders({ from: '2026-07-14', to: '2026-07-14' })).length, 0);
  await assert.rejects(createRetailAccess({ loadRetail: async () => ({ data, ledger }) }).searchOrders({}), /time zone/);
});

// ---------- the browser helper mirrors the server primitive ----------
test('ui/civil-date.js gives the same date as the server primitive (winter, summer, DST, midnight windows, other zones)', () => {
  const ui = new Function(`${readFileSync(path.join(ROOT, 'ui/civil-date.js'), 'utf8')}\nreturn { civilDateIn, civilToday };`)();
  let n = 0;
  for (const zone of [BRU, 'UTC', 'America/New_York', 'Asia/Tokyo']) {
    for (const [from, to] of [['2026-01-14T20:00:00Z', '2026-01-16T04:00:00Z'], ['2026-03-28T20:00:00Z', '2026-03-30T04:00:00Z'], ['2026-07-14T20:00:00Z', '2026-07-16T04:00:00Z'], ['2026-10-24T20:00:00Z', '2026-10-26T04:00:00Z']]) {
      for (let t = Date.parse(from); t <= Date.parse(to); t += 15 * 60_000) { assert.equal(ui.civilDateIn(new Date(t), zone), civilDateIn(new Date(t), zone), `${zone} ${new Date(t).toISOString()}`); n += 1; }
    }
  }
  assert.ok(n > 1000);
  assert.match(ui.civilToday(BRU), /^\d{4}-\d{2}-\d{2}$/);
  assert.throws(() => ui.civilDateIn('2026-01-01T00:00:00Z'), TypeError);
  const html = readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8');
  assert.ok(html.indexOf('/civil-date.js') > 0 && html.indexOf('/civil-date.js') < html.indexOf('/app.js'), 'loaded before the views that use it');
});

// ---------- regression guard: no instant -> date by truncation, no UTC default clock ----------
const sources = () => {
  const out = [];
  const walk = (dir) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.js$/.test(f) && !/lang-(fr|nl)\.js$/.test(f)) out.push(p); } };
  walk(ROOT);
  return out.map((p) => ({ file: path.relative(ROOT, p).replaceAll('\\', '/'), lines: readFileSync(p, 'utf8').split(/\r?\n/) }));
};
const stripComment = (l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, '');

test('GUARD: ISO truncation to YYYY-MM-DD / YYYY-MM is only ever calendar arithmetic on a date built from civil components', () => {
  // Allowed: the Date being truncated was built from a civil date string ("...T00:00:00Z") or Date.UTC(y, m, d) - a calendar container, not an instant.
  // Anything else (a timestamp, new Date(), Date.now(), *_at / At / .at fields) must go through civilDateIn(instant, timeZone).
  const CONTAINER = /Date\.UTC\(|T00:00:00Z|T00:00:00\.000Z/;
  const EXPLICIT = [
    ['document.js', 'return d.toISOString().slice(0, 10);'], // addDays: d = `${dateStr}T00:00:00Z` shifted by whole days
    ['ui/views-workspace.js', 'const iso = (d) => d.toISOString().slice(0, 10);'], // period presets: d comes from Date.UTC(y, m, 1|0)
  ];
  const offenders = [];
  for (const { file, lines } of sources()) {
    lines.forEach((raw, i) => {
      const l = stripComment(raw);
      if (!/toISOString\(\)\.(slice|substring)\(0, ?(10|7)\)/.test(l)) return;
      if (CONTAINER.test(l)) return;
      if (EXPLICIT.some(([f, frag]) => file === f && l.includes(frag))) return;
      offenders.push(`${file}:${i + 1}: ${l.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(offenders, [], `convert instants with civilDateIn(instant, timeZone) (src/finance/civil-date.js):\n${offenders.join('\n')}`);
});

test('GUARD: no truncation of a timestamp field to a date, no default clock on the UTC day, no browser-local calendar for business dates', () => {
  const rules = [
    [/(_at|At|\.at)\b[^;]{0,60}\.slice\(0, ?(10|7)\)/, 'a timestamp field truncated to a date'],
    [/\.slice\(0, ?10\)[^;]{0,3}$/m, null], // placeholder to keep the list readable; never matches a rule below
    [/today\s*[:=]\s*(\(\)\s*=>\s*)?new Date\(/, 'a default "today" built from new Date()'],
    [/\?\?\s*\(\(\)\s*=>\s*new Date\(\)\.toISOString\(\)\.slice/, 'a "?? today" default on the UTC day'],
    [/new Date\(\)\.(getFullYear|getMonth|getDate|getDay)\(\)/, 'the browser/server local calendar used as a business date'],
  ].filter(([, why]) => why);
  const ALLOWED = [
    ['ui/app.js', 'HOME_QUOTES[new Date().getDate()'], // cosmetic "quote of the day", not a business date
  ];
  const offenders = [];
  for (const { file, lines } of sources()) {
    lines.forEach((raw, i) => {
      const l = stripComment(raw);
      for (const [re, why] of rules) {
        if (re.test(l) && !ALLOWED.some(([f, frag]) => file === f && l.includes(frag))) offenders.push(`${file}:${i + 1} (${why}): ${l.trim().slice(0, 130)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('GUARD: the only place that builds "today" from an instant and a zone is civil-date.js (and its browser mirror)', () => {
  const offenders = [];
  for (const { file, lines } of sources()) {
    if (file === 'civil-date.js' || file === 'ui/civil-date.js' || file === 'payables/due.js' || file === 'payables/index.js') continue;
    lines.forEach((raw, i) => { if (/new Intl\.DateTimeFormat\('en-CA'|localDateString\(/.test(stripComment(raw))) offenders.push(`${file}:${i + 1}: ${raw.trim().slice(0, 120)}`); });
  }
  // accountant-pack.js legitimately keeps localDateString for "first order's local date" (metrics windows) - same underlying function as civilDateIn
  const allowed = offenders.filter((o) => !o.startsWith('accountant-pack.js:'));
  assert.deepEqual(allowed, [], allowed.join('\n'));
});
