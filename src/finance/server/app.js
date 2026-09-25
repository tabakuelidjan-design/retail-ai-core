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

import { clientIpOf } from './hosting.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readNordlaShared } from '../../shared/nordla-static.js';
import { buildAccountantPack } from '../accountant-pack.js';
import { createCompanyLookup, createViesProvider, ManualProvider, normalizeBelgianNumber } from '../company.js';
import { createCatalogPicker } from '../catalog.js';
import { createStockService } from '../stock.js';
import { settlement as settlementOf } from '../document.js';
import { buildAccountantPackage, resolvePeriod } from '../accountant-package.js';
import { NoMailAdapter, MailError, accountantMessage, buildEml } from '../mail.js';
import { buildActions } from '../actions.js';
import { createBankService } from '../bank-service.js';
import { NoBankAdapter, createConsentVault, loadVaultKey } from '../bank.js';
import { connectorStatus } from '../connectors.js';
import { NullAccessPointAdapter, PEPPOL_STATUSES, prepareTransmission, transmissionEvent } from '../peppol.js';
import { INBOX_ADAPTERS, INBOX_STATUSES, createInboxService, createMemoryAttachmentStore, defaultExtractor, validationErrors, validationErrorsFor } from '../inbox.js';
import { eurOfSupplier, eurPaidOfSupplier, isNative } from '../currency.js';
import { refundRows } from '../refund-rows.js';
import { CATEGORIES, PACK_ACTION, originalOf, pdfOf, analyzePack, buildCategoryPackage, buildPackComptable, categoryFromStoredZip, changesSince, fingerprintOf, historyFromEvents, nextVersion, normalizeInclude, packLabel, previewCounts } from '../pack-comptable.js';
import { NoRegistry, NoSearchProvider, createCbeApiProvider, createCompanySearch, createPeppolDirectoryProvider } from '../company-search.js';
import { FinanceError, createDraft, daysBetween, effectiveStatus, settlement, validateForIssue } from '../document.js';
import { cleanCompany, cleanDocumentInput, cleanLines, cleanPaymentInput, cleanVat, isDate } from '../input.js';
import { orderTotalsFromLedger } from '../linking.js';
import { formatCents, fromScaled, percentToBp, toCents } from '../money.js';
import { money, renderDocumentPdf, unitPrice as unitPriceText } from '../pdf.js';
import { buildContacts, contactDetail, contactExportRow, planImport } from '../contacts.js';
import { buildPeriodReport, buildPurchaseAnalytics, buildSalesAnalytics } from '../analytics.js';
import { toCsv } from '../export-csv.js';
import { buildReceivables } from '../receivables.js';
import { loadDocsForReports, packFileBuffers } from '../reports.js';
import { createFinanceService } from '../service.js';
import { LOGO_DIR, configFromSettings, missingForInvoicing, parseLogoDataUrl, sanitizeText, validateSettings } from '../settings.js';
import { validateVat } from '../vat.js';

const UI = new URL('../ui/', import.meta.url);
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/nordla-tokens.css': ['nordla-tokens.css', 'text/css; charset=utf-8'], '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'], '/views-workspace.js': ['views-workspace.js', 'text/javascript; charset=utf-8'], '/views-contacts.js': ['views-contacts.js', 'text/javascript; charset=utf-8'], '/views-pack.js': ['views-pack.js', 'text/javascript; charset=utf-8'], '/lang-fr.js': ['lang-fr.js', 'text/javascript; charset=utf-8'], '/lang-nl.js': ['lang-nl.js', 'text/javascript; charset=utf-8'] };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MERCHANT_ACTOR = { type: 'merchant', id: 'dashboard' };
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const SESSION_MS = 8 * 3600 * 1000;
const NOT_FOUND_CODES = ['BANK_TRANSACTION_NOT_FOUND', 'DOCUMENT_NOT_FOUND', 'COMPANY_NOT_FOUND', 'INBOX_ITEM_NOT_FOUND', 'STOCK_MOVEMENT_NOT_FOUND', 'ATTACHMENT_NOT_FOUND'];
const UNPROCESSABLE = ['INPUT_INVALID', 'NOT_READY_FOR_APPROVAL', 'NOT_READY_TO_ISSUE', 'QUOTE_NOT_READY', 'CREDIT_EXCEEDS_INVOICE', 'PAYMENT_AMOUNT_INVALID', 'PAYMENT_DATE_INVALID', 'PAYMENT_EXCEEDS_REMAINING', 'CORRECTION_REQUIRES_A_REFERENCE', 'CREDIT_NOTE_INVALID', 'BANK_CSV_EMPTY', 'BANK_CSV_COLUMNS_NOT_FOUND', 'CASH_AMOUNT_INVALID', 'CASH_DATE_INVALID', 'CASH_KIND_INVALID', 'ATTACHMENT_EMPTY', 'ATTACHMENT_TOO_LARGE', 'ATTACHMENT_TYPE_NOT_ALLOWED', 'SOURCE_INVALID', 'PAID_ON_INVALID', 'AMOUNT_INVALID', 'REASON_REQUIRED'];

class HttpError extends Error { constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra ?? null; } }
const sha = (s) => createHash('sha256').update(String(s)).digest();
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
const cents = (c) => formatCents(c);

/**
 * @param {object} deps { merchantId, store, token, settings: {load, save, saveLogo}, retail?, retailConfig, timeZone, clock?, audit?, retailHistory?, lookupProviders?, allowedHosts?, secureCookie?, trustProxyHops?, syncStatus? }
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
  const cookieFlags = deps.secureCookie ? '; Secure' : ''; // hosted mode: HTTPS is terminated by the platform

  // ---------- plumbing ----------
  const headers = (extra = {}) => ({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://cdn.shopify.com; frame-src 'self'; object-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin', ...(deps.secureCookie ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}), ...extra,
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
  const COOKIE = deps.cookieName ?? 'fin_sid'; // a second instance (the demo) uses its own cookie name so it never signs the real dashboard out
  const sessionOf = (req) => { const s = sessions.get(cookies(req)[COOKIE]); if (!s) return null; if (s.expires < Date.now()) { sessions.delete(cookies(req)[COOKIE]); return null; } return s; };
  const actor = MERCHANT_ACTOR;

  async function servicesFor() {
    const settings = await settingsIo.load();
    const config = configFromSettings(settings, merchantId);
    const ledgerProvider = async () => (retail ? (await retail.ledgerData()).ledger : null);
    const stock = stockFor(settings);
    const hooks = {
      restockDecisionNeeded: (doc, inv) => (settings.stock?.mode === 'off' ? false : stock.restockDecisionNeeded(doc, inv)),
      afterIssue: async (doc) => {
        if (!settings.stock || settings.stock.mode === 'off') return; // stock sync is off: no ledger writes (enabling it later reconciles already issued documents)
        const inv = doc.type === 'credit_note' && doc.relatedDocumentId ? await store.getDocument(doc.relatedDocumentId) : null;
        await stock.record(doc, { invoice: inv });
        if (settings.stock?.mode === 'live') await stock.applyPending();
      },
    };
    return { settings, stock, svc: createFinanceService({ store, config, clock: { now: clock.now, today: clock.today }, ledgerProvider, hooks }) };
  }
  const stockFor = (settings) => createStockService({ store, merchantId, retail, applier: deps.stockApplier ?? null, getSettings: async () => settings, now: clock.now, audit });

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
    const safeMoves = async (documentId) => { try { return await store.listStockMovements({ merchantId, documentId }); } catch { return []; } }; // the ledger may not exist yet
    const stockMovements = ['invoice', 'credit_note'].includes(doc.type) && doc.lockedAt ? await safeMoves(doc.id) : [];
    const stockInvoice = doc.type === 'invoice' ? doc : null;
    const soldMovements = stockInvoice ? stockMovements : (doc.relatedDocumentId ? await safeMoves(doc.relatedDocumentId) : []);
    const related = doc.relatedDocumentId ? all.find((d) => d.id === doc.relatedDocumentId) : null;
    const source = doc.sourceOrderId && retail ? await retail.getOrder(doc.sourceOrderId, await invoicedMap()).catch(() => null) : null;
    return {
      ...rowOf(doc, v.settlement ?? null, today), doc, totals: totalsView(doc), settlement: v.settlement ?? null, integrity: v.integrity,
      settlementView: v.settlement ? { gross: disp(v.settlement.grossCents, doc), credited: disp(v.settlement.creditedCents, doc), paid: disp(v.settlement.paidCents, doc), remaining: disp(v.settlement.remainingCents, doc) } : null,
      stockMovements, hadStockMovements: soldMovements.some((m) => m.kind === 'SALE_DECREMENT' && m.status !== 'SKIPPED'),
      readiness, events, payments: payments.map((p) => ({ ...p, amount: disp(p.amountCents, doc) })), creditNotes: creditNotes.map((c) => rowOf(c, null, today)),
      related: related ? { id: related.id, type: related.type, number: related.number } : null,
      convertedInvoice: doc.convertedInvoiceId ? (() => { const i = all.find((d) => d.id === doc.convertedInvoiceId); return i ? { id: i.id, number: i.number, status: i.status } : null; })() : null,
      sourceOrder: source, actions: actionsFor(doc, v.settlement ?? null, credited),
      nextNumber: !doc.lockedAt && doc.status !== 'CANCELLED' ? await svc.peekNextNumber(doc.type, doc.issueDate ?? today).catch(() => null) : null,
      revenueNote: doc.revenueBasis === 'linked_source_order' ? 'LINKED: this invoice documents an existing shop/POS sale. It does NOT create additional revenue.' : doc.revenueBasis === 'standalone_b2b' ? 'STANDALONE: this is a new B2B sale outside the shop. It is ADDITIVE revenue.' : null,
      peppol: { ...(peppolStateOf(events) ?? { status: apConfigured() ? 'NOT_SENT' : 'NOT_CONFIGURED' }), configured: apConfigured(), transmitted: ['SENT', 'DELIVERED'].includes(peppolStateOf(events)?.status), canSend: apConfigured() && settings.peppol.topology.mode !== 'undecided' && !!doc.lockedAt && ['invoice', 'credit_note'].includes(doc.type), topologyConfirmed: settings.peppol.topology.mode !== 'undecided', note: apConfigured() ? null : 'No Peppol Access Point is configured. Nothing is sent externally.' },
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
    // EUR-only: documents in another currency stay visible in their own screens but never enter these totals
    const allDocs = await loadDocsForReports(store, merchantId);
    const docs = allDocs.filter(({ doc }) => isNative(doc, settings.defaults.currency));
    const foreignSales = allDocs.filter(({ doc }) => !isNative(doc, settings.defaults.currency) && doc.type !== 'quote' && doc.lockedAt).length;
    const nativeIds = new Set(docs.map(({ doc }) => doc.id));
    const today = clock.today();
    const rec = buildReceivables(docs, { today, dueSoonDays: settings.dashboard.dueSoonDays });
    const nonQuote = docs.filter(({ doc }) => doc.type !== 'quote');
    const quotes = docs.filter(({ doc }) => doc.type === 'quote');
    const month = today.slice(0, 7);
    const payments = (await store.listPaymentsForMerchant(merchantId)).filter((p) => nativeIds.has(p.documentId));
    const paidMonth = payments.filter((p) => p.paidOn?.startsWith(month));
    const cur = settings.defaults.currency;
    const lang = settings.defaults.language;
    const m = (c) => money(c, lang);
    // Real last-7-days payment totals for the dashboard trend strip - reuses `payments`, already loaded above.
    // Never estimated: a day with no recorded payment is 0, not interpolated.
    const last7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(Date.parse(`${today}T00:00:00Z`) - (6 - i) * 86_400_000).toISOString().slice(0, 10); return { date: d, cents: payments.filter((p) => p.paidOn === d).reduce((a, p) => a + p.amountCents, 0) }; });
    // Revenue / expenses this month vs last month - real, computed from documents/supplier invoices already
    // available to this function (or one extra read-only fetch for supplier invoices). "Revenue" = gross of
    // invoices issued in the period (never quotes, never drafts); "expenses" = gross of supplier invoices the
    // merchant has accepted (validated/to pay/paid) in the period. Never a forecast, never interpolated.
    const lastMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    const invoiceGrossInMonth = (mth) => nonQuote.filter(({ doc }) => doc.type === 'invoice' && doc.lockedAt && doc.issueDate?.startsWith(mth) && doc.status !== 'CANCELLED').reduce((a, { doc }) => a + doc.totals.grossCents, 0);
    const supplierInvoices = await store.listSupplierInvoices(merchantId).catch(() => []);
    const accepted = supplierInvoices.filter((s) => ['VALIDATED', 'TO_PAY', 'PAID'].includes(s.status));
    const expenseGrossInMonth = (mth) => accepted.filter((s) => s.issueDate?.startsWith(mth)).reduce((a, s) => a + (eurOfSupplier(s, settings.defaults.currency) ?? 0), 0);
    const pctChange = (cur2, prev) => (prev > 0 ? Math.round(((cur2 - prev) / prev) * 100) : cur2 > 0 ? 100 : 0);
    const revenueThis = invoiceGrossInMonth(month); const revenueLast = invoiceGrossInMonth(lastMonth);
    const expenseThis = expenseGrossInMonth(month); const expenseLast = expenseGrossInMonth(lastMonth);
    // Top suppliers by accepted amount - real supplier-invoice data, used on the dashboard where the approved
    // design calls for an expense-category donut; there is no expense-category field anywhere in this data
    // model, so categories would have to be invented. Supplier concentration is the closest real substitute.
    const bySupplier = new Map();
    for (const s of accepted) { const e = eurOfSupplier(s, settings.defaults.currency); if (e !== null) bySupplier.set(s.supplierName, (bySupplier.get(s.supplierName) || 0) + e); }
    const supplierTotal = [...bySupplier.values()].reduce((a, c) => a + c, 0);
    const topSuppliers = [...bySupplier.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, cents]) => ({ name, cents, amount: m(cents), sharePct: supplierTotal > 0 ? Math.round((cents / supplierTotal) * 100) : 0 }));
    // Paid / Outstanding / Overdue snapshot across all locked invoices - real effectiveStatus per document,
    // not a period aggregate. `rec.invoices` only holds OPEN ones (buildReceivables drops paid invoices
    // entirely), so "paid" is derived separately here the same way buildReceivables derives status.
    const lockedInvoices = nonQuote.filter(({ doc }) => doc.type === 'invoice' && doc.lockedAt && doc.status !== 'CANCELLED');
    const paidInvoices = lockedInvoices.filter(({ doc, payments: pays, creditNotes }) => effectiveStatus(doc, settlement(doc, pays, creditNotes), today) === 'PAID');
    const paidCents = paidInvoices.reduce((a, { doc }) => a + doc.totals.grossCents, 0);
    const invoiceStatus = {
      paid: { count: paidInvoices.length, cents: paidCents, amount: m(paidCents) },
      outstanding: { count: rec.unpaid.count - rec.overdue.count, cents: rec.unpaid.outstandingCents - rec.overdue.outstandingCents, amount: m(rec.unpaid.outstandingCents - rec.overdue.outstandingCents) },
      overdue: { count: rec.overdue.count, cents: rec.overdue.outstandingCents, amount: m(rec.overdue.outstandingCents) },
    };
    return {
      invoiceStatus,
      revenue: { thisMonth: m(revenueThis), thisMonthCents: revenueThis, changePct: pctChange(revenueThis, revenueLast) },
      expenses: { thisMonth: m(expenseThis), thisMonthCents: expenseThis, changePct: pctChange(expenseThis, expenseLast) },
      topSuppliers, supplierTotalCents: supplierTotal,
      asOf: today, currency: cur,
      foreign: { salesDocuments: foreignSales, purchaseDocuments: accepted.filter((s) => eurOfSupplier(s, settings.defaults.currency) === null).length },
      counts: {
        unpaid: rec.unpaid.count, overdue: rec.overdue.count, dueSoon: rec.due_soon.count,
        awaitingApproval: nonQuote.filter(({ doc }) => doc.status === 'READY_FOR_APPROVAL').length,
        draftInvoices: nonQuote.filter(({ doc }) => doc.status === 'DRAFT' && doc.type === 'invoice').length,
        quotesAwaitingResponse: quotes.filter(({ doc }) => doc.status === 'SENT').length,
        quotesToConvert: quotes.filter(({ doc }) => doc.status === 'ACCEPTED').length,
        partiallyPaid: docs.filter(({ doc }) => doc.status === 'PARTIALLY_PAID').length,
      },
      amounts: { outstanding: m(rec.unpaid.outstandingCents), outstandingCents: rec.unpaid.outstandingCents, overdue: m(rec.overdue.outstandingCents), overdueCents: rec.overdue.outstandingCents, dueSoon: m(rec.due_soon.outstandingCents), paidThisMonth: m(paidMonth.reduce((a, p) => a + p.amountCents, 0)), paidThisMonthCents: paidMonth.reduce((a, p) => a + p.amountCents, 0), paidThisMonthCount: paidMonth.length, month },
      trend7d: last7.map((d) => ({ date: d.date, cents: d.cents, amount: m(d.cents) })),
      aging: Object.fromEntries(Object.entries(rec.aging).map(([k, v]) => [k, { count: v.count, amount: m(v.outstandingCents), cents: v.outstandingCents }])),
      attention: {
        overdue: rec.invoices.filter((i) => i.overdue).slice(0, 5).map((i) => ({ number: i.number, customer: i.customer, daysOverdue: i.daysOverdue, remaining: m(i.remainingCents) })),
        dueSoon: rec.invoices.filter((i) => i.dueSoon).slice(0, 5).map((i) => ({ number: i.number, customer: i.customer, dueDate: i.dueDate, remaining: m(i.remainingCents) })),
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
    const ip = clientIpOf(ctx.req, deps.trustProxyHops ?? 0);
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
    json(ctx.res, 200, { ok: true, csrf: s.csrf }, { 'Set-Cookie': `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${cookieFlags}` });
  }, { public: true });

  // Sync health: the last Shopify -> Supabase SYNCHRONISATION (from the Core sync run log), factual and read-only. Pack/report generation is not a sync.
  on('GET', '/api/sync-status', async (ctx) => {
    let sync = { available: false, reason: 'NOT_CONFIGURED' };
    try { if (deps.syncStatus) sync = await deps.syncStatus(); } catch { sync = { available: false, reason: 'STATUS_UNAVAILABLE' }; }
    json(ctx.res, 200, { sync });
  });
  on('GET', '/api/session', async (ctx) => {
    const s = sessionOf(ctx.req);
    json(ctx.res, 200, s ? { authenticated: true, csrf: s.csrf } : { authenticated: false });
  }, { public: true });

  on('POST', '/api/logout', async (ctx) => { sessions.delete(cookies(ctx.req)[COOKIE]); json(ctx.res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieFlags}` }); });

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

  // Dashboard "recent activity" feed: the real document lifecycle trail (fin_events), never a fabricated
  // or estimated timeline. Fetched separately from /api/overview so a slow merchant history never blocks
  // the KPIs above it - same lazy-card pattern as /api/overview/pack.
  on('GET', '/api/overview/activity', async (ctx) => {
    const { settings } = await servicesFor();
    // Reference-matched compact list (this endpoint is only consumed by the homepage's Recent activity card):
    // 5 most-recent real events, not fabricated - just a smaller slice of the same real event log.
    const events = await store.listEventsForMerchant({ merchantId, limit: 5 });
    const docIds = [...new Set(events.map((e) => e.documentId).filter(Boolean))];
    const docs = new Map((await Promise.all(docIds.map((id) => store.getDocument(id).catch(() => null)))).filter(Boolean).map((d) => [d.id, d]));
    const m = (c) => money(c, settings.defaults.language);
    json(ctx.res, 200, { rows: events.map((e) => { const d = docs.get(e.documentId); return { action: e.action, at: e.at, docType: d?.type ?? null, docNumber: d?.number ?? null, docId: e.documentId, amount: e.detail?.amountCents != null ? m(e.detail.amountCents) : null, currency: d?.currency ?? settings.defaults.currency }; }) });
  });

  // Dashboard "Repartition des depenses" donut: real supplier-invoice totals grouped by supplier (there is no
  // expense-category field anywhere in this data model, so a category breakdown would have to be invented -
  // supplier concentration is the closest honest substitute, and the legend shows real supplier names, never
  // invented category labels). `period` is real and functional: 'month' scopes to the current calendar month,
  // anything else (default) is all-time - both filter the exact same real accepted supplier invoices, nothing
  // estimated or interpolated for a period with no data.
  on('GET', '/api/overview/expense-breakdown', async (ctx) => {
    const { settings } = await servicesFor();
    const period = ctx.url.searchParams.get('period') === 'month' ? 'month' : 'all';
    const month = clock.today().slice(0, 7);
    const m = (c) => money(c, settings.defaults.language);
    const supplierInvoices = await store.listSupplierInvoices(merchantId).catch(() => []);
    const accepted = supplierInvoices.filter((s) => ['VALIDATED', 'TO_PAY', 'PAID'].includes(s.status) && (period === 'all' || s.issueDate?.startsWith(month)));
    const CUR = settings.defaults.currency;
    const bySupplier = new Map();
    for (const s of accepted) { const e = eurOfSupplier(s, CUR); if (e !== null) bySupplier.set(s.supplierName, (bySupplier.get(s.supplierName) || 0) + e); }
    const total = [...bySupplier.values()].reduce((a, c) => a + c, 0);
    const suppliers = [...bySupplier.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, cents]) => ({ name, cents, amount: m(cents), sharePct: total > 0 ? Math.round((cents / total) * 100) : 0 }));
    // Real month-over-month change on the total, same definition as the KPI strip's own trend figures.
    const lastMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    const thisMonthTotal = accepted.filter((s) => period === 'month' || s.issueDate?.startsWith(month)).reduce((a, s) => a + (eurOfSupplier(s, CUR) ?? 0), 0);
    const lastMonthTotal = supplierInvoices.filter((s) => ['VALIDATED', 'TO_PAY', 'PAID'].includes(s.status) && s.issueDate?.startsWith(lastMonth)).reduce((a, s) => a + (eurOfSupplier(s, CUR) ?? 0), 0);
    const changePct = lastMonthTotal > 0 ? Math.round(((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100) : thisMonthTotal > 0 ? 100 : 0;
    json(ctx.res, 200, { period, suppliers, total, totalDisplay: m(total), currency: settings.defaults.currency, changePct, excludedForeign: accepted.filter((s) => eurOfSupplier(s, CUR) === null).length });
  });

  // Dashboard treasury chart: real monthly totals of client payments received (inflow) and supplier invoices
  // paid (outflow), with a running net total. This is documented cash MOVEMENT, not the literal bank balance -
  // the two only match once a bank account is actually connected and reconciled. Never a forecast: a month
  // with no recorded movement is 0, not interpolated or projected forward.
  on('GET', '/api/overview/cashflow', async (ctx) => {
    const { settings } = await servicesFor();
    const months = [3, 6, 12].includes(Number(ctx.url.searchParams.get('months'))) ? Number(ctx.url.searchParams.get('months')) : 6;
    const today = clock.today();
    const [payments, supplierInvoices, docs] = await Promise.all([store.listPaymentsForMerchant(merchantId), store.listSupplierInvoices(merchantId).catch(() => []), loadDocsForReports(store, merchantId)]);
    const CUR = settings.defaults.currency; const nativeIds = new Set(docs.filter(({ doc }) => isNative(doc, CUR)).map(({ doc }) => doc.id));
    const paidSupplier = supplierInvoices.filter((s) => s.status === 'PAID' && s.paidAt);
    // Revenue/expense series for the "Revenue vs Expenses" mini-chart - the exact same definitions already used
    // for the KPI strip's this-month/last-month figures (invoiced gross for revenue, accepted supplier-invoice
    // gross for expenses), just repeated per month instead of only the current and previous one.
    const accepted = supplierInvoices.filter((s) => ['VALIDATED', 'TO_PAY', 'PAID'].includes(s.status));
    const invoicesLocked = docs.filter(({ doc }) => doc.type === 'invoice' && doc.lockedAt && doc.status !== 'CANCELLED' && isNative(doc, CUR));
    const monthKeys = Array.from({ length: months }, (_, i) => { const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - (months - 1 - i), 1)); return d.toISOString().slice(0, 7); });
    const m = (c) => money(c, settings.defaults.language);
    let running = 0;
    const rows = monthKeys.map((mth) => {
      const inflowCents = payments.filter((p) => p.paidOn?.startsWith(mth) && nativeIds.has(p.documentId)).reduce((a, p) => a + p.amountCents, 0);
      const outflowCents = paidSupplier.filter((s) => String(s.paidAt).startsWith(mth)).reduce((a, s) => a + (eurPaidOfSupplier(s, CUR) ?? 0), 0);
      const revenueCents = invoicesLocked.filter(({ doc }) => doc.issueDate?.startsWith(mth)).reduce((a, { doc }) => a + doc.totals.grossCents, 0);
      const expenseCents = accepted.filter((s) => s.issueDate?.startsWith(mth)).reduce((a, s) => a + (eurOfSupplier(s, CUR) ?? 0), 0);
      running += inflowCents - outflowCents;
      return { month: mth, inflowCents, outflowCents, netCents: inflowCents - outflowCents, balanceCents: running, inflow: m(inflowCents), outflow: m(outflowCents), balance: m(running), revenueCents, expenseCents, revenue: m(revenueCents), expense: m(expenseCents) };
    });
    const hasActivity = rows.some((r) => r.inflowCents || r.outflowCents);
    const excluded = { salesDocuments: docs.filter(({ doc }) => !isNative(doc, CUR) && doc.type === 'invoice' && doc.lockedAt).length, purchaseDocuments: accepted.filter((s) => eurOfSupplier(s, CUR) === null).length };
    json(ctx.res, 200, { currency: settings.defaults.currency, months, rows, hasActivity, excluded });
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
    const cn = await svc.createCreditNote(id, { reason, lines, restock: typeof body.restock === 'boolean' ? body.restock : undefined }, actor);
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
    const c = cleanCompany(body, errors, 'company', { allowNotes: true });
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
    const homeCur = (await settingsIo.load()).defaults.currency;
    const invoices = docs.filter(({ doc }) => doc.type === 'invoice' && doc.lockedAt && isNative(doc, homeCur));
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
  // Phase 1 (Contact foundation): a read-only projection over the SAME fin_companies referential as
  // /api/companies - not a second contact store, not a replacement route. Nothing in the existing UI
  // depends on this endpoint; it exists so the future Contacts UI (Phase 2) does not have to merge several
  // endpoints itself. One pass over pre-fetched, merchant-scoped data (see contacts.js) - no per-contact query.
  // role: all | customer | supplier | both | incomplete | archived (V1). "all"/"customer"/"supplier"/"both"
  // implicitly exclude archived contacts (an archived contact is only ever visible under role=archived) -
  // matching the mandate's "un contact archivé disparaît des vues actives".
  const contactsFor = async (ctx) => {
    const { svc, settings } = await servicesFor();
    const role = ctx.url.searchParams.get('role') ?? 'all';
    const q = (ctx.url.searchParams.get('q') ?? '').trim().toLowerCase();
    const m = (c) => money(c, settings.defaults.language);
    const [companies, salesDocs, supplierInvoices] = await Promise.all([svc.listCompanies(), loadDocsForReports(store, merchantId), store.listSupplierInvoices(merchantId)]);
    let rows = buildContacts({ companies, salesDocs, supplierInvoices, m, today: clock.today() });
    if (role === 'archived') rows = rows.filter((r) => r.archived);
    else {
      rows = rows.filter((r) => !r.archived);
      if (role === 'customer') rows = rows.filter((r) => r.isCustomer);
      else if (role === 'supplier') rows = rows.filter((r) => r.isSupplier);
      else if (role === 'both') rows = rows.filter((r) => r.isCustomer && r.isSupplier);
      else if (role === 'incomplete') rows = rows.filter((r) => r.incomplete);
    }
    if (q) rows = rows.filter((r) => `${r.displayName} ${r.vatNumber ?? ''} ${r.email ?? ''}`.toLowerCase().includes(q));
    return { svc, companies, rows: rows.sort((a, b) => a.displayName.localeCompare(b.displayName)) };
  };
  on('GET', '/api/contacts', async (ctx) => { const { rows } = await contactsFor(ctx); json(ctx.res, 200, { rows }); });
  on('GET', `/api/contacts/${P}`, async (ctx) => {
    const { svc, settings } = await servicesFor();
    const c = await svc.getCompany(idParam(ctx.m[1])); // throws COMPANY_NOT_FOUND - same tenant check as /api/companies/:id
    const m = (c2) => money(c2, settings.defaults.language);
    const [salesDocs, supplierInvoices] = await Promise.all([loadDocsForReports(store, merchantId), store.listSupplierInvoices(merchantId)]);
    json(ctx.res, 200, contactDetail(c, { salesDocs, supplierInvoices, m, today: clock.today() }));
  });
  // Contacts V1: archive/restore - never a destructive delete, and never touches any other field or any
  // linked document. Reuses the same tenant-scoped svc.getCompany() check every other company route uses.
  on('POST', `/api/companies/${P}/archive`, async (ctx) => { const { svc } = await servicesFor(); json(ctx.res, 200, await svc.archiveCompany(idParam(ctx.m[1]), actor)); });
  on('POST', `/api/companies/${P}/restore`, async (ctx) => { const { svc } = await servicesFor(); json(ctx.res, 200, await svc.restoreCompany(idParam(ctx.m[1]), actor)); });
  // Contacts V1: CSV export. `ids=` (comma-separated) restricts to an explicit selection (bulk export from
  // the list); otherwise the current role/q filter is exported, exactly as shown on screen.
  on('GET', '/api/contacts/export.csv', async (ctx) => {
    const { companies, rows } = await contactsFor(ctx);
    const idsParam = ctx.url.searchParams.get('ids');
    const wanted = idsParam ? new Set(idsParam.split(',').map((s) => s.trim()).filter(Boolean)) : null;
    const byId = new Map(companies.map((c) => [c.id, c]));
    const selected = wanted ? rows.filter((r) => wanted.has(r.id)) : rows;
    const csvRows = selected.map((r) => contactExportRow(r, byId.get(r.id)));
    const cols = ['id', 'kind', 'name', 'vatNumber', 'enterpriseNumber', 'email', 'street', 'postalCode', 'city', 'countryCode', 'isCustomer', 'isSupplier', 'archived', 'source'].map((key) => ({ key, header: key }));
    send(ctx.res, 200, toCsv(csvRows, cols, { delimiter: ';' }), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="contacts.csv"', 'Cache-Control': 'no-store' });
  });
  // Contacts V1: CSV/simple-object import. dryRun (default true) only returns the plan (create/update/
  // ambiguous/errors) - nothing is written until the caller resends with dryRun:false, after the merchant has
  // seen the preview. Matching is the same conservative, non-fuzzy algorithm as the Phase 1 supplier backfill
  // (see contacts.js planImport): stable id first, then exact VAT, then exact normalised name; anything
  // ambiguous is reported, never guessed, and never auto-merged.
  on('POST', '/api/contacts/import', async (ctx) => {
    const { svc } = await servicesFor();
    const rows = Array.isArray(ctx.body?.rows) ? ctx.body.rows.slice(0, 2000) : null;
    if (!rows) fields([{ field: 'rows', code: 'REQUIRED' }]);
    const companies = await svc.listCompanies();
    const plan = planImport(rows, companies);
    const dryRun = ctx.body?.dryRun !== false;
    let created = 0; let updated = 0; const writeErrors = [];
    if (!dryRun) {
      // Each row is applied independently: one bad/duplicate row (e.g. two rows in the same file sharing a
      // VAT number) is reported and skipped, never aborts the rest of the import.
      for (const { line, payload } of plan.toCreate) {
        const errors = []; const c = cleanCompany(payload, errors, 'company', { allowNotes: false });
        if (errors.length) { writeErrors.push({ line, reason: 'INVALID', fields: errors }); continue; }
        try { await svc.saveCompany({ ...c, source: 'manual' }, actor); created += 1; } catch (e) { writeErrors.push({ line, reason: e.code ?? 'WRITE_FAILED' }); }
      }
      for (const { line, id, patch } of plan.toUpdate) {
        const errors = []; const c = cleanCompany(patch, errors, 'company', { allowNotes: false });
        if (errors.length) { writeErrors.push({ line, reason: 'INVALID', fields: errors }); continue; }
        try { await svc.updateCompany(id, c, actor); updated += 1; } catch (e) { writeErrors.push({ line, reason: e.code ?? 'WRITE_FAILED' }); }
      }
    }
    json(ctx.res, 200, { committed: !dryRun, created: dryRun ? plan.toCreate.length : created, updated: dryRun ? plan.toUpdate.length : updated, ambiguous: plan.ambiguous, errors: dryRun ? plan.errors : [...plan.errors, ...writeErrors] });
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

  // ---------- Bank & Treasury: READ ONLY. No route here can move money; the bank token never leaves the vault. ----------
  const bankAdapter = () => deps.bankAdapter ?? NoBankAdapter;
  const bankFor = async () => {
    const { svc } = await servicesFor();
    const vault = createConsentVault({ store, merchantId, key: deps.bankVaultKey !== undefined ? deps.bankVaultKey : loadVaultKey(), now: clock.now });
    return createBankService({ store, merchantId, adapter: bankAdapter(), vault, inbox: inboxFor(), clock, audit,
      finance: { listInvoices: () => loadDocsForReports(store, merchantId), recordPayment: (id, payment, a) => { const c = cleanPaymentInput(payment); if (c.errors.length) throw new HttpError(422, 'INPUT_INVALID', { fields: c.errors }); return svc.recordPayment(id, c.payment, a); } } });
  };
  const txView = (t) => ({ id: t.id, date: t.date, amountCents: t.amountCents, amount: formatCents(t.amountCents), currency: t.currency, counterpartyName: t.counterpartyName, reference: t.reference, structuredReference: t.structuredReference, source: t.source, status: t.status, matchedKind: t.matchedKind, matchedDocumentId: t.matchedDocumentId, matchedAmountCents: t.matchedAmountCents });
  on('GET', '/api/bank/status', async (ctx) => json(ctx.res, 200, await (await bankFor()).status()));
  on('GET', '/api/bank/transactions', async (ctx) => { const st = ctx.url.searchParams.get('status'); json(ctx.res, 200, { rows: (await (await bankFor()).transactions(['NEW', 'MATCHED', 'IGNORED'].includes(st) ? { status: st } : {})).map(txView) }); });
  on('GET', '/api/bank/suggestions', async (ctx) => json(ctx.res, 200, { rows: (await (await bankFor()).suggestions()).map((s) => ({ ...s, transaction: txView(s.transaction) })) }));
  on('POST', '/api/bank/sync', async (ctx) => json(ctx.res, 200, await (await bankFor()).sync({})));
  on('POST', '/api/bank/import-csv', async (ctx) => { const text = typeof ctx.body?.csv === 'string' ? ctx.body.csv : ''; if (!text) fields([{ field: 'csv', code: 'REQUIRED' }]); json(ctx.res, 200, await (await bankFor()).importCsv(text)); }, { bodyLimit: 4_000_000 });
  on('POST', `/api/bank/transactions/${P}/confirm`, async (ctx) => {
    const b = ctx.body ?? {}; const cents = b.amount === undefined || b.amount === '' ? undefined : toCents(String(b.amount));
    json(ctx.res, 200, await (await bankFor()).confirm(idParam(ctx.m[1]), { documentId: typeof b.documentId === 'string' && ID.test(b.documentId) ? b.documentId : undefined, itemId: typeof b.itemId === 'string' && ID.test(b.itemId) ? b.itemId : undefined, amountCents: Number.isInteger(cents) ? cents : undefined }, actor));
  });
  on('POST', `/api/bank/transactions/${P}/ignore`, async (ctx) => json(ctx.res, 200, txView(await (await bankFor()).ignore(idParam(ctx.m[1]), actor))));
  on('POST', '/api/bank/connect', async (ctx) => json(ctx.res, 200, await (await bankFor()).beginConsent(`http://${ctx.req.headers.host}/#/bank`, actor)));
  on('POST', '/api/bank/consent', async (ctx) => json(ctx.res, 200, await (await bankFor()).completeConsent({ code: sanitizeText(ctx.body?.code, 500), state: sanitizeText(ctx.body?.state, 200) }, actor)));
  on('POST', '/api/bank/disconnect', async (ctx) => json(ctx.res, 200, await (await bankFor()).disconnect(actor)));
  on('POST', '/api/cash/counts', async (ctx) => { const c = toCents(String(ctx.body?.amount ?? '')); json(ctx.res, 201, await (await bankFor()).confirmCashCount({ amountCents: Number.isInteger(c) ? c : NaN, countedOn: ctx.body?.countedOn, note: sanitizeText(ctx.body?.note, 200) }, actor)); });
  on('POST', '/api/cash/movements', async (ctx) => { const c = toCents(String(ctx.body?.amount ?? '')); json(ctx.res, 201, await (await bankFor()).addCashMovement({ kind: ctx.body?.kind, amountCents: Number.isInteger(c) ? c : NaN, date: ctx.body?.date, note: sanitizeText(ctx.body?.note, 200) }, actor)); });
  on('GET', '/api/treasury', async (ctx) => {
    const { settings } = await servicesFor(); const bank = await bankFor();
    const horizonDays = [30, 60, 90].includes(Number(ctx.url.searchParams.get('horizon'))) ? Number(ctx.url.searchParams.get('horizon')) : 7;
    const t = await bank.treasury({ currency: settings.defaults.currency, horizonDays });
    const m = (c) => (c == null ? null : money(c, settings.defaults.language));
    // Per-account balances for the dashboard's "Comptes bancaires" list - real rows from fin_bank_balances,
    // never fabricated placeholder accounts. Empty when nothing is connected (the UI shows a proper empty state).
    const status = await bank.status().catch(() => null);
    const balances = await store.listBankBalances(merchantId).catch(() => []);
    const accounts = balances.map((b) => ({ accountId: b.accountId, ibanMasked: b.iban ? `${b.iban.slice(0, 4)} •••• •••• ${b.iban.slice(-4)}` : null, balance: m(b.balanceCents), balanceCents: b.balanceCents, currency: b.currency, asOf: b.asOf }));
    json(ctx.res, 200, { ...t, display: { bank: m(t.observed.bankCents), cash: m(t.observed.cashCents), liquid: m(t.observed.liquidCents), incoming: m(t.expected.incomingCents), outgoing: m(t.expected.outgoingCents), overdue: m(t.assumed.overdueReceivablesCents), projection: m(t.projection.cents) }, connected: !!status?.connected, provider: status?.adapter?.label ?? null, accounts });
  });

  // ---------- Finance Action Center: what to do next, from facts the workspace already holds ----------
  on('GET', '/api/actions', async (ctx) => {
    const { svc, settings, stock } = await servicesFor();
    const allDocs = await loadDocsForReports(store, merchantId);
    const docs = allDocs.filter(({ doc }) => isNative(doc, settings.defaults.currency));
    const foreignSales = allDocs.filter(({ doc }) => !isNative(doc, settings.defaults.currency) && doc.type !== 'quote' && doc.lockedAt).length;
    const today = clock.today();
    const rec = buildReceivables(docs, { today, dueSoonDays: settings.dashboard.dueSoonDays });
    const drafts = docs.filter(({ doc }) => ['DRAFT', 'READY_FOR_APPROVAL'].includes(doc.status) && doc.type !== 'quote').slice(0, 40);
    let draftsMissingVat = 0;
    for (const { doc } of drafts) { const r = await svc.readiness(doc).catch(() => null); if (r && r.errors.some((e) => /VAT/.test(String(e)))) draftsMissingVat += 1; }
    let pack = null;
    if (retail) {
      try {
        const y = Number(today.slice(0, 4)); const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3); const py = q === 0 ? y - 1 : y; const pq = q === 0 ? 3 : q - 1;
        const p = await computePack(`${py}-${String(pq * 3 + 1).padStart(2, '0')}-01`, new Date(Date.UTC(py, pq * 3 + 3, 0)).toISOString().slice(0, 10));
        pack = { status: 'OK', period: p.period, completeness: p.completeness.status, reconciliation: p.reconciliation.status, anomalies: p.anomalies.length, orders: p.retail.orders };
      } catch { pack = null; }
    }
    const inboxCounts = await inboxFor().counts(settings.defaults.currency).catch(() => ({ toReview: 0, TO_PAY: 0, toPayCents: 0, toPayForeign: 0 }));
    const actions = buildActions({
      today, currency: settings.defaults.currency, dueSoonDays: settings.dashboard.dueSoonDays, receivables: rec, inbox: inboxCounts, stock: await stock.status().catch(() => null),
      draftsMissingVat, awaitingApproval: docs.filter(({ doc }) => doc.status === 'READY_FOR_APPROVAL' && doc.type !== 'quote').length, quotesToConvert: docs.filter(({ doc }) => doc.type === 'quote' && doc.status === 'ACCEPTED').length,
      pack, settingsMissing: missingForInvoicing(settings).length,
    });
    json(ctx.res, 200, { asOf: today, currency: settings.defaults.currency, foreign: { salesDocuments: foreignSales, purchaseDocuments: inboxCounts.toPayForeign ?? 0 }, actions: actions.map((a) => ({ ...a, amount: a.cents != null ? money(a.cents, settings.defaults.language) : null })) });
  });

  on('GET', '/api/connectors', async (ctx) => json(ctx.res, 200, { connectors: connectorStatus({ accountingExport: deps.accountingExport, bankReconciliation: deps.bankReconciliation, customerPortal: deps.customerPortal, mail: mailer(), accessPoint: accessPoint(), inbox: INBOX_ADAPTERS }) }));

  // ---------- Peppol: provider-neutral states and topology. Nothing is transmitted without a configured Access Point AND the merchant's approval. ----------
  const accessPoint = () => deps.accessPoint ?? NullAccessPointAdapter;
  const apConfigured = () => accessPoint().name !== 'none';
  const peppolStateOf = (events) => { const last = [...events].reverse().find((e) => /^PEPPOL_/.test(e.action)); return last ? { status: last.action.replace('PEPPOL_', ''), at: last.at, providerMessageId: last.detail?.providerMessageId ?? null, detail: last.detail?.detail ?? null } : null; };
  on('GET', '/api/peppol/status', async (ctx) => {
    const settings = await settingsIo.load();
    json(ctx.res, 200, {
      outgoing: { configured: apConfigured(), adapter: accessPoint().name }, incoming: { configured: false, note: 'RECEIVING_DEPENDS_ON_CONFIRMED_TOPOLOGY' }, states: PEPPOL_STATUSES, topology: settings.peppol.topology,
      questions: ['WHO_OWNS_THE_RECEIVING_REGISTRATION', 'IS_CODABOX_VOILA_THE_RECEIVER', 'DOES_IT_EXPOSE_AN_EXPORT_OR_API', 'SEND_ONLY_OR_INTEGRATE_EXISTING'],
      warning: 'DO_NOT_REGISTER_A_SECOND_RECEIVING_ACCESS_POINT_BEFORE_THE_TOPOLOGY_IS_CONFIRMED', decided: settings.peppol.topology.mode !== 'undecided',
    });
  });
  const peppolDoc = async (ctx) => { const { svc, settings } = await servicesFor(); const doc = await svc.get(idParam(ctx.m[1])); return { svc, settings, doc }; };
  on('POST', `/api/documents/${P}/peppol/send`, async (ctx) => {
    const { svc, settings, doc } = await peppolDoc(ctx);
    if (ctx.body?.approve !== true) throw new HttpError(422, 'APPROVAL_REQUIRED');
    if (!apConfigured()) throw new HttpError(409, 'PEPPOL_ACCESS_POINT_NOT_CONFIGURED');
    if (settings.peppol.topology.mode === 'undecided') throw new HttpError(409, 'PEPPOL_TOPOLOGY_NOT_CONFIRMED');
    if (!doc.lockedAt || !['invoice', 'credit_note'].includes(doc.type)) throw new HttpError(409, 'ONLY_ISSUED_INVOICES_AND_CREDIT_NOTES_CAN_BE_SENT');
    const events = await svc.events(doc.id);
    if (peppolStateOf(events) && ['SENT', 'DELIVERED'].includes(peppolStateOf(events).status)) throw new HttpError(409, 'ALREADY_SENT_VIA_PEPPOL');
    const original = doc.type === 'credit_note' && doc.relatedDocumentId ? (await svc.get(doc.relatedDocumentId).catch(() => null))?.number : null;
    const prepared = prepareTransmission(doc, { originalNumber: original, defaultBuyerReference: settings.peppol.defaultBuyerReference });
    if (prepared.status !== 'PREPARED') throw new HttpError(422, 'PEPPOL_NOT_READY', { errors: prepared.errors, transmitted: false });
    await audit({ at: clock.now(), action: 'PEPPOL_SEND_APPROVED', detail: { documentId: doc.id, number: doc.number } });
    let r; try { r = await accessPoint().submit({ payloadXml: prepared.payloadXml, sender: prepared.sender, receiver: prepared.receiver, documentNumber: doc.number }); } catch (e) { await store.appendEvent({ ...transmissionEvent(doc.id, merchantId, { status: 'FAILED', at: clock.now(), detail: String(e.message).slice(0, 120) }) }); throw new HttpError(502, 'PEPPOL_SEND_FAILED'); }
    await store.appendEvent(transmissionEvent(doc.id, merchantId, { status: 'SENT', at: clock.now(), providerMessageId: r.providerMessageId ?? null }));
    json(ctx.res, 200, { status: 'SENT', providerMessageId: r.providerMessageId ?? null });
  });
  on('POST', `/api/documents/${P}/peppol/refresh`, async (ctx) => {
    const { svc, doc } = await peppolDoc(ctx);
    if (!apConfigured()) throw new HttpError(409, 'PEPPOL_ACCESS_POINT_NOT_CONFIGURED');
    const cur = peppolStateOf(await svc.events(doc.id)); if (!cur?.providerMessageId) throw new HttpError(409, 'NOTHING_SENT_YET');
    const s = await accessPoint().fetchStatus(cur.providerMessageId);
    if (PEPPOL_STATUSES.includes(s.status) && s.status !== cur.status) await store.appendEvent(transmissionEvent(doc.id, merchantId, { status: s.status, at: s.at ?? clock.now(), providerMessageId: cur.providerMessageId, detail: s.detail ?? null }));
    json(ctx.res, 200, { status: s.status });
  });

  // ---------- Finance Inbox + Purchases: private attachments, human review, no mailbox access ----------
  const attachmentStore = deps.attachmentStore ?? createMemoryAttachmentStore();
  const inboxFor = () => createInboxService({ store, attachments: attachmentStore, extractor: deps.documentExtractor ?? defaultExtractor, merchantId, now: clock.now, audit });
  const itemView = (raw) => { const r = new Proxy(raw, { get: (t, k) => t[k] ?? null }); return {
    id: r.id, source: r.source, status: r.status, supplierName: r.supplierName, supplierVatNumber: r.supplierVatNumber, supplierCompanyId: r.supplierCompanyId, invoiceNumber: r.invoiceNumber, issueDate: r.issueDate, dueDate: r.dueDate,
    netCents: r.netCents, vatCents: r.vatCents, grossCents: r.grossCents, currency: r.currency, paymentReference: r.paymentReference, fileName: r.fileName, contentType: r.contentType, sizeBytes: r.sizeBytes, receivedAt: r.receivedAt,
    fromAddress: r.fromAddress, subject: r.subject, extraction: r.extraction, validatedAt: r.validatedAt, paidAt: r.paidAt, paidReference: r.paidReference, rejectedReason: r.rejectedReason, hasFile: !!r.attachmentRef,
    net: r.netCents == null ? null : formatCents(r.netCents), vat: r.vatCents == null ? null : formatCents(r.vatCents), gross: r.grossCents == null ? null : formatCents(r.grossCents),
    errors: validationErrorsFor(raw),
    capture: (() => { const c = r.extraction?.capture; return c ? { kind: c.kind, origin: c.origin, capturedAt: c.capturedAt, category: c.category ?? null, paymentMethod: c.paymentMethod ?? null, note: c.note ?? null, eurAmountCents: c.eurAmountCents ?? null, eurAmountSource: c.eurAmountSource ?? null,
      vatRateBp: c.vatRateBp ?? null, hasOriginal: !!c.original, originalContentType: c.original?.contentType ?? null, originalFileName: c.original?.fileName ?? null, pdfGenerated: !!c.pdf?.generated } : null; })(),
    receipt: (() => { const c = r.extraction?.receipt; return c ? { hasOriginal: !!c.original, originalContentType: c.original?.contentType ?? null, originalFileName: c.original?.fileName ?? null, pdfGenerated: !!c.pdf?.generated, attachedAt: c.attachedAt } : null; })(),
  }; };
  // merchant-typed capture metadata (category, payment method, note, EUR amount actually charged): sanitised, never computed
  const captureMetaInput = (b = {}) => {
    const out = {};
    if ('category' in b) out.category = String(b.category ?? '');
    if ('paymentMethod' in b) out.paymentMethod = String(b.paymentMethod ?? '');
    if ('note' in b) out.note = sanitizeText(b.note, 300);
    if ('eur' in b) { if (b.eur === '' || b.eur == null) out.eurAmountCents = null; else { const c = toCents(String(b.eur)); if (!Number.isInteger(c) || c <= 0) fields([{ field: 'eur', code: 'AMOUNT_INVALID' }]); out.eurAmountCents = c; } }
    if ('vatRate' in b) { if (b.vatRate === '' || b.vatRate == null) out.vatRateBp = null; else { const bp = percentToBp(String(b.vatRate)); if (!Number.isInteger(bp) || bp < 0 || bp > 10000) fields([{ field: 'vatRate', code: 'VAT_RATE_INVALID' }]); out.vatRateBp = bp; } }
    return out;
  };
  const AMOUNTS = ['netCents', 'vatCents', 'grossCents'];
  const inboxInput = (b) => {
    const out = {}; const errors = [];
    for (const k of ['supplierName', 'supplierVatNumber', 'invoiceNumber', 'paymentReference']) if (k in (b ?? {})) out[k] = sanitizeText(b[k], 120);
    for (const k of ['issueDate', 'dueDate']) if (k in (b ?? {})) { if (b[k] === '' || b[k] == null) out[k] = null; else if (isDate(b[k])) out[k] = b[k]; else errors.push({ field: k, code: 'DATE_INVALID' }); }
    if ('currency' in (b ?? {})) { const c = sanitizeText(b.currency, 3)?.toUpperCase(); if (!c || /^[A-Z]{3}$/.test(c)) out.currency = c ?? null; else errors.push({ field: 'currency', code: 'CURRENCY_INVALID' }); }
    for (const k of ['net', 'vat', 'gross']) if (k in (b ?? {})) { if (b[k] === '' || b[k] == null) out[`${k}Cents`] = null; else { const c = toCents(String(b[k])); if (Number.isInteger(c) && c >= 0) out[`${k}Cents`] = c; else errors.push({ field: k, code: 'AMOUNT_INVALID' }); } }
    return { out, errors };
  };
  on('GET', '/api/inbox/status', async (ctx) => {
    const settings = await settingsIo.load(); const inbox = inboxFor();
    json(ctx.res, 200, { counts: await inbox.counts(settings.defaults.currency), adapters: INBOX_ADAPTERS.map((a) => (a.name === 'email' ? { ...a, financeAddressSet: !!settings.inbox.financeAddress } : a)), statuses: INBOX_STATUSES, extractor: (deps.documentExtractor ?? defaultExtractor).label });
  });
  on('GET', '/api/inbox', async (ctx) => {
    const st = ctx.url.searchParams.get('scope');
    const f = st === 'purchases' ? { statuses: ['VALIDATED', 'TO_PAY', 'PAID'] } : st === 'inbox' ? { statuses: ['RECEIVED', 'TO_REVIEW', 'REJECTED'] } : {};
    const status = ctx.url.searchParams.get('status'); if (status && INBOX_STATUSES.includes(status)) f.status = status;
    json(ctx.res, 200, { rows: (await inboxFor().list(f)).map(itemView) });
  });
  // Upload as JSON (base64): sniffed, size-limited, stored privately, extracted, then left TO_REVIEW for a person. Same file twice = same record.
  on('POST', '/api/inbox/upload', async (ctx) => {
    const name = sanitizeText(ctx.body?.fileName, 120); const b64 = typeof ctx.body?.dataBase64 === 'string' ? ctx.body.dataBase64 : '';
    if (!name || !b64) fields([{ field: 'file', code: 'REQUIRED' }]);
    const r = await inboxFor().ingest({ source: 'upload', fileName: name, data: Buffer.from(b64, 'base64') });
    json(ctx.res, r.duplicate ? 200 : 201, { duplicate: r.duplicate, item: itemView(r.item) });
  }, { bodyLimit: 9_000_000 });
  // Expense capture (camera photo / image / PDF): the original is stored untouched, an image also gets a PDF container; the merchant reviews the fields.
  on('POST', '/api/inbox/capture', async (ctx) => {
    const b = ctx.body ?? {}; const name = sanitizeText(b.fileName, 120); const b64 = typeof b.dataBase64 === 'string' ? b.dataBase64 : '';
    if (!name || !b64) fields([{ field: 'file', code: 'REQUIRED' }]);
    const { out, errors } = inboxInput(b.fields ?? {}); if (errors.length) fields(errors);
    const r = await inboxFor().captureExpense({ fileName: name, data: Buffer.from(b64, 'base64'), origin: typeof b.origin === 'string' ? b.origin : 'image', fields: out, meta: captureMetaInput(b.capture ?? {}) }, actor);
    json(ctx.res, r.duplicate ? 200 : 201, { duplicate: r.duplicate, item: itemView(r.item) });
  }, { bodyLimit: 17_500_000 });
  on('POST', `/api/inbox/${P}/attach`, async (ctx) => {
    const name = sanitizeText(ctx.body?.fileName, 120); const b64 = typeof ctx.body?.dataBase64 === 'string' ? ctx.body.dataBase64 : '';
    if (!name || !b64) fields([{ field: 'file', code: 'REQUIRED' }]);
    json(ctx.res, 200, itemView(await inboxFor().attachDocument(idParam(ctx.m[1]), { fileName: name, data: Buffer.from(b64, 'base64') }, actor)));
  }, { bodyLimit: 17_500_000 });
  on('GET', `/api/inbox/${P}/original`, async (ctx) => {
    const f = await inboxFor().originalFile(idParam(ctx.m[1]));
    send(ctx.res, 200, f.data, { 'Content-Type': f.contentType, 'Content-Disposition': `inline; filename="${String(f.fileName).replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  });
  on('POST', '/api/inbox/manual', async (ctx) => { const { out, errors } = inboxInput(ctx.body); if (errors.length) fields(errors); json(ctx.res, 201, itemView(await inboxFor().createManual(out, actor))); });
  on('GET', `/api/inbox/${P}`, async (ctx) => json(ctx.res, 200, itemView(await inboxFor().get(idParam(ctx.m[1])))));
  on('PUT', `/api/inbox/${P}`, async (ctx) => {
    const { out, errors } = inboxInput(ctx.body); if (errors.length) fields(errors);
    const meta = ctx.body?.capture ? captureMetaInput(ctx.body.capture) : null; const svc = inboxFor(); const id = idParam(ctx.m[1]);
    let saved = await svc.update(id, out, actor); if (meta) saved = await svc.updateCapture(id, meta, actor);
    json(ctx.res, 200, itemView(saved));
  });
  on('GET', `/api/inbox/${P}/file`, async (ctx) => {
    const f = await inboxFor().file(idParam(ctx.m[1]));
    send(ctx.res, 200, f.data, { 'Content-Type': f.contentType, 'Content-Disposition': `inline; filename="${String(f.fileName).replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  });
  const inboxAct = (path, fn) => on('POST', `/api/inbox/${P}/${path}`, async (ctx) => json(ctx.res, 200, itemView(await fn(inboxFor(), idParam(ctx.m[1]), ctx.body ?? {}))));
  inboxAct('validate', (i, id) => i.validate(id, actor));
  inboxAct('to-pay', (i, id) => i.markToPay(id, actor));
  inboxAct('reopen', (i, id) => i.reopen(id, actor));
  inboxAct('reject', (i, id, b) => i.reject(id, sanitizeText(b.reason, 300), actor));
  inboxAct('pay', (i, id, b) => { const c = toCents(String(b.amount ?? '')); return i.pay(id, { paidOn: isDate(b.paidOn) ? b.paidOn : null, amountCents: Number.isInteger(c) ? c : null, reference: sanitizeText(b.reference, 100) }, actor); });
  // Phase 1 (Contact foundation): link/unlink a supplier invoice to a fin_companies contact. { contactId: "<uuid>" }
  // links; { contactId: null } (or omitted) unlinks. The tenant check on the contact happens here (via the same
  // svc.getCompany() every other company lookup uses) because inbox.js's service has no access to the company store.
  on('POST', `/api/inbox/${P}/contact`, async (ctx) => {
    const { svc } = await servicesFor();
    const raw = ctx.body?.contactId;
    const contactId = raw == null || raw === '' ? null : String(raw);
    if (contactId) await svc.getCompany(contactId); // throws COMPANY_NOT_FOUND if missing or a different merchant's contact
    json(ctx.res, 200, itemView(await inboxFor().linkContact(idParam(ctx.m[1]), contactId, actor)));
  });

  // ---------- accountant closing package: prepare -> preview -> merchant APPROVES -> send (or .eml fallback). Nothing is sent silently. ----------
  const packages = new Map(); // in memory only: the package is never written to disk; it expires
  const mailer = () => deps.mailAdapter ?? NoMailAdapter;
  const prune = () => { for (const [k, v] of packages) if (v.expires < Date.now()) packages.delete(k); };
  const inRange = (d, a, b) => typeof d === 'string' && d.slice(0, 10) >= a && d.slice(0, 10) <= b;
  on('POST', '/api/accountant/prepare', async (ctx) => {
    prune();
    let period; try { period = resolvePeriod(ctx.body ?? {}); } catch { fields([{ field: 'period', code: 'PERIOD_INVALID' }]); }
    const settings = await settingsIo.load();
    const pack = await computePack(period.start, period.end);
    const { data } = await retail.ledgerData(period.start);
    const all = await loadDocsForReports(store, merchantId);
    const byId = new Map(all.map((x) => [x.doc.id, x.doc]));
    const docs = all.filter(({ doc }) => doc.lockedAt && ['invoice', 'credit_note'].includes(doc.type) && doc.currency === pack.currency && inRange(doc.issueDate, period.start, period.end))
      .map(({ doc, payments, creditNotes }) => ({ doc, settlement: doc.type === 'invoice' ? settlementOf(doc, payments, creditNotes) : null, originalNumber: doc.type === 'credit_note' ? byId.get(doc.relatedDocumentId)?.number ?? null : null }));
    const refunds = refundRows(data, (d) => inRange(d, period.start, period.end));
    const supplierInvoices = ((await store.listSupplierInvoices?.()) ?? []).filter((s) => inRange(s.issue_date ?? s.issueDate, period.start, period.end)).map((s) => ({ supplierName: s.supplier_name ?? s.supplierName, supplierVatNumber: s.supplier_vat_number ?? s.supplierVatNumber, invoiceNumber: s.invoice_number ?? s.invoiceNumber, issueDate: s.issue_date ?? s.issueDate, dueDate: s.due_date ?? s.dueDate, netCents: Number(s.net_cents ?? s.netCents), vatCents: Number(s.vat_cents ?? s.vatCents), grossCents: Number(s.gross_cents ?? s.grossCents), status: s.status ?? s.payment_status ?? s.paymentStatus, source: s.source, attachmentRef: s.attachment_ref ?? s.attachmentRef }));
    const acc = settings.accountant;
    const built = await buildAccountantPackage({ pack, period, docs, refunds, supplierInvoices, merchantName: settings.seller.name ?? '', filePrefix: 'Comptabilite', namePrefix: acc.packageName || undefined, branding: settings.branding, generatedAt: clock.now() });
    const msg = accountantMessage({ merchantName: settings.seller.name ?? '', accountantName: acc.name, periodLabel: period.label, zipName: built.fileName, completeness: built.completeness });
    const id = randomUUID();
    const preview = {
      id, period, fileName: built.fileName, size: built.zip.length, sha256: built.sha256, completeness: built.completeness, counts: built.counts, files: built.files,
      recipient: { name: acc.name, email: acc.email, configured: !!acc.email }, subject: msg.subject, body: msg.text,
      attachments: [{ name: built.fileName, size: built.zip.length, sha256: built.sha256 }],
      canSendDirectly: mailer().canSend && !!acc.email, sendChannel: mailer().label, requiresApproval: true, sent: false,
      warnings: [...(!acc.email ? ['ACCOUNTANT_EMAIL_MISSING'] : []), ...(built.completeness !== 'COMPLETE' ? ['PACK_INCOMPLETE'] : []), ...(!mailer().canSend ? ['DIRECT_SEND_NOT_CONFIGURED'] : [])],
    };
    packages.set(id, { preview, zip: built.zip, message: msg, from: settings.seller.email ?? '', expires: Date.now() + 30 * 60_000, approvedAt: null, sentAt: null });
    await audit({ at: clock.now(), action: 'ACCOUNTANT_PACKAGE_PREPARED', detail: { period: period.label, files: built.files.length, sha256: built.sha256, recipientConfigured: !!acc.email } });
    json(ctx.res, 200, { ...preview, downloadUrl: `/api/accountant/package/${id}/download`, emlUrl: `/api/accountant/package/${id}/eml` });
  });
  const pkgOf = (ctx) => { prune(); const p = packages.get(idParam(ctx.m[1])); if (!p) throw new HttpError(404, 'PACKAGE_NOT_FOUND'); return p; };
  on('GET', `/api/accountant/package/${P}/download`, async (ctx) => { const p = pkgOf(ctx); send(ctx.res, 200, p.zip, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${p.preview.fileName}"` }); });
  on('GET', `/api/accountant/package/${P}/eml`, async (ctx) => {
    const p = pkgOf(ctx); const settings = await settingsIo.load();
    const eml = buildEml({ from: p.from, to: settings.accountant.email, subject: p.message.subject, text: p.message.text, attachments: [{ name: p.preview.fileName, contentType: 'application/zip', data: p.zip }] });
    await audit({ at: clock.now(), action: 'ACCOUNTANT_PACKAGE_EML_EXPORTED', detail: { period: p.preview.period.label, sha256: p.preview.sha256 } });
    send(ctx.res, 200, eml, { 'Content-Type': 'message/rfc822', 'Content-Disposition': `attachment; filename="${p.preview.fileName.replace(/\.zip$/, '')}.eml"` });
  });
  // The merchant's APPROVE: the request must name the exact recipient shown in the preview, so a changed recipient can never ride on an old approval.
  on('POST', `/api/accountant/package/${P}/send`, async (ctx) => {
    const p = pkgOf(ctx); const settings = await settingsIo.load();
    if (ctx.body?.approve !== true) throw new HttpError(422, 'APPROVAL_REQUIRED');
    if (p.sentAt) throw new HttpError(409, 'ALREADY_SENT');
    const to = settings.accountant.email;
    if (!to) throw new HttpError(422, 'ACCOUNTANT_EMAIL_MISSING');
    if (ctx.body?.recipient !== to || to !== p.preview.recipient.email) throw new HttpError(409, 'RECIPIENT_CHANGED_SINCE_PREVIEW');
    if (!mailer().canSend) throw new HttpError(409, 'DIRECT_SEND_NOT_CONFIGURED', { eml: `/api/accountant/package/${ctx.m[1]}/eml` });
    p.approvedAt = clock.now();
    await audit({ at: clock.now(), action: 'ACCOUNTANT_PACKAGE_APPROVED', detail: { period: p.preview.period.label, sha256: p.preview.sha256 } });
    let r;
    try { r = await mailer().send({ from: p.from, to, subject: p.message.subject, text: p.message.text, attachments: [{ name: p.preview.fileName, contentType: 'application/zip', data: p.zip }] }); } catch (e) { await audit({ at: clock.now(), action: 'ACCOUNTANT_PACKAGE_SEND_FAILED', detail: { error: String(e.code ?? e.message).slice(0, 80) } }); throw new HttpError(502, 'SEND_FAILED'); }
    p.sentAt = clock.now(); p.preview.sent = true;
    await audit({ at: clock.now(), action: 'ACCOUNTANT_PACKAGE_SENT', detail: { period: p.preview.period.label, sha256: p.preview.sha256, messageId: r.messageId ?? null } });
    json(ctx.res, 200, { status: 'SENT', messageId: r.messageId ?? null, sentAt: p.sentAt });
  });

  // ---------- Pack comptable v1: prepare -> control -> complete -> download (complete pack or one category at a time) ----------
  const periodFromQuery = (q) => ({ kind: q.get('kind'), year: Number(q.get('year')), quarter: Number(q.get('quarter')), month: Number(q.get('month')), from: q.get('from'), to: q.get('to') });
  /** Everything the pack is built from, read once. `withFiles` also fetches the stored attachments (needed to build files, not to show the page). */
  async function gatherPackComptable(spec, { withFiles = false } = {}) {
    let period; try { period = resolvePeriod(spec ?? {}); } catch { fields([{ field: 'period', code: 'PERIOD_INVALID' }]); }
    const settings = await settingsIo.load();
    const pack = await computePack(period.start, period.end);
    const { data } = await retail.ledgerData(period.start);
    const all = await loadDocsForReports(store, merchantId);
    const byId = new Map(all.map((x) => [x.doc.id, x.doc]));
    const docs = all.filter(({ doc }) => doc.lockedAt && ['invoice', 'credit_note'].includes(doc.type) && doc.currency === pack.currency && inRange(doc.issueDate, period.start, period.end))
      .map(({ doc, payments, creditNotes }) => ({ doc, settlement: doc.type === 'invoice' ? settlementOf(doc, payments, creditNotes) : null, originalNumber: doc.type === 'credit_note' ? byId.get(doc.relatedDocumentId)?.number ?? null : null }));
    const refunds = refundRows(data, (d) => inRange(d, period.start, period.end));
    const rows = (await store.listSupplierInvoices(merchantId)).filter((r) => r.status !== 'REJECTED');
    const purchases = rows.filter((r) => inRange(r.issueDate, period.start, period.end)).map((r) => ({ ...r }));
    if (withFiles) {
      for (const r of purchases) {
        if (!r.attachmentRef) continue;
        const f = await attachmentStore.get(r.attachmentRef).catch(() => null);
        if (!f) { r._attachmentMissing = true; continue; }
        r._data = f.data;
        const o = originalOf(r);
        if (o && pdfOf(r)?.generated) { const of = await attachmentStore.get(o.ref).catch(() => null); if (of) r._original = of.data; }
      }
    }
    const tx = await store.listBankTransactions({ merchantId });
    const dates = tx.map((t) => t.date).filter(Boolean).sort();
    const cash = (await store.listCashMovements(merchantId)).filter((m) => inRange(m.date, period.start, period.end));
    return {
      period, pack, currency: pack.currency, merchantName: settings.seller.name ?? '', namePrefix: settings.accountant?.packageName || undefined, branding: settings.branding,
      invoices: docs.filter((d) => d.doc.type === 'invoice'), creditNotes: docs.filter((d) => d.doc.type === 'credit_note'), refunds, purchases, undatedInbox: rows.filter((r) => !r.issueDate).length,
      bank: { transactions: tx.filter((t) => inRange(t.date, period.start, period.end)), allCount: tx.length, first: dates[0] ?? null, last: dates.at(-1) ?? null }, cash: { movements: cash }, generatedAt: clock.now(), settings,
    };
  }
  const packEvents = async () => historyFromEvents(await store.listEventsForMerchant({ merchantId, limit: 1000 }));
  const historyView = (r) => ({ packId: r.packId, label: r.label, period: r.period, version: r.version, versionLabel: r.versionLabel, generatedAt: r.generatedAt, generatedBy: r.generatedBy, verdict: r.verdict, completeness: r.completeness, counts: r.counts, fileCount: r.fileCount, sha256: r.sha256, size: r.size, fileName: r.fileName, warnings: r.warnings,
    downloadUrl: `/api/pack-comptable/history/${r.packId}/download`, categories: CATEGORIES.map((c) => ({ id: c.id, count: r.categories?.find((x) => x.id === c.id)?.count ?? null, status: r.categories?.find((x) => x.id === c.id)?.status ?? null, url: `/api/pack-comptable/history/${r.packId}/category?category=${c.id}` })) });
  const modelView = (input, model, history) => {
    const versions = history.filter((h) => h.label === packLabel(input.period)); const latest = versions[0] ?? null;
    return { model, preview: previewCounts(model, {}, input), history: { versions: versions.map(historyView), latest: latest ? historyView(latest) : null, changed: latest ? changesSince(latest.fingerprint, fingerprintOf(input)) : null } };
  };
  on('POST', '/api/pack-comptable/status', async (ctx) => {
    if (!retail) throw new HttpError(503, 'RETAIL_SOURCE_UNAVAILABLE');
    const input = await gatherPackComptable(ctx.body);
    json(ctx.res, 200, { period: input.period, ...modelView(input, analyzePack(input), await packEvents()) });
  });
  on('POST', '/api/pack-comptable/preview', async (ctx) => {
    if (!retail) throw new HttpError(503, 'RETAIL_SOURCE_UNAVAILABLE');
    const input = await gatherPackComptable(ctx.body?.period); const model = analyzePack(input);
    json(ctx.res, 200, { counts: previewCounts(model, ctx.body?.include, input), blocking: model.counts.blocking, warnings: model.counts.warnings, verdict: model.verdict, completeness: model.completeness });
  });
  on('POST', '/api/pack-comptable/generate', async (ctx) => {
    if (!retail) throw new HttpError(503, 'RETAIL_SOURCE_UNAVAILABLE');
    const include = normalizeInclude(ctx.body?.include);
    const input = await gatherPackComptable(ctx.body?.period, { withFiles: true }); const model = analyzePack(input);
    if (model.counts.blocking) throw new HttpError(422, 'PACK_HAS_BLOCKING_ISSUES', { blocking: model.issues.filter((i) => i.level === 'blocking').map((i) => i.code) });
    if (model.verdict !== 'ready' && ctx.body?.acknowledgeWarnings !== true) throw new HttpError(422, 'WARNINGS_NOT_ACKNOWLEDGED', { warnings: model.counts.warnings });
    const history = await packEvents(); const label = packLabel(input.period); const n = nextVersion(history, label); const versionLabel = `v${n}.0`;
    const built = await buildPackComptable({ input, model, include, version: versionLabel });
    const packId = randomUUID(); const storageRef = `${merchantId}/packs/${label}/v${n}_${built.sha256.slice(0, 12)}.zip`;
    await attachmentStore.put(storageRef, built.zip, { contentType: 'application/zip' });
    const record = { packId, label, period: { start: input.period.start, end: input.period.end, kind: input.period.kind, label: input.period.label }, version: n, versionLabel, generatedAt: input.generatedAt, generatedBy: 'merchant', verdict: model.verdict, completeness: model.completeness,
      counts: built.counts, categories: model.categories.map((c) => ({ id: c.id, count: c.count, status: c.status })), fileCount: built.fileCount, sha256: built.sha256, size: built.size, fileName: built.fileName, storageRef, warnings: model.counts.warnings, include, fingerprint: fingerprintOf(input) };
    await store.appendEvent({ merchantId, documentId: null, at: input.generatedAt, actor, action: PACK_ACTION, detail: record });
    await audit({ at: clock.now(), action: 'PACK_COMPTABLE_GENERATED', detail: { label, version: versionLabel, sha256: built.sha256, verdict: model.verdict, warnings: model.counts.warnings } });
    // the same in-memory package the existing "send to accountant" step (approval-gated) works from
    const acc = input.settings.accountant; const msg = accountantMessage({ merchantName: input.merchantName, accountantName: acc.name, periodLabel: input.period.label, zipName: built.fileName, completeness: model.completeness });
    prune(); packages.set(packId, { preview: { id: packId, period: input.period, fileName: built.fileName, size: built.size, sha256: built.sha256, completeness: model.completeness, counts: { invoices: built.counts.invoices, creditNotes: built.counts.creditNotes, refunds: input.refunds.length, supplierInvoices: built.counts.purchases }, files: built.files,
      recipient: { name: acc.name, email: acc.email, configured: !!acc.email }, subject: msg.subject, body: msg.text, attachments: [{ name: built.fileName, size: built.size, sha256: built.sha256 }], canSendDirectly: mailer().canSend && !!acc.email, sendChannel: mailer().label, requiresApproval: true, sent: false,
      warnings: [...(!acc.email ? ['ACCOUNTANT_EMAIL_MISSING'] : []), ...(!mailer().canSend ? ['DIRECT_SEND_NOT_CONFIGURED'] : [])] }, zip: built.zip, message: msg, from: input.settings.seller.email ?? '', expires: Date.now() + 30 * 60_000, approvedAt: null, sentAt: null });
    const pv = packages.get(packId).preview;
    json(ctx.res, 200, { record: historyView(record), send: { ...pv, downloadUrl: `/api/accountant/package/${packId}/download`, emlUrl: `/api/accountant/package/${packId}/eml` } });
  });
  on('GET', '/api/pack-comptable/category', async (ctx) => {
    if (!retail) throw new HttpError(503, 'RETAIL_SOURCE_UNAVAILABLE');
    const category = ctx.url.searchParams.get('category');
    if (!CATEGORIES.some((c) => c.id === category)) fields([{ field: 'category', code: 'CATEGORY_UNKNOWN' }]);
    const input = await gatherPackComptable(periodFromQuery(ctx.url.searchParams), { withFiles: true }); const model = analyzePack(input);
    let built; try { built = await buildCategoryPackage({ input, model, category }); } catch (e) { if (e.code === 'CATEGORY_EMPTY') throw new HttpError(422, 'CATEGORY_EMPTY'); throw e; }
    await audit({ at: clock.now(), action: 'PACK_COMPTABLE_CATEGORY_DOWNLOADED', detail: { category, label: packLabel(input.period), sha256: built.sha256 } });
    send(ctx.res, 200, built.zip, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${safeName(built.fileName)}"`, 'Cache-Control': 'no-store' });
  });
  on('GET', '/api/pack-comptable/history', async (ctx) => json(ctx.res, 200, { rows: (await packEvents()).map(historyView) }));
  const historyRecord = async (ctx) => { const id = idParam(ctx.m[1]); const r = (await packEvents()).find((x) => x.packId === id); if (!r) throw new HttpError(404, 'PACK_NOT_FOUND'); return r; };
  on('GET', `/api/pack-comptable/history/${P}/download`, async (ctx) => {
    const r = await historyRecord(ctx); const f = await attachmentStore.get(r.storageRef);
    if (!f) throw new HttpError(404, 'PACK_FILE_NOT_STORED');
    await audit({ at: clock.now(), action: 'PACK_COMPTABLE_DOWNLOADED', detail: { packId: r.packId, versionLabel: r.versionLabel } });
    send(ctx.res, 200, f.data, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${safeName(r.fileName)}"`, 'Cache-Control': 'no-store' });
  });
  on('GET', `/api/pack-comptable/history/${P}/category`, async (ctx) => {
    const r = await historyRecord(ctx); const f = await attachmentStore.get(r.storageRef);
    if (!f) throw new HttpError(404, 'PACK_FILE_NOT_STORED');
    const category = ctx.url.searchParams.get('category'); if (!CATEGORIES.some((c) => c.id === category)) fields([{ field: 'category', code: 'CATEGORY_UNKNOWN' }]);
    let out; try { out = categoryFromStoredZip(f.data, category); } catch (e) { if (e.code === 'CATEGORY_EMPTY') throw new HttpError(422, 'CATEGORY_EMPTY'); throw e; }
    send(ctx.res, 200, out.zip, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${safeName(out.fileName)}"`, 'Cache-Control': 'no-store' });
  });

  // ---------- stock synchronisation (Shopify stays the source of truth; Finance keeps an append-only movement ledger) ----------
  on('GET', '/api/stock/status', async (ctx) => { const { stock } = await servicesFor(); json(ctx.res, 200, await stock.status()); });
  on('GET', '/api/stock/movements', async (ctx) => {
    const { stock } = await servicesFor();
    const documentId = ctx.url.searchParams.get('documentId');
    json(ctx.res, 200, { rows: await stock.list(documentId && ID.test(documentId) ? { documentId } : {}) });
  });
  on('POST', '/api/stock/apply', async (ctx) => { const { stock } = await servicesFor(); json(ctx.res, 200, await stock.applyPending()); });
  on('POST', '/api/stock/reconcile', async (ctx) => {
    const { stock } = await servicesFor();
    const docs = (await store.listDocuments({ merchantId })).filter((d) => d.lockedAt && (d.type === 'invoice' || d.type === 'credit_note'));
    json(ctx.res, 200, await stock.reconcile(docs, (id) => store.getDocument(id)));
  });
  on('POST', `/api/stock/movements/${P}/retry`, async (ctx) => {
    const { stock } = await servicesFor();
    const applied = typeof ctx.body?.appliedInShopify === 'boolean' ? ctx.body.appliedInShopify : null;
    json(ctx.res, 200, await stock.retry(idParam(ctx.m[1]), { appliedInShopify: applied }));
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
    const allDocs = await loadDocsForReports(store, merchantId);
    const docs = allDocs.filter(({ doc }) => isNative(doc, settings.defaults.currency));
    const foreignDocuments = allDocs.filter(({ doc }) => !isNative(doc, settings.defaults.currency) && doc.type === 'invoice' && doc.lockedAt).length;
    const r = buildReceivables(docs, { today: clock.today(), dueSoonDays: settings.dashboard.dueSoonDays });
    const m = (c) => money(c, settings.defaults.language);
    json(ctx.res, 200, { ...r, foreignDocuments, unpaid: { ...r.unpaid, outstanding: m(r.unpaid.outstandingCents) }, overdue: { ...r.overdue, outstanding: m(r.overdue.outstandingCents) }, due_soon: { ...r.due_soon, outstanding: m(r.due_soon.outstandingCents) }, aging: Object.fromEntries(Object.entries(r.aging).map(([k, v]) => [k, { ...v, outstanding: m(v.outstandingCents) }])), invoices: r.invoices.map((i) => ({ ...i, remaining: m(i.remainingCents), gross: m(i.grossCents) })) });
  });

  // ---------- Sales/Purchases analytics (unified Finance module): product-level for sales (real
  // catalogue/sku data on lines), supplier/status-level only for purchases (supplier invoices carry no line
  // items) - see analytics.js's own module note for exactly why. All from/to filtering happens server-side
  // on data already loaded once (loadDocsForReports/listSupplierInvoices), never a per-row query. ----------
  const dateParam = (ctx, key) => { const v = ctx.url.searchParams.get(key); return v && isDate(v) ? v : undefined; };
  on('GET', '/api/sales/analytics', async (ctx) => {
    const { settings } = await servicesFor();
    const m = (c) => money(c, settings.defaults.language);
    const salesDocs = await loadDocsForReports(store, merchantId);
    json(ctx.res, 200, buildSalesAnalytics(salesDocs, { from: dateParam(ctx, 'from'), to: dateParam(ctx, 'to'), q: ctx.url.searchParams.get('q') ?? '', m, currency: settings.defaults.currency }));
  });
  on('GET', '/api/purchases/analytics', async (ctx) => {
    const { settings } = await servicesFor();
    const m = (c) => money(c, settings.defaults.language);
    const supplierInvoices = await store.listSupplierInvoices(merchantId);
    json(ctx.res, 200, buildPurchaseAnalytics(supplierInvoices, { from: dateParam(ctx, 'from'), to: dateParam(ctx, 'to'), q: ctx.url.searchParams.get('q') ?? '', m, currency: settings.defaults.currency }));
  });
  // Compact period report (Sales/Purchases/Credit notes/Net/VAT/counts) - complements, never replaces, the
  // Accountant Pack below (still the authoritative per-rate VAT export for actually closing a period).
  on('GET', '/api/period-report', async (ctx) => {
    const { settings } = await servicesFor();
    const m = (c) => money(c, settings.defaults.language);
    const [salesDocs, supplierInvoices] = await Promise.all([loadDocsForReports(store, merchantId), store.listSupplierInvoices(merchantId)]);
    const r = buildPeriodReport(salesDocs, supplierInvoices, { from: dateParam(ctx, 'from'), to: dateParam(ctx, 'to'), currency: settings.defaults.currency });
    json(ctx.res, 200, { ...r, sales: { ...r.sales, gross: m(r.sales.grossCents) }, creditNotes: { ...r.creditNotes, gross: m(r.creditNotes.grossCents) }, purchases: { ...r.purchases, gross: m(r.purchases.grossCents) }, netSalesAfterCredits: m(r.netSalesAfterCreditsCents), vat: m(r.vatCents) });
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
      if (!(deps.allowedHosts ? deps.allowedHosts.includes(host.toLowerCase()) : LOCAL_HOST.test(host))) throw new HttpError(403, 'HOST_NOT_ALLOWED');
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET') { const shared = await readNordlaShared(url.pathname); if (shared) return send(res, 200, shared.body, { 'Content-Type': shared.type, 'Cache-Control': 'no-store' }); }
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
      const body = mutating ? await readBody(req, route.r.bodyLimit) : undefined;
      await route.r.fn({ req, res, url, m: route.m, body, session });
    } catch (e) { errorResponse(res, e); }
  }

  return { handler, sessions, validateForIssue, orderTotalsFromLedger };
}
