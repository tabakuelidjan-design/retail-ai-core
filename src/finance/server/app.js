// Finance dashboard HTTP application (framework-free). A request handler you can mount on node:http, or call in tests.
//
// Security model (defence in depth, all server-side):
//   * bound to loopback by the launcher; Host header allow-list (DNS-rebinding guard)
//   * session cookie (HttpOnly, SameSite=Strict) after a token login; brute-force limiter
//   * CSRF token required on every mutating request; Origin checked when present
//   * every input is cleaned/validated (input.js); unknown keys are dropped (no mass assignment)
//   * every document/company lookup is scoped to the merchant (a foreign id is a plain 404: no IDOR, no enumeration)
//   * the browser NEVER calculates: totals, VAT and status come from the deterministic engine
//   * lifecycle actions run as a merchant actor through the finance service, which audits each one
//   * strict response headers (CSP without inline script, no sniffing, no caching of API data)

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildAccountantPack } from '../accountant-pack.js';
import { createCompanyLookup, createViesProvider, ManualProvider, normalizeBelgianNumber } from '../company.js';
import { createCatalogPicker } from '../catalog.js';
import { NoRegistry, NoSearchProvider, createCbeApiProvider, createCompanySearch, createPeppolDirectoryProvider } from '../company-search.js';
import { FinanceError, createDraft, daysBetween, effectiveStatus, settlement, validateForIssue } from '../document.js';
import { cleanCompany, cleanDocumentInput, cleanLines, cleanPaymentInput, cleanVat, isDate } from '../input.js';
import { orderTotalsFromLedger } from '../linking.js';
import { formatCents, fromScaled } from '../money.js';
import { money, renderDocumentPdf, unitPrice as unitPriceText } from '../pdf.js';
import { prepareTransmission } from '../peppol.js';
import { buildReceivables } from '../receivables.js';
import { loadDocsForReports, packFileBuffers } from '../reports.js';
import { createFinanceService } from '../service.js';
import { LOGO_DIR, configFromSettings, missingForInvoicing, parseLogoDataUrl, sanitizeText, validateSettings } from '../settings.js';
import { validateVat } from '../vat.js';

const UI = new URL('../ui/', import.meta.url);
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'], '/lang-fr.js': ['lang-fr.js', 'text/javascript; charset=utf-8'], '/lang-nl.js': ['lang-nl.js', 'text/javascript; charset=utf-8'] };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MERCHANT_ACTOR = { type: 'merchant', id: 'dashboard' };
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const SESSION_MS = 8 * 3600 * 1000;
const NOT_FOUND_CODES = ['DOCUMENT_NOT_FOUND', 'COMPANY_NOT_FOUND'];
const UNPROCESSABLE = ['INPUT_INVALID', 'NOT_READY_FOR_APPROVAL', 'NOT_READY_TO_ISSUE', 'QUOTE_NOT_READY', 'CREDIT_EXCEEDS_INVOICE', 'PAYMENT_AMOUNT_INVALID', 'PAYMENT_DATE_INVALID', 'PAYMENT_EXCEEDS_REMAINING', 'CORRECTION_REQUIRES_A_REFERENCE', 'CREDIT_NOTE_INVALID'];

class HttpError extends Error { constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra ?? null; } }
const sha = (s) => createHash('sha256').update(String(s)).digest();
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
const cents = (c) => formatCents(c);

/**
 * @param {object} deps { merchantId, store, token, settings: {load, save, saveLogo}, retail?, retailConfig, timeZone, clock?, audit?, retailHistory?, lookupProviders?, allowedHosts? }
 */
export function createFinanceApp(deps) {
  const { merchantId, store, token, settings: settingsIo, retail = null, retailConfig, timeZone = 'UTC', retailHistory = async () => null } = deps;
  if (!token || String(token).length < 24) throw new Error('FINANCE_DASHBOARD_TOKEN must be set (at least 24 characters)');
  const clock = deps.clock ?? { now: () => new Date().toISOString(), today: () => new Date().toISOString().slice(0, 10) };
  const audit = deps.audit ?? (async () => {});
  const sessions = new Map();
  const failures = new Map();
  const packCache = new Map();
  const tokenHash = sha(token);

  // ---------- plumbing ----------
  const headers = (extra = {}) => ({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://cdn.shopify.com; frame-src 'self'; object-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin', ...extra,
  });
  const send = (res, status, body, extra = {}) => { res.writeHead(status, headers(extra)); res.end(body); };
  const json = (res, status, obj, extra = {}) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  // Oversized bodies are drained (not stored) and answered with 413, so the client gets a real response instead of a dropped connection.
  const readBody = (req, limit = 1_200_000) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0; let tooBig = false;
    req.on('data', (c) => { n += c.length; if (n > limit) tooBig = true; else if (!tooBig) chunks.push(c); });
    req.on('end', () => {
      if (tooBig) return reject(new HttpError(413, 'BODY_TOO_LARGE'));
      try { const t = Buffer.concat(chunks).toString('utf8'); resolve(t ? JSON.parse(t) : {}); } catch { reject(new HttpError(400, 'INVALID_JSON')); }
    });
    req.on('error', reject);
  });
  const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
  const sessionOf = (req) => { const s = sessions.get(cookies(req).fin_sid); if (!s) return null; if (s.expires < Date.now()) { sessions.delete(cookies(req).fin_sid); return null; } return s; };
  const actor = MERCHANT_ACTOR;

  async function servicesFor() {
    const settings = await settingsIo.load();
    const config = configFromSettings(settings, merchantId);
    const ledgerProvider = async () => (retail ? (await retail.ledgerData()).ledger : null);
    return { settings, svc: createFinanceService({ store, config, clock: { now: clock.now, today: clock.today }, ledgerProvider }) };
  }

  const fields = (errors) => { throw new HttpError(422, 'INPUT_INVALID', { fields: errors }); };
  const idParam = (v) => { if (!ID.test(v ?? '')) throw new HttpError(400, 'BAD_ID'); return v; };

  // ---------- document views ----------
  const disp = (c, doc) => money(c, doc.language);
  // display-only text helpers (string formatting of server-side integers; no arithmetic on money)
  const qtyText = (milli) => String(milli / 1000);
  const pctText = (bp) => String(bp / 100);
  function totalsView(doc) {
    if (!doc.totals) return null;
    const t = doc.totals;
    return {
      netCents: t.netCents, vatCents: t.vatCents, grossCents: t.grossCents, discountCents: t.discountCents, roundingCents: t.roundingCents ?? 0, payableCents: t.grossCents + (t.roundingCents ?? 0),
      rounding: disp(t.roundingCents ?? 0, doc), payable: disp(t.grossCents + (t.roundingCents ?? 0), doc),
      net: disp(t.netCents, doc), vat: disp(t.vatCents, doc), gross: disp(t.grossCents, doc), discount: disp(t.discountCents, doc),
      vatBreakdown: t.vatBreakdown.map((g) => ({ ...g, taxable: disp(g.taxableCents, doc), vatAmount: disp(g.vatCents, doc) })),
      lines: t.lines.map((l) => ({ position: l.position, netCents: l.netCents, grossCents: l.grossCents, discountCents: l.discountCents, net: disp(l.netCents, doc), priceOrigin: l.priceOrigin ?? 'NET_MANUAL', unitPriceRaw: fromScaled(l.priceMicro, 4), unitPrice: unitPriceText(l.priceMicro, doc.language), quantity: qtyText(l.qtyMilli), discount: l.discountBp ? `${pctText(l.discountBp)}%` : l.discountCents ? disp(l.discountCents, doc) : '', vatRate: `${pctText(l.vatRateBp)}%` })),
    };
  }
  function actionsFor(doc, s, credited) {
    const a = [];
    const pdf = ['pdf'];
    if (doc.type === 'quote') {
      if (doc.status === 'DRAFT') a.push('edit', 'send_quote', 'cancel');
      if (doc.status === 'SENT') a.push('accept', 'reject_quote');
      if (doc.status === 'ACCEPTED') a.push('convert');
      return [...a, ...pdf];
    }
    if (doc.status === 'DRAFT') a.push('edit', 'submit', 'cancel');
    if (doc.status === 'READY_FOR_APPROVAL') a.push('approve', 'modify', 'reject');
    if (['ISSUED'].includes(doc.status)) a.push('mark_sent');
    if (doc.type === 'invoice' && ['ISSUED', 'SENT', 'PARTIALLY_PAID'].includes(doc.status) && s && s.remainingCents > 0) a.push('add_payment');
    if (doc.type === 'invoice' && ['ISSUED', 'SENT', 'PARTIALLY_PAID', 'PAID'].includes(doc.status) && s && credited < doc.totals.grossCents + (doc.totals.roundingCents ?? 0)) a.push('credit_note');
    if (doc.lockedAt) a.push('ubl');
    return [...a, ...pdf];
  }
  const rowOf = (doc, s, today) => ({
    id: doc.id, type: doc.type, number: doc.number, status: doc.status, effectiveStatus: s ? effectiveStatus(doc, s, today) : doc.status,
    customer: doc.customer?.name ?? null, issueDate: doc.issueDate, dueDate: doc.dueDate, validUntil: doc.validUntil, currency: doc.currency, language: doc.language,
    grossCents: doc.totals?.grossCents ?? null, gross: doc.totals ? disp(doc.totals.grossCents + (doc.totals.roundingCents ?? 0), doc) : null, remainingCents: s ? s.remainingCents : null, remaining: s ? disp(s.remainingCents, doc) : null,
    revenueBasis: doc.revenueBasis, sourceOrderId: doc.sourceOrderId, relatedDocumentId: doc.relatedDocumentId, quoteExpired: doc.type === 'quote' && doc.status === 'SENT' && !!doc.validUntil && today > doc.validUntil,
  });

  async function invoicedMap() {
    const docs = await store.listDocuments({ merchantId });
    return new Map(docs.filter((d) => d.type === 'invoice' && d.sourceOrderId && d.status !== 'CANCELLED').map((d) => [d.sourceOrderId, { id: d.id, number: d.number, status: d.status }]));
  }

  async function detail(svc, settings, id) {
    const doc = await svc.get(id);
    const today = clock.today();
    const v = await svc.view(id);
    const all = await store.listDocuments({ merchantId });
    const creditNotes = all.filter((d) => d.type === 'credit_note' && d.relatedDocumentId === doc.id);
    const credited = v.settlement?.creditedCents ?? 0;
    const payments = doc.type === 'invoice' ? await store.listPayments(doc.id) : [];
    const readiness = !doc.lockedAt ? await svc.readiness(doc) : null;
    const events = await svc.events(id);
    const related = doc.relatedDocumentId ? all.find((d) => d.id === doc.relatedDocumentId) : null;
    const source = doc.sourceOrderId && retail ? await retail.getOrder(doc.sourceOrderId, await invoicedMap()).catch(() => null) : null;
    return {
      ...rowOf(doc, v.settlement ?? null, today), doc, totals: totalsView(doc), settlement: v.settlement ?? null, integrity: v.integrity,
      settlementView: v.settlement ? { gross: disp(v.settlement.grossCents, doc), credited: disp(v.settlement.creditedCents, doc), paid: disp(v.settlement.paidCents, doc), remaining: disp(v.settlement.remainingCents, doc) } : null,
      readiness, events, payments: payments.map((p) => ({ ...p, amount: disp(p.amountCents, doc) })), creditNotes: creditNotes.map((c) => rowOf(c, null, today)),
      related: related ? { id: related.id, type: related.type, number: related.number } : null,
      convertedInvoice: doc.convertedInvoiceId ? (() => { const i = all.find((d) => d.id === doc.convertedInvoiceId); return i ? { id: i.id, number: i.number, status: i.status } : null; })() : null,
      sourceOrder: source, actions: actionsFor(doc, v.settlement ?? null, credited),
      nextNumber: !doc.lockedAt && doc.status !== 'CANCELLED' ? await svc.peekNextNumber(doc.type, doc.issueDate ?? today).catch(() => null) : null,
      revenueNote: doc.revenueBasis === 'linked_source_order' ? 'LINKED: this invoice documents an existing shop/POS sale. It does NOT create additional revenue.' : doc.revenueBasis === 'standalone_b2b' ? 'STANDALONE: this is a new B2B sale outside the shop. It is ADDITIVE revenue.' : null,
      peppol: { status: 'NOT_CONFIGURED', transmitted: false, note: 'No Peppol provider is configured. Nothing is sent externally.' },
      sellerReady: missingForInvoicing(settings).length === 0,
    };
  }

  /** Build a draft from cleaned input, resolving the company from the directory (identity fields come from the directory, not the client). */
  async function materialise(svc, input) {
    if (input.customer?.companyId) {
      const c = await svc.getCompany(input.customer.companyId).catch(() => null);
      if (!c) fields([{ field: 'customer.companyId', code: 'COMPANY_NOT_FOUND' }]);
      input.customer = { ...input.customer, kind: c.kind, name: c.name, vatNumber: c.vatNumber ?? undefined, enterpriseNumber: c.enterpriseNumber ?? undefined, peppolId: c.peppolId ?? undefined, address: c.address, email: input.customer.email ?? c.email ?? undefined, companyId: c.id };
    }
    return input;
  }

  // ---------- overview ----------
  async function overview(svc, settings) {
    const docs = await loadDocsForReports(store, merchantId);
    const today = clock.today();
    const rec = buildReceivables(docs, { today, dueSoonDays: settings.dashboard.dueSoonDays });
    const nonQuote = docs.filter(({ doc }) => doc.type !== 'quote');
    const quotes = docs.filter(({ doc }) => doc.type === 'quote');
    const month = today.slice(0, 7);
    const payments = await store.listPaymentsForMerchant(merchantId);
    const paidMonth = payments.filter((p) => p.paidOn?.startsWith(month));
    const cur = settings.defaults.currency;
    const lang = settings.defaults.language;
    const m = (c) => money(c, lang);
    return {
      asOf: today, currency: cur,
      counts: {
        unpaid: rec.unpaid.count, overdue: rec.overdue.count, dueSoon: rec.due_soon.count,
        awaitingApproval: nonQuote.filter(({ doc }) => doc.status === 'READY_FOR_APPROVAL').length,
        draftInvoices: nonQuote.filter(({ doc }) => doc.status === 'DRAFT' && doc.type === 'invoice').length,
        quotesAwaitingResponse: quotes.filter(({ doc }) => doc.status === 'SENT').length,
        quotesToConvert: quotes.filter(({ doc }) => doc.status === 'ACCEPTED').length,
        partiallyPaid: docs.filter(({ doc }) => doc.status === 'PARTIALLY_PAID').length,
      },
      amounts: { outstanding: m(rec.unpaid.outstandingCents), outstandingCents: rec.unpaid.outstandingCents, overdue: m(rec.overdue.outstandingCents), overdueCents: rec.overdue.outstandingCents, dueSoon: m(rec.due_soon.outstandingCents), paidThisMonth: m(paidMonth.reduce((a, p) => a + p.amountCents, 0)), paidThisMonthCents: paidMonth.reduce((a, p) => a + p.amountCents, 0), paidThisMonthCount: paidMonth.length, month },
      aging: Object.fromEntries(Object.entries(rec.aging).map(([k, v]) => [k, { count: v.count, amount: m(v.outstandingCents), cents: v.outstandingCents }])),
      attention: {
        overdue: rec.invoices.filter((i) => i.overdue).slice(0, 5).map((i) => ({ number: i.number, customer: i.customer, daysOverdue: i.daysOverdue, remaining: m(i.remainingCents) })),
        awaitingApproval: nonQuote.filter(({ doc }) => doc.status === 'READY_FOR_APPROVAL').slice(0, 5).map(({ doc }) => ({ id: doc.id, type: doc.type, customer: doc.customer.name, gross: disp(doc.totals.grossCents, doc) })),
        quotes: quotes.filter(({ doc }) => doc.status === 'SENT' || doc.status === 'ACCEPTED').slice(0, 5).map(({ doc }) => ({ id: doc.id, number: doc.number, status: doc.status, customer: doc.customer.name, expired: !!doc.validUntil && today > doc.validUntil })),
      },
      settingsMissing: missingForInvoicing(settings),
      peppol: { status: 'NOT_CONFIGURED', note: 'No Peppol provider is selected. Structured invoices can be prepared but nothing is transmitted.' },
    };
  }

  // ---------- accountant pack ----------
  async function computePack(from, to) {
    if (!retail) throw new HttpError(503, 'RETAIL_UNAVAILABLE');
    if (!isDate(from) || !isDate(to) || to < from) fields([{ field: 'period', code: 'PERIOD_INVALID' }]);
    if (daysBetween(from, to) > 800) fields([{ field: 'period', code: 'PERIOD_TOO_LONG' }]);
    const { data, ledger } = await retail.ledgerData(from);
    const settings = await settingsIo.load();
    const pack = buildAccountantPack({ ledger, rawOrders: data.orders, docs: await loadDocsForReports(store, merchantId), period: { start: from, end: to }, timeZone, now: new Date(clock.now()), config: { ...retailConfig, finance: { linking: settings.linking } }, today: clock.today(), dueSoonDays: settings.dashboard.dueSoonDays, retailHistory: await retailHistory() });
    packCache.set(`${from}|${to}`, { pack, expires: Date.now() + 10 * 60_000, settings });
    return pack;
  }

  // ---------- route table ----------
  const routes = [];
  const on = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn, ...opts });
  const P = '([A-Za-z0-9_-]{1,64})';

  on('POST', '/api/login', async (ctx) => {
    const ip = ctx.req.socket.remoteAddress ?? 'unknown';
    const f = failures.get(ip) ?? { n: 0, until: 0 };
    if (f.until > Date.now()) throw new HttpError(429, 'TOO_MANY_ATTEMPTS');
    const supplied = typeof ctx.body?.token === 'string' ? ctx.body.token : '';
    if (!timingSafeEqual(sha(supplied), tokenHash)) {
      f.n += 1; if (f.n >= 5) { f.until = Date.now() + 5 * 60_000; f.n = 0; } failures.set(ip, f);
      await audit({ at: clock.now(), action: 'LOGIN_FAILED' });
      throw new HttpError(401, 'INVALID_TOKEN');
    }
    failures.delete(ip);
    const sid = randomBytes(32).toString('hex');
    const s = { csrf: randomBytes(24).toString('hex'), expires: Date.now() + SESSION_MS };
    sessions.set(sid, s);
    await audit({ at: clock.now(), action: 'LOGIN' });
    json(ctx.res, 200, { ok: true, csrf: s.csrf }, { 'Set-Cookie': `fin_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
  }, { public: true });

  on('GET', '/api/session', async (ctx) => {
    const s = sessionOf(ctx.req);
    json(ctx.res, 200, s ? { authenticated: true, csrf: s.csrf } : { authenticated: false });
  }, { public: true });

  on('POST', '/api/logout', async (ctx) => { sessions.delete(cookies(ctx.req).fin_sid); json(ctx.res, 200, { ok: true }, { 'Set-Cookie': 'fin_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); });

  on('GET', '/api/overview', async (ctx) => { const { svc, settings } = await servicesFor(); json(ctx.res, 200, await overview(svc, settings)); });

  on('GET', '/api/overview/pack', async (ctx) => {
    if (!retail) return json(ctx.res, 200, { status: 'UNAVAILABLE' });
    const t = clock.today(); const y = Number(t.slice(0, 4)); const q = Math.floor((Number(t.slice(5, 7)) - 1) / 3);
    const py = q === 0 ? y - 1 : y; const pq = q === 0 ? 3 : q - 1;
    const from = `${py}-${String(pq * 3 + 1).padStart(2, '0')}-01`;
    const end = new Date(Date.UTC(py, pq * 3 + 3, 0)).toISOString().slice(0, 10);
    const pack = await computePack(from, end);
    json(ctx.res, 200, { status: 'OK', period: pack.period, completeness: pack.completeness.status, reasons: pack.completeness.reasons, anomalies: pack.anomalies.length, critical: pack.completeness.critical_anomalies, reconciliation: pack.reconciliation.status });
  });

  on('POST', '/api/calc', async (ctx) => {
    const errors = [];
    const lines = cleanLines(ctx.body?.lines, errors);
    const vat = cleanVat(ctx.body?.vat, errors);
    const c = ctx.body?.customer ?? {};
    const currency = sanitizeText(ctx.body?.currency, 3)?.toUpperCase() ?? 'EUR';
    const language = ['fr', 'nl', 'en'].includes(ctx.body?.language) ? ctx.body.language : 'fr';
    if (!lines) return json(ctx.res, 200, { ok: false, errors });
    const { settings } = await servicesFor();
    const { doc, errors: engineErrors } = createDraft({ type: 'invoice', merchantId, customer: {}, lines, vat, currency, language });
    const hints = validateVat({ regime: vat.regime, regimeConfirmed: true, lines: doc.lines, customer: { vatNumber: sanitizeText(c.vatNumber, 30), address: { countryCode: sanitizeText(c.countryCode, 2)?.toUpperCase() } }, mention: vat.mention, vatConfig: settings.vat, sellerVatNumber: settings.seller.vatNumber })
      .filter((h) => h !== 'VAT_TREATMENT_NOT_CONFIRMED_BY_MERCHANT');
    json(ctx.res, 200, { ok: errors.length === 0 && engineErrors.length === 0 && !!doc.totals, errors: [...errors, ...engineErrors.map((code) => ({ field: 'lines', code }))], totals: totalsView(doc), hints });
  });

  on('GET', '/api/documents', async (ctx) => {
    const q = ctx.url.searchParams;
    const type = q.get('type');
    const status = q.get('status');
    const today = clock.today();
    const docs = await loadDocsForReports(store, merchantId);
    let rows = docs.filter(({ doc }) => (!type || doc.type === type)).map(({ doc, payments, creditNotes }) => rowOf(doc, doc.type === 'invoice' ? settlement(doc, payments, creditNotes) : null, today));
    if (status) rows = rows.filter((r) => (status === 'OVERDUE' ? r.effectiveStatus === 'OVERDUE' : r.status === status));
    const text = (q.get('q') ?? '').trim().toLowerCase();
    if (text) rows = rows.filter((r) => `${r.number ?? ''} ${r.customer ?? ''}`.toLowerCase().includes(text));
    rows.sort((a, b) => String(b.issueDate ?? '').localeCompare(String(a.issueDate ?? '')) || String(b.number ?? '').localeCompare(String(a.number ?? '')));
    json(ctx.res, 200, { rows: rows.slice(0, 500) });
  });

  on('POST', '/api/documents', async (ctx) => {
    const { input, errors } = cleanDocumentInput(ctx.body);
    if (errors.length) fields(errors);
    const { svc, settings } = await servicesFor();
    const doc = await svc.create(await materialise(svc, input), actor);
    json(ctx.res, 201, await detail(svc, settings, doc.id));
  });

  on('GET', `/api/documents/${P}`, async (ctx) => { const { svc, settings } = await servicesFor(); json(ctx.res, 200, await detail(svc, settings, idParam(ctx.m[1]))); });

  on('PUT', `/api/documents/${P}`, async (ctx) => {
    const id = idParam(ctx.m[1]);
    const { input, errors } = cleanDocumentInput(ctx.body);
    if (errors.length) fields(errors);
    const { svc, settings } = await servicesFor();
    await svc.get(id); // 404 for a foreign document before anything else
    delete input.type; // the type of a document never changes
    await svc.update(id, await materialise(svc, input), actor);
    json(ctx.res, 200, await detail(svc, settings, id));
  });

  const act = (path, fn) => on('POST', `/api/documents/${P}/${path}`, async (ctx) => {
    const id = idParam(ctx.m[1]);
    const { svc, settings } = await servicesFor();
    // Actions return either nothing (show this document) or { open: id } (show another document, e.g. the invoice just created).
    const out = await fn({ svc, id, body: ctx.body ?? {}, settings });
    json(ctx.res, 200, await detail(svc, settings, out && out.open ? out.open : id));
  });
  act('submit', ({ svc, id }) => svc.submit(id, actor));
  act('approve', ({ svc, id, body }) => svc.decide(id, 'APPROVE', actor, sanitizeText(body.note, 300) ?? undefined));
  act('modify', ({ svc, id, body }) => svc.decide(id, 'MODIFY', actor, sanitizeText(body.note, 300) ?? undefined));
  act('reject', ({ svc, id, body }) => svc.decide(id, 'REJECT', actor, sanitizeText(body.note, 300) ?? undefined));
  act('mark-sent', ({ svc, id }) => svc.markSent(id, actor, 'manual'));
  act('cancel', ({ svc, id, body }) => svc.cancelDraft(id, actor, sanitizeText(body.reason, 200) ?? undefined));
  act('send-quote', ({ svc, id }) => svc.sendQuote(id, actor));
  act('accept', ({ svc, id }) => svc.acceptQuote(id, actor));
  act('reject-quote', ({ svc, id }) => svc.rejectQuote(id, actor));
  act('convert', async ({ svc, id, body }) => {
    const basis = body.revenueBasis === 'linked_source_order' ? 'linked_source_order' : 'standalone_b2b';
    const sourceOrderId = typeof body.sourceOrderId === 'string' && ID.test(body.sourceOrderId) ? body.sourceOrderId : null;
    const inv = await svc.convertQuote(id, actor, { revenueBasis: basis, sourceOrderId });
    return { open: inv.id };
  });
  act('credit-note', async ({ svc, id, body }) => {
    const errors = [];
    const lines = body.lines ? cleanLines(body.lines, errors) : undefined;
    if (errors.length) fields(errors);
    const reason = sanitizeText(body.reason, 300);
    if (!reason) fields([{ field: 'reason', code: 'REQUIRED' }]);
    const cn = await svc.createCreditNote(id, { reason, lines }, actor);
    return { open: cn.id };
  });

  on('POST', `/api/documents/${P}/payments`, async (ctx) => {
    const id = idParam(ctx.m[1]);
    const { payment, errors, note } = cleanPaymentInput(ctx.body);
    if (errors.length) fields(errors);
    const { svc, settings } = await servicesFor();
    const saved = await svc.recordPayment(id, payment, actor);
    if (note) await store.appendEvent({ documentId: id, merchantId, actor, action: 'PAYMENT_NOTE', fromStatus: null, toStatus: null, detail: { paymentId: saved.id, note }, at: clock.now() });
    json(ctx.res, 201, await detail(svc, settings, id));
  });

  on('GET', `/api/documents/${P}/pdf`, async (ctx) => {
    const { svc, settings } = await servicesFor();
    const v = await svc.view(idParam(ctx.m[1]));
    const original = v.doc.type === 'credit_note' && v.doc.relatedDocumentId ? (await svc.get(v.doc.relatedDocumentId).catch(() => null))?.number : null;
    const buf = await renderDocumentPdf(v.doc, { settlement: v.settlement ?? null, originalNumber: original, branding: settings.branding });
    const name = safeName(`${v.doc.type}_${v.doc.number ?? 'draft'}`);
    send(ctx.res, 200, buf, { 'Content-Type': 'application/pdf', 'Content-Disposition': `${ctx.url.searchParams.get('download') ? 'attachment' : 'inline'}; filename="${name}.pdf"`, 'Cache-Control': 'no-store' });
  });

  on('GET', `/api/documents/${P}/ubl`, async (ctx) => {
    const { svc, settings } = await servicesFor();
    const doc = await svc.get(idParam(ctx.m[1]));
    const original = doc.type === 'credit_note' && doc.relatedDocumentId ? (await svc.get(doc.relatedDocumentId).catch(() => null))?.number : null;
    const r = prepareTransmission(doc, { originalNumber: original, defaultBuyerReference: settings.peppol.defaultBuyerReference });
    if (!r.payloadXml) throw new HttpError(422, 'PEPPOL_NOT_READY', { errors: r.errors, transmitted: false });
    send(ctx.res, 200, r.payloadXml, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${safeName(doc.number)}.ubl.xml"`, 'X-Peppol-Transmitted': 'false', 'Cache-Control': 'no-store' });
  });

  // ---------- companies ----------
  on('GET', '/api/companies', async (ctx) => {
    const { svc } = await servicesFor();
    const q = (ctx.url.searchParams.get('q') ?? '').trim().toLowerCase();
    const all = await svc.listCompanies();
    json(ctx.res, 200, { rows: all.filter((c) => !q || `${c.name} ${c.vatNumber ?? ''} ${c.enterpriseNumber ?? ''}`.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200) });
  });

  const companyBody = (body) => {
    const errors = [];
    const c = cleanCompany(body, errors, 'company');
    if (body?.source && ['manual', 'vies', 'cbeapi'].includes(body.source)) c.source = body.source;
    if (errors.length) fields(errors);
    return c;
  };
  on('POST', '/api/companies', async (ctx) => {
    const { svc } = await servicesFor();
    const c = companyBody(ctx.body);
    const saved = await svc.saveCompany({ ...c, source: c.source ?? 'manual', verifiedAt: c.source === 'vies' || c.source === 'cbeapi' ? clock.now() : null }, actor);
    json(ctx.res, 201, saved);
  });
  on('PUT', `/api/companies/${P}`, async (ctx) => { const { svc } = await servicesFor(); json(ctx.res, 200, await svc.updateCompany(idParam(ctx.m[1]), companyBody(ctx.body), actor)); });
  on('GET', `/api/companies/${P}`, async (ctx) => {
    const { svc } = await servicesFor();
    const c = await svc.getCompany(idParam(ctx.m[1]));
    const today = clock.today();
    const docs = (await loadDocsForReports(store, merchantId)).filter(({ doc }) => doc.customer?.companyId === c.id || (c.vatNumber && doc.customer?.vatNumber === c.vatNumber));
    const invoices = docs.filter(({ doc }) => doc.type === 'invoice' && doc.lockedAt);
    const rec = buildReceivables(invoices, { today });
    const pays = docs.flatMap(({ payments }) => payments);
    json(ctx.res, 200, {
      company: c,
      documents: docs.map(({ doc, payments, creditNotes }) => rowOf(doc, doc.type === 'invoice' ? settlement(doc, payments, creditNotes) : null, today)).sort((a, b) => String(b.issueDate).localeCompare(String(a.issueDate))),
      outstandingCents: rec.unpaid.outstandingCents, overdueCents: rec.overdue.outstandingCents,
      payments: { count: pays.filter((p) => p.amountCents > 0).length, totalPaidCents: pays.reduce((a, p) => a + p.amountCents, 0), lastPaidOn: pays.map((p) => p.paidOn).sort().at(-1) ?? null },
      credit: { scoring: 'NOT_IMPLEMENTED', note: 'No credit-risk or solvency scoring exists in this module.' },
    });
  });
  on('POST', '/api/companies/lookup', async (ctx) => {
    const { settings } = await servicesFor();
    const providers = deps.lookupProviders ? deps.lookupProviders(settings) : settings.companyLookup.provider === 'vies' ? [createViesProvider(), ManualProvider] : [ManualProvider];
    const errors = [];
    const q = { vatNumber: sanitizeText(ctx.body?.vatNumber, 30) ?? undefined, enterpriseNumber: sanitizeText(ctx.body?.enterpriseNumber, 30) ?? undefined, name: sanitizeText(ctx.body?.name, 120) ?? undefined };
    if (!q.vatNumber && !q.enterpriseNumber && !q.name) errors.push({ field: 'query', code: 'NAME_OR_NUMBER_REQUIRED' });
    if (errors.length) fields(errors);
    const r = await createCompanyLookup(providers).lookup(q);
    const fallback = r.status !== 'FOUND';
    json(ctx.res, 200, { status: r.status, source: r.source ?? null, reason: r.reason ?? null, company: r.company ? { name: r.company.name, kind: 'business', vatNumber: r.company.vatNumber, enterpriseNumber: r.company.enterpriseNumber, address: r.company.address, source: r.company.source } : null, manualEntryAvailable: true, message: fallback ? 'No official data was returned. You can enter the company manually.' : 'Official data found: check it, then save.', provider: settings.companyLookup.provider });
  });

  // ---------- one company search (directory + VIES + name-search provider) ----------
  const searchFor = (settings, svc) => {
    const vies = deps.lookupProviders ? deps.lookupProviders(settings) : settings.companyLookup.provider === 'vies' ? [createViesProvider(), ManualProvider] : [ManualProvider];
    const nameProvider = deps.companySearchProvider ? deps.companySearchProvider(settings) : settings.companySearch.provider === 'peppol_directory' ? createPeppolDirectoryProvider() : NoSearchProvider;
    const directorySearch = async (q) => {
      const t = String(q).toLowerCase();
      const digits = t.replace(/\D/g, '');
      return (await svc.listCompanies()).filter((c) => c.name.toLowerCase().includes(t) || (digits.length >= 9 && `${c.vatNumber ?? ''}${c.enterpriseNumber ?? ''}`.replace(/\D/g, '').includes(digits)));
    };
    const registry = deps.companyRegistry ? deps.companyRegistry(settings) : settings.companySearch.registry === 'cbeapi' ? createCbeApiProvider({ apiKey: process.env.CBEAPI_KEY }) : NoRegistry;
    return createCompanySearch({ numberLookup: createCompanyLookup(vies), nameProvider, registry, directorySearch });
  };
  on('POST', '/api/companies/search', async (ctx) => {
    const { svc, settings } = await servicesFor();
    const query = sanitizeText(ctx.body?.query, 80) ?? '';
    json(ctx.res, 200, { ...(await searchFor(settings, svc).search(query)), providers: { numberLookup: settings.companyLookup.provider, nameSearch: settings.companySearch.provider, registry: settings.companySearch.registry } });
  });
  on('POST', '/api/companies/resolve', async (ctx) => {
    const { svc, settings } = await servicesFor();
    const n = normalizeBelgianNumber(sanitizeText(ctx.body?.enterpriseNumber, 30));
    if (!n.ok) fields([{ field: 'enterpriseNumber', code: `BELGIAN_NUMBER_${n.reason}` }]);
    json(ctx.res, 200, await searchFor(settings, svc).resolve({ enterpriseNumber: n.digits, name: sanitizeText(ctx.body?.name, 120), status: sanitizeText(ctx.body?.status, 80) }));
  });

  // ---------- product catalogue picker (Retail Core is read; nothing is stored or written here) ----------
  const picker = () => { if (!retail?.searchCatalog) throw new HttpError(503, 'RETAIL_UNAVAILABLE'); return createCatalogPicker({ retail, priceSource: deps.priceSource ?? null }); };
  on('GET', '/api/catalog/search', async (ctx) => {
    const q = sanitizeText(ctx.url.searchParams.get('q'), 80) ?? '';
    if (q.length < 2) return json(ctx.res, 200, { rows: [], message: 'Type at least 2 characters: a product name, variant or SKU.' });
    json(ctx.res, 200, { rows: await picker().search(q) });
  });
  on('POST', '/api/catalog/select', async (ctx) => {
    const { settings } = await servicesFor();
    const id = sanitizeText(ctx.body?.variantId, 64);
    if (!id) fields([{ field: 'variantId', code: 'REQUIRED' }]);
    const r = await picker().select(id, { allowedRatesBp: settings.vat.allowedRatesBp });
    if (!r.found) throw new HttpError(404, 'PRODUCT_NOT_FOUND');
    json(ctx.res, 200, r);
  });

  // ---------- orders (linking) ----------
  on('GET', '/api/orders', async (ctx) => {
    if (!retail) throw new HttpError(503, 'RETAIL_UNAVAILABLE');
    const q = ctx.url.searchParams;
    const num = (k) => (q.get(k) != null && q.get(k) !== '' && /^\d{1,9}(\.\d{1,2})?$/.test(q.get(k)) ? Math.round(Number(q.get(k)) * 100) : null);
    const from = q.get('from') && isDate(q.get('from')) ? q.get('from') : undefined;
    const to = q.get('to') && isDate(q.get('to')) ? q.get('to') : undefined;
    json(ctx.res, 200, { rows: await retail.searchOrders({ q: sanitizeText(q.get('q'), 60) ?? '', from, to, minCents: num('min'), maxCents: num('max'), limit: 30 }, await invoicedMap()) });
  });

  // ---------- receivables ----------
  on('GET', '/api/receivables', async (ctx) => {
    const { settings } = await servicesFor();
    const docs = await loadDocsForReports(store, merchantId);
    const r = buildReceivables(docs, { today: clock.today(), dueSoonDays: settings.dashboard.dueSoonDays });
    const m = (c) => money(c, settings.defaults.language);
    json(ctx.res, 200, { ...r, unpaid: { ...r.unpaid, outstanding: m(r.unpaid.outstandingCents) }, overdue: { ...r.overdue, outstanding: m(r.overdue.outstandingCents) }, due_soon: { ...r.due_soon, outstanding: m(r.due_soon.outstandingCents) }, aging: Object.fromEntries(Object.entries(r.aging).map(([k, v]) => [k, { ...v, outstanding: m(v.outstandingCents) }])), invoices: r.invoices.map((i) => ({ ...i, remaining: m(i.remainingCents), gross: m(i.grossCents) })) });
  });

  // ---------- accountant pack ----------
  on('POST', '/api/pack', async (ctx) => {
    const pack = await computePack(ctx.body?.from, ctx.body?.to);
    const files = await packFileBuffers(pack, {});
    await audit({ at: clock.now(), action: 'PACK_GENERATED', detail: { from: ctx.body.from, to: ctx.body.to, completeness: pack.completeness.status } });
    json(ctx.res, 200, { pack, downloads: [...files.keys()].map((name) => ({ name, url: `/api/pack/file?from=${pack.period.start}&to=${pack.period.end}&name=${encodeURIComponent(name)}` })) });
  });
  on('GET', '/api/pack/file', async (ctx) => {
    const from = ctx.url.searchParams.get('from'); const to = ctx.url.searchParams.get('to'); const name = ctx.url.searchParams.get('name') ?? '';
    const hit = packCache.get(`${from}|${to}`);
    const pack = hit && hit.expires > Date.now() ? hit.pack : await computePack(from, to);
    const settings = await settingsIo.load();
    const files = await packFileBuffers(pack, { branding: settings.branding, merchantName: settings.seller.name ?? '' });
    const f = files.get(name);
    if (!f) throw new HttpError(404, 'FILE_NOT_FOUND');
    await audit({ at: clock.now(), action: 'PACK_DOWNLOADED', detail: { name } });
    send(ctx.res, 200, f.data, { 'Content-Type': f.contentType, 'Content-Disposition': `attachment; filename="${safeName(name)}"`, 'Cache-Control': 'no-store' });
  });

  // ---------- settings ----------
  const publicSettings = (s) => ({ ...s, branding: { ...s.branding, logoPath: undefined, hasLogo: !!s.branding.logoPath }, peppol: { ...s.peppol, provider: null, status: 'NOT_CONFIGURED' } });
  on('GET', '/api/settings', async (ctx) => { const s = await settingsIo.load(); json(ctx.res, 200, { settings: publicSettings(s), missing: missingForInvoicing(s), vatRegimes: ['domestic', 'intra_eu_b2b_exempt', 'reverse_charge', 'export_outside_eu', 'vat_exempt_small_business'] }); });
  on('PUT', '/api/settings', async (ctx) => {
    const cur = await settingsIo.load();
    const { settings, errors } = validateSettings(ctx.body, cur);
    if (errors.length) fields(errors);
    settings.branding.logoPath = cur.branding.logoPath; // never client-controlled
    await settingsIo.save(settings);
    await audit({ at: clock.now(), action: 'SETTINGS_CHANGED', detail: { sections: Object.keys(ctx.body ?? {}) } });
    json(ctx.res, 200, { settings: publicSettings(settings), missing: missingForInvoicing(settings) });
  });
  on('POST', '/api/settings/logo', async (ctx) => {
    const r = parseLogoDataUrl(ctx.body?.dataUrl);
    if (r.error) fields([{ field: 'logo', code: r.error }]);
    const cur = await settingsIo.load();
    const path = await settingsIo.saveLogo(r);
    cur.branding.logoPath = path;
    await settingsIo.save(cur);
    await audit({ at: clock.now(), action: 'LOGO_CHANGED' });
    json(ctx.res, 200, { ok: true });
  });
  on('GET', '/api/settings/logo', async (ctx) => {
    const cur = await settingsIo.load();
    if (!cur.branding.logoPath) throw new HttpError(404, 'NO_LOGO');
    const buf = await readFile(cur.branding.logoPath);
    send(ctx.res, 200, buf, { 'Content-Type': cur.branding.logoPath.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' });
  });

  // ---------- dispatcher ----------
  function errorResponse(res, e) {
    if (e instanceof HttpError) return json(res, e.status, { error: { code: e.code, ...(e.extra ?? {}) } });
    if (e instanceof FinanceError) {
      const status = NOT_FOUND_CODES.includes(e.code) ? 404 : UNPROCESSABLE.includes(e.code) ? 422 : 409;
      return json(res, status, { error: { code: e.code, message: e.detail ?? null } });
    }
    console.error('finance dashboard internal error:', e?.message);
    return json(res, 500, { error: { code: 'INTERNAL_ERROR' } });
  }

  async function handler(req, res) {
    try {
      const host = req.headers.host ?? '';
      if (!(deps.allowedHosts ? deps.allowedHosts.includes(host) : LOCAL_HOST.test(host))) throw new HttpError(403, 'HOST_NOT_ALLOWED');
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && STATIC[url.pathname]) { const [file, type] = STATIC[url.pathname]; return send(res, 200, await readFile(new URL(file, UI)), { 'Content-Type': type, 'Cache-Control': 'no-store' }); }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND');
      const route = routes.map((r) => ({ r, m: r.method === req.method ? r.re.exec(url.pathname) : null })).find((x) => x.m);
      if (!route) throw new HttpError(url.pathname === '/api/session' ? 405 : 404, 'NOT_FOUND');
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      let session = null;
      if (!route.r.public) {
        session = sessionOf(req);
        if (!session) throw new HttpError(401, 'AUTHENTICATION_REQUIRED');
      }
      if (mutating) {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== host) throw new HttpError(403, 'ORIGIN_NOT_ALLOWED');
        if (!route.r.public && req.headers['x-csrf-token'] !== session.csrf) throw new HttpError(403, 'CSRF_TOKEN_INVALID');
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON_REQUIRED');
      }
      const body = mutating ? await readBody(req) : undefined;
      await route.r.fn({ req, res, url, m: route.m, body, session });
    } catch (e) { errorResponse(res, e); }
  }

  return { handler, sessions, validateForIssue, orderTotalsFromLedger };
}
