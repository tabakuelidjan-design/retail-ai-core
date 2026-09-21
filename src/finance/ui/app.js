'use strict';
// Finance dashboard UI. Rules: (1) no innerHTML anywhere: every piece of text goes through text nodes, so free text can never become
// markup; (2) the browser NEVER calculates money, VAT or status: it sends inputs and shows what the server (the deterministic
// finance engine) returns; (3) every action is a server call that re-validates.

const state = { csrf: null, settings: null, missing: [] };
const app = document.getElementById('app');

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style') { for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } } // CSSOM, not an inline style attribute: allowed by the strict CSP
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c))); };
  kids.forEach(add);
  return el;
}
/** Append only when there is something to append (a conditional element may be null). */
const mount = (parent, node) => { if (node) parent.appendChild(node); return parent; };
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
const show = (...nodes) => { clear(app); nodes.forEach((n) => app.appendChild(n)); };

// ---------- text helpers ----------
const TXT = {
  REQUIRED: 'Required', QUANTITY_INVALID: 'Enter a quantity (up to 3 decimals)', UNIT_PRICE_INVALID: 'Enter a unit price (up to 4 decimals)', VAT_RATE_INVALID: 'Choose a VAT rate', DISCOUNT_INVALID: 'Invalid discount',
  DATE_INVALID: 'Invalid date', AMOUNT_INVALID: 'Enter an amount like 12.34', EMAIL_INVALID: 'Invalid email address', IBAN_INVALID: 'Invalid IBAN', COUNTRY_CODE_INVALID: 'Use a 2-letter country code',
  AT_LEAST_ONE_LINE_REQUIRED: 'Add at least one line', NOT_READY_FOR_APPROVAL: 'Fix the items listed below first', NOT_READY_TO_ISSUE: 'Fix the items listed below first', INVALID_TRANSITION: 'This action is not allowed in the current status',
  SOURCE_ORDER_ALREADY_INVOICED: 'This shop/POS order already has an active invoice', CONCURRENT_MODIFICATION: 'The document changed meanwhile: reload and retry', DOCUMENT_LOCKED: 'Issued documents cannot be edited: create a credit note instead',
  PAYMENT_EXCEEDS_REMAINING: 'The payment is higher than the amount still due', CREDIT_EXCEEDS_INVOICE: 'The credit is higher than what can still be credited', COMPANY_ALREADY_EXISTS: 'This company is already in the directory',
  INVALID_TOKEN: 'Wrong access token', TOO_MANY_ATTEMPTS: 'Too many attempts. Wait a few minutes.', AUTHENTICATION_REQUIRED: 'Please log in again',
  VAT_TREATMENT_NOT_CONFIRMED_BY_MERCHANT: 'Confirm the VAT treatment', REVENUE_BASIS_NOT_DECLARED: 'Choose whether this invoice is linked to a shop order or a new B2B sale',
  CUSTOMER_COMPANY_NUMBER_MISSING: 'Enter the customer VAT or enterprise number', SELLER_NAME_MISSING: 'Complete your company details in Settings', SELLER_VAT_NUMBER_MISSING: 'Add your VAT number in Settings',
  PAYMENT_INSTRUCTIONS_MISSING: 'Add your IBAN in Settings (or payment terms on the invoice)', DUE_DATE_MISSING_OR_INVALID: 'Set a due date', LINKED_BASIS_WITHOUT_SOURCE_ORDER: 'Select the shop/POS order to link',
  SOURCE_ORDER_NOT_FOUND_IN_RETAIL_CORE: 'The linked order was not found', CREDIT_REASON_MISSING: 'Give a reason for the credit note',
};
const human = (code) => { const c = String(code).split(' ')[0].split('(')[0]; if (TXT[c]) return TXT[c]; if (/^LINE_\d+_/.test(c)) return `Line ${c.split('_')[1]}: ${c.split('_').slice(2).join(' ').toLowerCase()}`; if (/^CUSTOMER_ADDRESS_/.test(c)) return `Customer address: ${c.replace('CUSTOMER_ADDRESS_', '').replace('_MISSING', '').toLowerCase()} is missing`; if (/^POSSIBLE_DUPLICATE/.test(c)) return 'This looks like a shop sale that is not linked. Link it, or confirm it is a separate sale.'; return c.replace(/_/g, ' ').toLowerCase().replace(/^./, (x) => x.toUpperCase()); };
const STATUS = { DRAFT: 'Draft', READY_FOR_APPROVAL: 'Ready for approval', ISSUED: 'Issued', SENT: 'Sent', PARTIALLY_PAID: 'Partially paid', PAID: 'Paid', OVERDUE: 'Overdue', CREDITED: 'Credited', CANCELLED: 'Cancelled', ACCEPTED: 'Accepted', REJECTED: 'Rejected', CONVERTED: 'Converted' };
const badge = (s) => h('span', { class: `badge ${s}` }, STATUS[s] || s);
const TYPE = { invoice: 'Invoice', quote: 'Quote', credit_note: 'Credit note' };
const REGIME = { domestic: 'Domestic - VAT charged', intra_eu_b2b_exempt: 'Intra-EU B2B - VAT exempt', reverse_charge: 'Reverse charge (customer accounts for VAT)', export_outside_eu: 'Export outside the EU', vat_exempt_small_business: 'VAT-exempt (small business scheme)' };

function toast(msg, kind) { const t = h('div', { class: `toast ${kind || ''}` }, msg); document.body.appendChild(t); setTimeout(() => t.remove(), 4200); }

// ---------- API ----------
class ApiError extends Error { constructor(status, body) { super((body && body.error && body.error.code) || 'ERROR'); this.status = status; this.code = this.message; this.fields = (body && body.error && body.error.fields) || null; this.extra = (body && body.error) || {}; } }
async function api(method, path, body) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf || '' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : null;
  if (res.status === 401 && path !== '/api/login') { state.csrf = null; renderLogin(); throw new ApiError(401, data); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
function fail(e, into) {
  if (!(e instanceof ApiError)) console.error('UI error:', e && e.stack ? e.stack : e);
  const msg = e instanceof ApiError ? human(e.code) : 'Something went wrong';
  if (into) { clear(into); into.appendChild(h('div', { class: 'banner bad' }, msg, e.fields ? h('ul', { class: 'plain' }, e.fields.map((f) => h('li', null, `${f.field}: ${human(f.code)}`))) : null, e.extra && e.extra.message ? h('div', { class: 'small' }, human(e.extra.message)) : null)); } else toast(msg, 'bad');
}

// ---------- modal ----------
function modal(title, body, buttons) {
  const back = h('div', { class: 'modal-back', on: { click: (ev) => { if (ev.target === back) back.remove(); } } });
  const box = h('div', { class: 'modal' }, h('h2', null, title), body, h('div', { class: 'actions', style: 'margin-top:14px' }, buttons(() => back.remove())));
  back.appendChild(box); document.body.appendChild(back);
  return back;
}

// ---------- layout ----------
const NAV = [['#/', 'Overview'], ['#/invoices', 'Invoices'], ['#/quotes', 'Quotes'], ['#/companies', 'Companies'], ['#/receivables', 'Payments'], ['#/pack', 'Accountant pack'], ['#/settings', 'Settings']];
function layout(active, ...content) {
  const side = h('nav', { class: 'side' }, h('div', { class: 'brand' }, (state.settings && state.settings.seller && state.settings.seller.name) || 'Finance'),
    NAV.map(([href, label]) => h('a', { href, class: href === active ? 'active' : '' }, label)),
    h('div', { class: 'foot' }, h('div', null, 'Peppol: NOT CONFIGURED'), h('div', null, 'Nothing is sent externally.'), h('button', { style: 'margin-top:10px', on: { click: async () => { await api('POST', '/api/logout', {}).catch(() => {}); state.csrf = null; renderLogin(); } } }, 'Log out')));
  const main = h('main', { class: 'main' }, content);
  show(h('div', { class: 'shell' }, side, main));
  return main;
}
function applyAccent() { const a = state.settings && state.settings.branding && state.settings.branding.accent; if (/^#[0-9a-fA-F]{6}$/.test(a || '')) document.documentElement.style.setProperty('--accent', a); }
async function loadSettings() { const r = await api('GET', '/api/settings'); state.settings = r.settings; state.missing = r.missing; state.regimes = r.vatRegimes; applyAccent(); return r; }

// ---------- login ----------
function renderLogin() {
  const inp = h('input', { type: 'password', placeholder: 'Access token', autocomplete: 'current-password' });
  const msg = h('div');
  const go = async () => { try { const r = await api('POST', '/api/login', { token: inp.value }); state.csrf = r.csrf; inp.value = ''; await loadSettings(); route(); } catch (e) { fail(e, msg); } };
  inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
  show(h('div', { class: 'login card' }, h('h1', null, 'Finance'), h('p', { class: 'muted' }, 'Enter the access token stored in your .env file (FINANCE_DASHBOARD_TOKEN).'), h('div', { class: 'field' }, inp), msg, h('button', { class: 'primary', on: { click: go } }, 'Log in')));
  inp.focus();
}

// ---------- overview ----------
async function viewOverview() {
  const main = layout('#/', h('div', { class: 'topbar' }, h('div', null, h('h1', null, 'Overview'), h('div', { class: 'muted small' }, 'What needs your attention')), h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/new/invoice' }, 'New invoice'), h('a', { class: 'btn', href: '#/new/quote' }, 'New quote'))));
  const box = h('div'); main.appendChild(box);
  try {
    const o = await api('GET', '/api/overview');
    const stat = (n, l, cls, href) => h('a', { href, style: 'text-decoration:none;color:inherit' }, h('div', { class: `card stat ${cls || ''}` }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l)));
    mount(box, o.settingsMissing.length ? h('div', { class: 'banner warn' }, h('strong', null, 'Finish your setup before issuing real invoices: '), `${o.settingsMissing.length} setting(s) missing. `, h('a', { href: '#/settings' }, 'Open settings')) : null);
    box.appendChild(h('div', { class: 'grid cards' },
      stat(o.counts.unpaid, `Unpaid invoices (${o.amounts.outstanding} ${o.currency})`, '', '#/receivables'),
      stat(o.counts.overdue, `Overdue (${o.amounts.overdue} ${o.currency})`, o.counts.overdue ? 'bad' : '', '#/receivables'),
      stat(`${o.amounts.paidThisMonth}`, `Paid this month (${o.amounts.paidThisMonthCount} payment(s))`, 'ok', '#/receivables'),
      stat(o.counts.awaitingApproval, 'Awaiting your approval', o.counts.awaitingApproval ? 'warn' : '', '#/invoices?status=READY_FOR_APPROVAL'),
      stat(o.counts.quotesAwaitingResponse, 'Quotes awaiting response', '', '#/quotes?status=SENT'),
      stat(o.counts.quotesToConvert, 'Accepted quotes to convert', o.counts.quotesToConvert ? 'warn' : '', '#/quotes?status=ACCEPTED')));
    const overdueRows = o.attention.overdue.map((r) => h('tr', null, h('td', null, r.number), h('td', null, r.customer), h('td', { class: 'num' }, `${r.daysOverdue} days`), h('td', { class: 'num' }, r.remaining)));
    box.appendChild(h('div', { class: 'grid two', style: 'margin-top:16px' },
      h('div', { class: 'card' }, h('h2', null, 'Overdue invoices'), overdueRows.length ? h('table', null, h('tr', null, h('th', null, 'Invoice'), h('th', null, 'Customer'), h('th', { class: 'num' }, 'Late'), h('th', { class: 'num' }, 'Due')), overdueRows) : h('div', { class: 'muted' }, 'Nothing overdue.')),
      h('div', { class: 'card' }, h('h2', null, 'Waiting for you'),
        o.attention.awaitingApproval.length ? h('div', null, h('h3', null, 'To approve'), o.attention.awaitingApproval.map((r) => h('div', null, h('a', { href: `#/doc/${r.id}` }, `${TYPE[r.type]} - ${r.customer} - ${r.gross}`)))) : null,
        o.attention.quotes.length ? h('div', { style: 'margin-top:8px' }, h('h3', null, 'Quotes'), o.attention.quotes.map((r) => h('div', null, h('a', { href: `#/doc/${r.id}` }, `${r.number || 'Quote'} - ${r.customer} - ${STATUS[r.status]}${r.expired ? ' (expired)' : ''}`)))) : null,
        !o.attention.awaitingApproval.length && !o.attention.quotes.length ? h('div', { class: 'muted' }, 'Nothing is waiting.') : null)));
    box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Ageing of unpaid invoices'), h('table', null, h('tr', null, ['Not yet due', '0-7 days', '8-30 days', '31-60 days', '60+ days'].map((x) => h('th', { class: 'num' }, x))), h('tr', null, ['not_due', '0_7', '8_30', '31_60', '60_plus'].map((k) => h('td', { class: 'num' }, `${o.aging[k].amount} (${o.aging[k].count})`))))));
    const packCard = h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Accountant pack - last closed quarter'), h('div', { class: 'muted' }, 'Checking...'));
    box.appendChild(packCard);
    api('GET', '/api/overview/pack').then((p) => { clear(packCard); packCard.appendChild(h('h2', null, 'Accountant pack - last closed quarter')); if (p.status !== 'OK') return packCard.appendChild(h('div', { class: 'muted' }, 'Retail data is not available.')); packCard.appendChild(h('div', { class: 'actions' }, h('span', null, `${p.period.start} to ${p.period.end}`), h('span', { class: `badge ${p.completeness}` }, p.completeness), h('span', { class: `badge ${p.reconciliation}` }, p.reconciliation), p.anomalies ? h('span', { class: 'badge PARTIAL' }, `${p.anomalies} anomaly(ies)`) : null, h('a', { href: '#/pack' }, 'Open the pack'))); if (p.reasons.length) packCard.appendChild(h('ul', { class: 'plain small muted' }, p.reasons.map((r) => h('li', null, human(r))))); }).catch(() => { clear(packCard); packCard.appendChild(h('div', { class: 'muted' }, 'Pack status unavailable.')); });
  } catch (e) { fail(e, box); }
}

// ---------- document lists ----------
const INV_FILTERS = [['', 'All'], ['DRAFT', 'Draft'], ['READY_FOR_APPROVAL', 'Ready for approval'], ['ISSUED', 'Issued'], ['SENT', 'Sent'], ['PARTIALLY_PAID', 'Partially paid'], ['PAID', 'Paid'], ['OVERDUE', 'Overdue'], ['CREDITED', 'Credited']];
const QUOTE_FILTERS = [['', 'All'], ['DRAFT', 'Draft'], ['SENT', 'Sent'], ['ACCEPTED', 'Accepted'], ['REJECTED', 'Rejected'], ['CONVERTED', 'Converted']];
async function viewList(kind, query) {
  const isQuote = kind === 'quote';
  const status = query.get('status') || '';
  const main = layout(isQuote ? '#/quotes' : '#/invoices', h('div', { class: 'topbar' }, h('div', null, h('h1', null, isQuote ? 'Quotes' : 'Invoices')), h('a', { class: 'btn primary', href: `#/new/${kind}` }, isQuote ? 'New quote' : 'New invoice')));
  const base = isQuote ? '#/quotes' : '#/invoices';
  main.appendChild(h('div', { class: 'pills' }, (isQuote ? QUOTE_FILTERS : INV_FILTERS).map(([v, l]) => h('a', { class: `pill ${status === v ? 'active' : ''}`, href: v ? `${base}?status=${v}` : base, style: 'text-decoration:none' }, l))));
  const box = h('div', { class: 'card' }); main.appendChild(box);
  try {
    const types = isQuote ? ['quote'] : ['invoice', 'credit_note'];
    const lists = await Promise.all(types.map((t) => api('GET', `/api/documents?type=${t}${status ? `&status=${status}` : ''}`)));
    const rows = lists.flatMap((l) => l.rows).sort((a, b) => String(b.issueDate).localeCompare(String(a.issueDate)));
    box.appendChild(rows.length ? h('table', null, h('tr', null, ['Number', 'Type', 'Customer', 'Date', isQuote ? 'Valid until' : 'Due', 'Total', isQuote ? '' : 'Still due', 'Status'].map((x, i) => h('th', { class: i === 5 || i === 6 ? 'num' : '' }, x))),
      rows.map((r) => h('tr', { class: 'click', on: { click: () => { location.hash = `#/doc/${r.id}`; } } }, h('td', null, r.number || h('span', { class: 'muted' }, 'not numbered yet')), h('td', null, TYPE[r.type]), h('td', null, r.customer), h('td', { class: 'nowrap' }, r.issueDate), h('td', { class: 'nowrap' }, (isQuote ? r.validUntil : r.dueDate) || ''), h('td', { class: 'num' }, r.gross ? `${r.gross} ${r.currency}` : ''), h('td', { class: 'num' }, r.remaining && r.type === 'invoice' ? r.remaining : ''), h('td', null, badge(r.effectiveStatus))))) : h('div', { class: 'muted' }, 'Nothing here yet.'));
  } catch (e) { fail(e, box); }
}

// ---------- document form (new / edit) ----------
async function viewForm(kind, editId) {
  const isQuote = kind === 'quote';
  const main = layout(isQuote ? '#/quotes' : '#/invoices', h('div', { class: 'topbar' }, h('h1', null, `${editId ? 'Edit draft' : 'New'} ${isQuote ? 'quote' : 'invoice'}`)));
  const errBox = h('div');
  const s = state.settings;
  let doc = null;
  if (editId) { try { doc = await api('GET', `/api/documents/${editId}`); } catch (e) { return fail(e, main); } }
  const D = doc ? doc.doc : null;
  const model = {
    companyId: D && D.customer.companyId || null, name: D ? D.customer.name : '', vatNumber: D ? (D.customer.vatNumber || D.customer.enterpriseNumber || '') : '',
    street: D ? D.customer.address.street : '', postalCode: D ? D.customer.address.postalCode : '', city: D ? D.customer.address.city : '', countryCode: D ? D.customer.address.countryCode : 'BE', email: D ? (D.customer.email || '') : '',
    issueDate: D ? D.issueDate : new Date().toISOString().slice(0, 10), dueDate: D ? (D.dueDate || '') : '', paymentTermsDays: D ? (D.paymentTermsDays ?? '') : s.defaults.paymentTermsDays, paymentTerms: D ? (D.paymentTerms || '') : (s.defaults.paymentTerms || ''),
    validUntil: D ? (D.validUntil || '') : '', currency: D ? D.currency : s.defaults.currency, language: D ? D.language : s.defaults.language, notes: D ? (D.notes || '') : '',
    regime: D ? D.vat.regime : 'domestic', confirmed: D ? D.vat.confirmed : false, mention: D ? (D.vat.mention || '') : '',
    basis: D ? D.revenueBasis : (isQuote ? null : 'standalone_b2b'), sourceOrderId: D ? D.sourceOrderId : null, sourceLabel: null, ack: D ? !!D.acknowledgedNotDuplicate : false, saveCompany: true,
    lines: D ? D.lines.map((l) => ({ description: l.description, quantity: String(l.qtyMilli / 1000), unit: l.unit || '', unitPrice: String(l.priceMicro / 10000), discountKind: l.discountBp ? 'percent' : 'amount', discount: l.discountBp ? String(l.discountBp / 100) : l.discountCents ? String(l.discountCents / 100) : '', vatRate: String(l.vatRateBp / 100) })) : [{ description: '', quantity: '1', unit: '', unitPrice: '', discountKind: 'percent', discount: '', vatRate: s.vat.allowedRatesBp.length ? String(s.vat.allowedRatesBp[0] / 100) : '' }],
  };
  const totalsBox = h('div', { class: 'card totals' });
  const linesBody = h('tbody');
  let calcTimer = null; let calcSeq = 0; let lastCalc = null;

  const payload = () => ({
    type: kind, customer: { companyId: model.companyId || undefined, kind: 'business', name: model.name, vatNumber: model.vatNumber, address: { street: model.street, postalCode: model.postalCode, city: model.city, countryCode: model.countryCode }, email: model.email || undefined },
    issueDate: model.issueDate, dueDate: model.dueDate || undefined, paymentTermsDays: model.paymentTermsDays === '' ? undefined : Number(model.paymentTermsDays), paymentTerms: model.paymentTerms, validUntil: isQuote ? (model.validUntil || undefined) : undefined,
    currency: model.currency, language: model.language, notes: model.notes, vat: { regime: model.regime, confirmed: model.confirmed, mention: model.mention },
    revenueBasis: isQuote ? undefined : model.basis, sourceOrderId: model.basis === 'linked_source_order' ? model.sourceOrderId : undefined, acknowledgedNotDuplicate: model.ack,
    lines: model.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit || undefined, unitPrice: l.unitPrice, vatRate: model.regime === 'domestic' ? l.vatRate : '0', discountPercent: l.discountKind === 'percent' && l.discount ? l.discount : undefined, discountAmount: l.discountKind === 'amount' && l.discount ? l.discount : undefined })),
  });

  function scheduleCalc() { clearTimeout(calcTimer); calcTimer = setTimeout(runCalc, 250); }
  async function runCalc() {
    const seq = ++calcSeq;
    try {
      const p = payload();
      const r = await api('POST', '/api/calc', { lines: p.lines, vat: p.vat, customer: { vatNumber: p.customer.vatNumber, countryCode: p.customer.address.countryCode }, currency: p.currency, language: p.language });
      if (seq !== calcSeq) return; lastCalc = r; renderTotals(); renderLineTotals();
    } catch (e) { /* the next edit retries */ }
  }
  function renderTotals() {
    clear(totalsBox); totalsBox.appendChild(h('h2', null, 'Totals'));
    const t = lastCalc && lastCalc.totals;
    if (!t) { totalsBox.appendChild(h('div', { class: 'muted small' }, lastCalc && lastCalc.errors && lastCalc.errors.length ? 'Complete the lines to see totals.' : 'Add lines to see totals.')); return; }
    const row = (l, v, cls) => h('div', { class: `t ${cls || ''}` }, h('span', null, l), h('span', null, `${v} ${model.currency}`));
    totalsBox.appendChild(row('Subtotal excl. VAT', t.net)); if (t.discountCents > 0) totalsBox.appendChild(row('of which discounts', t.discount));
    t.vatBreakdown.forEach((g) => totalsBox.appendChild(row(`VAT ${g.vatRateBp / 100}% on ${g.taxable}`, g.vatAmount)));
    totalsBox.appendChild(row('Total VAT', t.vat)); totalsBox.appendChild(row('Total incl. VAT', t.gross, 'big')); if (!isQuote) totalsBox.appendChild(row('Amount due', t.gross));
    if (lastCalc.hints && lastCalc.hints.length) totalsBox.appendChild(h('div', { class: 'banner warn small', style: 'margin-top:10px' }, lastCalc.hints.map((x) => h('div', null, human(x)))));
    totalsBox.appendChild(h('div', { class: 'hint' }, 'Calculated by the finance engine, not by this page.'));
  }
  function renderLineTotals() { const t = lastCalc && lastCalc.totals; linesBody.querySelectorAll('[data-lt]').forEach((c) => { const i = Number(c.getAttribute('data-lt')); c.textContent = t && t.lines[i] ? `${t.lines[i].net}` : ''; }); }

  const bind = (obj, key, extra) => (ev) => { obj[key] = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value; if (extra) extra(); scheduleCalc(); };
  const field = (label, input, hint) => h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  const text = (key, ph, type) => h('input', { type: type || 'text', value: model[key] ?? '', placeholder: ph || '', on: { input: bind(model, key) } });

  function renderLines() {
    clear(linesBody);
    const rates = s.vat.allowedRatesBp.length ? s.vat.allowedRatesBp : [2100, 600, 0];
    model.lines.forEach((l, i) => {
      const rateSel = h('select', { on: { change: bind(l, 'vatRate') }, disabled: model.regime !== 'domestic' }, rates.map((bp) => h('option', { value: String(bp / 100), selected: String(bp / 100) === String(l.vatRate) }, `${bp / 100}%`)));
      if (model.regime !== 'domestic') rateSel.appendChild(h('option', { value: '0', selected: true }, '0%'));
      linesBody.appendChild(h('tr', null,
        h('td', { style: 'min-width:170px' }, h('input', { value: l.description, placeholder: 'Description', on: { input: bind(l, 'description') } })),
        h('td', { style: 'width:72px' }, h('input', { value: l.quantity, inputmode: 'decimal', on: { input: bind(l, 'quantity') } })),
        h('td', { style: 'width:72px' }, h('input', { value: l.unit, placeholder: 'unit', on: { input: bind(l, 'unit') } })),
        h('td', { style: 'width:100px' }, h('input', { value: l.unitPrice, inputmode: 'decimal', placeholder: '0.00', on: { input: bind(l, 'unitPrice') } })),
        h('td', { style: 'width:132px' }, h('div', { style: 'display:flex;gap:4px' }, h('input', { value: l.discount, inputmode: 'decimal', placeholder: '0', on: { input: bind(l, 'discount') } }), h('select', { style: 'width:70px', on: { change: bind(l, 'discountKind') } }, h('option', { value: 'percent', selected: l.discountKind === 'percent' }, '%'), h('option', { value: 'amount', selected: l.discountKind === 'amount' }, model.currency)))),
        h('td', { style: 'width:88px' }, rateSel),
        h('td', { class: 'num nowrap', 'data-lt': String(i) }, ''),
        h('td', null, model.lines.length > 1 ? h('button', { class: 'danger', on: { click: () => { model.lines.splice(i, 1); renderLines(); scheduleCalc(); } } }, 'x') : null)));
    });
    renderLineTotals();
  }

  // customer
  const companyPick = h('input', { placeholder: 'Search your company directory...', on: { input: async (ev) => { const q = ev.target.value; if (q.length < 2) return clear(pickList); try { const r = await api('GET', `/api/companies?q=${encodeURIComponent(q)}`); clear(pickList); r.rows.slice(0, 6).forEach((c) => pickList.appendChild(h('div', null, h('a', { href: '#', on: { click: (e2) => { e2.preventDefault(); Object.assign(model, { companyId: c.id, name: c.name, vatNumber: c.vatNumber || c.enterpriseNumber || '', street: c.address.street || '', postalCode: c.address.postalCode || '', city: c.address.city || '', countryCode: c.address.countryCode || 'BE', email: c.email || '' }); clear(pickList); renderCustomer(); scheduleCalc(); } } }, `${c.name} - ${c.vatNumber || c.enterpriseNumber || 'no number'}`)))); } catch (e) { /* ignore */ } } } });
  const pickList = h('div', { class: 'small', style: 'margin-top:4px' });
  const custBox = h('div');
  const lookupMsg = h('div', { class: 'hint' });
  function renderCustomer() {
    clear(custBox);
    mount(custBox, model.companyId ? h('div', { class: 'banner info small' }, 'Company from your directory. ', h('a', { href: '#', on: { click: (e) => { e.preventDefault(); model.companyId = null; renderCustomer(); } } }, 'Detach and edit manually')) : null);
    const ro = !!model.companyId;
    const inp = (key, ph) => h('input', { value: model[key] ?? '', placeholder: ph || '', disabled: ro, on: { input: bind(model, key) } });
    const vatIn = h('input', { value: model.vatNumber, placeholder: 'BE0123.456.789', disabled: ro, on: { input: bind(model, 'vatNumber') } });
    custBox.appendChild(h('div', { class: 'row r2' }, field('Company name', inp('name')), field('VAT / enterprise number', h('div', { style: 'display:flex;gap:6px' }, vatIn, h('button', { disabled: ro, on: { click: async (e) => { e.preventDefault(); clear(lookupMsg); try { const r = await api('POST', '/api/companies/lookup', { vatNumber: model.vatNumber || undefined, name: model.name || undefined }); if (r.status === 'FOUND') { Object.assign(model, { name: r.company.name, vatNumber: r.company.vatNumber, street: r.company.address.street || '', postalCode: r.company.address.postalCode || '', city: r.company.address.city || '', countryCode: r.company.address.countryCode || 'BE' }); renderCustomer(); toast('Official data found and filled in. Please check it.', 'ok'); } else lookupMsg.appendChild(h('span', { class: 'err' }, `${human(r.reason || r.status)}. ${r.message}`)); } catch (er) { fail(er); } } } }, 'Look up')), 'Look up uses the free EU VIES service and only runs when you click. You can always type the details yourself.')));
    custBox.appendChild(lookupMsg);
    custBox.appendChild(h('div', { class: 'row r4' }, field('Street and number', inp('street')), field('Postal code', inp('postalCode')), field('City', inp('city')), field('Country', inp('countryCode', 'BE'))));
    custBox.appendChild(field('Email (optional)', inp('email', 'accounts@company.example'), 'Stored only if you enter it. Not needed for the invoice.'));
    if (!model.companyId) custBox.appendChild(h('label', { style: 'color:inherit' }, h('input', { type: 'checkbox', checked: model.saveCompany, on: { change: (e) => { model.saveCompany = e.target.checked; } } }), 'Save this company to my directory'));
  }

  // revenue basis + order picker
  const basisBox = h('div');
  const orderResults = h('div');
  function renderBasis() {
    clear(basisBox);
    if (isQuote) return;
    const opt = (val, title, desc) => h('div', { class: `basis ${model.basis === val ? 'sel' : ''}`, on: { click: () => { model.basis = val; if (val === 'standalone_b2b') { model.sourceOrderId = null; model.sourceLabel = null; } renderBasis(); } } }, h('label', { style: 'color:var(--ink);font-weight:600;cursor:pointer' }, h('input', { type: 'radio', name: 'basis', checked: model.basis === val }), title), h('div', { class: 'small muted' }, desc));
    basisBox.appendChild(h('div', { class: 'row r2' }, opt('standalone_b2b', 'New B2B sale (outside the shop)', 'This is ADDITIVE revenue: it is counted on top of your shop and POS sales.'), opt('linked_source_order', 'Invoice for an existing shop / POS order', 'This invoice does NOT create additional revenue: the sale is already counted from the shop. Each order can have one active invoice.')));
    if (model.basis === 'linked_source_order') {
      basisBox.appendChild(h('div', { style: 'margin-top:12px' }, model.sourceOrderId ? h('div', { class: 'banner ok small' }, `Linked to order ${model.sourceLabel || model.sourceOrderId}. No additional revenue will be counted.`) : h('div', { class: 'banner warn small' }, 'Choose the order below.'), h('button', { on: { click: (e) => { e.preventDefault(); openPicker(); } } }, model.sourceOrderId ? 'Change order' : 'Find the order')));
    } else basisBox.appendChild(h('label', { style: 'margin-top:10px;color:inherit' }, h('input', { type: 'checkbox', checked: model.ack, on: { change: (e) => { model.ack = e.target.checked; } } }), 'Only if the system warns that this looks like a shop sale: confirm it is a separate sale.'));
  }
  function openPicker() {
    const q = h('input', { placeholder: 'Order number or product...' }); const from = h('input', { type: 'date' }); const to = h('input', { type: 'date' }); const min = h('input', { placeholder: 'min amount' }); const max = h('input', { placeholder: 'max amount' });
    const out = h('div'); const bk = modal('Select the shop / POS order', h('div', null, h('div', { class: 'row r2' }, field('Search', q), h('div', { class: 'row r2' }, field('From', from), field('To', to))), h('div', { class: 'row r2' }, field('Amount from', min), field('Amount to', max)), out), (close) => [h('button', { on: { click: close } }, 'Close')]);
    const run = async () => {
      try {
        const qs = new URLSearchParams(); if (q.value) qs.set('q', q.value); if (from.value) qs.set('from', from.value); if (to.value) qs.set('to', to.value); if (min.value) qs.set('min', min.value); if (max.value) qs.set('max', max.value);
        const r = await api('GET', `/api/orders?${qs}`); clear(out);
        out.appendChild(r.rows.length ? h('table', null, h('tr', null, ['Order', 'Date', 'Channel', 'Items', 'Total', ''].map((x, i) => h('th', { class: i === 4 ? 'num' : '' }, x))), r.rows.map((o) => h('tr', { class: `picker-row ${o.invoiced ? 'disabled' : ''}` }, h('td', null, `#${o.ref}`), h('td', { class: 'nowrap' }, o.date), h('td', null, o.channel), h('td', { class: 'small' }, o.items.join(', '), o.moreItems ? ` +${o.moreItems}` : ''), h('td', { class: 'num nowrap' }, `${o.total} ${model.currency}`, o.refunded ? h('div', { class: 'small muted' }, `refunded ${o.refunded}`) : null), h('td', null, o.invoiced ? h('span', { class: 'badge PARTIAL' }, `Invoiced ${o.invoiced.number || ''}`) : h('button', { class: 'primary', on: { click: () => { model.sourceOrderId = o.sourceOrderId; model.sourceLabel = `#${o.ref} (${o.date}, ${o.total})`; bk.remove(); renderBasis(); } } }, 'Select'))))) : h('div', { class: 'muted' }, 'No matching orders.'));
      } catch (e) { fail(e, out); }
    };
    [q, from, to, min, max].forEach((i) => i.addEventListener('input', () => { clearTimeout(run.t); run.t = setTimeout(run, 250); })); run();
  }

  // vat treatment
  const vatBox = h('div');
  function renderVat() {
    clear(vatBox);
    vatBox.appendChild(h('div', { class: 'row r2' }, field('VAT treatment', h('select', { on: { change: (e) => { model.regime = e.target.value; if (model.regime !== 'domestic') model.lines.forEach((l) => { l.vatRate = '0'; }); renderVat(); renderLines(); scheduleCalc(); } } }, Object.entries(REGIME).map(([k, v]) => h('option', { value: k, selected: model.regime === k }, v)))), h('div', { class: 'field' }, h('label', null, 'Your confirmation'), h('label', { style: 'color:var(--ink)' }, h('input', { type: 'checkbox', checked: model.confirmed, on: { change: (e) => { model.confirmed = e.target.checked; } } }), 'I confirm this VAT treatment applies to this document'))));
    if (model.regime !== 'domestic') vatBox.appendChild(field('Legal mention printed on the document', h('input', { value: model.mention, placeholder: 'e.g. VAT reverse charge - article 51 par. 2 ...', on: { input: bind(model, 'mention') } }), 'Required for this treatment. The system does not decide which text is legally correct: you do.'));
  }

  const dueField = h('input', { type: 'date', value: model.dueDate, on: { input: bind(model, 'dueDate') } });
  const save = async (thenSubmit) => {
    clear(errBox);
    try {
      const body = payload();
      if (!model.companyId && model.saveCompany && model.name && model.vatNumber) {
        try { const c = await api('POST', '/api/companies', { kind: 'business', name: model.name, vatNumber: model.vatNumber, address: { street: model.street, postalCode: model.postalCode, city: model.city, countryCode: model.countryCode }, email: model.email || undefined, source: 'manual' }); body.customer.companyId = c.id; model.companyId = c.id; } catch (e) { if (e.code !== 'COMPANY_ALREADY_EXISTS' && e.status !== 422) throw e; }
      }
      const saved = editId ? await api('PUT', `/api/documents/${editId}`, body) : await api('POST', '/api/documents', body);
      if (thenSubmit && !isQuote) { try { await api('POST', `/api/documents/${saved.id}/submit`, {}); toast('Submitted for approval', 'ok'); } catch (e) { toast('Saved as draft. Fix the listed items to submit.', 'bad'); } }
      else toast('Draft saved', 'ok');
      location.hash = `#/doc/${saved.id}`;
    } catch (e) { fail(e, errBox); window.scrollTo(0, 0); }
  };

  const form = h('div', { class: 'grid formgrid' },
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('h2', null, 'Customer'), field('Company', companyPick), pickList, custBox),
      h('div', { class: 'card' }, h('h2', null, 'Dates and terms'), h('div', { class: 'row r4' }, field('Issue date', h('input', { type: 'date', value: model.issueDate, on: { input: bind(model, 'issueDate') } })), isQuote ? field('Valid until', h('input', { type: 'date', value: model.validUntil, on: { input: bind(model, 'validUntil') } })) : field('Due date', dueField, 'Leave empty to use the payment terms'), field('Payment terms (days)', h('input', { value: String(model.paymentTermsDays), inputmode: 'numeric', on: { input: bind(model, 'paymentTermsDays') } })), field('Currency', h('input', { value: model.currency, on: { input: bind(model, 'currency') } }))), h('div', { class: 'row r2' }, field(isQuote ? 'Commercial terms' : 'Payment terms text', h('input', { value: model.paymentTerms, on: { input: bind(model, 'paymentTerms') } })), field('Document language', h('select', { on: { change: bind(model, 'language') } }, [['fr', 'Francais'], ['nl', 'Nederlands'], ['en', 'English']].map(([v, l]) => h('option', { value: v, selected: model.language === v }, l)))))),
      isQuote ? null : h('div', { class: 'card' }, h('h2', null, 'Revenue basis'), basisBox),
      h('div', { class: 'card' }, h('h2', null, 'VAT treatment'), vatBox),
      h('div', { class: 'card' }, h('h2', null, 'Lines'), h('div', { class: 'scrollx' }, h('table', { class: 'lines' }, h('thead', null, h('tr', null, ['Description', 'Qty', 'Unit', 'Unit price', 'Discount', 'VAT', 'Line total', ''].map((x, i) => h('th', { class: i === 6 ? 'num' : '' }, x)))), linesBody)), h('button', { style: 'margin-top:10px', on: { click: (e) => { e.preventDefault(); model.lines.push({ description: '', quantity: '1', unit: '', unitPrice: '', discountKind: 'percent', discount: '', vatRate: model.lines[0] ? model.lines[0].vatRate : '' }); renderLines(); } } }, 'Add a line')),
      h('div', { class: 'card' }, field('Notes (printed on the document)', h('textarea', { rows: 3, on: { input: bind(model, 'notes') } }, model.notes)))),
    h('div', null, totalsBox, h('div', { class: 'actions', style: 'margin-top:12px' }, h('button', { on: { click: () => save(false) } }, 'Save draft'), isQuote ? null : h('button', { class: 'primary', on: { click: () => save(true) } }, 'Save and review'))));
  main.appendChild(errBox); main.appendChild(form);
  renderCustomer(); renderBasis(); renderVat(); renderLines(); renderTotals(); runCalc();
}

// ---------- document detail / approval screen ----------
function kv(rows) { return h('div', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [h('div', null, k), h('div', null, v)])); }
function linesTable(d) {
  const t = d.totals;
  return h('table', null, h('tr', null, ['#', 'Description', 'Qty', 'Unit price', 'Discount', 'VAT', 'Net'].map((x, i) => h('th', { class: i >= 2 ? 'num' : '' }, x))), d.doc.lines.map((l, i) => h('tr', null, h('td', null, l.position), h('td', null, l.description), h('td', { class: 'num' }, t.lines[i].quantity), h('td', { class: 'num' }, t.lines[i].unitPrice), h('td', { class: 'num' }, t.lines[i].discount), h('td', { class: 'num' }, t.lines[i].vatRate), h('td', { class: 'num' }, t.lines[i].net))));
}
async function viewDoc(id) {
  const main = layout(null);
  const box = h('div'); main.appendChild(box);
  const reload = () => viewDoc(id);
  let d;
  try { d = await api('GET', `/api/documents/${id}`); } catch (e) { return fail(e, box); }
  const cur = d.currency;
  const has = (a) => d.actions.includes(a);
  const call = (path, body, msg) => async () => { try { await api('POST', `/api/documents/${id}/${path}`, body || {}); toast(msg, 'ok'); reload(); } catch (e) { fail(e); if (e.fields || e.code.startsWith('NOT_READY')) reload(); } };
  const isQ = d.type === 'quote';
  const top = h('div', { class: 'topbar' }, h('div', null, h('h1', null, `${TYPE[d.type]} ${d.number || '(draft)'}`), h('div', { class: 'actions' }, badge(d.effectiveStatus), h('span', { class: 'muted' }, d.customer), d.revenueBasis ? h('span', { class: 'badge' }, d.revenueBasis === 'linked_source_order' ? 'linked - no extra revenue' : 'standalone - additive') : null)),
    h('div', { class: 'actions' },
      has('edit') ? h('a', { class: 'btn', href: `#/doc/${id}/edit` }, 'Edit draft') : null,
      has('submit') ? h('button', { class: 'primary', on: { click: call('submit', {}, 'Submitted for approval') } }, 'Submit for approval') : null,
      has('send_quote') ? h('button', { class: 'primary', on: { click: () => confirmModal('Send quote', `This numbers the quote (${d.nextNumber || ''}) and locks it. Send the PDF to your customer yourself; the system sends nothing.`, 'Number and lock', call('send-quote', {}, 'Quote numbered')) } }, 'Mark as sent') : null,
      has('accept') ? h('button', { class: 'ok', on: { click: call('accept', {}, 'Quote accepted') } }, 'Accepted') : null,
      has('reject_quote') ? h('button', { class: 'danger', on: { click: call('reject-quote', {}, 'Quote rejected') } }, 'Rejected') : null,
      has('convert') ? h('button', { class: 'primary', on: { click: async () => { try { const r = await api('POST', `/api/documents/${id}/convert`, { revenueBasis: 'standalone_b2b' }); toast('Invoice draft created from the quote', 'ok'); location.hash = `#/doc/${r.id}`; } catch (e) { fail(e); } } } }, 'Convert to invoice') : null,
      has('mark_sent') ? h('button', { on: { click: () => confirmModal('Mark as sent', 'Record that you have sent this document to your customer. The system does not send anything.', 'Mark sent', call('mark-sent', {}, 'Marked as sent')) } }, 'Mark sent') : null,
      has('add_payment') ? h('button', { class: 'primary', on: { click: () => paymentModal(d, reload) } }, 'Add payment') : null,
      has('credit_note') ? h('button', { on: { click: () => creditModal(d) } }, 'Create credit note') : null,
      has('cancel') ? h('button', { class: 'danger', on: { click: () => confirmModal('Cancel draft', 'This draft will be cancelled. No number is used.', 'Cancel draft', call('cancel', {}, 'Draft cancelled')) } }, 'Cancel draft') : null,
      h('a', { class: 'btn', href: `/api/documents/${id}/pdf?download=1` }, 'Download PDF'),
      has('ubl') ? h('a', { class: 'btn', href: `/api/documents/${id}/ubl` }, 'Peppol/UBL file') : null));
  box.appendChild(top);
  if (d.status === 'READY_FOR_APPROVAL') {
    box.appendChild(h('div', { class: 'banner info' }, h('strong', null, 'Review before you approve. '), `Approving issues the document, assigns its number (${d.nextNumber || 'next in sequence'}) and freezes it. Afterwards it can only be corrected with a credit note. Nothing is sent to your customer.`, h('div', { class: 'actions', style: 'margin-top:10px' },
      h('button', { class: 'ok', on: { click: () => confirmModal('Approve and issue', `Issue this ${TYPE[d.type].toLowerCase()} now? It will receive the next number and cannot be edited afterwards.`, 'APPROVE', call('approve', {}, 'Issued')) } }, 'APPROVE'),
      h('button', { on: { click: call('modify', {}, 'Returned to draft') } }, 'MODIFY'),
      h('button', { class: 'danger', on: { click: () => confirmModal('Reject', 'The draft will be cancelled. No number is used.', 'REJECT', call('reject', {}, 'Rejected')) } }, 'REJECT'))));
  }
  if (d.readiness && !d.readiness.ready) box.appendChild(h('div', { class: 'banner bad' }, h('strong', null, 'Not ready to issue: '), h('ul', { class: 'plain' }, d.readiness.errors.map((x) => h('li', null, human(x))))));
  if (d.readiness && d.readiness.warnings.length) box.appendChild(h('div', { class: 'banner warn' }, h('ul', { class: 'plain' }, d.readiness.warnings.map((x) => h('li', null, human(x))))));
  if (d.revenueNote) box.appendChild(h('div', { class: `banner ${d.revenueBasis === 'linked_source_order' ? 'info' : 'ok'}` }, d.revenueNote));
  if (!d.integrity.ok) box.appendChild(h('div', { class: 'banner bad' }, 'INTEGRITY WARNING: the stored fingerprint does not match this document. Do not use it and contact support.'));
  const s = d.doc.seller || {}; const c = d.doc.customer;
  const addr = (a) => [a.street, `${a.postalCode || ''} ${a.city || ''}`.trim(), a.countryCode].filter(Boolean).join(', ');
  box.appendChild(h('div', { class: 'grid two' },
    h('div', { class: 'card' }, h('h2', null, 'Seller'), kv([['Name', s.name], ['Address', addr(s.address || {})], ['VAT', s.vatNumber], ['IBAN', s.iban]])),
    h('div', { class: 'card' }, h('h2', null, 'Customer'), kv([['Name', c.name], ['Address', addr(c.address || {})], ['VAT / no.', c.vatNumber || c.enterpriseNumber], ['Email', c.email]]))));
  box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Details'), kv([['Number', d.number || `(assigned on approval: ${d.nextNumber || 'next'})`], ['Issue date', d.issueDate], [isQ ? 'Valid until' : 'Due date', isQ ? d.validUntil : d.dueDate], ['Payment terms', d.doc.paymentTerms], ['VAT treatment', REGIME[d.doc.vat.regime]], ['Legal mention', d.doc.vat.mention], ['Language', d.doc.language], ['Notes', d.doc.notes],
    d.related ? ['Related', h('a', { href: `#/doc/${d.related.id}` }, `${TYPE[d.related.type]} ${d.related.number || ''}`)] : null, d.convertedInvoice ? ['Converted to', h('a', { href: `#/doc/${d.convertedInvoice.id}` }, `Invoice ${d.convertedInvoice.number || '(draft)'}`)] : null,
    d.sourceOrder ? ['Shop/POS order', `#${d.sourceOrder.ref} - ${d.sourceOrder.date} - ${d.sourceOrder.channel} - ${d.sourceOrder.total} ${cur}`] : null])));
  const t = d.totals;
  box.appendChild(h('div', { class: 'grid detailgrid', style: 'margin-top:16px' }, h('div', { class: 'card' }, h('h2', null, 'Lines'), linesTable(d)),
    h('div', { class: 'card' }, h('h2', null, 'Totals'), h('div', { class: 'kv', style: 'grid-template-columns:1fr auto' }, [['Subtotal excl. VAT', t.net], ...t.vatBreakdown.map((g) => [`VAT ${g.vatRateBp / 100}% on ${g.taxable}`, g.vatAmount]), ['Total VAT', t.vat], ['Total incl. VAT', t.gross], !isQ && d.settlementView ? ['Paid', d.settlementView.paid] : null, !isQ && d.settlementView && d.settlement.creditedCents ? ['Credited', d.settlementView.credited] : null, !isQ && d.settlementView ? ['Amount due', d.settlementView.remaining] : null].filter(Boolean).map(([k, v]) => [h('div', null, k), h('div', { class: 'right' }, `${v} ${cur}`)])))));
  if (d.payments.length) box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Payments'), h('table', null, h('tr', null, ['Date', 'Amount', 'Method', 'Reference'].map((x) => h('th', null, x))), d.payments.map((p) => h('tr', null, h('td', null, p.paidOn), h('td', null, `${p.amount} ${cur}`), h('td', null, p.method), h('td', null, p.reference || ''))))));
  if (d.creditNotes.length) box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Credit notes'), d.creditNotes.map((cn) => h('div', null, h('a', { href: `#/doc/${cn.id}` }, `${cn.number || '(draft)'} - ${cn.gross} ${cn.currency}`), ' ', badge(cn.status)))));
  const pdfWrap = h('div', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'topbar' }, h('h2', null, `PDF preview${d.doc.lockedAt ? '' : ' (draft watermark)'}`), h('button', { on: { click: (ev) => { ev.target.remove(); pdfWrap.appendChild(h('iframe', { class: 'pdf', src: `/api/documents/${id}/pdf`, title: 'PDF preview' })); } } }, 'Show preview')));
  box.appendChild(pdfWrap);
  box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Audit trail'), h('table', null, h('tr', null, ['When', 'Action', 'Status', 'By'].map((x) => h('th', null, x))), d.events.map((e) => h('tr', null, h('td', { class: 'nowrap small' }, String(e.at).replace('T', ' ').slice(0, 19)), h('td', null, human(e.action)), h('td', null, `${e.fromStatus ? STATUS[e.fromStatus] || e.fromStatus : ''} ${e.toStatus ? `-> ${STATUS[e.toStatus] || e.toStatus}` : ''}`), h('td', { class: 'small' }, e.actor ? `${e.actor.type}` : ''))))));
  box.appendChild(h('div', { class: 'small muted', style: 'margin-top:12px' }, 'Peppol: NOT CONFIGURED. Structured invoices can be prepared, but nothing is transmitted until a provider is selected.'));
}
function confirmModal(title, text, label, onYes) { modal(title, h('p', null, text), (close) => [h('button', { class: 'primary', on: { click: () => { close(); onYes(); } } }, label), h('button', { on: { click: close } }, 'Cancel')]); }
function paymentModal(d, reload) {
  const amt = h('input', { inputmode: 'decimal', placeholder: d.remaining }); const date = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const method = h('select', null, [['bank_transfer', 'Bank transfer'], ['cash', 'Cash'], ['card', 'Card'], ['other', 'Other']].map(([v, l]) => h('option', { value: v }, l))); const ref = h('input', { placeholder: 'Bank reference (optional)' }); const note = h('input', { placeholder: 'Note (optional)' }); const err = h('div');
  modal('Add a payment', h('div', null, h('p', { class: 'muted' }, `Still due: ${d.remaining} ${d.currency}`), err, h('div', { class: 'row r2' }, h('div', { class: 'field' }, h('label', null, 'Amount'), amt), h('div', { class: 'field' }, h('label', null, 'Date paid'), date)), h('div', { class: 'row r2' }, h('div', { class: 'field' }, h('label', null, 'Method'), method), h('div', { class: 'field' }, h('label', null, 'Reference'), ref)), h('div', { class: 'field' }, h('label', null, 'Note'), note)),
    (close) => [h('button', { class: 'primary', on: { click: async () => { try { await api('POST', `/api/documents/${d.id}/payments`, { amount: amt.value, paidOn: date.value, method: method.value, reference: ref.value || undefined, note: note.value || undefined }); close(); toast('Payment recorded', 'ok'); reload(); } catch (e) { fail(e, err); } } } }, 'Record payment'), h('button', { on: { click: close } }, 'Cancel')]);
}
function creditModal(d) {
  const reason = h('input', { placeholder: 'Reason (required)' }); const err = h('div'); const full = h('input', { type: 'checkbox', checked: true });
  const rows = d.doc.lines.map((l) => ({ description: l.description, quantity: String(l.qtyMilli / 1000), unitPrice: String(l.priceMicro / 10000), vatRate: String(l.vatRateBp / 100), discountPercent: l.discountBp ? String(l.discountBp / 100) : undefined }));
  const editor = h('div');
  const draw = () => { clear(editor); if (full.checked) return; rows.forEach((r, i) => editor.appendChild(h('div', { class: 'row r4', style: 'margin-bottom:6px' }, h('input', { value: r.description, on: { input: (e) => { r.description = e.target.value; } } }), h('input', { value: r.quantity, on: { input: (e) => { r.quantity = e.target.value; } } }), h('input', { value: r.unitPrice, on: { input: (e) => { r.unitPrice = e.target.value; } } }), h('button', { on: { click: () => { rows.splice(i, 1); draw(); } } }, 'Remove')))); };
  full.addEventListener('change', draw);
  modal('Create a credit note', h('div', null, h('p', { class: 'muted' }, 'A credit note corrects an issued invoice. The invoice itself is never changed.'), err, h('div', { class: 'field' }, h('label', null, 'Reason'), reason), h('label', { style: 'color:var(--ink)' }, full, 'Credit the whole invoice'), editor),
    (close) => [h('button', { class: 'primary', on: { click: async () => { try { const r = await api('POST', `/api/documents/${d.id}/credit-note`, { reason: reason.value, lines: full.checked ? undefined : rows }); close(); toast('Credit note draft created', 'ok'); location.hash = `#/doc/${r.id}`; } catch (e) { fail(e, err); } } } }, 'Create draft'), h('button', { on: { click: close } }, 'Cancel')]);
}

// ---------- companies ----------
async function viewCompanies() {
  const main = layout('#/companies', h('div', { class: 'topbar' }, h('h1', null, 'Companies'), h('button', { class: 'primary', on: { click: () => companyModal(null) } }, 'Add a company')));
  const q = h('input', { placeholder: 'Search name or VAT number...' }); const box = h('div', { class: 'card' });
  const load = async () => { try { const r = await api('GET', `/api/companies?q=${encodeURIComponent(q.value)}`); clear(box); box.appendChild(r.rows.length ? h('table', null, h('tr', null, ['Company', 'VAT / no.', 'City', 'Source'].map((x) => h('th', null, x))), r.rows.map((c) => h('tr', { class: 'click', on: { click: () => { location.hash = `#/companies/${c.id}`; } } }, h('td', null, c.name), h('td', null, c.vatNumber || c.enterpriseNumber || ''), h('td', null, c.address.city || ''), h('td', null, c.source)))) : h('div', { class: 'muted' }, 'No companies yet. They are added automatically when you create an invoice, or click "Add a company".')); } catch (e) { fail(e, box); } };
  q.addEventListener('input', () => { clearTimeout(load.t); load.t = setTimeout(load, 200); });
  main.appendChild(h('div', { class: 'field' }, q)); main.appendChild(box); load();
}
function companyModal(existing) {
  const m = existing ? { name: existing.name, vat: existing.vatNumber || existing.enterpriseNumber || '', street: existing.address.street || '', postalCode: existing.address.postalCode || '', city: existing.address.city || '', countryCode: existing.address.countryCode || 'BE', email: existing.email || '', source: existing.source || 'manual' } : { name: '', vat: '', street: '', postalCode: '', city: '', countryCode: 'BE', email: '', source: 'manual' };
  const err = h('div'); const msg = h('div', { class: 'hint' }); const fields = {};
  const inp = (k, label, ph) => { fields[k] = h('input', { value: m[k], placeholder: ph || '', on: { input: (e) => { m[k] = e.target.value; } } }); return h('div', { class: 'field' }, h('label', null, label), fields[k]); };
  const lookup = async () => { clear(msg); try { const r = await api('POST', '/api/companies/lookup', { vatNumber: m.vat || undefined, name: m.name || undefined }); if (r.status === 'FOUND') { Object.assign(m, { name: r.company.name, vat: r.company.vatNumber, street: r.company.address.street || '', postalCode: r.company.address.postalCode || '', city: r.company.address.city || '', countryCode: r.company.address.countryCode || 'BE', source: 'vies' }); Object.keys(fields).forEach((k) => { fields[k].value = m[k]; }); msg.appendChild(h('span', { class: 'ok' }, 'Official data found and filled in. Check it, then save.')); } else msg.appendChild(h('span', { class: 'err' }, `${human(r.reason || r.status)}. ${r.message}`)); } catch (e) { fail(e); } };
  modal(existing ? 'Edit company' : 'Add a company', h('div', null, err, inp('name', 'Company name'), h('div', { class: 'field' }, h('label', null, 'VAT / enterprise number'), h('div', { style: 'display:flex;gap:6px' }, (fields.vat = h('input', { value: m.vat, placeholder: 'BE0123.456.789', on: { input: (e) => { m.vat = e.target.value; } } })), h('button', { on: { click: lookup } }, 'Look up')), msg, h('div', { class: 'hint' }, 'Free EU VIES lookup runs only when you click. Manual entry always works.')), h('div', { class: 'row r2' }, inp('street', 'Street and number'), inp('postalCode', 'Postal code')), h('div', { class: 'row r2' }, inp('city', 'City'), inp('countryCode', 'Country (2 letters)')), inp('email', 'Email (optional)')),
    (close) => [h('button', { class: 'primary', on: { click: async () => { try { const body = { kind: 'business', name: m.name, vatNumber: m.vat, address: { street: m.street, postalCode: m.postalCode, city: m.city, countryCode: m.countryCode }, email: m.email || undefined, source: m.source }; const r = existing ? await api('PUT', `/api/companies/${existing.id}`, body) : await api('POST', '/api/companies', body); close(); toast('Company saved', 'ok'); location.hash = `#/companies/${r.id}`; if (existing) route(); } catch (e) { fail(e, err); } } } }, 'Save'), h('button', { on: { click: close } }, 'Cancel')]);
}
async function viewCompany(id) {
  const main = layout('#/companies'); const box = h('div'); main.appendChild(box);
  try {
    const r = await api('GET', `/api/companies/${id}`); const c = r.company; const cur = state.settings.defaults.currency; const m2 = (x) => (x / 100).toFixed(2);
    box.appendChild(h('div', { class: 'topbar' }, h('div', null, h('h1', null, c.name), h('div', { class: 'muted' }, `${c.vatNumber || c.enterpriseNumber || 'no number'} - source: ${c.source}`)), h('div', { class: 'actions' }, h('button', { on: { click: () => companyModal(c) } }, 'Edit'))));
    box.appendChild(h('div', { class: 'grid cards' }, h('div', { class: 'card stat' }, h('div', { class: 'n' }, `${m2(r.outstandingCents)}`), h('div', { class: 'l' }, `Outstanding (${cur})`)), h('div', { class: `card stat ${r.overdueCents ? 'bad' : ''}` }, h('div', { class: 'n' }, `${m2(r.overdueCents)}`), h('div', { class: 'l' }, 'Overdue')), h('div', { class: 'card stat ok' }, h('div', { class: 'n' }, `${m2(r.payments.totalPaidCents)}`), h('div', { class: 'l' }, `Paid so far (${r.payments.count} payment(s)${r.payments.lastPaidOn ? `, last ${r.payments.lastPaidOn}` : ''})`))));
    box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Details'), kv([['Address', [c.address.street, `${c.address.postalCode || ''} ${c.address.city || ''}`.trim(), c.address.countryCode].filter(Boolean).join(', ')], ['Email', c.email], ['Peppol ID', c.peppolId], ['Credit scoring', 'Not implemented (no solvency provider)']])));
    box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Documents'), r.documents.length ? h('table', null, h('tr', null, ['Number', 'Type', 'Date', 'Total', 'Status'].map((x) => h('th', null, x))), r.documents.map((d) => h('tr', { class: 'click', on: { click: () => { location.hash = `#/doc/${d.id}`; } } }, h('td', null, d.number || '(draft)'), h('td', null, TYPE[d.type]), h('td', null, d.issueDate), h('td', null, `${d.gross} ${d.currency}`), h('td', null, badge(d.effectiveStatus))))) : h('div', { class: 'muted' }, 'No documents yet.')));
  } catch (e) { fail(e, box); }
}

// ---------- receivables ----------
async function viewReceivables() {
  const main = layout('#/receivables', h('div', { class: 'topbar' }, h('div', null, h('h1', null, 'Payments and receivables'), h('div', { class: 'muted small' }, 'No reminders are sent automatically.')))); const box = h('div'); main.appendChild(box);
  try {
    const r = await api('GET', '/api/receivables'); const cur = state.settings.defaults.currency;
    box.appendChild(h('div', { class: 'grid cards' }, [['Unpaid', r.unpaid.count, r.unpaid.outstanding, ''], ['Due soon', r.due_soon.count, r.due_soon.outstanding, 'warn'], ['Overdue', r.overdue.count, r.overdue.outstanding, r.overdue.count ? 'bad' : '']].map(([l, n, a, cls]) => h('div', { class: `card stat ${cls}` }, h('div', { class: 'n' }, `${a}`), h('div', { class: 'l' }, `${l}: ${n} invoice(s) (${cur})`)))));
    box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Ageing (days past due)'), h('table', null, h('tr', null, ['Not yet due', '0-7', '8-30', '31-60', '60+'].map((x) => h('th', { class: 'num' }, x))), h('tr', null, ['not_due', '0_7', '8_30', '31_60', '60_plus'].map((k) => h('td', { class: 'num' }, `${r.aging[k].outstanding} (${r.aging[k].count})`))))));
    box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Open invoices'), r.invoices.length ? h('table', null, h('tr', null, ['Invoice', 'Customer', 'Due', 'Days late', 'Total', 'Still due', 'Status'].map((x, i) => h('th', { class: i >= 3 && i < 6 ? 'num' : '' }, x))), r.invoices.map((i) => h('tr', null, h('td', null, i.number), h('td', null, i.customer), h('td', null, i.dueDate), h('td', { class: 'num' }, i.daysOverdue > 0 ? String(i.daysOverdue) : ''), h('td', { class: 'num' }, i.gross), h('td', { class: 'num' }, i.remaining), h('td', null, badge(i.effectiveStatus))))) : h('div', { class: 'muted' }, 'No open invoices.'), h('p', { class: 'small muted' }, 'Open an invoice from the Invoices page to register a payment.')));
  } catch (e) { fail(e, box); }
}

// ---------- accountant pack ----------
async function viewPack() {
  const t = new Date().toISOString().slice(0, 10); const y = Number(t.slice(0, 4)); const q = Math.floor((Number(t.slice(5, 7)) - 1) / 3);
  const from = h('input', { type: 'date', value: `${y}-${String(q * 3 + 1).padStart(2, '0')}-01` }); const to = h('input', { type: 'date', value: t });
  const out = h('div');
  const main = layout('#/pack', h('div', { class: 'topbar' }, h('div', null, h('h1', null, 'Accountant pack'), h('div', { class: 'muted small' }, 'Shop/POS sales come from the validated retail figures; only standalone B2B invoices are added.'))),
    h('div', { class: 'card' }, h('div', { class: 'row r3', style: 'align-items:end' }, h('div', { class: 'field' }, h('label', null, 'From'), from), h('div', { class: 'field' }, h('label', null, 'To'), to), h('div', { class: 'field' }, h('button', { class: 'primary', on: { click: gen } }, 'Generate pack')))), out);
  async function gen() {
    clear(out); out.appendChild(h('div', { class: 'muted', style: 'margin:12px' }, 'Generating...'));
    try {
      const r = await api('POST', '/api/pack', { from: from.value, to: to.value }); const p = r.pack; const cur = p.currency; const e2 = (c) => (c / 100).toFixed(2); clear(out);
      out.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'actions' }, h('strong', null, `${p.period.start} to ${p.period.end}`), h('span', { class: `badge ${p.completeness.status}` }, p.completeness.status), h('span', { class: `badge ${p.reconciliation.status}` }, `Reconciliation: ${p.reconciliation.status}`), h('span', { class: 'muted small' }, `generated ${p.generated_at}`)), p.completeness.reasons.length ? h('ul', { class: 'plain small', style: 'margin-top:8px' }, p.completeness.reasons.map((x) => h('li', null, human(x)))) : h('div', { class: 'small muted' }, 'All source data for this period is present.'), h('div', { class: 'small muted', style: 'margin-top:6px' }, `Sources: ${p.source_systems.map((s) => s.system).join(', ')}`)));
      const row = (l, v, b) => h('tr', null, h('td', null, b ? h('strong', null, l) : l), h('td', { class: 'num' }, b ? h('strong', null, v) : v));
      out.appendChild(h('div', { class: 'grid two', style: 'margin-top:16px' },
        h('div', { class: 'card' }, h('h2', null, 'Shop and POS (retail)'), h('table', null, row('Gross sales', `${p.retail.gross_sales.toFixed(2)} ${cur}`), row('Discounts', p.retail.discounts.toFixed(2)), row('Refunds', p.retail.refunds.toFixed(2)), row('Net sales incl. VAT', p.retail.net_sales.toFixed(2)), row('VAT', p.retail.vat.toFixed(2)), row('Net sales excl. VAT', p.retail.net_sales_ex_vat.toFixed(2), true), row('POS excl. VAT', p.retail.by_channel.pos.net_sales_ex_vat.toFixed(2)), row('Online excl. VAT', p.retail.by_channel.online.net_sales_ex_vat.toFixed(2)))),
        h('div', { class: 'card' }, h('h2', null, 'Invoices and credit notes'), h('table', null, row('Standalone B2B invoices', String(p.b2b.standalone_invoices)), row('Standalone credit notes', String(p.b2b.standalone_credit_notes)), row('B2B net excl. VAT', e2(p.b2b.net_ex_vat_cents), true), row('B2B VAT', e2(p.b2b.vat_cents)), row('Linked invoices (not added)', `${p.b2b_linked.documents} / ${e2(p.b2b_linked.gross_documented_cents)}`), row('Credit notes issued', `${p.credit_notes.issued} / ${e2(p.credit_notes.gross_cents)}`)))));
      out.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Totals (retail + standalone B2B)'), h('table', null, row('Sales excl. VAT', `${e2(p.totals.sales_ex_vat_cents)} ${cur}`, true), row('VAT collected', e2(p.totals.vat_collected_cents)), row('Sales incl. VAT', e2(p.totals.sales_incl_vat_cents), true))));
      const v = p.vat_summary;
      out.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'actions' }, h('h2', null, 'VAT by rate'), h('span', { class: `badge ${v.status}` }, v.status)), h('table', null, h('tr', null, ['Rate', 'Taxable base', 'VAT'].map((x, i) => h('th', { class: i ? 'num' : '' }, x))), v.combined_by_rate.map((g) => h('tr', null, h('td', null, `${g.vatRateBp / 100}%`), h('td', { class: 'num' }, e2(g.taxableCents)), h('td', { class: 'num' }, e2(g.vatCents))))), v.retail_unclassified ? h('div', { class: 'banner warn small', style: 'margin-top:10px' }, `Unavailable: ${v.retail_unclassified.lines} retail line(s) have no captured VAT rate (base ${e2(v.retail_unclassified.taxableCents)}, VAT ${e2(v.retail_unclassified.vatCents)}). They are not spread across rates.`) : null, v.b2b.by_treatment.filter((x) => x.exemptOrReverseCharge).map((x) => h('div', { class: 'small' }, `B2B ${REGIME[x.regime] || x.regime}: base ${e2(x.taxableCents)} (no VAT)`))));
      const ps = p.payment_status_of_period_invoices;
      out.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Payment status of B2B invoices in the period'), h('table', null, Object.entries(ps).map(([k, x]) => row(k.replace('_', ' '), `${x.count} invoice(s) - ${e2(x.cents)}`)))));
      out.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, `Anomalies (${p.anomalies.length})`), p.anomalies.length ? h('ul', { class: 'plain' }, p.anomalies.map((a) => h('li', null, `[${a.severity}] ${human(a.code)} - ${a.detail}`))) : h('div', { class: 'muted' }, 'None detected.')));
      out.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Downloads'), h('div', { class: 'actions' }, r.downloads.map((d) => h('a', { class: 'btn', href: d.url }, d.name.replace(/^accountant-pack_[\d-]+_[\d-]+/, '').replace(/^_/, '') || 'pack.json')))));
    } catch (e) { fail(e, out); }
  }
}

// ---------- settings ----------
async function viewSettings() {
  const main = layout('#/settings', h('div', { class: 'topbar' }, h('div', null, h('h1', null, 'Settings'), h('div', { class: 'muted small' }, 'Your company details, numbering and VAT rates. No passwords or keys are stored here.')))); const err = h('div'); main.appendChild(err);
  let r; try { r = await loadSettings(); } catch (e) { return fail(e, err); }
  const s = JSON.parse(JSON.stringify(state.settings)); const rates = s.vat.allowedRatesBp.map((b) => String(b / 100)).join(', ');
  const st = { rates };
  const inp = (obj, key, label, opts) => h('div', { class: 'field' }, h('label', null, label), h('input', { value: obj[key] ?? '', placeholder: (opts && opts.ph) || '', on: { input: (e) => { obj[key] = e.target.value; } } }), opts && opts.hint ? h('div', { class: 'hint' }, opts.hint) : null);
  const sel = (obj, key, label, options) => h('div', { class: 'field' }, h('label', null, label), h('select', { on: { change: (e) => { obj[key] = e.target.value; } } }, options.map(([v, l]) => h('option', { value: v, selected: obj[key] === v }, l))));
  if (r.missing.length) main.appendChild(h('div', { class: 'banner warn' }, h('strong', null, 'Still needed before real invoices: '), r.missing.map((m) => human(m.replace(/[.]/g, '_').toUpperCase())).join(', ')));
  main.appendChild(h('div', { class: 'card' }, h('h2', null, 'Your company (seller)'), h('div', { class: 'row r2' }, inp(s.seller, 'name', 'Legal name'), inp(s.seller, 'email', 'Finance email')), h('div', { class: 'row r2' }, inp(s.seller, 'vatNumber', 'VAT number', { ph: 'BE0123456789' }), inp(s.seller, 'enterpriseNumber', 'Enterprise number', { ph: '0123.456.789' })), h('div', { class: 'row r2' }, inp(s.seller.address, 'street', 'Street and number'), inp(s.seller.address, 'postalCode', 'Postal code')), h('div', { class: 'row r2' }, inp(s.seller.address, 'city', 'City'), inp(s.seller.address, 'countryCode', 'Country (2 letters)')), h('div', { class: 'row r2' }, inp(s.seller, 'iban', 'IBAN'), inp(s.seller, 'bic', 'BIC (optional)'))));
  main.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'VAT and payment'), inp(st, 'rates', 'Allowed VAT rates (%)', { ph: '21, 12, 6, 0', hint: 'The rates you may choose on domestic invoices. You decide these; nothing is assumed.' }), h('div', { class: 'row r3' }, inp(s.defaults, 'paymentTermsDays', 'Default payment terms (days)'), inp(s.defaults, 'currency', 'Currency'), sel(s.defaults, 'language', 'Default language', [['fr', 'Francais'], ['nl', 'Nederlands'], ['en', 'English']])), inp(s.defaults, 'paymentTerms', 'Payment terms text'), inp(s.branding, 'paymentInstructions', 'Extra payment instructions'), h('label', { style: 'color:var(--ink)' }, h('input', { type: 'checkbox', checked: s.branding.structuredCommunication, on: { change: (e) => { s.branding.structuredCommunication = e.target.checked; } } }), 'Print a Belgian structured communication (+++xxx/xxxx/xxxxx+++)')));
  main.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Numbering'), h('div', { class: 'row r4' }, inp(s.numbering.invoice, 'prefix', 'Invoice prefix'), inp(s.numbering.credit_note, 'prefix', 'Credit note prefix'), inp(s.numbering.quote, 'prefix', 'Quote prefix'), inp(s.numbering.invoice, 'pad', 'Digits')), inp(s.numbering, 'format', 'Format', { hint: 'Use {prefix}, {year} and {seq}, e.g. {prefix}-{year}-{seq} gives INV-2026-0001. Numbers are assigned when a document is issued and never skip.' })));
  main.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Look and feel'), h('div', { class: 'row r2' }, inp(s.branding, 'accent', 'Accent colour', { ph: '#183247' }), inp(s.branding, 'footer', 'Footer text on documents')), h('div', { class: 'field' }, h('label', null, `Logo (PNG or JPEG, max 400 KB)${s.branding.hasLogo ? ' - a logo is set' : ''}`), h('input', { type: 'file', accept: 'image/png,image/jpeg', on: { change: (e) => { const f = e.target.files[0]; if (!f) return; const fr = new FileReader(); fr.onload = async () => { try { await api('POST', '/api/settings/logo', { dataUrl: fr.result }); toast('Logo saved', 'ok'); } catch (er) { fail(er, err); } }; fr.readAsDataURL(f); } } }))));
  main.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Company lookup and e-invoicing'), sel(s.companyLookup, 'provider', 'Company lookup provider', [['vies', 'EU VIES (free, official) with manual fallback'], ['manual', 'Manual entry only']]), h('div', { class: 'field' }, h('label', null, 'Peppol provider'), h('span', { class: 'badge NOT_CONFIGURED' }, 'NOT CONFIGURED'), h('div', { class: 'hint' }, 'Nothing is transmitted. Structured invoices (UBL) can be prepared and downloaded.'))));
  main.appendChild(h('div', { class: 'actions', style: 'margin-top:16px' }, h('button', { class: 'primary', on: { click: async () => { try {
    const num = (v) => (v === '' || v === null ? undefined : Number(v));
    const body = { seller: s.seller, vat: { allowedRatesPercent: st.rates.split(',').map((x) => x.trim()).filter(Boolean) }, defaults: { ...s.defaults, paymentTermsDays: num(s.defaults.paymentTermsDays) }, numbering: { invoice: { prefix: s.numbering.invoice.prefix, pad: num(s.numbering.invoice.pad) }, credit_note: { prefix: s.numbering.credit_note.prefix, pad: num(s.numbering.invoice.pad) }, quote: { prefix: s.numbering.quote.prefix, pad: num(s.numbering.invoice.pad) }, format: s.numbering.format }, branding: { accent: s.branding.accent, footer: s.branding.footer, paymentInstructions: s.branding.paymentInstructions, structuredCommunication: s.branding.structuredCommunication }, companyLookup: { provider: s.companyLookup.provider } };
    const r2 = await api('PUT', '/api/settings', body); state.settings = r2.settings; state.missing = r2.missing; applyAccent(); toast('Settings saved', 'ok'); viewSettings(); } catch (e) { fail(e, err); window.scrollTo(0, 0); } } } }, 'Save settings')));
}

// ---------- router ----------
async function route() {
  if (!state.csrf) { try { const s = await api('GET', '/api/session'); if (s.authenticated) { state.csrf = s.csrf; await loadSettings(); } else return renderLogin(); } catch (e) { return renderLogin(); } }
  const [path, qs] = (location.hash.slice(1) || '/').split('?'); const q = new URLSearchParams(qs || ''); const parts = path.split('/').filter(Boolean);
  try {
    if (!parts.length) return await viewOverview();
    if (parts[0] === 'invoices') return await viewList('invoice', q);
    if (parts[0] === 'quotes') return await viewList('quote', q);
    if (parts[0] === 'new') return await viewForm(parts[1] === 'quote' ? 'quote' : 'invoice', null);
    if (parts[0] === 'doc' && parts[2] === 'edit') { const d = await api('GET', `/api/documents/${parts[1]}`); return await viewForm(d.type === 'quote' ? 'quote' : 'invoice', parts[1]); }
    if (parts[0] === 'doc') return await viewDoc(parts[1]);
    if (parts[0] === 'companies') return parts[1] ? await viewCompany(parts[1]) : await viewCompanies();
    if (parts[0] === 'receivables') return await viewReceivables();
    if (parts[0] === 'pack') return await viewPack();
    if (parts[0] === 'settings') return await viewSettings();
    location.hash = '#/';
  } catch (e) { if (!(e instanceof ApiError && e.status === 401)) fail(e); }
}
window.addEventListener('hashchange', route);
route();
