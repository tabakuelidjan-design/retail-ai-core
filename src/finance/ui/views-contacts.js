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
// 'archived' uses the backend's existing role=archived filter (already real and tested - just had no UI tab).
const CONTACT_TABS = [['all', 'All contacts'], ['customer', 'Customers'], ['supplier', 'Suppliers'], ['both', 'Both'], ['incomplete', 'To complete'], ['archived', 'Archived']];
const CONTACT_SORTS = [['name', 'Name'], ['receivable', 'Amount receivable'], ['payable', 'Amount payable'], ['activity', 'Last activity']];
async function viewContacts(q) {
  const cur = state.settings.defaults.currency;
  const openId = q ? q.get('open') : null;
  let role = 'all'; let all = []; let archivedRows = []; let sort = 'name';
  let searchTimer = null;

  const shell = h('div', { class: 'page-shell premium' });
  layout('#/contacts', shell);
  shell.appendChild(h('div', { class: 'hero-row subpage' }, h('div', { class: 'hero-block' }, h('h1', null, tt('Contacts')), h('div', { class: 'subtitle' }, tt('Customers, suppliers and financial relationships in one directory.'))),
    h('div', { class: 'quote-card', style: 'align-self:center' }, h('button', { class: 'btn primary big', type: 'button', on: { click: () => companyModal(null) } }, tt('+ New contact')))));
  const box = h('div', { style: 'display:grid;gap:14px' }); shell.appendChild(box);
  const metricRow = h('div', { class: 'metric-grid' }); box.appendChild(metricRow);
  const tabsrow = h('div', { class: 'tabsrow' }); box.appendChild(tabsrow);
  const wsMain = h('div', { class: 'card' }); box.appendChild(wsMain);
  const search = h('input', { placeholder: tr('Search name, VAT, email...'), on: {
    input: () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 220); },
    keydown: (e) => { if (e.key === 'Escape' && search.value) { search.value = ''; load(); } },
  } });

  function drawMetrics() {
    clear(metricRow);
    const metric = (icon, label, value) => h('div', { class: 'metric' }, h('span', { class: 'metric-icon' }, svgIcon(icon, 17)), h('div', null, h('div', { class: 'metric-title' }, label), h('div', { class: 'metric-value' }, String(value))));
    metricRow.appendChild(metric('building', tt('Contacts'), all.length));
    metricRow.appendChild(metric('doc', tt('Customers'), all.filter((r) => r.isCustomer).length));
    metricRow.appendChild(metric('cart', tt('Suppliers'), all.filter((r) => r.isSupplier).length));
  }
  function drawTabs() {
    clear(tabsrow);
    const counts = { all: all.length, customer: all.filter((r) => r.isCustomer).length, supplier: all.filter((r) => r.isSupplier).length, both: all.filter((r) => r.isCustomer && r.isSupplier).length, incomplete: all.filter((r) => r.incomplete).length, archived: archivedRows.length };
    CONTACT_TABS.forEach(([v, l]) => tabsrow.appendChild(h('button', { type: 'button', class: `tab2 ${role === v ? 'on' : ''}`, on: { click: () => { role = v; drawTabs(); drawRows(); } } }, tt(l), h('span', { class: 'pc' }, String(counts[v])))));
  }
  function baseRows() {
    if (role === 'archived') return archivedRows;
    const rows = role === 'all' ? all : role === 'customer' ? all.filter((r) => r.isCustomer) : role === 'supplier' ? all.filter((r) => r.isSupplier) : role === 'both' ? all.filter((r) => r.isCustomer && r.isSupplier) : all.filter((r) => r.incomplete);
    // Real client-side sort over the already-loaded real rows - never re-fetched or re-derived.
    const key = { name: (r) => r.displayName, receivable: (r) => -(r.amountReceivableCents ?? 0), payable: (r) => -(r.amountPayableCents ?? 0), activity: (r) => (r.lastActivityAt ? -new Date(r.lastActivityAt).getTime() : 0) }[sort] || ((r) => r.displayName);
    return [...rows].sort((a, b) => (typeof key(a) === 'string' ? String(key(a)).localeCompare(String(key(b))) : key(a) - key(b)));
  }
  function drawRows() {
    clear(wsMain);
    const rows = baseRows();
    const sortSel = h('select', { class: 'tool', on: { change: (e) => { sort = e.target.value; drawRows(); } } }, CONTACT_SORTS.map(([v, l]) => h('option', { value: v, selected: v === sort }, tt(l))));
    wsMain.appendChild(h('div', { class: 'workspace-toolbar' }, h('label', { class: 'search-field' }, NordlaIcon.semantic('recherche', 'sm'), search),
      h('div', { class: 'tools' }, sortSel, h('button', { class: 'tool', type: 'button', on: { click: () => exportRowsAsCsv(rows, [{ header: 'Name', key: 'displayName' }, { header: 'VAT', key: 'vatNumber' }, { header: 'Relation', value: (r) => relationText(r) }, { header: 'Email', key: 'email' }, { header: 'Amount receivable', value: (r) => (r.isCustomer ? withCur(r.amountReceivable, cur) : '') }, { header: 'Amount payable', value: (r) => (r.isSupplier ? withCur(r.amountPayable, cur) : '') }], 'contacts.csv') } }, tt('Export')))));
    const tableWrap = h('div', { class: 'table-wrap' }); wsMain.appendChild(tableWrap);
    // "No contacts at all" only applies with no active search - a search that matches nothing is always the
    // "no results for this search" state below, never mistaken for an empty directory.
    if (role !== 'archived' && !all.length && !search.value.trim()) { tableWrap.appendChild(h('div', { class: 'empty big' }, h('span', { class: 'eicon' }, svgIcon('building', 26)),
      h('div', null, h('strong', null, tt('Your contacts will appear here.')),
        h('div', { class: 'muted small', style: 'max-width:420px;margin-top:4px' }, tt('Add a client or a company now; suppliers will also be gathered in this directory once they are linked to your purchase documents.')),
        h('button', { class: 'primary', style: 'margin-top:12px', on: { click: () => companyModal(null) } }, tt('Add a contact'))))); return; }
    if (!rows.length) {
      if (role === 'archived') { tableWrap.appendChild(h('div', { class: 'empty big' }, h('span', { class: 'eicon ok' }, svgIcon('check', 26)), h('div', null, h('strong', null, tt('No archived contacts.'))))); return; }
      tableWrap.appendChild(h('div', { class: 'empty big' }, h('span', { class: 'eicon' }, NordlaIcon.semantic('recherche', 'lg')),
        h('div', null, h('strong', null, tt('No contact matches this search.')),
          search.value ? h('button', { class: 'btn ghost', style: 'margin-top:10px', on: { click: () => { search.value = ''; load(); } } }, tt('Clear the search')) : null))); return;
    }
    tableWrap.appendChild(h('table', null, h('tr', null, [tt('Contact'), tt('Relation'), tt('Contact details'), tt('Amount receivable'), tt('Amount payable'), tt('Last activity')].map((x, i) => h('th', { class: i >= 3 && i <= 4 ? 'num' : '' }, x))),
      rows.map((r) => h('tr', { class: 'click', on: { click: () => { openContactDrawer(r.id, load); } } },
        h('td', { 'data-label': tr('Contact') }, h('strong', null, r.displayName), h('small', null, r.vatNumber ? `${r.vatNumber} · ${tt(CONTACT_TYPE_TEXT[r.kind] || r.kind)}` : tt(CONTACT_TYPE_TEXT[r.kind] || r.kind))),
        h('td', { 'data-label': tr('Relation') }, relationText(r)),
        h('td', { 'data-label': tr('Contact details') }, r.email || '—'),
        h('td', { class: 'num', 'data-label': tr('Amount receivable') }, r.isCustomer ? withCur(r.amountReceivable, cur) : '—'),
        h('td', { class: 'num', 'data-label': tr('Amount payable') }, r.isSupplier ? withCur(r.amountPayable, cur) : '—'),
        h('td', { 'data-label': tr('Last activity') }, fmtDateShort(r.lastActivityAt))))));
  }
  async function load() {
    clear(wsMain); wsMain.appendChild(h('div', { style: 'padding:12px' }, [1, 2, 3, 4, 5].map(() => h('div', { class: 'skl', style: 'height:14px;width:60%;margin-bottom:10px' }))));
    try {
      const query = encodeURIComponent(search.value.trim());
      const [main, archived] = await Promise.all([api('GET', `/api/contacts?q=${query}`), api('GET', `/api/contacts?role=archived&q=${query}`)]);
      all = main.rows; archivedRows = archived.rows;
      drawMetrics(); drawTabs(); drawRows();
    } catch (e) {
      clear(wsMain); wsMain.appendChild(h('div', { class: 'empty big' }, h('span', { class: 'eicon bad' }, svgIcon('alert', 26)),
        h('div', null, h('strong', null, tt('Contacts could not be loaded.')), h('div', { style: 'margin-top:10px' }, h('button', { class: 'primary', on: { click: load } }, tt('Retry'))))));
    }
  }
  drawTabs();
  await load();
  if (openId) openContactDrawer(openId, load);
}

// ---------- Contact detail drawer ----------
function finItem(label, value, tone) { return h('div', { class: `fi ${tone || ''}` }, h('span', { class: 'fl' }, label), h('span', { class: 'fv' }, value)); }
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
  const goToNew = (kind) => { back.remove(); if (onClose) onClose(); location.hash = `#/new/${kind}?companyId=${id}`; };
  async function draw() {
    clear(body); clear(err);
    let c; try { c = await api('GET', `/api/contacts/${id}`); } catch (e) { return fail(e, body); }
    const cur = state.settings.defaults.currency;
    body.appendChild(h('div', { class: 'detail-head' },
      h('div', null, h('h2', null, c.displayName), h('p', null, [tt(CONTACT_TYPE_TEXT[c.kind] || c.kind), c.vatNumber].filter(Boolean).join(' · ')), h('p', null, relationText(c))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: () => goToNew('invoice') } }, tt('+ Create')), h('button', { class: 'btn', type: 'button', on: { click: async () => { try { const r = await api('GET', `/api/companies/${id}`); companyModal(r.company); } catch (e) { fail(e, err); } } } }, tt('Edit')),
        // Real archive/restore (index(4).html alignment) - the backend has supported this since Phase 1 but
        // had no UI control anywhere. Never a delete: the contact and its documents are untouched either way.
        c.archived
          ? h('button', { class: 'btn', type: 'button', on: { click: async () => { try { await api('POST', `/api/companies/${id}/restore`, {}); toast(tt('Contact restored'), 'ok'); draw(); if (onClose) onClose(); } catch (e) { fail(e, err); } } } }, tt('Restore'))
          : h('button', { class: 'btn', type: 'button', on: { click: async () => { try { await api('POST', `/api/companies/${id}/archive`, {}); toast(tt('Contact archived'), 'ok'); draw(); if (onClose) onClose(); } catch (e) { fail(e, err); } } } }, tt('Archive')))));
    const fin = h('div', { class: 'contact-fin' });
    if (c.isCustomer) fin.appendChild(finItem(tt('Amount receivable'), withCur(c.amountReceivable, cur)));
    // More actionable overdue callout (index(4).html alignment): a real link into Ventes, pre-filtered to this
    // customer's real invoices - not a "Relancer" button, since no reminder-sending capability exists.
    if (c.isCustomer && c.overdueCount > 0) fin.appendChild(h('a', { href: `#/sales?tab=invoices&q=${encodeURIComponent(c.displayName)}`, class: 'fi bad', style: 'text-decoration:none' }, h('span', { class: 'fl' }, tt('Overdue')), h('span', { class: 'fv' }, withCur(c.amountOverdue, cur))));
    if (c.isSupplier) fin.appendChild(finItem(tt('Amount payable'), withCur(c.amountPayable, cur)));
    if (!c.isCustomer && !c.isSupplier) fin.appendChild(h('div', { class: 'muted small' }, tt('This contact has no invoiced activity yet.')));
    body.appendChild(fin);
    if (c.isCustomer) {
      body.appendChild(h('h3', { class: 'section-title', style: 'margin:18px 0 6px;font-size:15px' }, tt('Sales documents')));
      body.appendChild(c.salesDocuments.length ? h('div', { class: 'doclist' }, c.salesDocuments.map((d) => docRow(d, cur, () => goToDoc(d.id)))) : h('div', { class: 'muted small' }, tt('No sales documents yet.')));
    }
    if (c.isSupplier) {
      body.appendChild(h('h3', { class: 'section-title', style: 'margin:18px 0 6px;font-size:15px' }, tt('Supplier documents')));
      body.appendChild(c.supplierDocuments.length ? h('div', { class: 'doclist' }, c.supplierDocuments.map((d) => supplierDocRow(d, cur, () => openInboxItem(d.id, draw)))) : h('div', { class: 'muted small' }, tt('No supplier documents yet.')));
    }
    // No Transactions section/tab: /api/contacts/:id always returns transactions: [] until a real bank<->
    // contact relation exists (Phase 1 scope) - inventing an empty section for it would misrepresent that
    // as a feature (mandate section 15).
  }
  draw();
}
