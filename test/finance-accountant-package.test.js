import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolvePeriod } from '../src/finance/accountant-package.js';
import { MailError, buildEml, NoMailAdapter } from '../src/finance/mail.js';
import { validateSettings } from '../src/finance/settings.js';
import { unzip } from '../src/finance/xlsx.js';
import { baseSettings, invoiceBody, startApp } from './finance-dashboard-helpers.js';

// Synthetic accountant. The real recipient lives in merchant-local settings, never in the repository.
const ACCOUNTANT = { name: 'Comptable Exemple', email: 'comptable@cabinet.example', preferredFormat: 'zip', software: 'Logiciel Exemple', packageName: 'EXEMPLE' };
const sha = (b) => createHash('sha256').update(b).digest('hex');

function fakeMail() {
  const sent = [];
  return { name: 'fake', label: 'Fake SMTP (test)', canSend: true, sent, async send(m) { sent.push(m); return { status: 'SENT', messageId: `msg-${sent.length}` }; } };
}
async function harness({ accountant = ACCOUNTANT, mail } = {}) {
  const s = baseSettings(); s.accountant = { ...s.accountant, ...accountant };
  const audits = [];
  const a = await startApp({ settings: s, mailAdapter: mail, audit: async (e) => { audits.push(e); } });
  const c = await a.authed();
  const issue = async (over = {}) => { const d = (await c.post('/api/documents', invoiceBody(over))).data; await c.post(`/api/documents/${d.id}/submit`, {}); const r = await c.post(`/api/documents/${d.id}/approve`, {}); assert.equal(r.status, 200, JSON.stringify(r.data)); return d.id; };
  return { a, c, audits, issue, close: () => a.close() };
}
const Q3 = { kind: 'quarter', year: 2026, quarter: 3 };
const withH = (cfg, fn) => async () => { const h = await harness(cfg); try { await fn(h); } finally { await h.close(); } };

test('periods: month, quarter, year and custom resolve to exact dates and labels; anything else is refused', () => {
  assert.deepEqual(resolvePeriod({ kind: 'quarter', year: 2026, quarter: 3 }), { kind: 'quarter', start: '2026-07-01', end: '2026-09-30', label: 'Q3_2026' });
  assert.deepEqual(resolvePeriod({ kind: 'month', year: 2026, month: 2 }), { kind: 'month', start: '2026-02-01', end: '2026-02-28', label: '2026-02' });
  assert.equal(resolvePeriod({ kind: 'month', year: 2028, month: 2 }).end, '2028-02-29');
  assert.deepEqual(resolvePeriod({ kind: 'year', year: 2026 }), { kind: 'year', start: '2026-01-01', end: '2026-12-31', label: '2026' });
  assert.deepEqual(resolvePeriod({ kind: 'custom', from: '2026-07-15', to: '2026-08-10' }), { kind: 'custom', start: '2026-07-15', end: '2026-08-10', label: '2026-07-15_2026-08-10' });
  for (const bad of [{ kind: 'quarter', year: 2026, quarter: 5 }, { kind: 'month', year: 2026, month: 13 }, { kind: 'year', year: 1999 }, { kind: 'custom', from: '2026-09-01', to: '2026-08-01' }, { kind: 'custom', from: 'x', to: 'y' }, { kind: 'decade', year: 2026 }, {}]) assert.throws(() => resolvePeriod(bad), /PERIOD_INVALID/);
});

test('ONE CLICK: the package holds the agreed folder structure, French names, real PDFs, and a manifest whose hashes match every file', withH({}, async (h) => {
  const inv = await h.issue({ lines: [{ description: 'Service', quantity: '2', unitPrice: '50.00', vatRate: '21' }] });
  await h.c.post(`/api/documents/${inv}/credit-note`, { reason: 'Geste commercial', lines: [{ description: 'Service', quantity: '1', unitPrice: '10.00', vatRate: '21' }] }).then(async (r) => { await h.c.post(`/api/documents/${r.data.id}/submit`, {}); await h.c.post(`/api/documents/${r.data.id}/approve`, {}); });
  const p = (await h.c.post('/api/accountant/prepare', Q3)).data;
  assert.equal(p.fileName, 'EXEMPLE_Comptabilite_Q3_2026.zip'); assert.equal(p.period.label, 'Q3_2026');
  const zipBuf = (await h.c.get(p.downloadUrl)).data;
  assert.equal(sha(zipBuf), p.sha256); assert.equal(p.size, zipBuf.length);
  const z = unzip(zipBuf); const root = 'EXEMPLE_Comptabilite_Q3_2026/';
  const names = [...z.keys()].map((k) => k.slice(root.length));
  for (const expected of ['00_Resume_Q3_2026.pdf', '01_Ventes_Q3_2026.xlsx', '02_Ventes_Q3_2026.csv', '03_TVA_Q3_2026.pdf', '04_Factures_clients/liste.csv', '06_Remboursements/remboursements_Q3_2026.csv', '07_Factures_fournisseurs/liste_Q3_2026.csv', '08_Rapprochement_Q3_2026.pdf', '09_Anomalies_et_completude_Q3_2026.pdf', 'manifest.json']) assert.ok(names.includes(expected), `missing ${expected} in ${names.join(', ')}`);
  assert.equal(names.filter((n) => n.startsWith('04_Factures_clients/') && n.endsWith('.pdf')).length, 1, 'the issued client invoice PDF');
  assert.equal(names.filter((n) => n.startsWith('05_Avoirs/') && n.endsWith('.pdf')).length, 1, 'the credit note PDF');
  for (const n of names.filter((x) => x.endsWith('.pdf'))) assert.equal(z.get(root + n).subarray(0, 4).toString(), '%PDF', n);
  assert.equal(z.get(`${root}01_Ventes_Q3_2026.xlsx`).subarray(0, 2).toString(), 'PK');
  const manifest = JSON.parse(z.get(`${root}manifest.json`).toString('utf8'));
  assert.equal(manifest.period.label, 'Q3_2026');
  for (const f of manifest.files) assert.equal(sha(z.get(root + f.path)), f.sha256, f.path);
  assert.equal(manifest.files.length, names.length - 1);
  // the refund of the fixture (2026-09-15) is listed, without customer data
  const refunds = z.get(`${root}06_Remboursements/remboursements_Q3_2026.csv`).toString('utf8');
  assert.match(refunds, /2026-09-15/); assert.ok(!/@|customer|email/i.test(refunds));
  // the sales csv and the accountant pack say the same thing
  const pack = (await h.c.post('/api/pack', { from: '2026-07-01', to: '2026-09-30' })).data.pack;
  assert.match(z.get(`${root}02_Ventes_Q3_2026.csv`).toString('utf8'), new RegExp(String(pack.totals.sales_ex_vat_cents / 100).replace('.', '\\.')));
  assert.deepEqual(p.counts, { invoices: 1, creditNotes: 1, refunds: 1, supplierInvoices: 0 });
}));

test('the preview shows recipient, subject, body and attachments; nothing is sent by preparing', async () => {
  const mail = fakeMail(); const h = await harness({ mail });
  try {
    await h.issue({});
    const p = (await h.c.post('/api/accountant/prepare', Q3)).data;
    assert.equal(p.recipient.email, ACCOUNTANT.email); assert.equal(p.recipient.configured, true); assert.equal(p.requiresApproval, true); assert.equal(p.sent, false);
    assert.match(p.subject, /dossier comptable Q3 2026/); assert.match(p.body, /^Bonjour Comptable Exemple,/); assert.deepEqual(p.attachments.map((a) => a.name), [p.fileName]);
    assert.equal(p.canSendDirectly, true); assert.equal(mail.sent.length, 0, 'prepare never sends');
    assert.ok(h.audits.some((e) => e.action === 'ACCOUNTANT_PACKAGE_PREPARED'));
  } finally { await h.close(); }
});

test('APPROVE then send: refused without approval, refused if the recipient differs from the preview, sent exactly once with the exact ZIP', async () => {
  const mail = fakeMail(); const h = await harness({ mail });
  try {
    await h.issue({});
    const p = (await h.c.post('/api/accountant/prepare', Q3)).data; const url = `/api/accountant/package/${p.id}/send`;
    assert.equal((await h.c.post(url, {})).status, 422); assert.equal((await h.c.post(url, { approve: false, recipient: ACCOUNTANT.email })).status, 422);
    assert.equal((await h.c.post(url, { approve: true, recipient: 'someone.else@elsewhere.example' })).status, 409);
    assert.equal(mail.sent.length, 0);
    const r = await h.c.post(url, { approve: true, recipient: ACCOUNTANT.email }); assert.equal(r.status, 200); assert.equal(r.data.status, 'SENT');
    assert.equal(mail.sent.length, 1); assert.equal(mail.sent[0].to, ACCOUNTANT.email); assert.equal(sha(mail.sent[0].attachments[0].data), p.sha256);
    assert.equal((await h.c.post(url, { approve: true, recipient: ACCOUNTANT.email })).status, 409, 'a second send is refused'); assert.equal(mail.sent.length, 1);
    const actions = h.audits.map((e) => e.action);
    for (const x of ['ACCOUNTANT_PACKAGE_PREPARED', 'ACCOUNTANT_PACKAGE_APPROVED', 'ACCOUNTANT_PACKAGE_SENT']) assert.ok(actions.includes(x), x);
  } finally { await h.close(); }
});

test('a recipient changed AFTER the preview cannot ride on the old approval', async () => {
  const mail = fakeMail(); const h = await harness({ mail });
  try {
    await h.issue({});
    const p = (await h.c.post('/api/accountant/prepare', Q3)).data;
    const s = h.a.getSettings(); s.accountant.email = 'autre@cabinet.example'; h.a.setSettings(s);
    assert.equal((await h.c.post(`/api/accountant/package/${p.id}/send`, { approve: true, recipient: ACCOUNTANT.email })).status, 409); assert.equal(mail.sent.length, 0);
  } finally { await h.close(); }
});

test('no direct mail channel configured: sending is refused with the .eml fallback; the .eml is a standard unsent message carrying the ZIP', withH({}, async (h) => {
  await h.issue({});
  const p = (await h.c.post('/api/accountant/prepare', Q3)).data;
  assert.equal(p.canSendDirectly, false); assert.ok(p.warnings.includes('DIRECT_SEND_NOT_CONFIGURED'));
  const r = await h.c.post(`/api/accountant/package/${p.id}/send`, { approve: true, recipient: ACCOUNTANT.email });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'DIRECT_SEND_NOT_CONFIGURED'); assert.ok(r.data.error.eml);
  const eml = (await h.c.get(p.emlUrl)).data.toString('utf8');
  assert.match(eml, /^From: /m); assert.match(eml, new RegExp(`^To: ${ACCOUNTANT.email}`, 'm')); assert.match(eml, /^X-Unsent: 1/m); assert.match(eml, /Content-Type: multipart\/mixed/); assert.match(eml, /filename="EXEMPLE_Comptabilite_Q3_2026\.zip"/);
  const b64 = eml.split(/filename="EXEMPLE_Comptabilite_Q3_2026\.zip"\r\n\r\n/)[1].split('\r\n--')[0].replace(/\r\n/g, '');
  assert.equal(sha(Buffer.from(b64, 'base64')), p.sha256);
  assert.ok(h.audits.some((e) => e.action === 'ACCOUNTANT_PACKAGE_EML_EXPORTED')); assert.ok(!h.audits.some((e) => e.action === 'ACCOUNTANT_PACKAGE_SENT'), 'an .eml export is not a send');
}));

test('no accountant address in settings: the preview warns and sending is refused', withH({ accountant: { email: '' } }, async (h) => {
  const p = (await h.c.post('/api/accountant/prepare', Q3)).data;
  assert.equal(p.recipient.configured, false); assert.ok(p.warnings.includes('ACCOUNTANT_EMAIL_MISSING'));
  assert.equal((await h.c.post(`/api/accountant/package/${p.id}/send`, { approve: true, recipient: '' })).status, 422);
}));

test('the accountant profile is merchant-local configuration: validated, and no real address exists anywhere in the generic sources', () => {
  assert.equal(validateSettings({}, undefined).settings.accountant.email, '');
  assert.ok(validateSettings({ accountant: { email: 'not an email' } }, undefined).errors.some((e) => e.code === 'EMAIL_INVALID'));
  assert.ok(validateSettings({ accountant: { preferredFormat: 'docx' } }, undefined).errors.some((e) => e.code === 'FORMAT_INVALID'));
  assert.deepEqual(validateSettings({ accountant: ACCOUNTANT }, undefined).settings.accountant, ACCOUNTANT);
  for (const f of ['accountant-package.js', 'mail.js']) assert.ok(!/@[a-z0-9-]+\.(be|com|eu|net)\b/i.test(readFileSync(new URL(`../src/finance/${f}`, import.meta.url), 'utf8')), f);
});

test('MailDeliveryAdapter boundary: the default adapter cannot send; a header-injection attempt in the subject is neutralised', async () => {
  assert.equal(NoMailAdapter.canSend, false); await assert.rejects(() => NoMailAdapter.send({}), (e) => e instanceof MailError && e.code === 'DIRECT_SEND_NOT_CONFIGURED');
  const eml = buildEml({ from: 'a@b.example', to: 'c@d.example', subject: 'Hello\r\nBcc: attacker@evil.example', text: 'x', attachments: [] }).toString('utf8');
  assert.ok(!/^Bcc:/m.test(eml));
});

test('security: endpoints need a session, an invalid period is refused, an unknown package is 404', async () => {
  const h = await harness();
  try {
    const anon = h.a.client();
    assert.equal((await anon.raw('POST', '/api/accountant/prepare', Q3)).status, 401);
    assert.equal((await h.c.post('/api/accountant/prepare', { kind: 'quarter', year: 2026, quarter: 9 })).status, 422);
    assert.equal((await h.c.get('/api/accountant/package/00000000-0000-0000-0000-000000000000/download')).status, 404);
  } finally { await h.close(); }
});
