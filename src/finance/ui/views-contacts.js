'use strict';
// Phase 2: unified Contacts workspace - the single premium replacement for the old, fragmented
// "Companies" page. Loaded after views-workspace.js (shares h, api, layout, modal, toast, tt, tr, fail,
// clear, mount, badge, avatar, svgIcon, I18N, fmtMoney, CUR_SYMBOL, inboxBadge, openInboxItem, companyModal,
// companySearchBox - all defined in app.js / views-workspace.js, loaded as plain global scripts, not modules).
//
// Backend (Phase 1, commit 5ce2342, untouched here): GET /api/contacts?role=all|customer|supplier&q=,
// GET /api/contacts/:id. Both already batch-load and aggregate server-side - this file never re-derives
// money, roles or document lists client-side; it only renders what the server returns.
//
// All source strings below are English message ids, same convention as app.js/views-workspace.js: the
// French/Dutch text a merchant actually sees lives in lang-fr.js/lang-nl.js, keyed by these exact strings.

const CONTACT_TYPE_TEXT = { business: 'Business', individual: 'Individual' };
const RELATION_TEXT = { both: 'Customer · Supplier', customer: 'Customer', supplier: 'Supplier', none: '—' };
const relationKey = (row) => (row.isCustomer && row.isSupplier ? 'both' : row.isCustomer ? 'customer' : row.isSupplier ? 'supplier' : 'none');
const relationText = (row) => tt(RELATION_TEXT[relationKey(row)]);

/** Appends the merchant's currency symbol to an already-formatted amount string (from the server's own
 * money() helper), using the same fr/nl/en placement rule as fmtMoney() - never recomputed from cents here. */
function withCur(s, cur) {
  if (s === undefined || s === null) return '—';
  const lang = I18N.getLang(); const sym = CUR_SYMBOL[cur] || cur || '';
  return lang === 'fr' ? `${s} ${sym}`.trim() : lang === 'nl' ? `${sym} ${s}`.trim() : `${sym}${s}`;
}
/** Short local date for the list/drawer ("22 sept."); '—' is never invented for a missing date. */
function fmtDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(I18N.tag(), { day: 'numeric', month: 'short' });
}

// ---------- Contacts list ----------
async function viewContacts(q) {
  const cur = state.settings.defaults.currency;
  const openId = q ? q.get('open') : null;
  let role = 'all'; let all = [];
  let searchTimer = null;

  const main = layout('#/contacts', h('div', { class: 'topbar' },
    h('div', null, h('h1', null, 'Contacts'), h('div', { class: 'muted small' }, tt('A financial directory of your customers and suppliers.'))),
    h('button', { class: 'primary', on: { click: () => companyModal(null) } }, tt('+ New contact'))));
  const tabs = h('div', { class: 'pills' });
  const search = h('input', { placeholder: tr('Search by name, VAT number...'), on: {
    input: () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 220); },
    keydown: (e) => { if (e.key === 'Escape' && search.value) { search.value = ''; load(); } },
  } });
  const box = h('div', { class: 'card listcard', style: 'margin-top:12px' });
  main.appendChild(tabs);
  main.appendChild(h('div', { class: 'field', style: 'max-width:340px' }, search));
  main.appendChild(box);

  const ROLE_TABS = [['all', 'All contacts'], ['customer', 'Customers'], ['supplier', 'Suppliers']];
  function drawTabs() {
    clear(tabs);
    const counts = { all: all.length, customer: all.filter((r) => r.isCustomer).length, supplier: all.filter((r) => r.isSupplier).length };
    ROLE_TABS.forEach(([v, l]) => tabs.appendChild(h('button', { type: 'button', class: `pill ${role === v ? 'active' : ''}`, on: { click: () => { role = v; drawTabs(); drawRows(); } } }, tt(l), h('span', { class: 'pc' }, String(counts[v])))));
  }
  function drawRows() {
    clear(box);
    const rows = role === 'all' ? all : all.filter((r) => (role === 'customer' ? r.isCustomer : r.isSupplier));
    // "No contacts at all" only applies with no active search - a search that matches nothing is always the
    // "no results for this search" state below, never mistaken for an empty directory.
    if (!all.length && !search.value.trim()) return box.appendChild(h('div', { class: 'empty big' }, h('span', { class: 'eicon' }, svgIcon('building', 26)),
      h('div', null, h('strong', null, tt('Your contacts will appear here.')),
        h('div', { class: 'muted small', style: 'max-width:420px;margin-top:4px' }, tt('Add a client or a company now; suppliers will also be gathered in this directory once they are linked to your purchase documents.')),
        h('button', { class: 'primary', style: 'margin-top:12px', on: { click: () => companyModal(null) } }, tt('Add a contact')))));
    if (!rows.length) return box.appendChild(h('div', { class: 'empty big' }, h('span', { class: 'eicon' }, svgIcon('search', 26)),
      h('div', null, h('strong', null, tt(role === 'supplier' ? 'No supplier matches this search.' : role === 'customer' ? 'No customer matches this search.' : 'No contact matches this search.')),
        search.value ? h('button', { class: 'btn ghost', style: 'margin-top:10px', on: { click: () => { search.value = ''; load(); } } }, tt('Clear the search')) : null)));
    box.appendChild(h('div', { class: 'chead' }, [tt('Contact'), tt('Type'), tt('Relation'), tt('Amount receivable'), tt('Amount payable'), tt('Last activity')].map((x, i) => h('div', { class: i >= 3 && i <= 4 ? 'num' : '' }, x))));
    rows.forEach((r) => {
      const open = () => openContactDrawer(r.id, load);
      box.appendChild(h('div', { class: 'crow', tabindex: '0', on: { click: open, keydown: (e) => { if (e.key === 'Enter') open(); } } },
        h('div', { class: 'cname' }, h('strong', null, r.displayName), r.vatNumber ? h('span', null, r.vatNumber) : null),
        h('div', { class: 'ctype' }, tt(CONTACT_TYPE_TEXT[r.kind] || r.kind)),
        h('div', { 'data-label': tr('Relation') }, relationText(r)),
        h('div', { class: 'num', 'data-label': tr('Amount receivable') }, r.isCustomer ? withCur(r.amountReceivable, cur) : '—'),
        h('div', { class: 'num', 'data-label': tr('Amount payable') }, r.isSupplier ? withCur(r.amountPayable, cur) : '—'),
        h('div', { 'data-label': tr('Last activity') }, fmtDateShort(r.lastActivityAt))));
    });
  }
  async function load() {
    clear(box); box.appendChild(h('div', { style: 'padding:4px' }, [1, 2, 3, 4, 5].map(() => h('div', { class: 'crow' }, h('div', { class: 'skl', style: 'height:14px;width:60%' })))));
    try {
      all = (await api('GET', `/api/contacts?q=${encodeURIComponent(search.value.trim())}`)).rows;
      drawTabs(); drawRows();
    } catch (e) {
      clear(box); box.appendChild(h('div', { class: 'empty big' }, h('span', { class: 'eicon bad' }, svgIcon('alert', 26)),
        h('div', null, h('strong', null, tt('Contacts could not be loaded.')), h('div', { style: 'margin-top:10px' }, h('button', { class: 'primary', on: { click: load } }, tt('Retry'))))));
    }
  }
  drawTabs();
  await load();
  if (openId) openContactDrawer(openId, load);
}

// ---------- Contact detail drawer ----------
function finItem(label, value) { return h('div', { class: 'fi' }, h('span', { class: 'fl' }, label), h('span', { class: 'fv' }, value)); }
function docRow(d, cur, onClick) {
  return h('a', { href: '#', class: 'crow-doc', on: { click: (e) => { e.preventDefault(); onClick(); } } },
    h('span', null, d.number || tt('(draft)')), h('span', { class: 'muted small' }, fmtDateShort(d.issueDate)), h('span', { class: 'cd-amt' }, withCur(d.gross, cur)), badge(d.status));
}
function supplierDocRow(d, cur, onClick) {
  return h('a', { href: '#', class: 'crow-doc', on: { click: (e) => { e.preventDefault(); onClick(); } } },
    h('span', null, d.invoiceNumber || tt('(no number)')), h('span', { class: 'muted small' }, fmtDateShort(d.issueDate)), h('span', { class: 'cd-amt' }, withCur(d.gross, cur)), inboxBadge(d.status));
}
function openContactDrawer(id, onClose) {
  const body = h('div', { class: 'drawer-body' }); const err = h('div');
  const back = modal('Contact', h('div', null, err, body), (close) => [h('button', { on: { click: () => { close(); if (onClose) onClose(); } } }, tt('Close'))]);
  back.classList.add('drawer');
  // Closes this drawer before handing off to the existing document detail (page nav for sales docs, the
  // existing inbox drawer for supplier docs) - never rebuilds Ventes/Achats here (mandate section 14).
  const goToDoc = (docId) => { back.remove(); if (onClose) onClose(); location.hash = `#/doc/${docId}`; };
  async function draw() {
    clear(body); clear(err);
    let c; try { c = await api('GET', `/api/contacts/${id}`); } catch (e) { return fail(e, body); }
    const cur = state.settings.defaults.currency;
    body.appendChild(h('div', { class: 'contact-head' }, h('h2', null, c.displayName),
      h('div', { class: 'muted small', style: 'margin-top:4px' }, [tt(CONTACT_TYPE_TEXT[c.kind] || c.kind), c.vatNumber, relationText(c)].filter(Boolean).join(' · '))));
    body.appendChild(h('div', { class: 'actions', style: 'margin-top:8px' }, h('button', { on: { click: async () => { try { const r = await api('GET', `/api/companies/${id}`); companyModal(r.company); } catch (e) { fail(e, err); } } } }, tt('Edit'))));
    const fin = h('div', { class: 'contact-fin' });
    if (c.isCustomer) fin.appendChild(finItem(tt('Amount receivable'), withCur(c.amountReceivable, cur)));
    if (c.isSupplier) fin.appendChild(finItem(tt('Amount payable'), withCur(c.amountPayable, cur)));
    if (!c.isCustomer && !c.isSupplier) fin.appendChild(h('div', { class: 'muted small' }, tt('This contact has no invoiced activity yet.')));
    body.appendChild(fin);
    if (c.isCustomer) {
      body.appendChild(h('h3', { style: 'margin:18px 0 6px' }, tt('Sales documents')));
      body.appendChild(c.salesDocuments.length ? h('div', { class: 'doclist' }, c.salesDocuments.map((d) => docRow(d, cur, () => goToDoc(d.id)))) : h('div', { class: 'muted small' }, tt('No sales documents yet.')));
    }
    if (c.isSupplier) {
      body.appendChild(h('h3', { style: 'margin:18px 0 6px' }, tt('Supplier documents')));
      body.appendChild(c.supplierDocuments.length ? h('div', { class: 'doclist' }, c.supplierDocuments.map((d) => supplierDocRow(d, cur, () => openInboxItem(d.id, draw)))) : h('div', { class: 'muted small' }, tt('No supplier documents yet.')));
    }
    // No Transactions section/tab: /api/contacts/:id always returns transactions: [] until a real bank<->
    // contact relation exists (Phase 1 scope) - inventing an empty section for it would misrepresent that
    // as a feature (mandate section 15).
  }
  draw();
}
