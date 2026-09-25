'use strict';
// Main "Clients" page (Analytics Premium) - the operational customer workspace. Renders ONLY what /api/customers and
// /api/customers/detail return (src/report/customers-workspace.js + Explorer > Clients figures): no metric is computed
// here, only display formatting, filtering, searching and sorting of rows the report already holds.
// Explorer > Clients stays the analytical deep dive; this page links to it and never repeats its charts.
// Customers are pseudonymous: only the safe label ("Client #A4B7") is ever shown, searched or exported.

let cachedCustomers = null;
async function loadCustomersIfNeeded() {
  if (cachedCustomers) return;
  try {
    const res = await fetch('/api/customers');
    if (res.ok) cachedCustomers = await res.json();
  } catch (e) { /* surfaces as the empty state */ }
}

// Page-local UI state (kept across re-renders, e.g. a language change).
const clState = { query: '', filter: 'all', recency: 'all', sort: 'recent', selected: null };
const clDetails = new Map(); // id -> detail payload, fetched once on selection

const CL_FILTERS = ['all', 'active', 'new', 'returning', 'unknown', 'inactive'];
const CL_RECENCY = ['all', 'd0_30', 'd31_60', 'd61_90', 'd90_plus'];
const CL_SORTS = ['recent', 'revenue', 'orders', 'known'];

const clMoney = (v, cur) => (v == null ? t('common.dash') : exMoney2(v, cur));
const clDate = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString(chartTag(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : t('common.dash'));
const clRecency = (days) => (days == null ? t('common.dash') : days === 0 ? t('cl.today') : t('cl.daysAgo', days));
const clShare = (v) => (v == null ? t('common.dash') : exShare(v));

function clStatusChip(r) {
  if (!r.active) return h('span', { class: 'cl-chip mute' }, t('cl.status.inactive'));
  const k = r.period_status === 'new' ? 'new' : r.period_status === 'returning' ? 'returning' : 'unknown';
  return h('span', { class: `cl-chip${k === 'new' ? '' : ' mute'}` }, t(`cl.status.${k}`));
}

/** Evolution vs the previous 30 days: coloured only for a real measured comparison (previous revenue > 0). */
function clEvolution(r) {
  const e = r.evolution;
  if (e.delta_pct != null) {
    const up = e.delta_pct >= 0;
    return h('span', { class: `cl-evo ${up ? 'up' : 'down'}` }, exPct(e.delta_pct));
  }
  return h('span', { class: 'cl-evo none', title: t(`cl.evo.${e.status}`) }, e.status === 'no_previous_purchase' ? t('cl.evo.newShort') : t('common.dash'));
}

/** Status filter only (period statuses apply to customers active in the current 30 days, as in the KPIs). */
function clInFilter(r, f) {
  if (f === 'active') return r.active;
  if (f === 'inactive') return !r.active;
  if (f === 'new' || f === 'returning' || f === 'unknown') return r.active && r.period_status === f;
  return true;
}
/** Search only covers what the report holds: the safe pseudonymous label (with or without "#", or "Client #..."). */
function clInSearch(r) {
  const q = clState.query.trim().toUpperCase();
  if (!q) return true;
  return r.id.includes(q.replace(/^#/, '')) || t('ex.customerLabel', r.label).toUpperCase().includes(q);
}
const clMatches = (r) => clInSearch(r) && clInFilter(r, clState.filter) && (clState.recency === 'all' || r.recency_bucket === clState.recency);

function clSorted(rows) {
  const s = clState.sort; const out = [...rows];
  const tie = (a, b) => a.id.localeCompare(b.id);
  if (s === 'revenue') out.sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax || b.order_count - a.order_count || tie(a, b));
  else if (s === 'orders') out.sort((a, b) => b.order_count - a.order_count || b.net_sales_ex_tax - a.net_sales_ex_tax || tie(a, b));
  else if (s === 'known') out.sort((a, b) => b.known_orders - a.known_orders || b.known_net_sales_ex_tax - a.known_net_sales_ex_tax || tie(a, b));
  else out.sort((a, b) => a.recency_days - b.recency_days || b.net_sales_ex_tax - a.net_sales_ex_tax || tie(a, b));
  return out;
}

// ---------- header, coverage, KPIs ----------
function clHeader(d) {
  return h('div', { class: 'ex-head cl-head' },
    h('div', null, h('h1', { class: 'ex-title' }, t('cl.title')), h('p', { class: 'ex-sub' }, t('cl.subtitle'))),
    h('div', { class: 'cl-head-actions' },
      h('a', { class: 'cl-link', href: '#/explorer/customers' }, NordlaIcon.semantic('explorer', 'sm'), t('cl.toExplorer')),
      h('button', { class: 'ex-export', type: 'button', disabled: d && d.available && d.list.length ? null : 'disabled', on: { click: () => { if (d && d.available) clExport(d); } } }, svg(['M12 4v10', 'M8 10l4 4 4-4', 'M5 19h14'], 15), t('ex.export'))));
}

function clCoverage(d) {
  const cv = d.coverage; const hs = d.history;
  return h('div', { class: 'cl-coverage' },
    h('span', { class: 'cl-coverage-ico' }, NordlaIcon.semantic('dataHealth', 'sm')),
    h('div', { class: 'cl-coverage-body' },
      h('div', { class: 'cl-coverage-title' }, t('cl.coverageTitle')),
      h('div', { class: 'cl-coverage-text' },
        h('strong', null, t('cl.coverageLine', clShare(cv.identified_share))),
        ' ', t('cl.coverageCounts', cv.identified_orders, cv.orders),
        cv.previous_identified_share != null ? ` · ${t('cl.coveragePrev', clShare(cv.previous_identified_share))}` : ''),
      h('div', { class: 'cl-coverage-scope' }, t('cl.scopePeriod'), ' · ', t('cl.scopeHistory', clDate(hs.first_order_date), hs.days, clShare(hs.identified_share)))));
}

function clKpiRow(d) {
  const k = d.kpis; const dl = k.delta || {}; const cv = d.coverage;
  const covNote = cv.previous_identified_share != null ? t('ex.covNotePrev', clShare(cv.identified_share), clShare(cv.previous_identified_share)) : t('ex.covNote', clShare(cv.identified_share));
  const row = h('div', { class: 'ex-kpi-row cl-kpis' },
    exKpi('clients', t('ex.kpi.activeCustomers'), String(k.active), dl.active_pct, covNote),
    exKpi('nouveauClient', t('ex.kpi.newCustomers'), String(k.new), dl.new_pct, t('ex.newDef')),
    exKpi('segmentClient', t('ex.kpi.returningCustomers'), String(k.returning), dl.returning_pct, t('ex.returningDef')),
    exKpi('chiffreAffaires', t('ex.kpi.identifiedRevenue'), exMoney(k.identified_net_sales_ex_tax, d.currency), dl.identified_net_sales_ex_tax_pct, covNote));
  // When identification coverage differs between the two periods, a customer-count change is partly a coverage change.
  const shifted = cv.previous_identified_share != null && cv.previous_identified_share !== cv.identified_share;
  return h('div', null, row, shifted ? h('p', { class: 'cl-caveat' }, t('cl.coverageShift', clShare(cv.previous_identified_share), clShare(cv.identified_share))) : null);
}

// ---------- compact blocks: top customers, distribution, watch ----------
function clTopCard(d) {
  const rows = d.top || [];
  const body = rows.length
    ? h('div', { class: 'cl-top' }, rows.map((r, i) => h('button', { type: 'button', class: 'cl-top-row', on: { click: () => clOpen(r.id) } },
      h('span', { class: 'ex-rk' }, String(i + 1)),
      h('span', { class: 'cl-top-main' }, h('span', { class: 'cl-name' }, t('ex.customerLabel', r.label)), h('span', { class: 'cl-sub' }, t('ex.lastOrder', clDate(r.last_order_date)))),
      h('span', { class: 'cl-top-val' }, h('strong', null, clMoney(r.net_sales_ex_tax, d.currency)), h('span', null, r.order_count === 1 ? t('ex.dayOrders1') : t('ex.dayOrdersN', r.order_count))))))
    : NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noCustomers'));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('cl.topTitle')), h('span', { class: 'cl-scope-tag' }, t('cl.tag30'))), body);
}

function clDistributionCard(d) {
  const sg = d.segments;
  const rows = [['new', sg.new], ['returning', sg.returning], ['unknown', sg.unknown]].filter(([, g]) => g.customers > 0);
  let body;
  if (!rows.length) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noCustomers'));
  else {
    const total = rows.reduce((a, [, g]) => a + g.customers, 0);
    body = NordlaCharts.donut(rows.map(([k, g]) => ({ name: t(`ex.seg.${k}`), pct: Math.round((g.customers / total) * 1000) / 10, value: t('ex.nCustomers', g.customers) })), { totalValue: String(total), totalLabel: t('ex.identifiedShort'), size: 140 });
  }
  return h('div', { class: 'ex-card ex-cats cl-dist' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('cl.distTitle')), h('span', { class: 'cl-scope-tag' }, t('cl.tag30'))),
    body, h('div', { class: 'ex-foot' }, t('cl.distNote', clShare(d.coverage.identified_share))));
}

function clWatch(d) {
  const w = d.watch; const cards = [];
  const who = (list) => h('div', { class: 'cl-watch-list' }, list.slice(0, 6).map((x) => h('button', { type: 'button', class: 'cl-watch-chip', on: { click: () => clOpen(x.id) } }, x.label)), list.length > 6 ? h('span', { class: 'cl-sub' }, t('cl.andMore', list.length - 6)) : null);
  // 1. bought in the previous 30 days, nothing in the current 30 days (a fact about two windows, not a churn label)
  cards.push(h('div', { class: 'ex-card cl-watch-card' },
    h('div', { class: 'cl-watch-top' }, h('span', { class: 'cl-watch-ico' }, NordlaIcon.semantic('calendrier', 'md')), h('span', { class: 'cl-watch-title' }, t('cl.watch.lapsedTitle'))),
    w.lapsed.length
      ? h('div', null, h('div', { class: 'cl-watch-text' }, t('cl.watch.lapsedText', w.lapsed.length)), who(w.lapsed))
      : h('div', { class: 'cl-watch-text' }, t('cl.watch.lapsedNone'))));
  // 2. customers with purchases in both periods: their real per-customer change
  cards.push(h('div', { class: 'ex-card cl-watch-card' },
    h('div', { class: 'cl-watch-top' }, h('span', { class: 'cl-watch-ico' }, NordlaIcon.semantic('ceQuiAChange', 'md')), h('span', { class: 'cl-watch-title' }, t('cl.watch.bothTitle'))),
    w.both_periods.length
      ? h('div', null, h('div', { class: 'cl-watch-text' }, t('cl.watch.bothText', w.both_periods.length)), who(w.both_periods))
      : h('div', { class: 'cl-watch-text' }, t('cl.watch.bothNone'))));
  // 3. recency vs the customer's own rhythm: only with enough observed gaps (approved gate), and no approved "unusual" rule yet
  const r = w.own_rhythm;
  cards.push(h('div', { class: 'ex-card cl-watch-card' },
    h('div', { class: 'cl-watch-top' }, h('span', { class: 'cl-watch-ico' }, NordlaIcon.semantic('dataHealth', 'md')), h('span', { class: 'cl-watch-title' }, t('cl.watch.rhythmTitle')), h('span', { class: 'cl-chip mute' }, t('ex.insufficient'))),
    h('div', { class: 'cl-watch-text' }, r.status === 'insufficient' ? t('cl.watch.rhythmInsufficient', r.intervals, r.required_intervals) : t('cl.watch.rhythmNoRule', r.intervals))));
  return h('div', null, h('h3', { class: 'section-heading' }, t('cl.watchHeading')), h('div', { class: 'cl-watch-grid' }, cards));
}

// ---------- customer list ----------
function clToolbar(d, onChange) {
  const counts = Object.fromEntries(CL_FILTERS.map((f) => [f, d.list.filter((r) => clInFilter(r, f)).length]));
  const input = h('input', { type: 'search', class: 'cl-search-input', placeholder: t('cl.searchPlaceholder'), 'aria-label': t('cl.searchLabel'), value: clState.query, autocomplete: 'off', spellcheck: 'false' });
  input.addEventListener('input', () => { clState.query = input.value; onChange(); });
  const select = (key, options, label) => h('select', { class: 'ex-select cl-select', 'aria-label': label, on: { change: (e) => { clState[key] = e.target.value; onChange(); } } },
    options.map((o) => h('option', { value: o, selected: clState[key] === o ? '' : null }, t(`cl.${key}.${o}`))));
  return h('div', { class: 'cl-toolbar' },
    h('label', { class: 'cl-search' }, NordlaIcon.semantic('recherche', 'sm'), input),
    h('div', { class: 'cl-filters', role: 'group', 'aria-label': t('cl.filtersLabel') }, CL_FILTERS.map((f) => h('button', { type: 'button', class: `cl-filter${clState.filter === f ? ' on' : ''}`, 'aria-pressed': String(clState.filter === f), on: { click: () => { clState.filter = f; onChange(true); } } }, t(`cl.filter.${f}`), h('span', { class: 'cl-filter-n' }, String(counts[f]))))),
    h('div', { class: 'cl-selects' }, select('recency', CL_RECENCY, t('cl.recencyLabel')), select('sort', CL_SORTS, t('cl.sortLabel'))));
}

function clRow(r, cur) {
  return h('button', { type: 'button', class: `cl-row${clState.selected === r.id ? ' sel' : ''}`, 'data-id': r.id, 'aria-label': t('cl.openDetail', t('ex.customerLabel', r.label)), on: { click: () => clOpen(r.id) } },
    h('span', { class: 'cl-c cl-c-name' }, h('span', { class: 'cl-avatar', 'aria-hidden': 'true' }, NordlaIcon.semantic('clients', 'sm')), h('span', { class: 'cl-name' }, t('ex.customerLabel', r.label))),
    h('span', { class: 'cl-c cl-c-status' }, clStatusChip(r)),
    h('span', { class: 'cl-c cl-c-num', 'data-k': t('cl.col.revenue') }, clMoney(r.net_sales_ex_tax, cur)),
    h('span', { class: 'cl-c cl-c-num', 'data-k': t('cl.col.orders') }, String(r.order_count)),
    h('span', { class: 'cl-c cl-c-num', 'data-k': t('cl.col.aov') }, clMoney(r.aov_ex_tax, cur)),
    h('span', { class: 'cl-c cl-c-date', 'data-k': t('cl.col.lastOrder') }, clDate(r.last_order_date)),
    h('span', { class: 'cl-c cl-c-rec', 'data-k': t('cl.col.recency') }, clRecency(r.recency_days)),
    h('span', { class: 'cl-c cl-c-evo', 'data-k': t('cl.col.evolution') }, clEvolution(r)));
}

function clListCard(d) {
  const body = h('div', { class: 'cl-list-body' });
  const draw = () => {
    body.innerHTML = '';
    const rows = clSorted(d.list.filter(clMatches));
    body.appendChild(h('div', { class: 'cl-count' }, t('cl.count', rows.length, d.list.length)));
    if (!d.list.length) { body.appendChild(NordlaCharts.insufficient(t('ex.insufficient'), t('cl.noIdentified'))); return; }
    if (!rows.length) { body.appendChild(NordlaCharts.insufficient(t('cl.noMatchTitle'), t('cl.noMatch'))); return; }
    body.appendChild(h('div', { class: 'cl-table', role: 'list' },
      h('div', { class: 'cl-thead', 'aria-hidden': 'true' },
        h('span', null, t('cl.col.customer')), h('span', null, t('cl.col.status')), h('span', { class: 'num' }, t('cl.col.revenue')), h('span', { class: 'num' }, t('cl.col.orders')),
        h('span', { class: 'num' }, t('cl.col.aov')), h('span', null, t('cl.col.lastOrder')), h('span', null, t('cl.col.recency')), h('span', { class: 'num' }, t('cl.col.evolution'))),
      rows.map((r) => clRow(r, d.currency))));
  };
  let toolbar = null;
  // Filter chips re-render the toolbar (active state + counts); typing only redraws the rows, so the search keeps focus.
  const onChange = (full) => { if (full) { const nt = clToolbar(d, onChange); toolbar.replaceWith(nt); toolbar = nt; } draw(); };
  toolbar = clToolbar(d, onChange);
  draw();
  return h('div', { class: 'ex-card cl-list' },
    h('div', { class: 'ex-card-head' }, h('h3', null, t('cl.listTitle')), h('span', { class: 'cl-scope-tag' }, t('cl.tagMixed'))),
    toolbar, body,
    h('div', { class: 'ex-foot' }, t('cl.listNote')),
    d.value.gated ? h('div', { class: 'ex-foot' }, t('ex.gated', d.value.identified_customers, d.value.min_customers)) : null);
}

// ---------- customer detail (drawer / full-screen sheet on mobile) ----------
let clEscHandler = null;
function clClose() {
  clState.selected = null;
  document.querySelector('.cl-drawer-wrap')?.remove();
  document.body.classList.remove('cl-lock');
  if (clEscHandler) { document.removeEventListener('keydown', clEscHandler); clEscHandler = null; }
  document.querySelectorAll('.cl-row.sel').forEach((el) => el.classList.remove('sel'));
}

async function clOpen(id) {
  clState.selected = id;
  document.querySelectorAll('.cl-row').forEach((el) => el.classList.toggle('sel', el.dataset.id === id));
  document.querySelector('.cl-drawer-wrap')?.remove();
  const panel = h('div', { class: 'cl-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('ex.customerLabel', `#${id}`) });
  const wrap = h('div', { class: 'cl-drawer-wrap' }, h('div', { class: 'cl-backdrop', on: { click: clClose } }), panel);
  panel.appendChild(clDrawerHead(id, null));
  panel.appendChild(h('div', { class: 'cl-drawer-body' }, h('div', { class: 'empty-note' }, t('cl.loading'))));
  document.body.appendChild(wrap);
  document.body.classList.add('cl-lock');
  if (!clEscHandler) { clEscHandler = (e) => { if (e.key === 'Escape') clClose(); }; document.addEventListener('keydown', clEscHandler); }
  panel.querySelector('.cl-close')?.focus();
  if (!clDetails.has(id)) {
    try { const res = await fetch(`/api/customers/detail?id=${encodeURIComponent(id)}`); if (res.ok) clDetails.set(id, await res.json()); } catch (e) { /* shown below */ }
  }
  if (clState.selected !== id || !panel.isConnected) return;
  const data = clDetails.get(id);
  panel.innerHTML = '';
  panel.appendChild(clDrawerHead(id, data?.customer ?? null));
  panel.appendChild(data ? clDrawerBody(data) : h('div', { class: 'cl-drawer-body' }, NordlaCharts.insufficient(t('ex.insufficient'), t('cl.detailError'))));
  panel.querySelector('.cl-close')?.focus();
}

function clDrawerHead(id, c) {
  return h('div', { class: 'cl-drawer-head' },
    h('span', { class: 'cl-avatar lg', 'aria-hidden': 'true' }, NordlaIcon.semantic('clients', 'md')),
    h('div', { class: 'cl-drawer-id' }, h('h2', null, t('ex.customerLabel', `#${id}`)), c ? h('div', { class: 'cl-drawer-status' }, clStatusChip(c), h('span', { class: 'cl-sub' }, c.active ? t('cl.d.activeLine') : t('cl.d.inactiveLine'))) : null),
    h('button', { type: 'button', class: 'cl-close', 'aria-label': t('cl.close'), on: { click: clClose } }, svg(['M6 6l12 12', 'M18 6L6 18'], 18)));
}

function clStat(icon_, label, value) {
  return h('div', { class: 'cl-stat' }, icon_ ? h('span', { class: 'cl-stat-ico' }, NordlaIcon.semantic(icon_, 'sm')) : null, h('span', { class: 'cl-stat-label' }, label), h('strong', { class: 'cl-stat-value' }, value));
}

function clDrawerBody(data) {
  const c = data.customer; const cur = data.currency;
  const sec = (title, tag, ...kids) => h('section', { class: 'cl-sec' }, h('div', { class: 'cl-sec-head' }, h('h3', null, title), tag ? h('span', { class: 'cl-scope-tag' }, tag) : null), ...kids);
  const earlier = c.earlier_history.status === 'outside_history' ? t('cl.d.earlierOutside', c.earlier_history.orders_before)
    : c.earlier_history.status === 'none' ? t('cl.d.earlierNone') : t('cl.d.earlierUnknown');

  // Évolution des achats: a restrained trend line of the real order amounts, only with >= 3 known orders.
  const chronological = [...c.orders].reverse();
  const trend = chronological.length >= 3
    ? NordlaCharts.trendLine(chronological.map((o) => ({ label: fmtDay(o.date), value: o.net_sales_ex_tax })), { format: (v) => fmtCompactMoney(v, cur), height: 150, label: t('cl.d.trendTitle') })
    : null;

  return h('div', { class: 'cl-drawer-body' },
    sec(t('cl.d.periodTitle'), t('cl.tag30'),
      h('div', { class: 'cl-stats' },
        clStat(null, t('cl.col.revenue'), clMoney(c.net_sales_ex_tax, cur)),
        clStat(null, t('cl.col.orders'), String(c.order_count)),
        clStat(null, t('cl.col.aov'), clMoney(c.aov_ex_tax, cur))),
      h('div', { class: 'cl-sub cl-evo-line' }, t('cl.d.previous', clMoney(c.previous_net_sales_ex_tax, cur), c.previous_order_count ?? t('common.dash')), ' · ', clEvolution(c))),
    sec(t('cl.d.historyTitle'), null,
      h('div', { class: 'cl-kv' },
        h('div', null, h('span', null, t('cl.d.firstKnown')), h('strong', null, clDate(c.first_order_date))),
        h('div', null, h('span', null, t('cl.d.lastKnown')), h('strong', null, clDate(c.last_order_date))),
        h('div', null, h('span', null, t('cl.d.knownOrders')), h('strong', null, String(c.known_orders))),
        h('div', null, h('span', null, t('cl.d.knownRevenue')), h('strong', null, clMoney(c.known_net_sales_ex_tax, cur))),
        h('div', null, h('span', null, t('cl.col.recency')), h('strong', null, clRecency(c.recency_days)))),
      h('div', { class: 'ex-foot' }, earlier)),
    sec(t('cl.d.trendTitle'), null,
      trend ? h('div', { class: 'cl-trend' }, trend) : h('div', { class: 'cl-sub' }, c.known_orders === 1 ? t('cl.d.trendOne') : t('cl.d.trendFew', c.known_orders))),
    sec(t('cl.d.ordersTitle'), t('cl.tagHistory'),
      h('div', { class: 'cl-orders' }, c.orders.map((o) => h('div', { class: 'cl-order' },
        h('div', { class: 'cl-order-main' }, h('strong', null, clDate(o.date)), h('span', { class: 'cl-sub' }, exChannelName(o.channel), o.in_period ? h('span', { class: 'cl-chip mute' }, t('cl.d.inPeriod')) : null, o.refunded ? h('span', { class: 'cl-chip mute' }, t('cl.d.refunded')) : null)),
        h('strong', { class: 'cl-order-amt' }, clMoney(o.net_sales_ex_tax, cur))))),
      h('div', { class: 'ex-foot' }, t('cl.d.ordersNote'))),
    c.products.length ? sec(t('cl.d.productsTitle'), t('cl.tagHistory'),
      h('div', { class: 'cl-products' }, c.products.map((p) => h('div', { class: 'cl-product' },
        p.image_url ? (() => { const img = h('img', { class: 'cl-thumb', src: p.image_url, alt: '', loading: 'lazy', on: { error: () => img.replaceWith(h('span', { class: 'cl-thumb' })) } }); return img; })() : h('span', { class: 'cl-thumb' }),
        h('span', { class: 'cl-product-name' }, p.title),
        h('span', { class: 'cl-product-qty' }, t('cl.d.units', p.units), p.refunded_units ? h('span', { class: 'cl-sub' }, t('cl.d.refundedUnits', p.refunded_units)) : null))))) : null);
}

// ---------- export: the list exactly as held by the report, safe labels only ----------
function clExport(d) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['customer', 'period_status', 'active_in_period', 'net_sales_ex_tax_30d', 'orders_30d', 'aov_ex_tax_30d', 'net_sales_ex_tax_previous_30d', 'evolution_pct', 'known_orders', 'known_net_sales_ex_tax', 'first_known_order', 'last_known_order', 'recency_days'];
  const lines = [head.map(q).join(',')];
  for (const r of d.list) lines.push([r.label, r.active ? r.period_status : '', r.active, r.net_sales_ex_tax, r.order_count, r.aov_ex_tax, r.previous_net_sales_ex_tax, r.evolution.delta_pct, r.known_orders, r.known_net_sales_ex_tax, r.first_order_date, r.last_order_date, r.recency_days].map(q).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `clients-${(d.generatedAt || '').slice(0, 10) || 'export'}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderCustomersPage(main) {
  clClose();
  main.appendChild(topbar(cachedCustomers, () => { const keep = clState.selected; route().then(() => { if (keep) clOpen(keep); }); }, { periodLocked: true }));
  const d = cachedCustomers;
  main.appendChild(clHeader(d));
  if (!d || !d.available) { main.appendChild(h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noReport')))); return; }
  main.appendChild(clCoverage(d));
  main.appendChild(clKpiRow(d));
  main.appendChild(h('div', { class: 'ex-grid-2 cl-grid' }, clTopCard(d), clDistributionCard(d)));
  main.appendChild(clListCard(d));
  main.appendChild(clWatch(d));
}
