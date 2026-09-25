'use strict';
// Main "Produits" page (Analytics Premium) - the operational product workspace. Renders ONLY what /api/products and
// /api/products/detail return (src/report/products-workspace.js + Explorer > Produits figures): no metric is computed here,
// only display formatting, searching, filtering and sorting of rows the report already holds.
// Explorer > Produits stays the analytical deep dive; this page links to it. No margin, stock or price is shown here.

let cachedProducts = null;
async function loadProductsIfNeeded() {
  if (cachedProducts) return;
  try {
    const res = await fetch('/api/products');
    if (res.ok) cachedProducts = await res.json();
  } catch (e) { /* surfaces as the empty state */ }
}

const prState = { query: '', filter: 'all', sort: 'revenue', selected: null };
const prDetails = new Map();

// Filters that need a previous window are only offered when that window exists (their state cannot be known otherwise).
const PR_FILTERS = [['all', false], ['up', true], ['down', true], ['new', true], ['absent', true], ['uncategorised', false]];
const PR_SORTS = ['revenue', 'units', 'gain', 'loss', 'recent', 'name'];

const prMoney = (v, cur) => (v == null ? t('common.dash') : exMoney2(v, cur));
const prDate = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString(chartTag(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : t('common.dash'));
const prShare = (v) => (v == null ? t('common.dash') : exShare(v));
const prSignedMoney = (v, cur) => (v == null ? t('common.dash') : `${v > 0 ? '+' : v < 0 ? '−' : ''}${exMoney2(Math.abs(v), cur)}`);

function prThumb(p, size) {
  const cls = `pr-thumb${size === 'lg' ? ' lg' : ''}`;
  if (!p.image_url) return h('span', { class: `${cls} empty`, title: t('pr.noImage') });
  const img = h('img', { class: cls, src: p.image_url, alt: '', loading: 'lazy', on: { error: () => img.replaceWith(h('span', { class: `${cls} empty`, title: t('pr.noImage') })) } });
  return img;
}

function prStatusChips(r) {
  const main = { compared: null, new: ['pr.status.new', ''], not_sold_before: ['pr.status.notBefore', ' mute'], absent: ['pr.status.absent', ' mute'], no_previous: ['pr.status.noPrevious', ' mute'] }[r.status];
  const chips = [];
  if (r.status === 'compared') chips.push(h('span', { class: 'pr-chip mute' }, t('pr.status.compared')));
  else if (main) chips.push(h('span', { class: `pr-chip${main[1]}` }, t(main[0])));
  if (r.flags.uncategorised) chips.push(h('span', { class: 'pr-chip mute' }, t('ex.uncategorised')));
  if (r.flags.partial) chips.push(h('span', { class: 'pr-chip warn', title: t('pr.partialTitle') }, t('pr.status.partial')));
  if (r.flags.negative) chips.push(h('span', { class: 'pr-chip warn' }, t('pr.status.negative')));
  return h('span', { class: 'pr-chips' }, chips);
}

/** Evolution: coloured only for a real comparison (previous revenue > 0). */
function prEvolution(r) {
  if (r.status === 'absent') return h('span', { class: 'pr-evo down' }, t('pr.noSaleNowShort'));
  if (r.delta_pct != null) return h('span', { class: `pr-evo ${r.delta_pct >= 0 ? 'up' : 'down'}` }, exPct(r.delta_pct));
  return h('span', { class: 'pr-evo none', title: t(`pr.evo.${r.status}`) }, t('common.dash'));
}

function prInFilter(r, f) {
  if (f === 'up') return r.direction === 'up';
  if (f === 'down') return r.direction === 'down';
  if (f === 'new') return r.status === 'new';
  if (f === 'absent') return r.status === 'absent';
  if (f === 'uncategorised') return r.flags.uncategorised;
  return true;
}
/** Search covers the real fields held by the report: product title and Shopify handle. */
function prInSearch(r) {
  const q = prState.query.trim().toLowerCase();
  if (!q) return true;
  return String(r.title ?? '').toLowerCase().includes(q) || String(r.handle ?? '').toLowerCase().includes(q);
}
const prMatches = (r) => prInSearch(r) && prInFilter(r, prState.filter);

function prSorted(rows) {
  const out = [...rows]; const s = prState.sort;
  const byName = (a, b) => String(a.title).localeCompare(String(b.title), chartTag());
  if (s === 'units') out.sort((a, b) => b.units_sold - a.units_sold || b.net_sales_ex_tax - a.net_sales_ex_tax || byName(a, b));
  else if (s === 'gain') out.sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity) || byName(a, b));
  else if (s === 'loss') out.sort((a, b) => (a.delta ?? Infinity) - (b.delta ?? Infinity) || byName(a, b));
  else if (s === 'recent') out.sort((a, b) => (a.days_since_last_sale ?? Infinity) - (b.days_since_last_sale ?? Infinity) || b.net_sales_ex_tax - a.net_sales_ex_tax || byName(a, b));
  else if (s === 'name') out.sort(byName);
  else out.sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax || b.units_sold - a.units_sold || byName(a, b));
  return out;
}

// ---------- header, scope, KPIs ----------
function prHeader(d) {
  return h('div', { class: 'ex-head pr-head' },
    h('div', null, h('h1', { class: 'ex-title' }, t('pr.title')), h('p', { class: 'ex-sub' }, t('pr.subtitle'))),
    h('div', { class: 'pr-head-actions' },
      h('a', { class: 'pr-link', href: '#/explorer/products' }, NordlaIcon.semantic('explorer', 'sm'), t('pr.toExplorer')),
      h('button', { class: 'ex-export', type: 'button', disabled: d && d.available && d.list.length ? null : 'disabled', on: { click: () => { if (d && d.available) prExport(d); } } }, svg(['M12 4v10', 'M8 10l4 4 4-4', 'M5 19h14'], 15), t('ex.export'))));
}

function prScope(d) {
  const c = d.watch.catalogue; const m = d.margin || {};
  return h('div', { class: 'pr-scope' },
    h('span', { class: 'pr-scope-ico' }, NordlaIcon.semantic('dataHealth', 'sm')),
    h('div', { class: 'pr-scope-body' },
      h('div', { class: 'pr-scope-text' }, h('strong', null, t('pr.scopeCurrent', prDate(d.period.start))), ' · ', d.period.previous_start ? t('pr.scopePrevious', prDate(d.period.previous_start)) : t('pr.scopeNoPrevious'), ' · ', t('pr.scopeHistory')),
      h('div', { class: 'pr-scope-sub' },
        t('pr.catalogueLine', prShare(c.uncategorised_share), prShare(c.unmatched_share)), ' · ',
        t('pr.marginOmitted', prShare(m.cost_coverage_pct), prShare(m.verified_cost_coverage_pct)))));
}

function prKpiRow(d) {
  const k = d.kpis; const cur = d.currency;
  const top = k.top_product;
  const pp = k.top3_share != null && k.previous_top3_share != null ? Math.round((k.top3_share - k.previous_top3_share) * 100) : null;
  return h('div', { class: 'ex-kpi-row pr-kpis' },
    exKpi('produits', t('pr.kpi.sold'), String(k.products_sold), k.products_sold_pct, k.previous_products_sold != null ? t('pr.kpi.soldPrev', k.previous_products_sold) : null),
    top ? exKpi('meilleurProduit', t('pr.kpi.top'), top.title, top.status === 'compared' ? top.delta_pct : null, `${exMoney(top.net_sales_ex_tax, cur)} · ${t('pr.shareOfRevenue', prShare(top.share))}`, top.status === 'compared' ? { text: true } : { text: true, neutral: t(`pr.evo.${top.status}`) })
      : exKpi('meilleurProduit', t('pr.kpi.top'), t('common.dash'), null, null, { text: true, neutral: t('ex.noProducts') }),
    exKpi('chiffreAffaires', t('pr.kpi.top3'), prShare(k.top3_share), null, t('pr.kpi.top3Note'), { neutral: k.previous_top3_share != null ? t('pr.kpi.top3Prev', prShare(k.previous_top3_share), `${pp > 0 ? '+' : pp < 0 ? '−' : '±'}${Math.abs(pp)} pt`) : t('ex.currentOnly') }),
    exKpi('produitEnBaisse', t('pr.kpi.declining'), k.comparison_available ? String(k.declining) : t('common.dash'), null, k.comparison_available ? t('pr.kpi.decliningNote', k.declining_absent) : null, { neutral: k.comparison_available ? t('pr.kpi.decliningScope') : t('ex.noComparison') }));
}

// ---------- growth / decline (Explorer's own lists: previous revenue > 0) + new products ----------
function prMoverRow(m, cur) {
  const gone = m.net_sales_ex_tax === 0 && m.previous_net_sales_ex_tax > 0;
  const up = m.delta >= 0;
  const inner = [prThumb(m),
    h('span', { class: 'pr-mover-main' }, h('span', { class: 'pr-name' }, m.title), h('span', { class: 'pr-sub' }, t('pr.prevToCur', prMoney(m.previous_net_sales_ex_tax, cur), prMoney(m.net_sales_ex_tax, cur)))),
    h('span', { class: `pr-mover-delta ${up ? 'up' : 'down'}` }, h('strong', null, prSignedMoney(m.delta, cur)), h('span', null, gone ? t('pr.status.absent') : exPct(m.delta_pct)))];
  return m.id ? h('button', { type: 'button', class: 'pr-mover', on: { click: () => prOpen(m.id) } }, inner) : h('div', { class: 'pr-mover' }, inner);
}

function prMoversCard(d, kind) {
  const rows = kind === 'growth' ? d.growth : d.decline;
  const body = [];
  if (!d.kpis.comparison_available) body.push(NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noComparison')));
  else if (rows.length) body.push(h('div', { class: 'pr-movers' }, rows.map((m) => prMoverRow(m, d.currency))));
  else body.push(NordlaCharts.insufficient(t('ex.insufficient'), t(kind === 'growth' ? 'ex.noGrowth' : 'ex.noDecline')));
  if (kind === 'growth' && d.new_products.length) {
    body.push(h('div', { class: 'pr-new' }, h('div', { class: 'pr-new-title' }, t('ex.statusNew')),
      h('div', { class: 'pr-movers' }, d.new_products.map((m) => h('button', { type: 'button', class: 'pr-mover', on: { click: () => prOpen(m.id) } }, prThumb(m),
        h('span', { class: 'pr-mover-main' }, h('span', { class: 'pr-name' }, m.title), h('span', { class: 'pr-sub' }, t('pr.newLine'))),
        h('span', { class: 'pr-mover-delta' }, h('strong', null, prMoney(m.net_sales_ex_tax, d.currency))))))));
  }
  const total = kind === 'growth' ? d.list.filter((r) => r.direction === 'up').length : d.list.filter((r) => r.direction === 'down').length;
  return h('div', { class: 'ex-card' },
    h('div', { class: 'ex-card-head' }, h('h3', { class: 'pr-card-title' }, NordlaIcon.semantic(kind === 'growth' ? 'produitEnHausse' : 'produitEnBaisse', 'md'), t(kind === 'growth' ? 'pr.growthTitle' : 'pr.declineTitle')), h('span', { class: 'pr-scope-tag' }, t('pr.tagCompare'))),
    body,
    d.kpis.comparison_available && total > rows.length ? h('div', { class: 'ex-foot' }, t('pr.moversMore', rows.length, total)) : null,
    h('div', { class: 'ex-foot' }, t('pr.moversNote')));
}

// ---------- product list ----------
function prToolbar(d, onChange) {
  const filters = PR_FILTERS.filter(([, needsPrev]) => !needsPrev || d.kpis.comparison_available).map(([f]) => f);
  const counts = Object.fromEntries(filters.map((f) => [f, d.list.filter((r) => prInFilter(r, f)).length]));
  const input = h('input', { type: 'search', class: 'pr-search-input', placeholder: t('pr.searchPlaceholder'), 'aria-label': t('pr.searchLabel'), value: prState.query, autocomplete: 'off', spellcheck: 'false' });
  input.addEventListener('input', () => { prState.query = input.value; onChange(); });
  return h('div', { class: 'pr-toolbar' },
    h('label', { class: 'pr-search' }, NordlaIcon.semantic('recherche', 'sm'), input),
    h('div', { class: 'pr-selects' }, h('select', { class: 'ex-select pr-select', 'aria-label': t('pr.sortLabel'), on: { change: (e) => { prState.sort = e.target.value; onChange(); } } },
      PR_SORTS.map((o) => h('option', { value: o, selected: prState.sort === o ? '' : null }, t(`pr.sort.${o}`))))),
    h('div', { class: 'pr-filters', role: 'group', 'aria-label': t('pr.filtersLabel') }, filters.map((f) => h('button', { type: 'button', class: `pr-filter${prState.filter === f ? ' on' : ''}`, 'aria-pressed': String(prState.filter === f), on: { click: () => { prState.filter = f; onChange(true); } } }, t(`pr.filter.${f}`), h('span', { class: 'pr-filter-n' }, String(counts[f]))))));
}

function prRow(r, cur) {
  return h('button', { type: 'button', class: `pr-row${prState.selected === r.id ? ' sel' : ''}`, 'data-id': r.id, 'aria-label': t('pr.openDetail', r.title), on: { click: () => prOpen(r.id) } },
    h('span', { class: 'pr-c pr-c-name' }, prThumb(r), h('span', { class: 'pr-name-wrap' }, h('span', { class: 'pr-name' }, r.title), r.category ? h('span', { class: 'pr-sub' }, r.category) : null)),
    h('span', { class: 'pr-c pr-c-num', 'data-k': t('pr.col.revenue') }, prMoney(r.net_sales_ex_tax, cur)),
    h('span', { class: 'pr-c pr-c-num', 'data-k': t('pr.col.units') }, String(r.units_sold)),
    h('span', { class: 'pr-c pr-c-num', 'data-k': t('pr.col.share') }, prShare(r.share)),
    h('span', { class: 'pr-c pr-c-evo', 'data-k': t('pr.col.evolution') }, prEvolution(r)),
    h('span', { class: 'pr-c pr-c-date', 'data-k': t('pr.col.lastSale') }, prDate(r.last_sale_date)),
    h('span', { class: 'pr-c pr-c-status' }, prStatusChips(r)));
}

function prListCard(d) {
  if (!d.kpis.comparison_available && ['up', 'down', 'new', 'absent'].includes(prState.filter)) prState.filter = 'all';
  const body = h('div', { class: 'pr-list-body' });
  const draw = () => {
    body.innerHTML = '';
    const rows = prSorted(d.list.filter(prMatches));
    body.appendChild(h('div', { class: 'pr-count' }, t('pr.count', rows.length, d.list.length)));
    if (!d.list.length) { body.appendChild(NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noProducts'))); return; }
    if (!rows.length) { body.appendChild(NordlaCharts.insufficient(t('pr.noMatchTitle'), t('pr.noMatch'))); return; }
    body.appendChild(h('div', { class: 'pr-table', role: 'list' },
      h('div', { class: 'pr-thead', 'aria-hidden': 'true' },
        h('span', null, t('pr.col.product')), h('span', { class: 'num' }, t('pr.col.revenue')), h('span', { class: 'num' }, t('pr.col.units')), h('span', { class: 'num' }, t('pr.col.share')),
        h('span', { class: 'num' }, t('pr.col.evolution')), h('span', null, t('pr.col.lastSale')), h('span', null, t('pr.col.status'))),
      rows.map((r) => prRow(r, d.currency))));
  };
  let toolbar = null;
  const onChange = (full) => { if (full) { const nt = prToolbar(d, onChange); toolbar.replaceWith(nt); toolbar = nt; } draw(); };
  toolbar = prToolbar(d, onChange);
  draw();
  return h('div', { class: 'ex-card pr-list' },
    h('div', { class: 'ex-card-head' }, h('h3', null, t('pr.listTitle')), h('span', { class: 'pr-scope-tag' }, t('pr.tag30'))),
    toolbar, body, h('div', { class: 'ex-foot' }, t('pr.listNote')));
}

// ---------- watch, categories, concentration ----------
function prWatch(d) {
  const w = d.watch; const cards = [];
  const chips = (list) => h('div', { class: 'pr-watch-list' }, list.slice(0, 5).map((x) => h('button', { type: 'button', class: 'pr-watch-item', on: { click: () => prOpen(x.id) } }, prThumb(x), h('span', { class: 'pr-name' }, x.title), h('span', { class: 'pr-sub' }, prSignedMoney(x.delta, d.currency)))),
    list.length > 5 ? h('span', { class: 'pr-sub' }, t('pr.andMore', list.length - 5)) : null);
  const card = (ico, title, content) => h('div', { class: 'ex-card pr-watch-card' }, h('div', { class: 'pr-watch-top' }, h('span', { class: 'pr-watch-ico' }, NordlaIcon.semantic(ico, 'md')), h('span', { class: 'pr-watch-title' }, title)), content);
  if (!d.kpis.comparison_available) cards.push(card('dataHealth', t('pr.watch.compareTitle'), NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noComparison'))));
  else {
    cards.push(card('produitEnBaisse', t('pr.watch.absentTitle'), w.absent.length ? h('div', null, h('div', { class: 'pr-watch-text' }, t('pr.watch.absentText', w.absent.length)), chips(w.absent)) : h('div', { class: 'pr-watch-text' }, t('pr.watch.absentNone'))));
    cards.push(card('baisse', t('pr.watch.lowerTitle'), w.lower.length ? h('div', null, h('div', { class: 'pr-watch-text' }, t('pr.watch.lowerText', w.lower.length)), chips(w.lower)) : h('div', { class: 'pr-watch-text' }, t('pr.watch.lowerNone'))));
  }
  const c = w.catalogue;
  cards.push(card('dataHealth', t('pr.watch.catalogueTitle'), h('div', null,
    h('div', { class: 'pr-watch-text' }, c.uncategorised_products ? t('pr.watch.uncat', c.uncategorised_products, prShare(c.uncategorised_share)) : t('pr.watch.uncatNone')),
    h('div', { class: 'pr-watch-text' }, c.unmatched_products ? t('pr.watch.unmatched', c.unmatched_products, prShare(c.unmatched_share)) : t('pr.watch.unmatchedNone')),
    w.negative.length ? h('div', null, h('div', { class: 'pr-watch-text' }, t('pr.watch.negative', w.negative.length)), chips(w.negative)) : null)));
  return h('div', null, h('h3', { class: 'section-heading' }, t('pr.watchHeading')), h('div', { class: 'pr-watch-grid' }, cards));
}

function prCategoriesCard(d) {
  const rows = d.categories || [];
  const max = Math.max(...rows.map((c) => c.net_sales_ex_tax), 1);
  const body = rows.length
    ? h('div', { class: 'pr-bars' }, rows.map((c) => h('div', { class: 'pr-bar-row' },
      h('span', { class: `pr-bar-name${c.name == null ? ' mute' : ''}` }, c.name ?? t('ex.uncategorised')),
      h('div', { class: 'ex-bar' }, h('i', { class: 'first', style: `width:${Math.max(3, Math.round((c.net_sales_ex_tax / max) * 100))}%` })),
      h('span', { class: 'pr-bar-val' }, h('strong', null, exMoney(c.net_sales_ex_tax, d.currency)), h('span', null, prShare(c.share))))))
    : NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noProducts'));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('pr.catTitle')), h('span', { class: 'pr-scope-tag' }, t('pr.tag30'))), body, h('div', { class: 'ex-foot' }, t('pr.catNote')));
}

function prConcentrationCard(d) {
  const c = d.concentration;
  const body = c && c.top1 != null
    ? h('div', { class: 'pr-bars' }, [[1, c.top1], [3, c.top3], [5, c.top5]].map(([n, v]) => h('div', { class: 'pr-bar-row' },
      h('span', { class: 'pr-bar-name' }, t('ex.topN', n)), h('div', { class: 'ex-bar' }, h('i', { class: 'first', style: `width:${Math.round((v ?? 0) * 100)}%` })), h('span', { class: 'pr-bar-val' }, h('strong', null, prShare(v))))))
    : NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noProducts'));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.concTitle')), h('span', { class: 'pr-scope-tag' }, t('pr.tag30'))), body,
    c ? h('div', { class: 'ex-foot' }, t('pr.concNote', c.products_sold)) : null, h('div', { class: 'ex-foot' }, t('ex.concNeutral')));
}

// ---------- product detail (drawer / full-screen sheet on mobile) ----------
let prEscHandler = null;
function prClose() {
  prState.selected = null;
  document.querySelector('.pr-drawer-wrap')?.remove();
  document.body.classList.remove('pr-lock');
  if (prEscHandler) { document.removeEventListener('keydown', prEscHandler); prEscHandler = null; }
  document.querySelectorAll('.pr-row.sel').forEach((el) => el.classList.remove('sel'));
}

async function prOpen(id) {
  if (!id) return;
  prState.selected = id;
  document.querySelectorAll('.pr-row').forEach((el) => el.classList.toggle('sel', el.dataset.id === id));
  document.querySelector('.pr-drawer-wrap')?.remove();
  const summary = cachedProducts?.list?.find((r) => r.id === id) ?? null;
  const panel = h('div', { class: 'pr-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': summary ? summary.title : t('pr.title') });
  const wrap = h('div', { class: 'pr-drawer-wrap' }, h('div', { class: 'pr-backdrop', on: { click: prClose } }), panel);
  panel.appendChild(prDrawerHead(summary));
  panel.appendChild(h('div', { class: 'pr-drawer-body' }, h('div', { class: 'empty-note' }, t('pr.loading'))));
  document.body.appendChild(wrap);
  document.body.classList.add('pr-lock');
  if (!prEscHandler) { prEscHandler = (e) => { if (e.key === 'Escape') prClose(); }; document.addEventListener('keydown', prEscHandler); }
  panel.querySelector('.pr-close')?.focus();
  if (!prDetails.has(id)) {
    try { const res = await fetch(`/api/products/detail?id=${encodeURIComponent(id)}`); if (res.ok) prDetails.set(id, await res.json()); } catch (e) { /* shown below */ }
  }
  if (prState.selected !== id || !panel.isConnected) return;
  const data = prDetails.get(id);
  panel.innerHTML = '';
  panel.appendChild(prDrawerHead(data?.product ?? summary));
  panel.appendChild(data ? prDrawerBody(data) : h('div', { class: 'pr-drawer-body' }, NordlaCharts.insufficient(t('ex.insufficient'), t('pr.detailError'))));
  panel.querySelector('.pr-close')?.focus();
}

function prDrawerHead(p) {
  return h('div', { class: 'pr-drawer-head' },
    p ? prThumb(p, 'lg') : null,
    h('div', { class: 'pr-drawer-id' }, h('h2', null, p ? p.title : ''), p ? h('div', { class: 'pr-drawer-meta' }, p.category ? h('span', { class: 'pr-sub' }, p.category) : !p.matched ? h('span', { class: 'pr-sub' }, t('pr.noCatalogue')) : null, prStatusChips(p)) : null),
    h('button', { type: 'button', class: 'pr-close', 'aria-label': t('pr.close'), on: { click: prClose } }, svg(['M6 6l12 12', 'M18 6L6 18'], 18)));
}

function prStat(label, value) { return h('div', { class: 'pr-stat' }, h('span', { class: 'pr-stat-label' }, label), h('strong', { class: 'pr-stat-value' }, value)); }

function prDrawerBody(data) {
  const p = data.product; const cur = data.currency;
  const sec = (title, tag, ...kids) => h('section', { class: 'pr-sec' }, h('div', { class: 'pr-sec-head' }, h('h3', null, title), tag ? h('span', { class: 'pr-scope-tag' }, tag) : null), ...kids);
  const trend = p.sale_days >= p.min_trend_sale_days
    ? NordlaCharts.trendLine(p.daily.map((x) => ({ label: fmtDay(x.date), value: x.net_sales_ex_tax })), { format: (v) => fmtCompactMoney(v, cur), height: 150, label: t('pr.d.trendTitle') })
    : null;
  const compared = p.previous_net_sales_ex_tax != null;
  return h('div', { class: 'pr-drawer-body' },
    sec(t('pr.d.currentTitle'), t('pr.tag30'),
      h('div', { class: 'pr-stats' },
        prStat(t('pr.col.revenue'), prMoney(p.net_sales_ex_tax, cur)),
        prStat(t('pr.col.units'), String(p.units_sold)),
        prStat(t('pr.col.share'), prShare(p.share)),
        prStat(t('pr.d.perUnit'), prMoney(p.revenue_per_unit, cur)))),
    sec(t('pr.d.compareTitle'), t('pr.tagPrevious'),
      compared ? h('div', { class: 'pr-kv' },
        h('div', null, h('span', null, t('pr.d.prevRevenue')), h('strong', null, prMoney(p.previous_net_sales_ex_tax, cur))),
        h('div', null, h('span', null, t('pr.d.prevUnits')), h('strong', null, String(p.previous_units_sold))),
        h('div', null, h('span', null, t('pr.d.change')), h('strong', null, prSignedMoney(p.delta, cur))),
        h('div', null, h('span', null, t('pr.d.changePct')), h('strong', null, p.delta_pct != null ? exPct(p.delta_pct) : t(`pr.evo.${p.status}`))))
        : h('div', { class: 'pr-sub' }, t('ex.noComparison')),
      p.contribution ? h('div', { class: 'ex-foot' }, t('pr.d.contribution', prSignedMoney(p.contribution.delta, cur), prSignedMoney(p.contribution.total_delta, cur))) : null),
    sec(t('pr.d.trendTitle'), t('pr.tag30'),
      trend ? h('div', { class: 'pr-trend' }, trend) : h('div', { class: 'pr-sub' }, p.sale_days ? t('pr.d.trendFew', p.sale_days) : t('pr.d.trendNone')),
      h('div', { class: 'ex-foot' }, t('pr.d.lastSale', prDate(p.last_sale_date)))),
    sec(t('pr.d.recentTitle'), t('pr.tagHistory'),
      p.recent_sales.length ? h('div', { class: 'pr-orders' }, p.recent_sales.map((s) => h('div', { class: 'pr-order' },
        h('div', { class: 'pr-order-main' }, h('strong', null, prDate(s.date)), h('span', { class: 'pr-sub' }, exChannelName(s.channel), ' · ', s.units === 1 ? t('ex.unit1') : t('ex.units', s.units), s.refunded_units ? h('span', { class: 'pr-chip mute' }, t('pr.d.refunded', s.refunded_units)) : null)),
        h('strong', { class: 'pr-order-amt' }, prMoney(s.net_sales_ex_tax, cur)))))
        : h('div', { class: 'pr-sub' }, t('pr.d.noRecent')),
      h('div', { class: 'ex-foot' }, t('pr.d.recentNote'))));
}

// ---------- export: the list exactly as held by the report ----------
function prExport(d) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['product', 'category', 'units_30d', 'net_sales_ex_tax_30d', 'share_of_revenue', 'net_sales_ex_tax_previous_30d', 'change', 'change_pct', 'status', 'last_sale'];
  const lines = [head.map(q).join(',')];
  for (const r of d.list) lines.push([r.title, r.category ?? '', r.units_sold, r.net_sales_ex_tax, r.share, r.previous_net_sales_ex_tax, r.delta, r.delta_pct, r.status, r.last_sale_date].map(q).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `produits-${(d.generatedAt || '').slice(0, 10) || 'export'}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderProductsPage(main) {
  prClose();
  main.appendChild(topbar(cachedProducts, () => { const keep = prState.selected; route().then(() => { if (keep) prOpen(keep); }); }, { periodLocked: true }));
  const d = cachedProducts;
  main.appendChild(prHeader(d));
  if (!d || !d.available) { main.appendChild(h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noReport')))); return; }
  main.appendChild(prScope(d));
  main.appendChild(prKpiRow(d));
  main.appendChild(h('div', { class: 'ex-grid-2 even pr-grid' }, prMoversCard(d, 'growth'), prMoversCard(d, 'decline')));
  main.appendChild(prListCard(d));
  main.appendChild(prWatch(d));
  main.appendChild(h('div', { class: 'ex-grid-2 even pr-grid' }, prCategoriesCard(d), prConcentrationCard(d)));
}
