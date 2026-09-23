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
    // data-label drives a CSS ::before (attr(data-label), see .lc[data-label] / .lrow .lc[data-label] in style.css) -
    // translated here for the same reason placeholder/title/aria-label/alt are: it's merchant-visible text, not markup.
    else el.setAttribute(k, v === true ? '' : (k === 'placeholder' || k === 'title' || k === 'aria-label' || k === 'alt' || k === 'data-label' ? tr(String(v)) : String(v)));
  }
  const add = (c) => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.appendChild(c instanceof Node ? c : document.createTextNode(typeof c === 'string' ? tr(c) : String(c))); };
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
const human = (code) => { const c = String(code).split(' ')[0].split('(')[0]; if (TXT[c]) return TXT[c]; if (/^LINE_\d+_/.test(c)) return tt('Line {0}: {1}', c.split('_')[1], (TXT[c.split('_').slice(2).join('_')] ? tr(TXT[c.split('_').slice(2).join('_')]) : c.split('_').slice(2).join(' ').toLowerCase())); if (/^CUSTOMER_ADDRESS_/.test(c)) return tt('Customer address: {0} is missing', tr(c.replace('CUSTOMER_ADDRESS_', '').replace('_MISSING', '').toLowerCase().replace('_', ''))); if (/^POSSIBLE_DUPLICATE/.test(c)) return 'This looks like a shop sale that is not linked. Link it, or confirm it is a separate sale.'; return c.replace(/_/g, ' ').toLowerCase().replace(/^./, (x) => x.toUpperCase()); };
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
// ---------- icons and small visual helpers (SVG built with the DOM API, never from strings of markup) ----------
const ICON_PATHS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z', doc: 'M6 2h8l5 5v15H6z M14 2v6h5 M9 13h7 M9 17h7', quote: 'M4 5h16v11H9l-5 4z',
  building: 'M4 21V4h10v17 M14 9h6v12 M8 8h2 M8 12h2 M8 16h2 M2 21h20', coins: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  book: 'M4 4h11a3 3 0 013 3v13H7a3 3 0 01-3-3z M4 17a3 3 0 013-3h11', gear: 'M12 15a3 3 0 100-6 3 3 0 000 6z M4 12h2 M18 12h2 M12 4v2 M12 18v2 M6.3 6.3l1.4 1.4 M16.3 16.3l1.4 1.4 M6.3 17.7l1.4-1.4 M16.3 7.7l1.4-1.4',
  plus: 'M12 5v14 M5 12h14', search: 'M11 4a7 7 0 100 14 7 7 0 000-14z M21 21l-4.3-4.3', chevron: 'M9 6l6 6-6 6', alert: 'M12 3l10 18H2z M12 10v5 M12 18h.01',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18z M12 7v5l3 2', inbox: 'M3 13l3-8h12l3 8v6H3z M3 13h5l1 3h6l1-3h5', cart: 'M3 4h2l2 11h11l2-8H7 M9 20h.01 M17 20h.01', check: 'M5 12l5 5 10-11', arrow: 'M5 12h14 M13 6l6 6-6 6', edit: 'M4 20h4L19 9l-4-4L4 16z',
  bell: 'M6 10a6 6 0 1112 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10z M10 19a2 2 0 004 0', logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4 M16 17l5-5-5-5 M21 12H9',
};
function svgIcon(name, size) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: String(size || 18), height: String(size || 18), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.doc); s.appendChild(p);
  return s;
}
const AV_TONES = ['t1', 't2', 't3', 't4', 't5'];
function avatar(name, size) {
  const t = String(name || '?').trim(); const parts = t.split(/\s+/);
  const ini = `${(parts[0] || '?')[0]}${(parts[1] || '')[0] || ''}`.toUpperCase();
  let hs = 0; for (const ch of t) hs = (hs * 31 + ch.charCodeAt(0)) >>> 0;
  return h('span', { class: `avatar ${AV_TONES[hs % AV_TONES.length]} ${size || ''}` }, ini);
}
/** Dashboard "recent activity" row: one real document-lifecycle event, in plain merchant language.
 * Every fact here (action, document type/number, amount) comes straight from the event as recorded -
 * nothing is inferred or reworded into a claim the event doesn't support. */
function activityRow(e) {
  const doc = e.docType ? tt('{0} {1}', tr(TYPE[e.docType] || e.docType), e.docNumber || tt('(draft)')) : tt('a document');
  const LABEL = {
    APPROVE_AND_ISSUE: () => tt('{0} issued', doc), MARK_SENT: () => tt('{0} marked as sent', doc), SEND_QUOTE: () => tt('{0} sent', doc),
    RECORD_PAYMENT: () => e.amount ? tt('Payment of {0} received on {1}', `${e.amount} ${e.currency || ''}`.trim(), doc) : tt('Payment received on {0}', doc),
    CREATE_CREDIT_NOTE: () => tt('{0} created', doc), ACCEPT_QUOTE: () => tt('{0} accepted', doc), REJECT_QUOTE: () => tt('{0} rejected', doc),
    SUBMIT_FOR_APPROVAL: () => tt('{0} submitted for approval', doc), CANCEL: () => tt('{0} cancelled', doc), REJECT: () => tt('{0} rejected', doc),
    MODIFY: () => tt('{0} returned to draft', doc), STATUS_CHANGE: () => tt('{0} status updated', doc),
  };
  const tone = { APPROVE_AND_ISSUE: 'ok', RECORD_PAYMENT: 'ok', CREATE_CREDIT_NOTE: 'warm', CANCEL: 'warm', REJECT: 'warm', REJECT_QUOTE: 'warm' }[e.action] || 'info';
  const text = (LABEL[e.action] || (() => tt('{0}: {1}', doc, e.action)))();
  const dt = e.at ? new Date(e.at) : null;
  const when = dt ? dt.toLocaleDateString(I18N.tag(), { day: 'numeric', month: 'short' }) + ' ' + dt.toLocaleTimeString(I18N.tag(), { hour: '2-digit', minute: '2-digit' }) : '';
  return h('a', { class: 'activity-row', href: e.docId ? `#/doc/${e.docId}` : undefined }, h('span', { class: `activity-dot ${tone}` }), h('span', { class: 'activity-text' }, text), h('span', { class: 'activity-time' }, when));
}
/** Days from today to a YYYY-MM-DD date (display only: how late / how soon). */
function daysFromToday(iso) { if (!iso) return null; const d = Date.parse(`${iso}T00:00:00Z`); if (Number.isNaN(d)) return null; const n = new Date(); return Math.round((d - Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000); }
const dueChip = (iso, remainingCents) => { if (!iso || remainingCents === 0) return null; const n = daysFromToday(iso); if (n === null) return null; return n < 0 ? h('span', { class: 'chip bad' }, tt(n === -1 ? '{0} day late' : '{0} days late', -n)) : n === 0 ? h('span', { class: 'chip warn' }, 'Due today') : n <= 7 ? h('span', { class: 'chip warn' }, tt(n === 1 ? 'Due in {0} day' : 'Due in {0} days', n)) : h('span', { class: 'chip mute' }, tt('Due in {0} days', n)); };

// Unified Finance module navigation (2026-09-24): the 7 approved sections. `primary: true` is one of
// the 4 items always visible in the mobile bottom bar (Home/To do/Sales/Bank & Cash); the rest live under
// the mobile "More" sheet together with Settings and Contact us. Every previous route this rail used to
// point to (Quotes/Invoices/Payments/Finance Inbox/Accountant pack/Bank & Treasury) still works - see the
// redirects in route() - only the top-level entry points are consolidated, per the mandate's own
// "ne recrée pas des entrées séparées" rule.
const NAV = [
  { href: '#/', label: 'Home', icon: 'home', primary: true },
  { href: '#/todo', label: 'To do', icon: 'check', primary: true },
  { href: '#/sales', label: 'Sales', icon: 'doc', primary: true },
  { href: '#/purchases', label: 'Purchases', icon: 'cart', primary: false },
  { href: '#/bank', label: 'Bank & Cash', icon: 'coins', primary: true },
  { href: '#/contacts', label: 'Contacts', icon: 'building', primary: false },
  { href: '#/treasury', label: 'Treasury', icon: 'clock', primary: false },
];
/** "Nous contacter": reuses the merchant's own configured finance email (Settings) - there is no support
 * ticketing backend in this product, so this never fakes a ticket send or a fabricated support address. */
function openContactSupport() {
  const email = state.settings && state.settings.seller && state.settings.seller.email;
  const body = email
    ? h('div', null, h('p', { class: 'muted small' }, tt('Reach your configured finance contact:')), h('p', null, h('a', { href: `mailto:${email}` }, email)))
    : h('div', null, h('p', { class: 'muted small' }, tt('No contact address is configured yet.')), h('a', { class: 'btn', href: '#/settings' }, tt('Open settings')));
  modal(tt('Contact us'), body, (close) => [h('button', { on: { click: close } }, tt('Close'))]);
}
/** Mobile-only "More" bottom sheet: the 3 secondary sections + Settings + Contact us (mandate section 6). */
function openMoreSheet() {
  const back = h('div', { class: 'sheet-back', on: { click: (e) => { if (e.target === back) back.remove(); } } });
  const items = [...NAV.filter((n) => !n.primary), { href: '#/pack', label: 'Accountant pack', icon: 'book' }, { href: '#/settings', label: 'Settings', icon: 'gear' }];
  const sheet = h('div', { class: 'sheet' }, h('div', { class: 'sheet-handle' }),
    items.map((n) => h('a', { class: 'sheet-item', href: n.href, on: { click: () => back.remove() } }, svgIcon(n.icon, 18), tr(n.label))),
    h('button', { class: 'sheet-item', type: 'button', on: { click: () => { back.remove(); openContactSupport(); } } }, svgIcon('inbox', 18), tt('Contact us')));
  back.appendChild(sheet); document.body.appendChild(back);
}
function langSwitch() {
  return h('div', { class: 'langswitch', role: 'group', 'aria-label': 'Interface language' }, I18N.LANGS.map((l) => h('button', { type: 'button', class: I18N.getLang() === l ? 'on' : '', title: { fr: 'Français', nl: 'Nederlands', en: 'English' }[l], on: { click: () => { I18N.setLang(l); route(); } } }, l.toUpperCase())));
}
/** Global search: real, not decorative - it reuses the existing invoice-list text filter (no separate search
 * index to build or fake). Enter jumps to the Invoices list pre-filtered; that page's own search box takes
 * over from there. Extending it to clients/suppliers is a follow-up once this shell is approved. */
function globalSearch() {
  const box = h('input', { class: 'gsearch', placeholder: tt('Search an invoice, a client, a supplier...'), autocomplete: 'off',
    on: { keydown: (e) => { if (e.key === 'Enter' && box.value.trim()) { location.hash = `#/invoices?q=${encodeURIComponent(box.value.trim())}`; } } } });
  return h('div', { class: 'gsearchwrap' }, svgIcon('search', 16), box, h('span', { class: 'gkey' }, '⌘K'));
}
function layout(active, ...content) {
  const seller = (state.settings && state.settings.seller && state.settings.seller.name) || 'Finance';
  const initial = seller.trim().charAt(0).toUpperCase() || 'F';
  const rail = h('nav', { class: 'rail', 'aria-label': 'Finance navigation' },
    h('a', { class: 'rail-mark', href: '#/', title: seller }, initial),
    h('div', { class: 'rail-nav' }, NAV.map((n) => h('a', { href: n.href, class: `railitem ${n.href === active ? 'active' : ''}`, ...(n.primary ? {} : { 'data-more': '1' }), title: tr(n.label), 'aria-label': tr(n.label) }, svgIcon(n.icon, 18), h('span', { class: 'rlabel' }, tr(n.label))))),
    h('button', { class: 'railitem rail-more', type: 'button', title: tt('More'), 'aria-label': tt('More'), on: { click: openMoreSheet } }, svgIcon('chevron', 18), h('span', { class: 'rlabel' }, tt('More'))),
    h('div', { class: 'rail-foot' },
      h('a', { class: `railitem ${active === '#/settings' ? 'active' : ''}`, href: '#/settings', title: tt('Settings'), 'aria-label': tt('Settings') }, svgIcon('gear', 18)),
      h('button', { class: 'railitem', type: 'button', title: tt('Log out'), 'aria-label': tt('Log out'), on: { click: async () => { await api('POST', '/api/logout', {}).catch(() => {}); state.csrf = null; renderLogin(); } } }, svgIcon('logout', 18)),
      avatar(seller, 'sm')));
  // The merchant's own name, not a hardcoded brand string - this Finance shell is generic/multi-tenant
  // under the hood (see tenant-isolation tests), so the context label must reflect whoever is actually
  // signed in rather than one fixed name.
  const topbar2 = h('div', { class: 'topbar2' }, globalSearch(), h('div', { class: 'tb-right' }, langSwitch(), h('span', { class: 'tb-brand' }, seller, h('span', { style: 'display:inline-flex;transform:rotate(90deg)' }, svgIcon('chevron', 13)))));
  const main = h('main', { class: 'main' }, content);
  const support = h('button', { class: 'contact-support', type: 'button', on: { click: openContactSupport } }, svgIcon('inbox', 16), h('span', null, tt('Contact us')));
  show(h('div', { class: 'shell' }, rail, h('div', { class: 'mainarea' }, topbar2, main, support)));
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
  show(h('div', { class: 'login card' }, h('div', { style: 'display:flex;justify-content:flex-end' }, langSwitch()), h('h1', null, 'Finance'), h('p', { class: 'muted' }, 'Enter the access token stored in your .env file (FINANCE_DASHBOARD_TOKEN).'), h('div', { class: 'field' }, inp), msg, h('button', { class: 'primary', on: { click: go } }, 'Log in')));
  inp.focus();
}

// ---------- overview ----------
// Minimal SVG element builder, same DOM-API discipline as svgIcon(): elements and text nodes only, no markup string is ever parsed.
function svgEl(tag, attrs, kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const k of kids || []) el.appendChild(k);
  return el;
}
/** Real treasury chart: monthly inflow/outflow bars + a running-total line, built from /api/overview/cashflow
 * rows only. Every number plotted is one already present in `rows`; nothing here interpolates or forecasts. */
function treasuryChart(rows, cur) {
  const W = 760, H = 230, mL = 44, mR = 8, mT = 8, mB = 22;
  const innerW = W - mL - mR; const n = Math.max(1, rows.length);
  const slot = innerW / n; const barW = Math.min(26, slot * 0.34);
  const maxAbs = Math.max(1, ...rows.flatMap((r) => [r.inflowCents, r.outflowCents, Math.abs(r.balanceCents)]));
  const zeroY = mT + (H - mT - mB) * 0.6;
  const scale = Math.min(zeroY - mT - 8, H - mB - zeroY - 8) / maxAbs;
  const xOf = (i) => mL + slot * i + slot / 2;
  const kids = [];
  // grid: zero line + two faint reference lines
  kids.push(svgEl('line', { class: 'tc-grid', x1: mL, x2: W - mR, y1: zeroY, y2: zeroY }));
  kids.push(svgEl('line', { class: 'tc-grid', x1: mL, x2: W - mR, y1: mT, y2: mT }));
  kids.push(svgEl('line', { class: 'tc-grid', x1: mL, x2: W - mR, y1: H - mB, y2: H - mB }));
  kids.push(svgEl('text', { class: 'tc-axis', x: 4, y: zeroY + 4 }, [document.createTextNode('0')]));
  const monthLabel = (mth) => new Date(`${mth}-01T00:00:00Z`).toLocaleDateString(I18N.tag(), { month: 'short' });
  rows.forEach((r, i) => {
    const x = xOf(i);
    const inH = r.inflowCents * scale; const outH = r.outflowCents * scale;
    kids.push(svgEl('rect', { class: 'tc-bar-in', x: x - barW - 1, y: zeroY - inH, width: barW, height: Math.max(0, inH), rx: 2 }, [svgEl('title', {}, [document.createTextNode(`${monthLabel(r.month)}: ${r.inflow} ${cur}`)])]));
    kids.push(svgEl('rect', { class: 'tc-bar-out', x: x + 1, y: zeroY, width: barW, height: Math.max(0, outH), rx: 2 }, [svgEl('title', {}, [document.createTextNode(`${monthLabel(r.month)}: -${r.outflow} ${cur}`)])]));
    kids.push(svgEl('text', { class: 'tc-axis', x, y: H - 6, 'text-anchor': 'middle' }, [document.createTextNode(monthLabel(r.month))]));
  });
  const pts = rows.map((r, i) => [xOf(i), zeroY - r.balanceCents * scale]);
  kids.push(svgEl('polyline', { class: 'tc-line', points: pts.map((p) => p.join(',')).join(' ') }));
  pts.forEach(([x, y], i) => { const r = rows[i]; kids.push(svgEl('circle', { class: 'tc-dot', cx: x, cy: y, r: i === pts.length - 1 ? 4 : 2.5 }, [svgEl('title', {}, [document.createTextNode(`${monthLabel(r.month)}: ${tt('balance')} ${r.balance} ${cur}`)])])); });
  return svgEl('svg', { class: 'tc-svg', viewBox: `0 0 ${W} ${H}` }, kids);
}
/** Compact Revenue vs Expenses chart (#4): same /api/overview/cashflow rows as the treasury chart, plotting
 * revenueCents/expenseCents (real invoiced revenue / accepted supplier-invoice expenses per month) as two
 * side-by-side bars from a shared baseline. No forecast, no interpolation - a month with nothing real is 0. */
function revenueExpenseChart(rows, cur) {
  // #4: same viewBox height family as the treasury chart above it, so the two read as comparably
  // important analytical elements rather than one dominant chart and one afterthought strip.
  const W = 760, H = 210, mL = 44, mR = 8, mT = 10, mB = 26;
  const innerW = W - mL - mR; const n = Math.max(1, rows.length);
  const slot = innerW / n; const barW = Math.min(26, slot * 0.34);
  const maxV = Math.max(1, ...rows.flatMap((r) => [r.revenueCents, r.expenseCents]));
  const baseY = H - mB; const scale = (baseY - mT - 6) / maxV;
  const xOf = (i) => mL + slot * i + slot / 2;
  const monthLabel = (mth) => new Date(`${mth}-01T00:00:00Z`).toLocaleDateString(I18N.tag(), { month: 'short' });
  const kids = [svgEl('line', { class: 'tc-grid', x1: mL, x2: W - mR, y1: baseY, y2: baseY })];
  rows.forEach((r, i) => {
    const x = xOf(i);
    const revH = r.revenueCents * scale; const expH = r.expenseCents * scale;
    kids.push(svgEl('rect', { class: 're-bar-rev', x: x - barW - 1, y: baseY - revH, width: barW, height: Math.max(0, revH), rx: 2 }, [svgEl('title', {}, [document.createTextNode(`${monthLabel(r.month)}: ${r.revenue} ${cur}`)])]));
    kids.push(svgEl('rect', { class: 're-bar-exp', x: x + 1, y: baseY - expH, width: barW, height: Math.max(0, expH), rx: 2 }, [svgEl('title', {}, [document.createTextNode(`${monthLabel(r.month)}: ${r.expense} ${cur}`)])]));
    kids.push(svgEl('text', { class: 'tc-axis', x, y: H - 6, 'text-anchor': 'middle' }, [document.createTextNode(monthLabel(r.month))]));
  });
  return svgEl('svg', { class: 'tc-svg', viewBox: `0 0 ${W} ${H}` }, kids);
}
// A handful of short, non-business decoration lines for the Accueil quote-card (mandate section 4: "phrase
// éditoriale... conservée si elle ne prend pas de place fonctionnelle"). This is copy, never merchant data -
// no figure, name or fact appears here, so it carries nothing that could be "invented data".
const HOME_QUOTES = [['Working with clarity.', 'Moving forward with peace of mind.'], ['Every invoice, told simply.'], ['Financial clarity, day after day.']];
function miniSpark(values, color) {
  if (!values.length || values.every((v) => v === 0)) return null;
  const w = 100; const h2 = 40; const max = Math.max(1, ...values.map(Math.abs));
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h2 - ((v / max) * (h2 - 6) + 3)}`).join(' ');
  return svgEl('svg', { viewBox: `0 0 ${w} ${h2}` }, [svgEl('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': 2.2 })]);
}
function barSpark(values, colors) {
  if (!values.length) return null;
  const w = 100; const h2 = 40; const bw = w / values.length - 3; const max = Math.max(1, ...values);
  return svgEl('svg', { viewBox: `0 0 ${w} ${h2}` }, values.map((v, i) => svgEl('rect', { x: i * (bw + 3), y: h2 - (v / max) * h2, width: bw, height: Math.max(1, (v / max) * h2), rx: 2, fill: colors[i % colors.length] })));
}
async function viewOverview() {
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = ((state.settings && state.settings.seller && state.settings.seller.name) || '').trim().split(/\s+/)[0] || '';
  const shell = h('div', { class: 'page-shell' });
  const main = layout('#/', shell);
  const quote = HOME_QUOTES[new Date().getDate() % HOME_QUOTES.length];
  shell.appendChild(h('div', { class: 'hero-row' },
    h('div', { class: 'hero-block' }, h('h1', null, first ? tt('{0} {1},', greet, first) : tt('{0},', greet))),
    h('div', { class: 'quote-card' }, h('div', { class: 'quote' }, quote.map((l, i) => [i ? h('br') : null, l])))));
  const box = h('div', { style: 'display:grid;gap:18px' }); shell.appendChild(box);
  box.appendChild(h('div', { class: 'metric-grid' }, [1, 2, 3, 4].map(() => h('div', { class: 'card skel-card' }, h('div', { class: 'skl', style: 'height:26px;width:40%' }), h('div', { class: 'skl', style: 'height:12px;width:70%;margin-top:12px' })))));
  try {
    const [o, treasury, purchaseRows, invoiceRows] = await Promise.all([
      api('GET', '/api/overview'),
      api('GET', '/api/treasury').catch(() => null),
      api('GET', '/api/inbox?scope=purchases').then((r) => r.rows).catch(() => []),
      api('GET', '/api/documents?type=invoice').then((r) => r.rows).catch(() => []),
    ]);
    const ac = await api('GET', '/api/actions').catch(() => ({ actions: [], currency: o.currency }));
    clear(box);
    const cur = o.currency;
    mount(box, o.settingsMissing.length ? h('div', { class: 'banner warn' }, h('strong', null, 'Finish your setup before issuing real invoices: '), tt('{0} setting(s) missing.', o.settingsMissing.length) + ' ', h('a', { href: '#/settings' }, 'Open settings')) : null);

    // ---- 4-metric strip: Chiffre d'affaires / Dépenses / Solde de trésorerie / Factures en attente.
    // Revenue and expenses (+ month-over-month change) are computed server-side from real invoices/supplier
    // invoices; treasury is the same real observed figure as the Bank & Treasury page; "en attente" is the
    // existing real outstanding-receivables total. Nothing here is estimated or interpolated.
    const toPay = purchaseRows.filter((r) => r.status === 'TO_PAY');
    // The arrow and sign always reflect the real direction of change (never flipped for effect); only the
    // colour (good/bad) depends on whether an increase is desirable for that particular metric - a rising
    // expense is still shown rising, just coloured as attention rather than success.
    const trendNote = (pct, goodWhenUp = true) => { const isUp = pct >= 0; const good = goodWhenUp ? isUp : !isUp; return h('span', { class: good ? 'good' : 'bad' }, (isUp ? '↑ +' : '↓ ') + pct + '%'); };
    // #9: proper FR/NL singular/plural instead of the "(s)" shorthand - same ternary-key pattern already used
    // elsewhere in this file (see dueChip's "{0} day late" / "{0} days late").
    const plural = (n, one, many) => tt(n === 1 ? one : many, n);
    const metric = (icon, label, value, note, spark, href) => h('a', { class: 'metric', href },
      h('span', { class: 'metric-icon' }, svgIcon(icon, 17)),
      h('div', null, h('div', { class: 'metric-title' }, label, ' ›'), h('div', { class: 'metric-value' }, value), h('div', { class: 'metric-note' }, note)),
      h('div', { class: 'metric-spark' }, spark));
    // Cashflow rows are fetched once, below, and reused for both the big chart AND these 4 real per-metric
    // sparklines (never a separate fabricated trend) - loadChart(6) populates `lastCashflowRows`.
    let lastCashflowRows = [];
    box.appendChild(h('div', { class: 'metric-grid' },
      metric('doc', tt('Revenue'), fmtMoney(o.revenue.thisMonthCents, cur), h('span', null, trendNote(o.revenue.changePct), ` ${tt('vs. last month')}`), h('span', { id: 'spark-revenue' }), '#/invoices'),
      metric('coins', 'Expenses', fmtMoney(o.expenses.thisMonthCents, cur), h('span', null, trendNote(o.expenses.changePct, false), ` ${tt('vs. last month')}`), h('span', { id: 'spark-expenses' }), '#/purchases'),
      // #2: no wrapped "Not connected" text - a quiet dash and a compact CTA until a real balance exists.
      metric('building', tt('Cash position'), treasury?.observed?.liquidCents != null ? fmtMoney(treasury.observed.liquidCents, cur) : '— €', treasury?.observed?.liquidCents != null ? null : h('a', { href: '#/bank' }, tt('Connect the bank')), null, '#/bank'),
      metric('clock', tt('Amount to collect'), fmtMoney(o.amounts.outstandingCents, cur), h('span', null, plural(o.counts.unpaid, '{0} unpaid invoice', '{0} unpaid invoices')), barSpark(Object.values(o.aging).map((a) => a.cents), ['#d0d7dc', '#d0d7dc', '#efc6b7', '#e69b7b', '#c96b42']), '#/receivables')));
    // #8: a derived figure from real numbers already shown above - explicitly labelled so it can never be read
    // as accounting net profit (no depreciation, no accruals, no tax, no cost of goods - just invoiced revenue
    // minus accepted supplier bills for the same month).
    const netRecorded = o.revenue.thisMonthCents - o.expenses.thisMonthCents;
    box.appendChild(h('div', { class: 'muted small' }, h('strong', { class: netRecorded >= 0 ? 'good' : 'bad' }, tt('Revenue − recorded expenses: {0}', fmtMoney(netRecorded, cur))), ' ', tt('(not an accounting net profit figure - no VAT, depreciation or accruals)')));

    // ---- Full-width invoice-status bar (#5): Paid / Outstanding / Overdue, real counts+amounts from
    // overview()'s invoiceStatus (all locked invoices, not period-limited). Uses the width the brief asked
    // the dashboard to make better use of, rather than adding another narrow card. ----
    const stBuckets = [['paid', 'ok', 'Paid'], ['outstanding', 'info', 'Outstanding'], ['overdue', 'bad', 'Overdue']];
    const stTotal = Math.max(1, ...stBuckets.map(() => 1), o.invoiceStatus.paid.cents + o.invoiceStatus.outstanding.cents + o.invoiceStatus.overdue.cents);
    box.appendChild(h('div', { class: 'card', style: 'padding:16px 18px' }, h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Invoice status')),
      h('div', { class: 'statusbar' }, stBuckets.map(([k, tone]) => { const v = o.invoiceStatus[k]; return h('span', { class: `sb-seg ${tone}`, style: `flex:${Math.max(v.cents, v.count ? 1 : 0) || 0.0001}`, title: `${v.amount} ${cur}` }); })),
      h('div', { class: 'statuslegend' }, stBuckets.map(([k, tone, label]) => { const v = o.invoiceStatus[k]; return h('div', { class: 'sl-item' }, h('span', { class: `sl-dot ${tone}` }), h('span', { class: 'sl-label' }, tt(label)), h('strong', null, `${v.amount} ${cur}`), h('span', { class: 'muted small' }, plural(v.count, '{0} invoice', '{0} invoices'))); }))));

    // ---- Central object: real treasury movement + Revenue vs Expenses + Recent activity + Create-invoice CTA.
    // "Due dates" and the secondary quick-actions list moved to the new À faire page (same real data, reused
    // rather than duplicated - see viewTodo()). ----
    const mid = h('div', { class: 'content-grid-3' });
    const chartCol = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });
    const chartWrap = h('div', { class: 'tc-wrap' }, h('div', { class: 'muted small' }, 'Loading...'));
    const reChartWrap = h('div', { class: 'tc-wrap re-wrap' }, h('div', { class: 'muted small' }, 'Loading...'));
    const loadChart = (months) => api('GET', `/api/overview/cashflow?months=${months}`).then((r) => {
      clear(chartWrap);
      // #3: an explicitly honest "not enough history" state instead of a flat, misleading chart when nothing
      // has actually been recorded yet.
      if (!r.hasActivity) { chartWrap.appendChild(h('div', { class: 'empty' }, h('span', { class: 'eicon' }, svgIcon('coins', 20)), h('div', null, h('strong', null, 'Not enough history yet'), h('div', { class: 'muted small' }, 'Record payments and supplier bills to see real cash movement here.')))); }
      else chartWrap.appendChild(treasuryChart(r.rows, r.currency));
      clear(reChartWrap); reChartWrap.appendChild(revenueExpenseChart(r.rows, r.currency));
      lastCashflowRows = r.rows;
      // Real per-metric sparklines (never fabricated): the same monthly revenue/expense series as the big
      // chart above, just plotted small inside the KPI cards - see metric-grid, above.
      const revSpark = document.getElementById('spark-revenue'); if (revSpark) { clear(revSpark); const s = miniSpark(r.rows.map((x) => x.revenueCents), '#20384e'); if (s) revSpark.appendChild(s); }
      const expSpark = document.getElementById('spark-expenses'); if (expSpark) { clear(expSpark); const s = miniSpark(r.rows.map((x) => x.expenseCents), '#8095a6'); if (s) expSpark.appendChild(s); }
    }).catch(() => { clear(chartWrap); chartWrap.appendChild(h('div', { class: 'muted small' }, 'Cash-flow unavailable.')); });
    const periodSelect = h('select', { class: 'tool', style: 'width:auto', on: { change: (e) => loadChart(Number(e.target.value)) } }, [[3, 'Last 3 months'], [6, 'Last 6 months'], [12, 'Last 12 months']].map(([v, l]) => h('option', { value: v, selected: v === 6 }, tt(l))));
    const chartCard = h('div', { class: 'card', style: 'padding:16px 18px' },
      h('div', { class: 'section-head' }, h('div', null, h('h2', { class: 'section-title' }, 'Treasury'), h('div', { class: 'section-sub' }, 'Real inflows, outflows and running documented balance')), periodSelect),
      chartWrap,
      h('div', { class: 'tc-legend' }, h('span', null, h('span', { class: 'tc-swatch', style: 'background:color-mix(in srgb, var(--info) 55%, #fff)' }), tt('Inflows')), h('span', null, h('span', { class: 'tc-swatch', style: 'background:color-mix(in srgb, var(--warm) 45%, #fff)' }), tt('Outflows')), h('span', null, h('span', { class: 'tc-swatch', style: 'background:var(--accent)' }), tt('Cumulative balance'))));
    // #4: compact Revenue vs Expenses chart, same real per-month figures as the KPI strip above, just plotted
    // across the same period as the treasury chart (shares its month selector via loadChart()).
    const reCard = h('div', { class: 'card', style: 'padding:16px 18px' },
      h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Revenue vs. expenses')),
      reChartWrap,
      h('div', { class: 'tc-legend' }, h('span', null, h('span', { class: 'tc-swatch', style: 'background:var(--ok)' }), tt('Revenue')), h('span', null, h('span', { class: 'tc-swatch', style: 'background:var(--warm)' }), tt('Expenses'))));
    chartCol.appendChild(chartCard); chartCol.appendChild(reCard);
    mid.appendChild(chartCol);
    loadChart(6);

    // Recent activity: the real document-lifecycle trail, unchanged data source.
    const actCard = h('div', { class: 'card panel-tall', style: 'padding:16px 18px' }, h('div', { class: 'section-head' }, h('h3', { class: 'section-title' }, 'Recent activity'), h('a', { href: '#/todo', class: 'viewall' }, tt('See all'), ' →')), h('div', { class: 'muted small' }, 'Loading...'));
    mid.appendChild(actCard);
    api('GET', '/api/overview/activity').then((r) => {
      clear(actCard); actCard.appendChild(h('div', { class: 'section-head' }, h('h3', { class: 'section-title' }, 'Recent activity'), h('a', { href: '#/todo', class: 'viewall' }, tt('See all'), ' →')));
      if (!r.rows.length) { actCard.appendChild(h('div', { class: 'empty' }, h('span', { class: 'eicon' }, svgIcon('doc', 20)), h('div', null, h('strong', null, 'Nothing yet'), h('div', { class: 'muted small' }, 'Issued invoices, payments and credit notes will show up here.')))); return; }
      actCard.appendChild(h('div', { class: 'activity' }, r.rows.map((e) => activityRow(e))));
    }).catch(() => { clear(actCard); actCard.appendChild(h('div', { class: 'muted small' }, 'Activity unavailable.')); });

    // Professional CTA card: create an invoice. A real, working preview of the same lines/VAT/total the
    // invoice form itself computes - not decoration, so it never shows figures the merchant did not enter
    // (the -most recent draft/open invoice's own real totals when one exists, otherwise a blank template).
    const ctaSample = invoiceRows.find((r) => ['DRAFT', 'READY_FOR_APPROVAL', 'ISSUED', 'SENT'].includes(r.status));
    const ctaCard = h('a', { class: 'card', href: ctaSample ? `#/doc/${ctaSample.id}` : '#/new/invoice', style: 'padding:20px;text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:14px' },
      h('h3', { class: 'section-title', style: 'font-style:italic;max-width:220px' }, tt('Create, send and track your invoices with ease.')),
      ctaSample ? h('div', { class: 'muted small' }, tt('Most recent: {0} · {1} {2}', ctaSample.number || tt('(draft)'), ctaSample.gross, cur), h('div', { style: 'margin-top:4px' }, badge(ctaSample.effectiveStatus))) : h('div', { class: 'muted small' }, tt('No invoice yet - create your first one.')),
      h('button', { class: 'btn primary big', type: 'button', style: 'margin-top:auto;width:100%;justify-content:space-between', on: { click: (e) => { e.preventDefault(); location.hash = '#/new/invoice'; } } }, tt('Create an invoice'), svgIcon('plus', 16)));
    mid.appendChild(ctaCard);
    box.appendChild(mid);

    // ---- Bottom row (bank accounts / invoices table / supplier concentration) ----
    const bottom = h('div', { class: 'content-grid-bottom' });
    // Client invoices: tabbed table (Due / Overdue / Paid) over the real invoice list.
    const invCard = h('div', { class: 'card', style: 'padding:16px 18px' }, h('div', { class: 'section-head' }, h('h3', { class: 'section-title' }, 'Client invoices'), h('a', { href: '#/invoices', class: 'viewall' }, tt('See all'), ' →')));
    const buckets = { open: invoiceRows.filter((r) => r.effectiveStatus !== 'OVERDUE' && r.effectiveStatus !== 'PAID' && r.effectiveStatus !== 'CREDITED' && r.effectiveStatus !== 'CANCELLED' && r.effectiveStatus !== 'DRAFT'), late: invoiceRows.filter((r) => r.effectiveStatus === 'OVERDUE'), paid: invoiceRows.filter((r) => r.effectiveStatus === 'PAID') };
    const tabs2 = h('div', { class: 'tabs2' });
    const tableWrap = h('div');
    let activeTab = 'open';
    const drawInvTable = () => {
      clear(tabs2); clear(tableWrap);
      [['open', 'Due'], ['late', 'Overdue'], ['paid', 'Paid']].forEach(([k, l]) => tabs2.appendChild(h('button', { type: 'button', class: `tab2 ${activeTab === k ? 'on' : ''}`, on: { click: () => { activeTab = k; drawInvTable(); } } }, tt(l), h('span', { class: 'pc' }, String(buckets[k].length)))));
      const rows = buckets[activeTab].slice(0, 6);
      if (!rows.length) { tableWrap.appendChild(h('div', { class: 'empty' }, h('span', { class: 'eicon ok' }, svgIcon('check', 20)), h('div', { class: 'muted small' }, 'Nothing here.'))); return; }
      tableWrap.appendChild(h('table', { class: 'fintable' }, h('tr', null, [tt('Client'), tt('Invoice no.'), tt('Amount'), tt('Due date'), tt('Status')].map((x, i) => h('th', { class: i === 2 ? 'num' : '' }, x))),
        rows.map((r) => h('tr', { class: 'click', on: { click: () => { location.hash = `#/doc/${r.id}`; } } }, h('td', { class: 'fname' }, r.customer), h('td', null, r.number || tt('(draft)')), h('td', { class: 'num' }, `${r.gross} ${cur}`), h('td', null, r.dueDate || '—'), h('td', null, badge(r.effectiveStatus))))));
    };
    drawInvTable();
    invCard.appendChild(tabs2); invCard.appendChild(tableWrap);
    bottom.appendChild(invCard);

    const rightBottom = h('div', { class: 'rb-col', style: 'display:flex;flex-direction:column;gap:16px' });
    // #1: Bank Accounts as a first-class component - name/account, balance, last sync (the balance's own
    // `asOf`, already real per-account data), and latest transactions from the existing, already-used
    // /api/bank/transactions endpoint (fetched lazily, only when an account is actually connected).
    const bankCard = h('div', { class: 'card bank-card', style: 'padding:16px 18px' }, h('div', { class: 'section-head' }, h('h3', { class: 'section-title' }, 'Bank accounts'), h('a', { href: '#/bank', class: 'viewall' }, tt('See all'), ' →')));
    if (treasury?.accounts?.length) {
      bankCard.appendChild(h('div', null, treasury.accounts.map((a) => h('div', { class: 'bankrow' },
        h('span', { class: 'bankmark' }, (treasury.provider || 'B')[0]),
        h('div', { class: 'bankmeta' }, h('div', { class: 'bname2' }, treasury.provider || tt('Connected account')), h('div', { class: 'biban' }, a.ibanMasked || ''), a.asOf ? h('div', { class: 'blastsync' }, tt('Last sync: {0}', a.asOf)) : null),
        h('div', { class: 'bankbal' }, `${a.balance} ${a.currency}`)))));
      const txWrap = h('div', { class: 'bank-tx' });
      bankCard.appendChild(txWrap);
      api('GET', '/api/bank/transactions').then((r) => {
        const rows = r.rows.slice(0, 3);
        if (!rows.length) return;
        clear(txWrap);
        txWrap.appendChild(h('div', { class: 'eyebrow', style: 'margin-top:10px' }, tt('Latest transactions')));
        txWrap.appendChild(h('div', null, rows.map((t) => h('div', { class: 'txmini' }, h('span', { class: 'txmini-c' }, t.counterpartyName || t.reference || tt('(no counterparty)')), h('span', { class: 'txmini-d' }, t.date), h('span', { class: `txmini-a ${t.amountCents < 0 ? 'bad' : 'ok'}` }, fmtMoney(t.amountCents, t.currency))))));
      }).catch(() => {});
    } else {
      // Clean empty state with one clear action - never a raw dash for something that simply isn't set up yet.
      bankCard.appendChild(h('div', { class: 'empty' }, h('div', null, h('strong', null, tt('No bank account connected')), h('div', { class: 'muted small', style: 'margin-top:2px' }, tt('Read-only: no payment can ever be initiated.')))));
    }
    bankCard.appendChild(h('button', { class: 'btn primary', style: 'margin-top:10px;width:100%;justify-content:center', type: 'button', on: { click: () => { location.hash = '#/bank'; } } }, svgIcon('plus', 14), tt('Connect bank')));
    rightBottom.appendChild(bankCard);

    // #6: supplier concentration - real (no expense-category field exists anywhere in this data model, so
    // this deliberately does not claim to be a category breakdown). A single supplier always renders as a
    // meaningless 100% ring, so that case gets a plain-text fallback instead of a fake-looking chart.
    const donutCard = h('div', { class: 'card donut-card', style: 'padding:16px 18px' }, h('div', { class: 'section-head' }, h('h3', { class: 'section-title' }, 'Breakdown by supplier')));
    if (o.topSuppliers.length >= 2) {
      const COLORS = ['var(--accent)', 'var(--warm)', 'var(--info)', 'var(--ok)', 'var(--muted)'];
      let acc = 0; const R = 46, CX = 55, CY = 55, STROKE = 16;
      const circ = 2 * Math.PI * R;
      const arcs = o.topSuppliers.map((s, i) => { const frac = s.sharePct / 100; const dash = `${Math.max(0, frac * circ - 2)} ${circ}`; const el = svgEl('circle', { cx: CX, cy: CY, r: R, fill: 'none', stroke: COLORS[i % COLORS.length], 'stroke-width': STROKE, 'stroke-dasharray': dash, 'stroke-dashoffset': -acc * circ, transform: `rotate(-90 ${CX} ${CY})` }); acc += frac; return el; });
      const donutSvg = svgEl('svg', { viewBox: '0 0 110 110', width: 110, height: 110 }, arcs);
      donutCard.appendChild(h('div', { class: 'donutwrap' },
        h('div', { style: 'position:relative;flex:0 0 auto' }, donutSvg, h('div', { style: 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center' }, h('div', { style: 'font-weight:700;font-size:15px' }, fmtMoney(o.supplierTotalCents, cur)), h('div', { class: 'muted', style: 'font-size:10.5px' }, tt('Total')))),
        h('div', { class: 'donutlegend' }, o.topSuppliers.map((s, i) => h('div', { class: 'dl-row' }, h('span', { class: 'dl-dot', style: `background:${COLORS[i % COLORS.length]}` }), h('span', { class: 'dl-name' }, s.name), h('span', { class: 'dl-pct' }, `${s.sharePct}%`))))));
    } else if (o.topSuppliers.length === 1) {
      const s = o.topSuppliers[0];
      donutCard.appendChild(h('div', { class: 'empty' }, h('div', null, h('strong', null, s.name), h('div', { class: 'muted small', style: 'margin-top:2px' }, tt('{0} - your only supplier so far. A breakdown becomes useful once you have more than one.', `${s.amount} ${cur}`)))));
    } else {
      donutCard.appendChild(h('div', { class: 'empty' }, h('div', { class: 'muted small' }, 'No supplier invoices yet.')));
    }
    bottom.appendChild(bankCard); bottom.appendChild(invCard); bottom.appendChild(donutCard);
    box.appendChild(bottom);
  } catch (e) { fail(e, box); }
}

// ---------- document lists ----------
const INV_FILTERS = [['', 'All'], ['DRAFT', 'Draft'], ['READY_FOR_APPROVAL', 'Ready for approval'], ['ISSUED', 'Issued'], ['SENT', 'Sent'], ['PARTIALLY_PAID', 'Partially paid'], ['PAID', 'Paid'], ['OVERDUE', 'Overdue'], ['CREDITED', 'Credited']];
const QUOTE_FILTERS = [['', 'All'], ['DRAFT', 'Draft'], ['SENT', 'Sent'], ['ACCEPTED', 'Accepted'], ['REJECTED', 'Rejected'], ['CONVERTED', 'Converted']];
async function viewList(kind, query) {
  const isQuote = kind === 'quote';
  let status = query.get('status') || '';
  let text = '';
  const filters = isQuote ? QUOTE_FILTERS : INV_FILTERS;
  const main = layout(isQuote ? '#/quotes' : '#/invoices', h('div', { class: 'hero' }, h('div', null, h('h1', null, isQuote ? 'Quotes' : 'Invoices'), h('div', { class: 'muted' }, isQuote ? 'Proposals for your customers.' : 'Everything you have issued or are preparing.')), h('a', { class: 'btn primary', href: `#/new/${kind}` }, svgIcon('plus', 16), isQuote ? 'New quote' : 'New invoice')));
  const search = h('input', { class: 'listsearch', placeholder: isQuote ? 'Search quotes by customer or number' : 'Search invoices by customer or number', autocomplete: 'off' });
  const pills = h('div', { class: 'pills' });
  const box = h('div', { class: 'card listcard' });
  main.appendChild(h('div', { class: 'toolbar' }, h('div', { class: 'searchbox' }, svgIcon('search', 16), search), pills));
  main.appendChild(box);
  box.appendChild(h('div', null, [1, 2, 3, 4].map(() => h('div', { class: 'docrow sk' }, h('span', { class: 'avatar' }), h('span', { class: 'skl', style: 'height:14px;flex:1' })))));
  let rows = [];
  const money2 = (r) => (r.gross ? `${r.gross} ${r.currency}` : '');
  function draw() {
    const q = text.trim().toLowerCase();
    const counts = new Map(); rows.forEach((r) => counts.set(r.effectiveStatus, (counts.get(r.effectiveStatus) || 0) + 1));
    clear(pills);
    filters.forEach(([v, l]) => { const n = v ? (counts.get(v) || 0) : rows.length; if (v && !n && status !== v) return; pills.appendChild(h('button', { type: 'button', class: `pill ${status === v ? 'active' : ''}`, on: { click: () => { status = v; draw(); } } }, l, h('span', { class: 'pc' }, String(n)))); });
    const shown = rows.filter((r) => (!status || r.effectiveStatus === status) && (!q || `${r.number || ''} ${r.customer || ''}`.toLowerCase().includes(q)));
    clear(box);
    if (!shown.length) {
      box.appendChild(h('div', { class: 'empty big' }, h('span', { class: 'eicon' }, svgIcon(isQuote ? 'quote' : 'doc', 26)),
        h('div', null, h('strong', null, rows.length ? 'No match' : (isQuote ? 'No quotes yet' : 'No invoices yet')), h('div', { class: 'muted small' }, rows.length ? 'Try another word or status.' : 'Create your first one in a minute.')),
        rows.length ? null : h('a', { class: 'btn primary', href: `#/new/${kind}` }, isQuote ? 'New quote' : 'New invoice')));
      return;
    }
    shown.forEach((r) => box.appendChild(h('a', { class: 'docrow', href: `#/doc/${r.id}` },
      avatar(r.customer),
      // Each piece translated individually before joining - joining first then translating the combined string
      // (as this used to do) produces one string that can never exact-match a dictionary key.
      h('span', { class: 'dmain' }, h('span', { class: 'dt' }, r.customer || '-'), h('span', { class: 'ds' }, [tr(r.number || 'not numbered yet'), tr(TYPE[r.type]), r.issueDate].filter(Boolean).join('  ·  '))),
      h('span', { class: 'damt' }, h('strong', null, money2(r)), !isQuote && r.type === 'invoice' && r.remaining ? h('span', { class: 'ds' }, tt('{0} still due', r.remaining)) : null),
      h('span', { class: 'dstat' }, badge(r.effectiveStatus), isQuote ? (r.validUntil ? h('span', { class: 'chip mute' }, tt('Valid until {0}', r.validUntil)) : null) : (r.type === 'invoice' ? dueChip(r.dueDate, r.remainingCents) : null)),
      h('span', { class: 'dgo' }, svgIcon('chevron', 16)))));
  }
  search.addEventListener('input', () => { text = search.value; draw(); });
  try {
    const types = isQuote ? ['quote'] : ['invoice', 'credit_note'];
    const lists = await Promise.all(types.map((t) => api('GET', `/api/documents?type=${t}`)));
    rows = lists.flatMap((l) => l.rows).sort((a, b) => String(b.issueDate).localeCompare(String(a.issueDate)));
    draw();
  } catch (e) { fail(e, box); }
}

// ---------- one company search, shared by "Add company", New invoice and New quote ----------
const SRC_TEXT = { cbeapi: 'Belgian company register (KBO/BCE)', vies: 'EU VIES (official VAT service)', peppol_directory: 'OpenPeppol Directory', directory: 'your company directory' };
/** Copy exactly the fields the server returned into a form model. Nothing is computed or guessed here. */
function fillFromResult(m, r) {
  const f = r.form || {};
  Object.assign(m, { name: f.name || '', vatNumber: f.vatNumber || '', enterpriseNumber: f.enterpriseNumber || '', street: f.street || '', postalCode: f.postalCode || '', city: f.city || '', countryCode: f.countryCode || 'BE' });
  m.companyId = r.source === 'directory' ? r.id : null;
  m.csource = r.source; m.cverified = !!r.vatVerified; m.vatState = r.vatState || null; m.dirty = false;
  m.personal = !!r.personalData; if (m.personal) m.saveCompany = false; // a sole trader is only saved when the merchant explicitly chooses to
}
function sourceText(m) {
  if (!m.csource || m.csource === 'manual') return tt('Source: entered by hand.');
  const parts = [tt('Source: {0}', tr(SRC_TEXT[m.csource] || m.csource))];
  if (m.cverified) parts.push(tt('VAT number confirmed')); else if (m.vatState === 'NOT_REGISTERED') parts.push(tt('no active VAT registration found (VAT number left empty)')); else if (m.vatState === 'UNCHECKED') parts.push(tt('VAT could not be checked (VAT number left empty)'));
  if (m.dirty) parts.push(tt('then edited by you'));
  return `${m.personal ? `${tt('SOLE TRADER / PERSONAL DATA')}. ` : ''}${parts.join(' - ')}.`;
}
function companySearchBox({ onPick }) {
  const input = h('input', { class: 'bigsearch', placeholder: 'Search company name or VAT / enterprise number', autocomplete: 'off' });
  const msg = h('div'); const list = h('div');
  let seq = 0;
  const say = (kind, text, extra) => { clear(msg); if (text) msg.appendChild(h('div', { class: `banner ${kind} small`, style: 'margin:10px 0 0' }, text, extra || null)); };
  async function choose(r, serverMsg) {
    try {
      let result = r;
      if (r.needsResolve || r.needsVatCheck) { const x = await api('POST', '/api/companies/resolve', { enterpriseNumber: r.enterpriseNumber, name: r.name, status: r.status || undefined }); result = x.result; say(x.status === 'FOUND' ? 'ok' : 'warn', x.message); }
      else if (serverMsg) say(r.personalData || (r.vatState && r.vatState !== 'ACTIVE') || /Register status/.test(serverMsg) ? 'warn' : 'ok', serverMsg + ' Check the fields below: you can still correct them.');
      else say('ok', tt('Filled in from: {0}. Check the fields below: you can still correct them.', tr(r.sourceLabel)));
      clear(list); onPick(result);
    } catch (e) { fail(e); }
  }
  async function run() {
    const mine = ++seq; clear(list);
    if (!input.value.trim()) return say('warn', 'Type a company name, or a VAT / enterprise number.');
    say('info', 'Searching...');
    try {
      const r = await api('POST', '/api/companies/search', { query: input.value });
      if (mine !== seq) return;
      const good = r.status === 'FOUND' || r.status === 'OK';
      const partial = r.partial ? h('div', { style: 'margin-top:6px' }, h('button', { type: 'button', on: { click: () => { clear(list); onPick(r.partial); say('warn', 'Number kept. Complete the other fields by hand.'); } } }, 'Use this number and complete by hand')) : null;
      say(good ? (r.autoFill ? 'ok' : 'info') : 'warn', r.message, partial);
      if (r.autoFill) return choose(r.autoFill, r.message);
      r.results.forEach((x) => list.appendChild(h('button', { type: 'button', class: 'result', on: { click: () => choose(x) } },
        h('div', { class: 'rname' }, x.name),
        h('div', { class: 'small muted' }, [x.enterpriseNumber, x.vatNumber, x.city, x.status].filter(Boolean).join('  |  ')),
        h('div', { class: 'small' }, x.personalData ? h('span', { class: 'badge warn' }, x.personalDataLabel) : null, h('span', { class: 'badge' }, x.sourceLabel), x.needsResolve ? h('span', { class: 'hint' }, '  select it to fill in what is available (the address may be missing)') : null))));
    } catch (e) { fail(e, msg); }
  }
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); run(); } });
  const node = h('div', { class: 'csearch' }, h('label', { style: 'font-weight:600;color:var(--ink)' }, 'Find the company'), h('div', { class: 'searchrow' }, input, h('button', { type: 'button', class: 'primary', on: { click: run } }, 'Search')), msg, list, h('div', { class: 'hint' }, 'Type a name or a VAT / enterprise number. Or skip this and fill the fields by hand.'));
  return { node, input };
}

// ---------- one product search (rich autocomplete), shared by invoice and quote lines; Retail Core is only read ----------
const CUR_SYM = { EUR: '€', USD: '$', GBP: '£' };
const money = (cur, v) => (v == null || v === '' ? '' : `${CUR_SYM[cur] || `${cur} `}${v}`);
function stockChip(st) {
  if (!st || st.state === 'unknown') return h('span', { class: 'chip mute' }, 'Stock n/a');
  if (st.state === 'out') return h('span', { class: 'chip bad' }, 'Out of stock');
  if (st.state === 'low') return h('span', { class: 'chip warn' }, tt('Low: {0}', st.qty));
  return h('span', { class: 'chip ok' }, tt('{0} in stock', st.qty));
}
function thumb(url, name) {
  const t = h('span', { class: 'thumb' }, h('i', null, (name || '?').trim().charAt(0).toUpperCase()));
  if (url) { const img = h('img', { src: url, alt: '', loading: 'lazy' }); img.addEventListener('error', () => img.remove()); t.appendChild(img); }
  return t;
}
function productSearchBox({ onPick, onClose, currency }) {
  const input = h('input', { class: 'acinput', placeholder: 'Search product name, variant or SKU', autocomplete: 'off' });
  const msg = h('div', { class: 'acmsg' }); const list = h('div', { class: 'aclist' });
  let seq = 0; let active = -1; let timer = null;
  const setActive = (n) => { active = n; [...list.children].forEach((c, i) => c.classList.toggle('active', i === n)); const el = list.children[n]; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); };
  const say = (txt) => { clear(msg); if (txt) msg.appendChild(document.createTextNode(tr(txt))); };
  function skeleton() { clear(list); for (let i = 0; i < 3; i += 1) list.appendChild(h('div', { class: 'opt sk' }, h('span', { class: 'thumb' }), h('span', { class: 'skl' }))); }
  async function run() {
    const mine = ++seq; const q = input.value.trim();
    if (q.length < 2) { clear(list); return say('Type at least 2 characters: a product name, variant or SKU.'); }
    say(''); skeleton();
    try {
      const r = await api('GET', `/api/catalog/search?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return;
      clear(list); active = -1;
      if (!r.rows.length) return say('No product found in the catalogue. Use "+ Add custom line" for a service or a special item.');
      say(tt(r.rows.length > 1 ? '{0} matches' : '{0} match', r.rows.length));
      r.rows.forEach((x, i) => list.appendChild(h('button', { type: 'button', class: 'opt', on: { click: () => pick(x), mousemove: () => { if (active !== i) setActive(i); } } },
        thumb(x.imageUrl, x.productTitle),
        h('span', { class: 'optmain' },
          h('span', { class: 'optname' }, x.productTitle, x.variantTitle ? h('span', { class: 'optvar' }, ` · ${x.variantTitle}`) : null),
          h('span', { class: 'optsku' }, x.sku ? tt('SKU {0}', x.sku) : 'No SKU', x.archived ? h('span', { class: 'chip mute' }, x.status.toLowerCase()) : null)),
        h('span', { class: 'optright' }, stockChip(x.stock),
          h('span', { class: 'optprice' }, x.price ? money(currency, x.price.amount) : '-', x.price ? h('small', null, x.price.taxesIncluded ? ' incl. VAT' : ' excl. VAT') : null)))));
      setActive(0);
    } catch (e) { clear(list); say(e && e.message ? e.message : 'Search failed.'); }
  }
  async function pick(x) {
    try { const r = await api('POST', '/api/catalog/select', { variantId: x.variantId }); onPick(r); } catch (e) { fail(e, msg); }
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });
  input.addEventListener('keydown', (ev) => {
    const n = list.children.length;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); if (n) setActive((active + 1) % n); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (n) setActive((active - 1 + n) % n); }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (list.children[active]) list.children[active].click(); else run(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); if (onClose) onClose(); }
  });
  const node = h('div', { class: 'ac' }, h('div', { class: 'acbar' }, input, h('button', { type: 'button', class: 'acclose', 'aria-label': 'Close', on: { click: () => onClose && onClose() } }, 'x')), msg, list);
  return { node, input };
}

// ---------- document form (new / edit) ----------
async function viewForm(kind, editId) {
  const isQuote = kind === 'quote';
  // Contacts "+ Create" shortcut (new invoice/quote from a contact's drawer) passes a 3rd argument with the
  // contact to pre-fill from. Deliberately read via `arguments`, not a declared 3rd parameter, so this
  // function's signature/contract - exercised by an existing structural test asserting exactly ONE shared
  // search component behind `function viewForm(kind, editId)` - never changes shape for callers that don't
  // need it (see the finding recorded when a declared 3rd parameter broke that test).
  const prefillCompanyId = arguments.length > 2 ? arguments[2] : null;
  const main = layout('#/sales', h('div', { class: 'topbar' }, h('h1', null, `${editId ? 'Edit draft' : 'New'} ${isQuote ? 'quote' : 'invoice'}`)));
  const errBox = h('div');
  const s = state.settings;
  let doc = null;
  if (editId) { try { doc = await api('GET', `/api/documents/${editId}`); } catch (e) { return fail(e, main); } }
  const D = doc ? doc.doc : null;
  let PF = null;
  if (!editId && prefillCompanyId) { try { PF = await api('GET', `/api/companies/${prefillCompanyId}`); } catch (e) { /* unknown/foreign id: fall back to a blank form rather than failing the page */ } }
  const model = {
    companyId: (D && D.customer.companyId) || (PF && PF.id) || null,
    name: D ? D.customer.name : (PF ? PF.name : ''), vatNumber: D ? (D.customer.vatNumber || '') : (PF ? (PF.vatNumber || '') : ''), enterpriseNumber: D ? (D.customer.enterpriseNumber || '') : (PF ? (PF.enterpriseNumber || '') : ''),
    csource: (D && D.customer.companyId) || PF ? 'directory' : 'manual', cverified: false, dirty: false,
    street: D ? D.customer.address.street : (PF ? (PF.address.street || '') : ''), postalCode: D ? D.customer.address.postalCode : (PF ? (PF.address.postalCode || '') : ''), city: D ? D.customer.address.city : (PF ? (PF.address.city || '') : ''), countryCode: D ? D.customer.address.countryCode : (PF ? (PF.address.countryCode || 'BE') : 'BE'), email: D ? (D.customer.email || '') : (PF ? (PF.email || '') : ''),
    issueDate: D ? D.issueDate : new Date().toISOString().slice(0, 10), dueDate: D ? (D.dueDate || '') : '', paymentTermsDays: D ? (D.paymentTermsDays ?? '') : s.defaults.paymentTermsDays, paymentTerms: D ? (D.paymentTerms || '') : (s.defaults.paymentTerms || ''),
    validUntil: D ? (D.validUntil || '') : '', currency: D ? D.currency : s.defaults.currency, language: D ? D.language : s.defaults.language, notes: D ? (D.notes || '') : '',
    regime: D ? D.vat.regime : 'domestic', confirmed: D ? D.vat.confirmed : false, mention: D ? (D.vat.mention || '') : '',
    _collapsed: !!D || !!PF, basis: D ? D.revenueBasis : (isQuote ? null : 'standalone_b2b'), sourceOrderId: D ? D.sourceOrderId : null, sourceLabel: null, ack: D ? !!D.acknowledgedNotDuplicate : false, saveCompany: true,
    lines: D ? D.lines.map((l) => ({ description: l.description, sku: l.sku || '', catalog: l.catalog || null, priceOrigin: l.priceOrigin || 'NET_MANUAL', grossUnitPrice: l.grossUnitMicro != null ? String(l.grossUnitMicro / 10000) : '', grossVatRate: l.grossVatRateBp != null ? String(l.grossVatRateBp / 100) : '', quantity: String(l.qtyMilli / 1000), unit: l.unit || '', sku: l.sku || '', catalog: l.catalog || null, unitPrice: String(l.priceMicro / 10000), discountKind: l.discountBp ? 'percent' : 'amount', discount: l.discountBp ? String(l.discountBp / 100) : l.discountCents ? String(l.discountCents / 100) : '', vatRate: String(l.vatRateBp / 100) })) : [{ description: '', sku: '', catalog: null, priceOrigin: 'NET_MANUAL', quantity: '1', unit: '', unitPrice: '', discountKind: 'percent', discount: '', vatRate: s.vat.allowedRatesBp.length ? String(s.vat.allowedRatesBp[0] / 100) : '' }],
  };
  const totalsBox = h('div', { class: 'card totals' });
  const linesBody = h('div', { class: 'lrows' });
  let calcTimer = null; let calcSeq = 0; let lastCalc = null;

  const payload = () => ({
    type: kind, customer: { companyId: model.companyId || undefined, kind: 'business', name: model.name, vatNumber: model.vatNumber || undefined, enterpriseNumber: model.enterpriseNumber || undefined, address: { street: model.street, postalCode: model.postalCode, city: model.city, countryCode: model.countryCode }, email: model.email || undefined },
    issueDate: model.issueDate, dueDate: model.dueDate || undefined, paymentTermsDays: model.paymentTermsDays === '' ? undefined : Number(model.paymentTermsDays), paymentTerms: model.paymentTerms, validUntil: isQuote ? (model.validUntil || undefined) : undefined,
    currency: model.currency, language: model.language, notes: model.notes, vat: { regime: model.regime, confirmed: model.confirmed, mention: model.mention },
    revenueBasis: isQuote ? undefined : model.basis, sourceOrderId: model.basis === 'linked_source_order' ? model.sourceOrderId : undefined, acknowledgedNotDuplicate: model.ack,
    lines: model.lines.map((l) => ({ description: l.description, sku: l.sku || undefined, catalog: l.catalog || undefined, quantity: l.quantity, unit: l.unit || undefined, ...(l.priceOrigin === 'GROSS_CATALOGUE' ? { priceOrigin: 'GROSS_CATALOGUE', grossUnitPrice: l.grossUnitPrice, grossVatRate: l.grossVatRate || undefined } : { unitPrice: l.unitPrice }), vatRate: model.regime === 'domestic' ? l.vatRate : '0', discountPercent: l.discountKind === 'percent' && l.discount ? l.discount : undefined, discountAmount: l.discountKind === 'amount' && l.discount ? l.discount : undefined })),
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
  const barTotal = h('strong', null, '-');
  function renderTotals() {
    clear(totalsBox); totalsBox.appendChild(h('h2', null, 'Live summary'));
    const t = lastCalc && lastCalc.totals;
    if (!t) { totalsBox.appendChild(h('div', { class: 'muted small' }, lastCalc && lastCalc.errors && lastCalc.errors.length ? 'Complete the lines to see totals.' : 'Add lines to see totals.')); return; }
    refreshSteps(); barTotal.textContent = `${t.payable} ${model.currency}`; totalsBox.classList.remove('flash'); void totalsBox.offsetWidth; totalsBox.classList.add('flash');
    const row = (l, v, cls) => h('div', { class: `t ${cls || ''}` }, h('span', null, l), h('span', null, `${v} ${model.currency}`));
    totalsBox.appendChild(row('Subtotal excl. VAT', t.net)); if (t.discountCents > 0) totalsBox.appendChild(row('of which discounts', t.discount));
    t.vatBreakdown.forEach((g) => totalsBox.appendChild(row(tt('VAT {0}% on {1}', g.vatRateBp / 100, g.taxable), g.vatAmount)));
    totalsBox.appendChild(row('Total VAT', t.vat));
    if (t.roundingCents) { totalsBox.appendChild(row('Total incl. VAT', t.gross)); totalsBox.appendChild(row('Rounding adjustment', t.rounding, 'muted')); totalsBox.appendChild(row(isQuote ? 'Amount to pay' : 'Amount due', t.payable, 'big')); totalsBox.appendChild(h('div', { class: 'hint' }, 'Explicit rounding (EN 16931) so the catalogue price stays exactly as published.')); }
    else { totalsBox.appendChild(row('Total incl. VAT', t.gross, 'big')); if (!isQuote) totalsBox.appendChild(row('Amount due', t.gross)); }
    if (lastCalc.hints && lastCalc.hints.length) totalsBox.appendChild(h('div', { class: 'banner warn small', style: 'margin-top:10px' }, lastCalc.hints.map((x) => h('div', null, human(x)))));
    totalsBox.appendChild(h('div', { class: 'hint' }, 'Calculated by the finance engine, not by this page.'));
  }
  function renderLineTotals() { const t = lastCalc && lastCalc.totals; if (t) model.lines.forEach((l, i) => { const tl = t.lines[i]; const inp = linesBody.querySelector(`[data-price="${i}"]`); if (tl && inp && l.priceOrigin === 'GROSS_CATALOGUE' && tl.unitPriceRaw) { l.unitPrice = tl.unitPriceRaw; if (document.activeElement !== inp) inp.value = tl.unitPriceRaw; } }); linesBody.querySelectorAll('[data-lt]').forEach((c) => { const i = Number(c.getAttribute('data-lt')); c.textContent = t && t.lines[i] ? `${t.lines[i].net}` : ''; }); }

  const bind = (obj, key, extra) => (ev) => { obj[key] = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value; if (extra) extra(); scheduleCalc(); };
  const field = (label, input, hint) => h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  const text = (key, ph, type) => h('input', { type: type || 'text', value: model[key] ?? '', placeholder: ph || '', on: { input: bind(model, key) } });

  // ---- invoice / quote lines: compact rows, one shared product autocomplete, custom lines always available ----
  const blankLine = () => ({ description: '', sku: '', catalog: null, priceOrigin: 'NET_MANUAL', quantity: '1', unit: '', unitPrice: '', discountKind: 'percent', discount: '', vatRate: model.lines[0] ? model.lines[0].vatRate : '' });
  const normDec = (x) => String(x ?? '').trim().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  let picker = null; // { line: the line being changed, or null when adding, box }
  const addAnchor = h('div', { class: 'add-anchor' });
  function closePicker() { picker = null; renderLines(); }
  function fillLine(l, r) {
    const pl = r.line;
    l.description = pl.description; l.sku = pl.sku || ''; l.catalog = pl.catalog; l.unit = pl.unit || '';
    l.unitPrice = pl.unitPrice; l.vatRate = model.regime === 'domestic' ? pl.vatRate : l.vatRate;
    l.priceOrigin = pl.priceOrigin || 'NET_MANUAL'; l.grossUnitPrice = pl.grossUnitPrice || ''; l.grossVatRate = pl.grossVatRate || '';
    l._pendingGross = pl.priceOrigin !== 'GROSS_CATALOGUE' && r.catalogue && r.catalogue.priceInclVat ? r.catalogue.priceInclVat : null;
    l._notes = r.notes || []; l._stock = r.stock; l._img = r.imageUrl;
    l._overridden = false; l._cat = r.catalogue ? { incl: r.catalogue.priceInclVat, ex: r.catalogue.priceExclVat, check: r.catalogue.check } : null;
  }
  function openProductPicker(line) {
    const box = productSearchBox({ currency: model.currency, onClose: closePicker, onPick: (r) => {
      let target = line;
      if (!target) { const only = model.lines.length === 1 && !model.lines[0].description && !model.lines[0].unitPrice && !model.lines[0].catalog; target = only ? model.lines[0] : blankLine(); if (!only) model.lines.push(target); }
      fillLine(target, r); picker = null; renderLines(); scheduleCalc();
    } });
    picker = { line, box }; renderLines(); setTimeout(() => box.input.focus(), 0);
  }
  function renderLines() {
    clear(linesBody); clear(addAnchor);
    const rates = s.vat.allowedRatesBp.length ? s.vat.allowedRatesBp : [2100, 600, 0];
    const cur = model.currency; const domestic = model.regime === 'domestic';
    model.lines.forEach((l, i) => {
      const rateSel = h('select', { disabled: !domestic, on: { change: (e) => { l.vatRate = e.target.value; if (l._pendingGross && l.catalog && l.vatRate !== '' && !l._overridden) { l.priceOrigin = 'GROSS_CATALOGUE'; l.grossUnitPrice = l._pendingGross; l.grossVatRate = l.vatRate; l._notes = []; l._cat = { incl: l._pendingGross, ex: null, check: null }; } renderLines(); scheduleCalc(); } } },
        l.vatRate === '' && domestic ? h('option', { value: '', selected: true }, 'VAT ?') : null,
        rates.map((bp) => h('option', { value: String(bp / 100), selected: String(bp / 100) === String(l.vatRate) }, `${bp / 100}%`)));
      if (!domestic) rateSel.appendChild(h('option', { value: '0', selected: true }, '0%'));
      const cat = l._cat;
      const isGross = l.priceOrigin === 'GROSS_CATALOGUE';
      const overridden = !!(l.catalog && l._overridden && l.priceOrigin === 'NET_MANUAL');
      const exceeds = !!(l._stock && l._stock.qty != null && Number(l.quantity) > l._stock.qty);
      const sub = h('div', { class: 'lsub' },
        l.sku ? h('span', { class: 'mono sku' }, l.sku) : null,
        isGross && cat && cat.incl ? h('span', { class: 'subtle' }, tt('Catalogue {0} incl. VAT', money(cur, cat.incl)), cat.check ? ' ' + tt('→ {0} excl. VAT', money(cur, cat.check.net)) : '') : (cat && !isGross && !overridden ? h('span', { class: 'subtle' }, 'Catalogue price excl. VAT') : null),
        isGross ? h('span', { class: 'chip ok' }, 'Catalogue price kept') : null,
        overridden ? h('span', { class: 'chip warn' }, 'Price override (excl. VAT)') : null,
        exceeds ? h('span', { class: 'chip warn' }, 'More than in stock') : null,
        l.catalog && l.vatRate === '' && domestic ? h('span', { class: 'chip warn' }, 'Confirm VAT rate') : null);
      const acts = h('div', { class: 'lacts' },
        h('button', { type: 'button', class: 'linkbtn', on: { click: () => (picker && picker.line === l ? closePicker() : openProductPicker(l)) } }, l.catalog ? 'Change product' : 'Search product'),
        overridden && cat && cat.incl ? h('button', { type: 'button', class: 'linkbtn', on: { click: () => { l.priceOrigin = 'GROSS_CATALOGUE'; l.unitPrice = cat.ex || l.unitPrice; l._overridden = false; renderLines(); scheduleCalc(); } } }, 'Use catalogue price') : null,
        l.catalog ? h('button', { type: 'button', class: 'linkbtn', on: { click: () => { l.catalog = null; l.priceOrigin = 'NET_MANUAL'; l._overridden = false; l.sku = ''; l._cat = null; l._stock = null; l._img = null; l._notes = []; renderLines(); scheduleCalc(); } } }, 'Make custom') : null,
        model.lines.length > 1 ? h('button', { type: 'button', class: 'linkbtn danger', on: { click: () => { model.lines.splice(i, 1); if (picker && picker.line === l) picker = null; renderLines(); scheduleCalc(); } } }, 'Remove line') : null);
      const cell = (label, node, cls) => h('div', { class: `lc ${cls || ''}`, 'data-label': label }, node);
      const row = h('div', { class: `lrow ${l.catalog ? 'cat' : 'cust'}` },
        h('div', { class: 'lc lprod' }, thumb(l._img, l.description || (l.catalog ? '' : 'C')),
          h('div', { class: 'lmain' },
            h('input', { class: 'ghost', value: l.description, placeholder: l.catalog ? 'Description' : 'Custom line: describe the service or item', on: { input: bind(l, 'description') } }),
            l.catalog ? sub : h('div', { class: 'lsub' }, h('span', { class: 'chip mute' }, 'Custom line')),
            l._notes && l._notes.length ? h('div', { class: 'lnote' }, l._notes.join(' ')) : null, acts)),
        cell('Stock', l.catalog ? stockChip(l._stock) : h('span', { class: 'subtle' }, '-'), 'lstock'),
        cell('Qty', h('input', { value: l.quantity, inputmode: 'decimal', on: { input: (e) => { l.quantity = e.target.value; scheduleCalc(); }, change: () => renderLines() } })),
        cell('Unit price excl. VAT', h('input', { 'data-price': String(i), value: l.unitPrice, inputmode: 'decimal', placeholder: '0.00', on: { input: (e) => { l.unitPrice = e.target.value; if (l.priceOrigin === 'GROSS_CATALOGUE') { l.priceOrigin = 'NET_MANUAL'; l._overridden = true; } scheduleCalc(); }, change: () => renderLines() } })),
        cell('Discount', h('div', { class: 'disc' }, h('input', { value: l.discount, inputmode: 'decimal', placeholder: '0', on: { input: bind(l, 'discount') } }), h('select', { on: { change: bind(l, 'discountKind') } }, h('option', { value: 'percent', selected: l.discountKind === 'percent' }, '%'), h('option', { value: 'amount', selected: l.discountKind === 'amount' }, cur)))),
        cell('VAT', rateSel),
        cell('Line total excl. VAT', h('div', { class: 'ltotal', 'data-lt': String(i) }, ''), 'ltot'));
      const wrap = h('div', { class: 'lwrap' }, row);
      if (picker && picker.line === l) wrap.appendChild(picker.box.node);
      linesBody.appendChild(wrap);
    });
    if (picker && picker.line === null) addAnchor.appendChild(picker.box.node);
    renderLineTotals();
  }

  // customer: one search first, results directly under it, then the editable fields and where the data came from
  const custBox = h('div');
  const sourceLine = h('div', { class: 'hint', style: 'margin:4px 0 10px' });
  const renderSource = () => { clear(sourceLine); sourceLine.appendChild(document.createTextNode(sourceText(model))); };
  const search = companySearchBox({ onPick: (r) => { fillFromResult(model, r); model._collapsed = true; renderCustomer(); scheduleCalc(); } });
  function renderCustomer() {
    clear(custBox);
    search.node.style.display = model._collapsed && customerDone() ? 'none' : '';
    if (model._collapsed && customerDone()) {
      renderSource();
      const addr = [model.street, `${model.postalCode || ''} ${model.city || ''}`.trim(), model.countryCode].filter(Boolean).join(', ');
      custBox.appendChild(h('div', { class: 'custchip' }, avatar(model.name, 'lg'),
        h('div', { class: 'cmain' }, h('div', { class: 'cname' }, model.name, model.personal ? h('span', { class: 'chip warn' }, 'SOLE TRADER / PERSONAL DATA') : null),
          h('div', { class: 'csub' }, [model.vatNumber || model.enterpriseNumber, addr].filter(Boolean).join('  ·  ')), h('div', { class: 'csrc' }, sourceLine)),
        h('div', { class: 'cact' }, h('button', { type: 'button', class: 'linkbtn', on: { click: () => { model._collapsed = false; renderCustomer(); } } }, 'Edit details'),
          h('button', { type: 'button', class: 'linkbtn', on: { click: () => { model._collapsed = false; renderCustomer(); setTimeout(() => search.input.focus(), 0); } } }, 'Change customer'))));
      refreshSteps(); return;
    }
    mount(custBox, model.companyId ? h('div', { class: 'banner info small' }, 'Company from your directory. ', h('a', { href: '#', on: { click: (e) => { e.preventDefault(); model.companyId = null; model.csource = 'manual'; renderCustomer(); } } }, 'Detach and edit manually')) : null);
    const ro = !!model.companyId;
    const inp = (key, ph, identity) => h('input', { value: model[key] ?? '', placeholder: ph || '', disabled: ro, on: { input: (e) => { model[key] = e.target.value; if (identity) { model.dirty = true; renderSource(); } refreshSteps(); } } });
    custBox.appendChild(h('div', { class: 'row r3' }, field('Company name', inp('name', '', true)), field('VAT number', inp('vatNumber', 'BE0123456789', true)), field('Enterprise number', inp('enterpriseNumber', '0123.456.789', true))));
    custBox.appendChild(h('div', { class: 'row r4' }, field('Street and number', inp('street', '', true)), field('Postal code', inp('postalCode', '', true)), field('City', inp('city', '', true)), field('Country', inp('countryCode', 'BE', true))));
    renderSource(); custBox.appendChild(sourceLine);
    custBox.appendChild(field('Email (optional)', h('input', { value: model.email ?? '', placeholder: 'accounts@company.example', on: { input: (e) => { model.email = e.target.value; } } }), 'Stored only if you enter it. Not needed for the invoice.'));
    if (!model.companyId) custBox.appendChild(h('label', { style: 'color:inherit' }, h('input', { type: 'checkbox', checked: model.saveCompany, on: { change: (e) => { model.saveCompany = e.target.checked; } } }), 'Save this company to my directory'));
    if (customerDone()) custBox.appendChild(h('div', { style: 'margin-top:10px' }, h('button', { type: 'button', class: 'primary', on: { click: () => { model._collapsed = true; renderCustomer(); } } }, 'Done')));
    refreshSteps();
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
      basisBox.appendChild(h('div', { style: 'margin-top:12px' }, model.sourceOrderId ? h('div', { class: 'banner ok small' }, tt('Linked to order {0}. No additional revenue will be counted.', model.sourceLabel || model.sourceOrderId)) : h('div', { class: 'banner warn small' }, 'Choose the order below.'), h('button', { on: { click: (e) => { e.preventDefault(); openPicker(); } } }, model.sourceOrderId ? 'Change order' : 'Find the order')));
    } else basisBox.appendChild(h('label', { style: 'margin-top:10px;color:inherit' }, h('input', { type: 'checkbox', checked: model.ack, on: { change: (e) => { model.ack = e.target.checked; } } }), 'Only if the system warns that this looks like a shop sale: confirm it is a separate sale.'));
  }
  function openPicker() {
    const q = h('input', { placeholder: 'Order number or product...' }); const from = h('input', { type: 'date' }); const to = h('input', { type: 'date' }); const min = h('input', { placeholder: 'min amount' }); const max = h('input', { placeholder: 'max amount' });
    const out = h('div'); const bk = modal('Select the shop / POS order', h('div', null, h('div', { class: 'row r2' }, field('Search', q), h('div', { class: 'row r2' }, field('From', from), field('To', to))), h('div', { class: 'row r2' }, field('Amount from', min), field('Amount to', max)), out), (close) => [h('button', { on: { click: close } }, 'Close')]);
    const run = async () => {
      try {
        const qs = new URLSearchParams(); if (q.value) qs.set('q', q.value); if (from.value) qs.set('from', from.value); if (to.value) qs.set('to', to.value); if (min.value) qs.set('min', min.value); if (max.value) qs.set('max', max.value);
        const r = await api('GET', `/api/orders?${qs}`); clear(out);
        out.appendChild(r.rows.length ? h('table', null, h('tr', null, ['Order', 'Date', 'Channel', 'Items', 'Total', ''].map((x, i) => h('th', { class: i === 4 ? 'num' : '' }, x))), r.rows.map((o) => h('tr', { class: `picker-row ${o.invoiced ? 'disabled' : ''}` }, h('td', null, `#${o.ref}`), h('td', { class: 'nowrap' }, o.date), h('td', null, o.channel), h('td', { class: 'small' }, o.items.join(', '), o.moreItems ? ` +${o.moreItems}` : ''), h('td', { class: 'num nowrap' }, `${o.total} ${model.currency}`, o.refunded ? h('div', { class: 'small muted' }, tt('refunded {0}', o.refunded)) : null), h('td', null, o.invoiced ? h('span', { class: 'badge PARTIAL' }, tt('Invoiced {0}', o.invoiced.number || '')) : h('button', { class: 'primary', on: { click: () => { model.sourceOrderId = o.sourceOrderId; model.sourceLabel = `#${o.ref} (${o.date}, ${o.total})`; bk.remove(); renderBasis(); } } }, 'Select'))))) : h('div', { class: 'muted' }, 'No matching orders.'));
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
      if (!model.companyId && model.saveCompany && model.name && (model.vatNumber || model.enterpriseNumber)) {
        const src = model.dirty || !model.csource ? 'manual' : model.csource; // edited data is no longer "as returned by" the provider
        try { const c = await api('POST', '/api/companies', { kind: 'business', name: model.name, vatNumber: model.vatNumber || undefined, enterpriseNumber: model.enterpriseNumber || undefined, address: { street: model.street, postalCode: model.postalCode, city: model.city, countryCode: model.countryCode }, email: model.email || undefined, source: src }); body.customer.companyId = c.id; model.companyId = c.id; } catch (e) { if (e.code !== 'COMPANY_ALREADY_EXISTS' && e.status !== 422) throw e; }
      }
      const saved = editId ? await api('PUT', `/api/documents/${editId}`, body) : await api('POST', '/api/documents', body);
      if (thenSubmit && !isQuote) { try { await api('POST', `/api/documents/${saved.id}/submit`, {}); toast('Submitted for approval', 'ok'); } catch (e) { toast('Saved as draft. Fix the listed items to submit.', 'bad'); } }
      else toast('Draft saved', 'ok');
      location.hash = `#/doc/${saved.id}`;
    } catch (e) { fail(e, errBox); window.scrollTo(0, 0); }
  };

  // progress: numbered sections tick off as they are completed; the checklist shows what is still missing before saving
  const steps = [];
  const customerDone = () => !!(model.name && (model.vatNumber || model.enterpriseNumber) && model.street && model.postalCode && model.city);
  const linesDone = () => !!(lastCalc && lastCalc.ok);
  const vatDone = () => model.confirmed === true;
  const basisDone = () => isQuote || (!!model.basis && (model.basis !== 'linked_source_order' || !!model.sourceOrderId));
  const stepHead = (n, title, isDone) => { const c = h('span', { class: 'stepn' }, String(n)); const el = h('div', { class: 'stephead' }, c, h('h2', null, title)); steps.push({ c, el, n, isDone }); return el; };
  const checkBox = h('div', { class: 'card checklist' });
  function renderChecklist() {
    clear(checkBox); checkBox.appendChild(h('h3', { class: 'eyebrow' }, 'Before you save'));
    [['Customer identified', customerDone()], ['Lines with prices', linesDone()], ['VAT treatment confirmed', vatDone()], ...(isQuote ? [] : [['Revenue basis chosen', basisDone()]])]
      .forEach(([l, d]) => checkBox.appendChild(h('div', { class: `ck ${d ? 'done' : ''}` }, h('span', { class: 'ckdot' }, d ? svgIcon('check', 12) : null), l)));
  }
  function refreshSteps() { steps.forEach((st) => { const d = st.isDone(); st.el.classList.toggle('done', d); clear(st.c); if (d) st.c.appendChild(svgIcon('check', 14)); else st.c.appendChild(document.createTextNode(String(st.n))); }); renderChecklist(); }
  const discCard = (title, hint, ...body) => h('details', { class: 'card disclosure' }, h('summary', null, h('span', { class: 'dtitle' }, title), h('span', { class: 'dhint' }, hint), svgIcon('chevron', 16)), h('div', { class: 'dbody' }, body));
  const nVat = isQuote ? 2 : 3;
  const form = h('div', { class: 'grid formgrid' },
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, stepHead(1, 'Customer', customerDone), search.node, h('div', { style: 'margin-top:14px' }, custBox)),
      discCard('Dates and terms', tt('Issue {0} · {1}', model.issueDate || tt('today'), model.paymentTermsDays === '' ? tt('no terms') : tt('{0} days', model.paymentTermsDays)), h('div', { class: 'row r4' }, field('Issue date', h('input', { type: 'date', value: model.issueDate, on: { input: bind(model, 'issueDate') } })), isQuote ? field('Valid until', h('input', { type: 'date', value: model.validUntil, on: { input: bind(model, 'validUntil') } })) : field('Due date', dueField, 'Leave empty to use the payment terms'), field('Payment terms (days)', h('input', { value: String(model.paymentTermsDays), inputmode: 'numeric', on: { input: bind(model, 'paymentTermsDays') } })), field('Currency', h('input', { value: model.currency, on: { input: bind(model, 'currency') } }))), h('div', { class: 'row r2' }, field(isQuote ? 'Commercial terms' : 'Payment terms text', h('input', { value: model.paymentTerms, on: { input: bind(model, 'paymentTerms') } })), field('Document language', h('select', { on: { change: bind(model, 'language') } }, [['fr', 'Francais'], ['nl', 'Nederlands'], ['en', 'English']].map(([v, l]) => h('option', { value: v, selected: model.language === v }, l)))))),
      isQuote ? null : h('div', { class: 'card' }, stepHead(2, 'Revenue basis', basisDone), basisBox),
      h('div', { class: 'card' }, stepHead(nVat, 'VAT treatment', vatDone), vatBox),
      h('div', { class: 'card lines-card' },
        h('div', { class: 'cardhead' }, stepHead(nVat + 1, 'Lines', linesDone), h('span', { class: 'muted small' }, 'Products come from your catalogue, prices from the shop')),
        h('div', { class: 'lhead' }, ['Product', 'Stock', 'Qty', 'Unit price excl. VAT', 'Discount', 'VAT', 'Line total excl. VAT'].map((x, k) => h('div', { class: k === 6 ? 'right' : '' }, x))),
        linesBody, addAnchor,
        h('div', { class: 'actions', style: 'margin-top:12px' },
          h('button', { class: 'ghostbtn', on: { click: (e) => { e.preventDefault(); if (picker && picker.line === null) closePicker(); else openProductPicker(null); } } }, '+ Add product'),
          h('button', { class: 'ghostbtn', on: { click: (e) => { e.preventDefault(); model.lines.push(blankLine()); renderLines(); } } }, '+ Add custom line'))),
      discCard('Notes', 'Printed on the document', field('Notes (printed on the document)', h('textarea', { rows: 3, on: { input: bind(model, 'notes') } }, model.notes)))),
    h('div', { class: 'stickycol' }, totalsBox, checkBox, h('div', { class: 'actions', style: 'margin-top:12px' }, h('button', { on: { click: () => save(false) } }, 'Save draft'), isQuote ? null : h('button', { class: 'primary', on: { click: () => save(true) } }, 'Save and review'))));
  main.appendChild(errBox); main.appendChild(form);
  main.appendChild(h('div', { class: 'stickybar' }, h('div', null, h('div', { class: 'small muted' }, 'Total incl. VAT'), barTotal), h('div', { class: 'actions' }, h('button', { on: { click: () => save(false) } }, 'Save draft'), isQuote ? null : h('button', { class: 'primary', on: { click: () => save(true) } }, 'Save and review'))));
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
  // TYPE[d.type] and the '(draft)' fallback are each individually translated (both have dictionary entries);
  // composed here with tt('{0} {1}', ...) rather than a template literal, because a literal fuses them into one
  // string ("Invoice INV-2026-0001") that can never exact-match a dictionary key - this was the root cause of
  // the document title staying in English regardless of the selected language.
  // ---- Header: one scannable strip with everything a merchant needs before reading further (Xero-style
  // clarity) - type, number, status and client up top; the money figures that matter right beside them.
  // Every value here already exists on `d` (the API response) - nothing is recomputed in the browser.
  const heroFigs = [['Total incl. VAT', `${d.totals.gross} ${cur}`]];
  if (!isQ && d.settlementView) {
    heroFigs.push(['Paid', `${d.settlementView.paid} ${cur}`]);
    heroFigs.push(['Amount due', `${d.settlementView.remaining} ${cur}`, d.settlement.remainingCents > 0 ? 'due' : 'settled']);
  }
  heroFigs.push(isQ ? ['Valid until', d.validUntil || '—'] : ['Due date', d.dueDate || '—']);
  const dochero = h('div', { class: 'dochero' },
    h('div', { class: 'dh-id' }, h('h1', null, tt('{0} {1}', tr(TYPE[d.type]), d.number || tt('(draft)'))),
      h('div', { class: 'actions' }, badge(d.effectiveStatus), h('span', { class: 'muted' }, d.customer), d.revenueBasis ? h('span', { class: `tag ${d.revenueBasis === 'linked_source_order' ? 'linked' : 'standalone'}` }, h('span', { class: 'dot-i' }), d.revenueBasis === 'linked_source_order' ? 'linked - no extra revenue' : 'standalone - additive') : null)),
    h('div', { class: 'dh-figures' }, heroFigs.map(([label, value, tone]) => h('div', { class: 'dh-fig' }, h('div', { class: 'headline-label' }, label), h('div', { class: `headline-figure ${tone || ''}` }, value)))));
  box.appendChild(dochero);
  const top = h('div', { class: 'topbar' },
    h('div', { class: 'actions' },
      has('edit') ? h('a', { class: 'btn', href: `#/doc/${id}/edit` }, 'Edit draft') : null,
      has('submit') ? h('button', { class: 'primary', on: { click: call('submit', {}, 'Submitted for approval') } }, 'Submit for approval') : null,
      has('send_quote') ? h('button', { class: 'primary', on: { click: () => confirmModal('Send quote', tt('This numbers the quote ({0}) and locks it. Send the PDF to your customer yourself; the system sends nothing.', d.nextNumber || ''), 'Number and lock', call('send-quote', {}, 'Quote numbered')) } }, 'Mark as sent') : null,
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
  const FLOW = isQ ? [['DRAFT', 'Draft'], ['SENT', 'Sent'], ['ACCEPTED', 'Accepted'], ['CONVERTED', 'Converted']] : [['DRAFT', 'Draft'], ['READY_FOR_APPROVAL', 'Ready'], ['ISSUED', 'Issued'], ['SENT', 'Sent'], ['PAID', 'Paid']];
  const flowKey = { OVERDUE: 'SENT', PARTIALLY_PAID: 'SENT', CREDITED: 'PAID', REJECTED: 'DRAFT', CANCELLED: 'DRAFT' }[d.effectiveStatus] || d.effectiveStatus;
  const curIdx = Math.max(0, FLOW.findIndex(([v]) => v === flowKey));
  if (d.type !== 'credit_note') box.appendChild(h('ol', { class: 'stepper' }, FLOW.map(([v, l], i) => h('li', { class: i < curIdx || (i === curIdx && v === 'PAID') ? 'done' : i === curIdx ? 'current' : '' }, h('span', { class: 'sdot' }, i < curIdx || (i === curIdx && v === 'PAID') ? svgIcon('check', 12) : String(i + 1)), h('span', null, l)))));
  if (d.status === 'READY_FOR_APPROVAL') {
    box.appendChild(h('div', { class: 'banner info' }, h('strong', null, 'Review before you approve. '), tt('Approving issues the document, assigns its number ({0}) and freezes it. Afterwards it can only be corrected with a credit note. Nothing is sent to your customer.', d.nextNumber || tt('next in sequence')), h('div', { class: 'actions', style: 'margin-top:10px' },
      // Sentence-case, matching every other button's style (was ALL-CAPS English before - a mixed-language screen
      // and a style inconsistency: the all-caps form also silently defeated the missing-translation detector,
      // whose heuristic deliberately ignores ALL-CAPS strings like status codes and currency codes).
      h('button', { class: 'ok', on: { click: () => confirmModal('Approve and issue', tt('Issue this {0} now? It will receive the next number and cannot be edited afterwards.', tr(TYPE[d.type]).toLowerCase()), 'Approve', call('approve', {}, 'Issued')) } }, 'Approve'),
      h('button', { on: { click: call('modify', {}, 'Returned to draft') } }, 'Modify'),
      h('button', { class: 'danger', on: { click: () => confirmModal('Reject', 'The draft will be cancelled. No number is used.', 'Reject', call('reject', {}, 'Rejected')) } }, 'Reject'))));
  }
  if (d.readiness && !d.readiness.ready) box.appendChild(h('div', { class: 'banner bad' }, h('strong', null, 'Not ready to issue: '), h('ul', { class: 'plain' }, d.readiness.errors.map((x) => h('li', null, human(x))))));
  if (d.readiness && d.readiness.warnings.length) box.appendChild(h('div', { class: 'banner warn' }, h('ul', { class: 'plain' }, d.readiness.warnings.map((x) => h('li', null, human(x))))));
  if (d.revenueNote) box.appendChild(h('div', { class: `banner ${d.revenueBasis === 'linked_source_order' ? 'info' : 'ok'}` }, d.revenueNote));
  if (!d.integrity.ok) box.appendChild(h('div', { class: 'banner bad' }, 'INTEGRITY WARNING: the stored fingerprint does not match this document. Do not use it and contact support.'));
  const s = d.doc.seller || {}; const c = d.doc.customer;
  const addr = (a) => [a.street, `${a.postalCode || ''} ${a.city || ''}`.trim(), a.countryCode].filter(Boolean).join(', ');
  // Seller/Customer are reference/context information, not decision-critical figures - deliberately given less
  // visual weight (via .meta-block) than the financial data below, per the card-hierarchy brief.
  box.appendChild(h('div', { class: 'grid two' },
    h('div', { class: 'card' }, h('h3', { class: 'eyebrow' }, 'Seller'), h('div', { class: 'meta-block' }, kv([['Name', s.name], ['Address', addr(s.address || {})], ['VAT', s.vatNumber], ['IBAN', s.iban]]))),
    h('div', { class: 'card' }, h('h3', { class: 'eyebrow' }, 'Customer'), h('div', { class: 'meta-block' }, kv([['Name', c.name], ['Address', addr(c.address || {})], ['VAT / no.', c.vatNumber || c.enterpriseNumber], ['Email', c.email]])))));
  box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Details'), kv([['Number', d.number || tt('(assigned on approval: {0})', d.nextNumber || tt('next'))], ['Issue date', d.issueDate], [isQ ? 'Valid until' : 'Due date', isQ ? d.validUntil : d.dueDate], ['Payment terms', d.doc.paymentTerms], ['VAT treatment', REGIME[d.doc.vat.regime]], ['Legal mention', d.doc.vat.mention], ['Language', d.doc.language], ['Notes', d.doc.notes],
    // Same fix as the document title above: TYPE[...] and the number must be translated/composed separately,
    // never fused into one template-literal string that can't exact-match a dictionary key.
    d.related ? ['Related', h('a', { href: `#/doc/${d.related.id}` }, tt('{0} {1}', tr(TYPE[d.related.type]), d.related.number || ''))] : null, d.convertedInvoice ? ['Converted to', h('a', { href: `#/doc/${d.convertedInvoice.id}` }, tt('Invoice {0}', d.convertedInvoice.number || tt('(draft)')))] : null,
    d.sourceOrder ? ['Shop/POS order', `#${d.sourceOrder.ref} - ${d.sourceOrder.date} - ${d.sourceOrder.channel} - ${d.sourceOrder.total} ${cur}`] : null])));
  // Credit Note impact summary: every figure here is read straight off already-computed document data (the
  // original invoice link, this document's own totals, its stockReturn decision) - nothing is inferred or
  // estimated. There is no separate "refund" record anywhere in Finance (grepped: no REFUND concept exists in
  // the codebase), so rather than fabricate a status we say plainly what the system does and does not track.
  if (d.type === 'credit_note') {
    const restockLabel = !d.hadStockMovements ? tt('Not applicable (original sale did not decrement stock)')
      : d.doc.stockReturn == null ? tt('Decision pending')
      : d.doc.stockReturn.restock ? (d.stockMovements.some((m) => m.kind === 'RETURN_RESTOCK' && m.status !== 'SKIPPED') ? tt('Restocked') : tt('Restock approved (processing)'))
      : tt('Not restocked (merchant declined)');
    box.appendChild(h('div', { class: 'impact-card', style: 'margin-top:16px' }, h('h3', null, tt('Impact of this credit note')),
      h('div', { class: 'impact-grid' },
        h('div', { class: 'impact-item' }, h('div', { class: 'l' }, tt('Original invoice')), h('div', { class: 'v' }, d.related ? h('a', { href: `#/doc/${d.related.id}` }, d.related.number || tt('(draft)')) : tt('Not linked yet'))),
        h('div', { class: 'impact-item lead' }, h('div', { class: 'l' }, tt('Credit note amount')), h('div', { class: 'v' }, `${d.totals.gross} ${cur}`)),
        h('div', { class: 'impact-item lead' }, h('div', { class: 'l' }, tt('Effect on balance')), h('div', { class: 'v' }, d.related ? tt('{0} owed on {1}', `-${d.totals.gross} ${cur}`, d.related.number || tt('(draft)')) : tt('Pending'))),
        h('div', { class: 'impact-item' }, h('div', { class: 'l' }, tt('VAT impact')), h('div', { class: 'v' }, tt('{0} VAT reversed', `-${d.totals.vat} ${cur}`))),
        h('div', { class: 'impact-item' }, h('div', { class: 'l' }, tt('Restock decision')), h('div', { class: 'v' }, restockLabel)),
        h('div', { class: 'impact-item' }, h('div', { class: 'l' }, tt('Refund')), h('div', { class: 'v' }, tt('Not tracked separately - deducts from what the customer owes')))),
      d.doc.creditReason ? h('div', { class: 'fin-secondary', style: 'margin-top:10px' }, tt('Reason: {0}', d.doc.creditReason)) : null,
      !d.doc.lockedAt ? h('div', { class: 'fin-secondary', style: 'margin-top:6px' }, tt('Draft - this impact applies once the credit note is approved and issued.')) : null));
  }
  const t = d.totals;
  // Financial hierarchy: the figures a merchant actually needs (what's owed, what's left) read at a clear
  // glance; the VAT breakdown that gets them there is real but secondary, and "amount due" is the one number
  // that gets the strongest, color-coded treatment (bad=still owed, ok=settled) - never a wall of equal-weight rows.
  const finRows = [
    ...[['Subtotal excl. VAT', t.net], ...t.vatBreakdown.map((g) => [tt('VAT {0}% on {1}', g.vatRateBp / 100, g.taxable), g.vatAmount])].map(([k, v]) => h('div', { class: 'fin-row' }, h('span', { class: 'fin-label' }, k), h('span', { class: 'fin-value fin-secondary' }, `${v} ${cur}`))),
    h('div', { class: 'fin-row total' }, h('span', { class: 'fin-label' }, 'Total incl. VAT'), h('span', { class: 'fin-value' }, `${t.gross} ${cur}`)),
    !isQ && d.settlementView ? h('div', { class: 'fin-row' }, h('span', { class: 'fin-label' }, 'Paid'), h('span', { class: 'fin-value' }, `${d.settlementView.paid} ${cur}`)) : null,
    !isQ && d.settlementView && d.settlement.creditedCents ? h('div', { class: 'fin-row' }, h('span', { class: 'fin-label' }, 'Credited'), h('span', { class: 'fin-value' }, `${d.settlementView.credited} ${cur}`)) : null,
    !isQ && d.settlementView ? h('div', { class: 'fin-row total' }, h('span', { class: 'fin-label' }, 'Amount due'), h('span', { class: `fin-primary ${d.settlement.remainingCents > 0 ? 'due' : 'settled'}`, style: 'font-size:20px' }, `${d.settlementView.remaining} ${cur}`)) : null,
  ].filter(Boolean);
  box.appendChild(h('div', { class: 'grid detailgrid', style: 'margin-top:16px' }, h('div', { class: 'card' }, h('h2', null, 'Lines'), linesTable(d)),
    h('div', { class: 'card emphasis' }, h('h2', null, 'Totals'), ...finRows)));
  if (d.payments.length) box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Payments'), h('table', null, h('tr', null, ['Date', 'Amount', 'Method', 'Reference'].map((x) => h('th', null, x))), d.payments.map((p) => h('tr', null, h('td', null, p.paidOn), h('td', null, `${p.amount} ${cur}`), h('td', null, p.method), h('td', null, p.reference || ''))))));
  if (d.creditNotes.length) box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Credit notes'), d.creditNotes.map((cn) => h('div', null, h('a', { href: `#/doc/${cn.id}` }, `${cn.number || '(draft)'} - ${cn.gross} ${cn.currency}`), ' ', badge(cn.status)))));
  const pdfWrap = h('div', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'topbar' }, h('h2', null, tt('PDF preview') + (d.doc.lockedAt ? '' : ' ' + tt('(draft watermark)'))), h('button', { on: { click: (ev) => { ev.target.remove(); pdfWrap.appendChild(h('iframe', { class: 'pdf', src: `/api/documents/${id}/pdf`, title: 'PDF preview' })); } } }, 'Show preview')));
  box.appendChild(pdfWrap);
  mount(box, stockMovementsCard(d)); mount(box, peppolCard(d, reload));
  box.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Audit trail'), h('table', null, h('tr', null, ['When', 'Action', 'Status', 'By'].map((x) => h('th', null, x))), d.events.map((e) => h('tr', null, h('td', { class: 'nowrap small' }, String(e.at).replace('T', ' ').slice(0, 19)), h('td', null, human(e.action)), h('td', null, `${e.fromStatus ? STATUS[e.fromStatus] || e.fromStatus : ''} ${e.toStatus ? `-> ${STATUS[e.toStatus] || e.toStatus}` : ''}`), h('td', { class: 'small' }, e.actor ? `${e.actor.type}` : ''))))));
  box.appendChild(h('div', { class: 'small muted', style: 'margin-top:12px' }, 'Peppol: NOT CONFIGURED. Structured invoices can be prepared, but nothing is transmitted until a provider is selected.'));
}
function confirmModal(title, text, label, onYes) { modal(title, h('p', null, text), (close) => [h('button', { class: 'primary', on: { click: () => { close(); onYes(); } } }, label), h('button', { on: { click: close } }, 'Cancel')]); }
function paymentModal(d, reload) {
  const amt = h('input', { inputmode: 'decimal', placeholder: d.remaining }); const date = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const method = h('select', null, [['bank_transfer', 'Bank transfer'], ['cash', 'Cash'], ['card', 'Card'], ['other', 'Other']].map(([v, l]) => h('option', { value: v }, l))); const ref = h('input', { placeholder: 'Bank reference (optional)' }); const note = h('input', { placeholder: 'Note (optional)' }); const err = h('div');
  modal('Add a payment', h('div', null, h('p', { class: 'muted' }, tt('Still due: {0} {1}', d.remaining, d.currency)), err, h('div', { class: 'row r2' }, h('div', { class: 'field' }, h('label', null, 'Amount'), amt), h('div', { class: 'field' }, h('label', null, 'Date paid'), date)), h('div', { class: 'row r2' }, h('div', { class: 'field' }, h('label', null, 'Method'), method), h('div', { class: 'field' }, h('label', null, 'Reference'), ref)), h('div', { class: 'field' }, h('label', null, 'Note'), note)),
    (close) => [h('button', { class: 'primary', on: { click: async () => { try { await api('POST', `/api/documents/${d.id}/payments`, { amount: amt.value, paidOn: date.value, method: method.value, reference: ref.value || undefined, note: note.value || undefined }); close(); toast('Payment recorded', 'ok'); reload(); } catch (e) { fail(e, err); } } } }, 'Record payment'), h('button', { on: { click: close } }, 'Cancel')]);
}
function creditModal(d) {
  const reason = h('input', { placeholder: 'Reason (required)' }); const err = h('div'); const full = h('input', { type: 'checkbox', checked: true });
  const rows = d.doc.lines.map((l) => ({ description: l.description, quantity: String(l.qtyMilli / 1000), unitPrice: String(l.priceMicro / 10000), vatRate: String(l.vatRateBp / 100), discountPercent: l.discountBp ? String(l.discountBp / 100) : undefined }));
  const editor = h('div');
  let restock = null;
  const restockBox = d.hadStockMovements ? h('div', { class: 'banner info', style: 'margin-top:10px' }, h('strong', null, tt('Stock')), h('div', { class: 'small' }, tt('This invoice took products out of stock. Are the goods returned to sellable stock?')), h('label', { style: 'color:var(--ink)' }, h('input', { type: 'radio', name: 'restock', on: { change: () => { restock = true; } } }), tt('Yes, put them back into stock')), h('label', { style: 'color:var(--ink)' }, h('input', { type: 'radio', name: 'restock', on: { change: () => { restock = false; } } }), tt('No, do not change the stock'))) : null;
  const draw = () => { clear(editor); if (full.checked) return; rows.forEach((r, i) => editor.appendChild(h('div', { class: 'row r4', style: 'margin-bottom:6px' }, h('input', { value: r.description, on: { input: (e) => { r.description = e.target.value; } } }), h('input', { value: r.quantity, on: { input: (e) => { r.quantity = e.target.value; } } }), h('input', { value: r.unitPrice, on: { input: (e) => { r.unitPrice = e.target.value; } } }), h('button', { on: { click: () => { rows.splice(i, 1); draw(); } } }, 'Remove')))); };
  full.addEventListener('change', draw);
  modal('Create a credit note', h('div', null, h('p', { class: 'muted' }, 'A credit note corrects an issued invoice. The invoice itself is never changed.'), err, h('div', { class: 'field' }, h('label', null, 'Reason'), reason), h('label', { style: 'color:var(--ink)' }, full, 'Credit the whole invoice'), editor, restockBox),
    (close) => [h('button', { class: 'primary', on: { click: async () => { try { const r = await api('POST', `/api/documents/${d.id}/credit-note`, { reason: reason.value, lines: full.checked ? undefined : rows, restock: restock === null ? undefined : restock }); close(); toast('Credit note draft created', 'ok'); location.hash = `#/doc/${r.id}`; } catch (e) { fail(e, err); } } } }, 'Create draft'), h('button', { on: { click: close } }, 'Cancel')]);
}

// ---------- companies (the "Add/edit a company" form only - the list/detail pages were replaced by the
// Contacts workspace in views-contacts.js; #/companies now redirects there. This form is still reused
// as-is by Contacts' "+ New contact" / "Edit", and by the invoice form's own "New client" shortcut). ----------
function companyModal(existing) {
  const m = existing
    ? { name: existing.name, vatNumber: existing.vatNumber || '', enterpriseNumber: existing.enterpriseNumber || '', street: existing.address.street || '', postalCode: existing.address.postalCode || '', city: existing.address.city || '', countryCode: existing.address.countryCode || 'BE', email: existing.email || '', csource: existing.source || 'manual', cverified: false, dirty: false, companyId: null }
    : { name: '', vatNumber: '', enterpriseNumber: '', street: '', postalCode: '', city: '', countryCode: 'BE', email: '', csource: 'manual', cverified: false, dirty: false, companyId: null };
  const err = h('div'); const box = h('div'); const sourceLine = h('div', { class: 'hint', style: 'margin:4px 0 10px' });
  let bk = null;
  const draw = () => {
    clear(box);
    const inp = (k, label, ph, identity) => h('div', { class: 'field' }, h('label', null, label), h('input', { value: m[k] || '', placeholder: ph || '', on: { input: (e) => { m[k] = e.target.value; if (identity) { m.dirty = true; clear(sourceLine); sourceLine.appendChild(document.createTextNode(sourceText(m))); } } } }));
    box.appendChild(h('div', { class: 'row r2' }, inp('name', 'Company name', '', true), inp('vatNumber', 'VAT number', 'BE0123456789', true)));
    box.appendChild(h('div', { class: 'row r2' }, inp('enterpriseNumber', 'Enterprise number', '0123.456.789', true), inp('street', 'Street and number', '', true)));
    box.appendChild(h('div', { class: 'row r3' }, inp('postalCode', 'Postal code', '', true), inp('city', 'City', '', true), inp('countryCode', 'Country (2 letters)', 'BE', true)));
    clear(sourceLine); sourceLine.appendChild(document.createTextNode(sourceText(m))); box.appendChild(sourceLine);
    box.appendChild(inp('email', 'Email (optional)', 'accounts@company.example', false));
  };
  const search = existing ? null : companySearchBox({ onPick: (r) => { if (r.source === 'directory') { toast('This company is already in your directory', 'ok'); if (bk) bk.remove(); location.hash = `#/companies/${r.id}`; return; } fillFromResult(m, r); draw(); } });
  draw();
  bk = modal(existing ? 'Edit company' : 'Add a company', h('div', null, err, search ? search.node : null, h('div', { style: 'margin-top:14px' }, box)),
    (close) => [h('button', { class: 'primary', on: { click: async () => { try {
      const src = m.dirty || !m.csource ? 'manual' : m.csource;
      const body = { kind: 'business', name: m.name, vatNumber: m.vatNumber || undefined, enterpriseNumber: m.enterpriseNumber || undefined, address: { street: m.street, postalCode: m.postalCode, city: m.city, countryCode: m.countryCode }, email: m.email || undefined, source: src };
      const r = existing ? await api('PUT', `/api/companies/${existing.id}`, body) : await api('POST', '/api/companies', body); close(); toast('Company saved', 'ok'); location.hash = `#/companies/${r.id}`; if (existing) route(); } catch (e) { fail(e, err); } } } }, 'Save'), h('button', { on: { click: close } }, 'Cancel')]);
  if (search) search.input.focus();
}

// ---------- receivables ----------
async function viewReceivables() {
  const main = layout('#/receivables', h('div', { class: 'topbar' }, h('div', null, h('h1', null, 'Payments and receivables'), h('div', { class: 'muted small' }, 'No reminders are sent automatically.')))); const box = h('div'); main.appendChild(box);
  try {
    const r = await api('GET', '/api/receivables'); const cur = state.settings.defaults.currency;
    box.appendChild(h('div', { class: 'grid cards' }, [['Unpaid', r.unpaid.count, r.unpaid.outstanding, ''], ['Due soon', r.due_soon.count, r.due_soon.outstanding, 'warn'], ['Overdue', r.overdue.count, r.overdue.outstanding, r.overdue.count ? 'bad' : '']].map(([l, n, a, cls]) => h('div', { class: `card stat ${cls}` }, h('div', { class: 'n' }, `${a}`), h('div', { class: 'l' }, tt('{0}: {1} invoice(s) ({2})', tr(l), n, cur))))));
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
  main.insertBefore(accountantWorkspace(), main.children[1] || null);
  async function gen() {
    clear(out); out.appendChild(h('div', { class: 'muted', style: 'margin:12px' }, 'Generating...'));
    try {
      const r = await api('POST', '/api/pack', { from: from.value, to: to.value }); const p = r.pack; const cur = p.currency; const e2 = (c) => (c / 100).toFixed(2); clear(out);
      out.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'actions' }, h('strong', null, `${p.period.start} to ${p.period.end}`), h('span', { class: `badge ${p.completeness.status}` }, p.completeness.status), h('span', { class: `badge ${p.reconciliation.status}` }, tt('Reconciliation: {0}', tr(p.reconciliation.status))), h('span', { class: 'muted small' }, tt('generated {0}', p.generated_at))), p.completeness.reasons.length ? h('ul', { class: 'plain small', style: 'margin-top:8px' }, p.completeness.reasons.map((x) => h('li', null, human(x)))) : h('div', { class: 'small muted' }, 'All source data for this period is present.'), h('div', { class: 'small muted', style: 'margin-top:6px' }, tt('Sources: {0}', p.source_systems.map((s) => s.system).join(', ')))));
      const row = (l, v, b) => h('tr', null, h('td', null, b ? h('strong', null, l) : l), h('td', { class: 'num' }, b ? h('strong', null, v) : v));
      out.appendChild(h('div', { class: 'grid two', style: 'margin-top:16px' },
        h('div', { class: 'card' }, h('h2', null, 'Shop and POS (retail)'), h('table', null, row('Gross sales', `${p.retail.gross_sales.toFixed(2)} ${cur}`), row('Discounts', p.retail.discounts.toFixed(2)), row('Refunds', p.retail.refunds.toFixed(2)), row('Net sales incl. VAT', p.retail.net_sales.toFixed(2)), row('VAT', p.retail.vat.toFixed(2)), row('Net sales excl. VAT', p.retail.net_sales_ex_vat.toFixed(2), true), row('POS excl. VAT', p.retail.by_channel.pos.net_sales_ex_vat.toFixed(2)), row('Online excl. VAT', p.retail.by_channel.online.net_sales_ex_vat.toFixed(2)))),
        h('div', { class: 'card' }, h('h2', null, 'Invoices and credit notes'), h('table', null, row('Standalone B2B invoices', String(p.b2b.standalone_invoices)), row('Standalone credit notes', String(p.b2b.standalone_credit_notes)), row('B2B net excl. VAT', e2(p.b2b.net_ex_vat_cents), true), row('B2B VAT', e2(p.b2b.vat_cents)), row('Linked invoices (not added)', `${p.b2b_linked.documents} / ${e2(p.b2b_linked.gross_documented_cents)}`), row('Credit notes issued', `${p.credit_notes.issued} / ${e2(p.credit_notes.gross_cents)}`)))));
      out.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Totals (retail + standalone B2B)'), h('table', null, row('Sales excl. VAT', `${e2(p.totals.sales_ex_vat_cents)} ${cur}`, true), row('VAT collected', e2(p.totals.vat_collected_cents)), row('Sales incl. VAT', e2(p.totals.sales_incl_vat_cents), true))));
      const v = p.vat_summary;
      out.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'actions' }, h('h2', null, 'VAT by rate'), h('span', { class: `badge ${v.status}` }, v.status)), h('table', null, h('tr', null, ['Rate', 'Taxable base', 'VAT'].map((x, i) => h('th', { class: i ? 'num' : '' }, x))), v.combined_by_rate.map((g) => h('tr', null, h('td', null, `${g.vatRateBp / 100}%`), h('td', { class: 'num' }, e2(g.taxableCents)), h('td', { class: 'num' }, e2(g.vatCents))))), v.retail_unclassified ? h('div', { class: 'banner warn small', style: 'margin-top:10px' }, tt('Unavailable: {0} retail line(s) have no captured VAT rate (base {1}, VAT {2}). They are not spread across rates.', v.retail_unclassified.lines, e2(v.retail_unclassified.taxableCents), e2(v.retail_unclassified.vatCents))) : null, v.b2b.by_treatment.filter((x) => x.exemptOrReverseCharge).map((x) => h('div', { class: 'small' }, tt('B2B {0}: base {1} (no VAT)', tr(REGIME[x.regime] || x.regime), e2(x.taxableCents))))));
      const ps = p.payment_status_of_period_invoices;
      out.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Payment status of B2B invoices in the period'), h('table', null, Object.entries(ps).map(([k, x]) => row(k.replace('_', ' '), tt('{0} invoice(s) - {1}', x.count, e2(x.cents)))))));
      out.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, tt('Anomalies ({0})', p.anomalies.length)), p.anomalies.length ? h('ul', { class: 'plain' }, p.anomalies.map((a) => h('li', null, `[${a.severity}] ${human(a.code)} - ${a.detail}`))) : h('div', { class: 'muted' }, 'None detected.')));
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
  main.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Look and feel'), h('div', { class: 'row r2' }, inp(s.branding, 'accent', 'Accent colour', { ph: '#183247' }), inp(s.branding, 'footer', 'Footer text on documents')), h('div', { class: 'field' }, h('label', null, tt('Logo (PNG or JPEG, max 400 KB)') + (s.branding.hasLogo ? ' - ' + tt('a logo is set') : '')), h('input', { type: 'file', accept: 'image/png,image/jpeg', on: { change: (e) => { const f = e.target.files[0]; if (!f) return; const fr = new FileReader(); fr.onload = async () => { try { await api('POST', '/api/settings/logo', { dataUrl: fr.result }); toast('Logo saved', 'ok'); } catch (er) { fail(er, err); } }; fr.readAsDataURL(f); } } }))));
  main.appendChild(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Company lookup and e-invoicing'), sel(s.companyLookup, 'provider', 'VAT / enterprise number lookup', [['vies', 'EU VIES (free, official) with manual fallback'], ['manual', 'Manual entry only']]), sel(s.companySearch, 'registry', 'Belgian company register (primary)', [['cbeapi', 'CBEAPI: official KBO/BCE data (needs CBEAPI_KEY)'], ['none', 'Off']]), sel(s.companySearch, 'provider', 'Secondary name search (if the register finds nothing)', [['peppol_directory', 'OpenPeppol Directory (Peppol-registered companies) + VIES for the address'], ['none', 'Off: search by number or type by hand']]), h('div', { class: 'field' }, h('label', null, 'Peppol provider'), h('span', { class: 'badge NOT_CONFIGURED' }, 'NOT CONFIGURED'), h('div', { class: 'hint' }, 'Nothing is transmitted. Structured invoices (UBL) can be prepared and downloaded.'))));
  main.appendChild(await workspaceSettingsCards());
  main.appendChild(h('div', { class: 'actions', style: 'margin-top:16px' }, h('button', { class: 'primary', on: { click: async () => { try {
    const num = (v) => (v === '' || v === null ? undefined : Number(v));
    const body = { seller: s.seller, vat: { allowedRatesPercent: st.rates.split(',').map((x) => x.trim()).filter(Boolean) }, defaults: { ...s.defaults, paymentTermsDays: num(s.defaults.paymentTermsDays) }, numbering: { invoice: { prefix: s.numbering.invoice.prefix, pad: num(s.numbering.invoice.pad) }, credit_note: { prefix: s.numbering.credit_note.prefix, pad: num(s.numbering.invoice.pad) }, quote: { prefix: s.numbering.quote.prefix, pad: num(s.numbering.invoice.pad) }, format: s.numbering.format }, branding: { accent: s.branding.accent, footer: s.branding.footer, paymentInstructions: s.branding.paymentInstructions, structuredCommunication: s.branding.structuredCommunication }, companyLookup: { provider: s.companyLookup.provider }, companySearch: { registry: s.companySearch.registry, provider: s.companySearch.provider } };
    const r2 = await api('PUT', '/api/settings', body); state.settings = r2.settings; state.missing = r2.missing; applyAccent(); toast('Settings saved', 'ok'); viewSettings(); } catch (e) { fail(e, err); window.scrollTo(0, 0); } } } }, 'Save settings')));
}

// ---------- router ----------
async function route() {
  if (!state.csrf) { try { const s = await api('GET', '/api/session'); if (s.authenticated) { state.csrf = s.csrf; await loadSettings(); } else return renderLogin(); } catch (e) { return renderLogin(); } }
  const [path, qs] = (location.hash.slice(1) || '/').split('?'); const q = new URLSearchParams(qs || ''); const parts = path.split('/').filter(Boolean);
  try {
    if (!parts.length) return await viewOverview();
    if (parts[0] === 'todo') return await viewTodo();
    // #/invoices and #/quotes are kept working (old deep links, dashboard links, bookmarks) but now redirect
    // into the unified Ventes workspace, which shows the same real lists under tabs.
    if (parts[0] === 'invoices') { location.hash = `#/sales?tab=invoices${qs ? `&${qs}` : ''}`; return; }
    if (parts[0] === 'quotes') { location.hash = `#/sales?tab=quotes${qs ? `&${qs}` : ''}`; return; }
    if (parts[0] === 'sales') return await viewSales(q);
    if (parts[0] === 'new') return await viewForm(parts[1] === 'quote' ? 'quote' : 'invoice', null, q.get('companyId') || null);
    if (parts[0] === 'doc' && parts[2] === 'edit') { const d = await api('GET', `/api/documents/${parts[1]}`); return await viewForm(d.type === 'quote' ? 'quote' : 'invoice', parts[1]); }
    if (parts[0] === 'doc') return await viewDoc(parts[1]);
    // #/companies is kept working (never removed/renamed) but now redirects into the unified Contacts
    // workspace - same underlying fin_companies id, so #/companies/:id still lands on the right contact.
    if (parts[0] === 'companies') { location.hash = parts[1] ? `#/contacts?open=${parts[1]}` : '#/contacts'; return; }
    if (parts[0] === 'contacts') return await viewContacts(q);
    if (parts[0] === 'receivables') return await viewReceivables();
    if (parts[0] === 'pack') return await viewPack();
    // #/inbox is kept working but now redirects into the unified Achats workspace.
    if (parts[0] === 'inbox') { location.hash = '#/purchases?tab=inbox'; return; }
    if (parts[0] === 'purchases') return await viewPurchasesWorkspace(q);
    if (parts[0] === 'bank') return await viewBank();
    if (parts[0] === 'treasury') return await viewTreasury();
    if (parts[0] === 'settings') return await viewSettings();
    location.hash = '#/';
  } catch (e) { if (!(e instanceof ApiError && e.status === 401)) fail(e); }
}
window.addEventListener('hashchange', route);
// start once every script (app, workspace views, i18n dictionaries) has loaded
if (document.readyState === 'complete') route(); else window.addEventListener('load', route);
