'use strict';
// Explorer page (Analytics Premium). Renders ONLY what /api/explorer returns (built in src/report/explorer.js from
// the real ledger): no figure is computed, estimated or invented here, except display formatting.
// Sections: header + Exporter, sub-tabs, 4 KPI cards, Sales trend, Category donut, Top products, Top customers.
// Only the "Vue d'ensemble" tab has content today; the other tabs are honest "not available yet" states.

let cachedExplorer = null;
async function loadExplorerIfNeeded() {
  if (cachedExplorer) return;
  try {
    const res = await fetch(`/api/explorer?${periodQuery()}`);
    if (res.ok) cachedExplorer = await res.json();
    else { let code = null; try { code = (await res.json()).error.code; } catch (e) { code = null; } cachedExplorer = { available: false, periodError: code || 'GENERIC' }; }
  } catch (e) { /* surfaces as the empty state */ }
}

const EX_TABS = ['overview', 'sales', 'products', 'customers', 'channels', 'zones', 'period', 'comparison'];
let exGranularity = 'day';

const exMoney2 = (v, cur) => new Intl.NumberFormat(chartTag(), { style: 'currency', currency: cur || 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
const exSigned = (v, cur) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtCompactMoney(Math.abs(v), cur)}`;
const exActiveTab = () => (/^#\/explorer\/sales/.test(location.hash) ? 'sales' : /^#\/explorer\/products/.test(location.hash) ? 'products' : /^#\/explorer\/customers/.test(location.hash) ? 'customers' : /^#\/explorer\/channels/.test(location.hash) ? 'channels' : /^#\/explorer\/zones/.test(location.hash) ? 'zones' : /^#\/explorer\/period/.test(location.hash) ? 'period' : /^#\/explorer\/comparison/.test(location.hash) ? 'comparison' : 'overview');
const exMoney = (v, cur) => new Intl.NumberFormat(chartTag(), { style: 'currency', currency: cur || 'EUR', maximumFractionDigits: 0 }).format(v);
const exPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))} %`;
const exShare = (v) => `${Math.round(v * 100)} %`;

/** Delta line of a KPI card: only a REAL measured comparison is coloured; a missing one is a neutral dash. */
function exDelta(pct) {
  if (pct == null) return h('div', { class: 'ex-delta none' }, t('ex.noComparison'));
  const up = pct >= 0;
  return h('div', { class: `ex-delta ${up ? 'up' : 'down'}` }, icon(up ? 'up' : 'down', 13), h('strong', null, exPct(pct)), h('span', null, t('ex.vsPrevious')));
}

function exKpi(iconName, label, value, deltaPct, note, opts = {}) {
  return h('div', { class: 'ex-kpi' },
    h('span', { class: 'ex-kpi-ico' }, NordlaIcon.semantic(iconName, 'lg')),
    h('div', { class: 'ex-kpi-body' },
      h('div', { class: 'ex-kpi-label' }, label),
      h('div', { class: `ex-kpi-value${opts.text ? ' text' : ''}${opts.tone ? ` ${opts.tone}` : ''}` }, value),
      opts.neutral ? h('div', { class: 'ex-delta none' }, opts.neutral) : exDelta(deltaPct),
      note ? h('div', { class: 'ex-kpi-note' }, note) : null));
}

function exKpiRow(d) {
  const k = d.kpis; const dl = k.delta || {};
  const idNote = k.identified_share != null ? t('ex.identifiedNote', exShare(k.identified_share)) : null;
  return h('div', { class: 'ex-kpi-row' },
    exKpi('chiffreAffaires', t('ex.kpi.revenue'), exMoney(k.net_sales_ex_tax, d.currency), dl.net_sales_ex_tax_pct),
    exKpi('commandes', t('ex.kpi.orders'), String(k.order_count), dl.order_count_pct),
    exKpi('clients', t('ex.kpi.customers'), String(k.active_customers), dl.active_customers_pct, idNote),
    exKpi('produits', t('ex.kpi.units'), String(k.units_sold), dl.units_sold_pct));
}

function exSalesCard(d, title) {
  title = title || t('ex.salesTitle');
  const weekly = exGranularity === 'week';
  const rows = weekly ? d.series.weekly : d.series.daily;
  const sel = h('select', { class: 'ex-select', 'aria-label': t('ex.granularity'), on: { change: (e) => { exGranularity = e.target.value; route(); } } },
    h('option', { value: 'day', selected: weekly ? null : '' }, t('ex.byDay')), h('option', { value: 'week', selected: weekly ? '' : null }, t('ex.byWeek')));
  let body;
  if (!rows || rows.length < 2) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.insufficientSub'));
  else {
    body = h('div', null,
      trendChart(rows.map((r) => r.net_sales_ex_tax), rows.map((r) => (weekly ? r.week_start : r.date)), { format: (v) => fmtCompactMoney(v, d.currency), height: 250, label: title }) || NordlaCharts.insufficient(t('ex.insufficient'), t('ex.insufficientSub')),
      weekly && rows.some((r) => r.days < 7) ? h('div', { class: 'ex-foot' }, t('ex.partialWeeks')) : null);
  }
  return h('div', { class: 'ex-card ex-sales' }, h('div', { class: 'ex-card-head' }, h('h3', null, title), sel), body);
}

function exCategoryCard(d, title) {
  const cats = d.categories || [];
  let body;
  if (!cats.length) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noCategories'));
  else {
    const label = (c) => c.name ?? t('ex.uncategorised');
    // At most 5 slices: the smallest categories beyond the 4th are summed into "Autres" (real sum, nothing dropped).
    let shown = cats;
    if (cats.length > 5) {
      const rest = cats.slice(4);
      shown = [...cats.slice(0, 4), { name: t('ex.others'), net_sales_ex_tax: rest.reduce((s, c) => s + c.net_sales_ex_tax, 0), share: rest.reduce((s, c) => s + c.share, 0), isOthers: true }];
    }
    const total = cats.reduce((s, c) => s + c.net_sales_ex_tax, 0);
    body = NordlaCharts.donut(shown.map((c) => ({ name: c.isOthers ? c.name : label(c), pct: Math.round(c.share * 1000) / 10, value: exMoney(c.net_sales_ex_tax, d.currency) })), { totalValue: exMoney(total, d.currency), totalLabel: t('ex.total'), size: 160 });
  }
  return h('div', { class: 'ex-card ex-cats' }, h('div', { class: 'ex-card-head' }, h('h3', null, title || t('ex.categoryTitle'))), body);
}

function exTopProducts(d) {
  const rows = d.top_products || [];
  let body;
  if (!rows.length) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noProducts'));
  else {
    body = h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table' },
      h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, t('ex.col.product')), h('th', { class: 'num' }, t('ex.col.sales')), h('th', { class: 'num' }, t('ex.col.revenue')), h('th', { class: 'num' }, t('ex.col.evolution')))),
      h('tbody', null, rows.map((p, i) => h('tr', null,
        h('td', { class: 'rk' }, String(i + 1)),
        h('td', null, h('div', { class: 'ex-prod' }, rankThumb({ imageUrl: p.image_url, title: p.title }), h('span', null, p.title))),
        h('td', { class: 'num' }, String(p.units_sold)),
        h('td', { class: 'num' }, exMoney(p.net_sales_ex_tax, d.currency)),
        h('td', { class: 'num' }, p.delta_pct == null ? h('span', { class: 'ex-dash' }, t('common.dash')) : h('span', { class: `ex-evo ${p.delta_pct >= 0 ? 'up' : 'down'}` }, icon(p.delta_pct >= 0 ? 'up' : 'down', 12), exPct(p.delta_pct))))))));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.topProducts'))), body);
}

function exTopCustomers(d) {
  const c = d.top_customers;
  let body;
  if (!c || c.status !== 'OK' || !c.rows.length) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noCustomers'));
  else {
    body = h('div', null,
      h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table slim' },
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, t('ex.col.customer')), h('th', { class: 'num' }, t('ex.col.revenue')), h('th', { class: 'num' }, t('ex.col.orders')))),
        h('tbody', null, c.rows.map((r, i) => h('tr', null,
          h('td', { class: 'rk' }, String(i + 1)),
          h('td', null, h('div', { class: 'ex-prod' }, h('span', { class: 'ex-cust-ico' }, NordlaIcon.semantic('clients', 'sm')), h('span', null, t('ex.customerLabel', r.label)))),
          h('td', { class: 'num' }, exMoney(r.net_sales_ex_tax, d.currency)),
          h('td', { class: 'num' }, String(r.order_count)))))),
      ),
      h('div', { class: 'ex-foot' }, t('ex.customerNote', c.identified_share != null ? exShare(c.identified_share) : t('common.dash'))));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.topCustomers'))), body);
}

/** Exporter: downloads the data exactly as shown (real report values) as one CSV file. */
function exExport(d) {
  const lines = [];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  lines.push(['section', 'label', 'value', 'extra'].map(q).join(','));
  for (const r of d.series.daily) lines.push(['sales_daily', r.date, r.net_sales_ex_tax, r.order_count].map(q).join(','));
  for (const r of d.series.weekly) lines.push(['sales_weekly', r.week_start, r.net_sales_ex_tax, r.order_count].map(q).join(','));
  for (const c of d.categories) lines.push(['category', c.name ?? t('ex.uncategorised'), c.net_sales_ex_tax, c.share].map(q).join(','));
  for (const p of d.top_products) lines.push(['top_product', p.title, p.net_sales_ex_tax, p.units_sold].map(q).join(','));
  for (const r of d.top_customers.rows) lines.push(['top_customer', r.label, r.net_sales_ex_tax, r.order_count].map(q).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `explorer-${(d.generatedAt || '').slice(0, 10) || 'export'}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const EX_TAB_ENABLED = { overview: '#/explorer', sales: '#/explorer/sales', products: '#/explorer/products', customers: '#/explorer/customers', channels: '#/explorer/channels', zones: '#/explorer/zones', period: '#/explorer/period', comparison: '#/explorer/comparison' };
function exTabs() {
  // Enabled tabs navigate by hash (deep-linkable); the rest are visibly disabled (not focusable, not clickable).
  const active = exActiveTab();
  const strip = h('div', { class: 'ex-tabs', role: 'tablist' }, EX_TABS.map((k) => {
    const href = EX_TAB_ENABLED[k]; const on = k === active;
    if (!href) return h('button', { type: 'button', role: 'tab', class: 'ex-tab off', 'aria-selected': 'false', 'aria-disabled': 'true', disabled: 'disabled', title: t('ex.soonTitle'), tabindex: '-1' }, t(`ex.tab.${k}`));
    return h('button', { type: 'button', role: 'tab', class: `ex-tab${on ? ' on' : ''}`, 'aria-selected': String(on), on: { click: () => { if (!on) location.hash = href; } } }, t(`ex.tab.${k}`));
  }));
  // On narrow screens the strip scrolls: bring the active tab into view (centred when possible) once it is laid out.
  const reveal = () => { const on = strip.querySelector('.ex-tab.on'); if (on && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = on.offsetLeft - (strip.clientWidth - on.offsetWidth) / 2; };
  requestAnimationFrame(reveal); setTimeout(reveal, 120);
  return strip;
}

// ---------- Ventes tab ----------
function exSalesKpiRow(d) {
  const k = d.kpis; const dl = k.delta || {};
  return h('div', { class: 'ex-kpi-row' },
    exKpi('chiffreAffaires', t('ex.kpi.revenue'), exMoney(k.net_sales_ex_tax, d.currency), dl.net_sales_ex_tax_pct),
    exKpi('commandes', t('ex.kpi.orders'), String(k.order_count), dl.order_count_pct),
    exKpi('panierMoyen', t('ex.kpi.aov'), k.aov_ex_tax == null ? t('common.dash') : exMoney2(k.aov_ex_tax, d.currency), dl.aov_ex_tax_pct),
    exKpi('produits', t('ex.kpi.items'), String(k.units_sold), dl.units_sold_pct));
}

function exChannelCard(d) {
  const ch = d.channels || [];
  const body = ch.length
    ? NordlaCharts.donut(ch.map((c) => ({ name: c.name ?? t('ex.channelUnknown'), pct: Math.round(c.share * 1000) / 10, value: exMoney(c.net_sales_ex_tax, d.currency) })), { totalValue: exMoney(ch.reduce((a, c) => a + c.net_sales_ex_tax, 0), d.currency), totalLabel: t('ex.total'), size: 160 })
    : NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noChannels'));
  return h('div', { class: 'ex-card ex-cats' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.channelTitle'))), body);
}

function exComparisonCard(d) {
  const blocks = d.comparison?.blocks;
  let body;
  if (!blocks || blocks.length < 2) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noPrevious'));
  else {
    const groups = blocks.map((b) => ({ label: fmtDay(b.start_date), a: b.previous_net_sales_ex_tax, b: b.current_net_sales_ex_tax }));
    const short = blocks.filter((b) => b.days < 7);
    body = h('div', null,
      NordlaCharts.comparison(groups, [{ name: t('ex.cmpPrev'), cls: 'prev' }, { name: t('ex.cmpCur'), cls: 'cur' }], { format: (v) => fmtCompactMoney(v, d.currency), height: 240, label: t('ex.cmpTitle') }),
      h('div', { class: 'ex-foot' }, t('ex.cmpNote'), short.length ? ` ${t('ex.cmpPartial', short[short.length - 1].days)}` : ''));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.cmpTitle'))), body);
}

function exContributionCard(d, title) {
  const c = d.contributions;
  let body;
  if (!c || (!c.positive.length && !c.negative.length)) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noContrib'));
  else {
    const items = [...c.positive, ...c.negative].map((m) => ({ label: m.title, value: m.delta }));
    body = h('div', null,
      NordlaCharts.contributionBars(items, { format: (v) => fmtCompactMoney(v, d.currency) }),
      h('div', { class: 'ex-foot' }, t('ex.contribNote', exSigned(c.total_delta, d.currency))));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, title || t('ex.contribTitle'))), body);
}

function exDayCard(iconName, title, day, d, note) {
  if (!day) return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, title)), NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noDays')));
  return h('div', { class: 'ex-card ex-day' },
    h('span', { class: 'ex-kpi-ico' }, NordlaIcon.semantic(iconName, 'lg')),
    h('div', { class: 'ex-kpi-body' },
      h('div', { class: 'ex-kpi-label' }, title),
      h('div', { class: 'ex-day-date' }, new Date(`${day.date}T00:00:00Z`).toLocaleDateString(chartTag(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })),
      h('div', { class: 'ex-day-figs' }, h('strong', null, exMoney2(day.net_sales_ex_tax, d.currency)), h('span', null, day.order_count === 1 ? t('ex.dayOrders1') : t('ex.dayOrdersN', day.order_count))),
      note ? h('div', { class: 'ex-kpi-note' }, note) : null));
}

function exDaysRow(d) {
  const dy = d.days || {};
  return h('div', { class: 'ex-grid-2 even' },
    exDayCard('croissance', t('ex.bestDay'), dy.best, d),
    exDayCard('baisse', t('ex.weakDay'), dy.weakest, d, dy.days_total ? `${t('ex.weakNote')} ${t('ex.daysNoSale', dy.days_without_sales, dy.days_total)}` : t('ex.weakNote')));
}

function renderSalesTab(main, d) {
  main.appendChild(exSalesKpiRow(d));
  main.appendChild(h('div', { class: 'ex-grid-2' }, exSalesCard(d, t('ex.trendTitle')), exChannelCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exComparisonCard(d), exContributionCard(d)));
  main.appendChild(exDaysRow(d));
}


// ---------- Produits tab ----------
const exProdTitle = (p) => (p.matched === false ? t('ex.unmatched') : p.title);

function exEvolution(p) {
  if (p.status === 'compared') return h('span', { class: `ex-evo ${p.delta_pct >= 0 ? 'up' : 'down'}` }, icon(p.delta_pct >= 0 ? 'up' : 'down', 12), exPct(p.delta_pct));
  if (p.status === 'new') return h('span', { class: 'ex-chip' }, t('ex.statusNew'));
  if (p.status === 'not_sold_before') return h('span', { class: 'ex-chip mute' }, t('ex.statusNotBefore'));
  return h('span', { class: 'ex-dash' }, t('common.dash'));
}

function exProdKpiRow(d) {
  const pr = d.products; const k = d.kpis; const dl = k.delta || {};
  const top = pr.top_revenue_product; const cat = pr.top_category; const c = pr.concentration;
  return h('div', { class: 'ex-kpi-row' },
    exKpi('produits', t('ex.kpi.productsSold'), String(k.units_sold), dl.units_sold_pct, t('ex.distinctProducts', c.products_sold)),
    top ? exKpi('meilleurProduit', t('ex.kpi.topProduct'), exProdTitle(top), top.status === 'compared' ? top.delta_pct : null, `${exMoney(top.net_sales_ex_tax, d.currency)} · ${exShare(top.share)}`, { text: true }) : exKpi('meilleurProduit', t('ex.kpi.topProduct'), t('common.dash'), null),
    cat ? exKpi('stock', t('ex.kpi.topCategory'), cat.name ?? t('ex.uncategorised'), null, `${exMoney(cat.net_sales_ex_tax, d.currency)} · ${exShare(cat.share)}`, { text: true, neutral: t('ex.currentOnly') }) : exKpi('stock', t('ex.kpi.topCategory'), t('common.dash'), null, null, { text: true, neutral: t('ex.currentOnly') }),
    exKpi('chiffreAffaires', t('ex.kpi.top3'), c.top3 == null ? t('common.dash') : exShare(c.top3), null, t('ex.concentrationNote'), { neutral: t('ex.currentOnly') }));
}

function exRankingCard(d) {
  const rows = d.products.ranking || [];
  let body;
  if (!rows.length) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noProducts'));
  else {
    const max = Math.max(...rows.map((r) => r.net_sales_ex_tax), 1);
    body = h('div', { class: 'ex-rank' }, rows.map((p, i) => h('div', { class: 'ex-rank-row' },
      h('span', { class: 'ex-rk' }, String(p.rank)),
      rankThumb({ imageUrl: p.image_url, title: exProdTitle(p) }),
      h('div', { class: 'ex-rank-main' },
        h('div', { class: 'ex-rank-name' }, h('span', null, exProdTitle(p)), h('span', { class: 'ex-share' }, p.share == null ? '' : exShare(p.share))),
        h('div', { class: 'ex-bar' }, h('i', { class: i === 0 ? 'first' : '', style: `width:${Math.max(3, Math.round((p.net_sales_ex_tax / max) * 100))}%` }))),
      h('div', { class: 'ex-rank-val' }, h('strong', null, exMoney(p.net_sales_ex_tax, d.currency)), h('span', null, p.units_sold === 1 ? t('ex.unit1') : t('ex.units', p.units_sold)), exEvolution(p)))));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.rankingTitle'))), body);
}

function exMoverCard(d, kind) {
  const rows = d.products[kind] || [];
  const title = t(kind === 'growth' ? 'ex.growthTitle' : 'ex.declineTitle');
  let body;
  if (!rows.length) body = NordlaCharts.insufficient(t('ex.insufficient'), t(kind === 'growth' ? 'ex.noGrowth' : 'ex.noDecline'));
  else body = h('div', { class: 'ex-movers' }, rows.map((m) => {
    const up = m.delta >= 0; const gone = m.net_sales_ex_tax === 0;
    return h('div', { class: 'ex-mover' },
      rankThumb({ imageUrl: m.image_url, title: exProdTitle(m) }),
      h('div', { class: 'ex-mover-main' }, h('div', { class: 'ex-mover-name' }, exProdTitle(m)), h('div', { class: 'ex-mover-sub' }, `${exMoney(m.previous_net_sales_ex_tax, d.currency)} → ${exMoney(m.net_sales_ex_tax, d.currency)}`)),
      h('div', { class: `ex-mover-delta ${up ? 'up' : 'down'}` }, h('strong', null, exSigned(m.delta, d.currency)), h('span', null, gone ? t('ex.noSaleNow') : exPct(m.delta_pct))));
  }));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, title)), body);
}

function exConcentrationCard(d) {
  const c = d.products.concentration;
  let body;
  if (c.top1 == null) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noProducts'));
  else {
    const rows = [[1, c.top1], [3, c.top3], [5, c.top5]];
    body = h('div', null,
      h('div', { class: 'ex-conc' }, rows.map(([n, v]) => h('div', { class: 'ex-conc-row' }, h('span', null, t('ex.topN', n)), h('div', { class: 'ex-bar' }, h('i', { class: 'first', style: `width:${Math.round((v ?? 0) * 100)}%` })), h('strong', null, exShare(v))))),
      c.products_sold >= 3 ? h('div', { class: 'ex-foot' }, t('ex.concSentence', exShare(c.top3))) : null,
      h('div', { class: 'ex-foot' }, t('ex.concNeutral')));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.concTitle'))), body);
}

function exUnitsRevenueCard(d) {
  const rows = d.products.units_vs_revenue || [];
  let body;
  if (rows.length < 2) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noProducts'));
  else {
    const groups = rows.map((r) => ({ label: `#${r.rank}`, title: exProdTitle(r), a: r.units_share, b: r.revenue_share }));
    body = h('div', null,
      NordlaCharts.comparison(groups, [{ name: t('ex.unitsShare'), cls: 'alt' }, { name: t('ex.revenueShare'), cls: 'cur' }], { format: (v) => `${Math.round(v * 100)} %`, height: 220, label: t('ex.unitsVsRevenue') }),
      h('div', { class: 'ex-foot' }, t('ex.unitsNote')));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.unitsVsRevenue'))), body);
}

function exMarginCard(d) {
  const m = d.products.margin;
  const pctTxt = (v) => (v == null ? t('common.dash') : exShare(v));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.marginTitle'))),
    NordlaCharts.insufficient(t('ex.marginPartial'), t('ex.marginSub', pctTxt(m.cost_coverage_pct), pctTxt(m.verified_cost_coverage_pct))));
}

function renderProductsTab(main, d) {
  if (!d.products) { main.appendChild(h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noReport')))); return; }
  main.appendChild(exProdKpiRow(d));
  main.appendChild(h('div', { class: 'ex-grid-2' }, exRankingCard(d), exCategoryCard(d, t('ex.catShareTitle'))));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exMoverCard(d, 'growth'), exMoverCard(d, 'decline')));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exContributionCard(d, t('ex.contribChangeTitle')), exConcentrationCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exUnitsRevenueCard(d), exMarginCard(d)));
}


// ---------- Clients tab ----------
// Identified customers only. Every figure comes from the report (src/report/explorer.js > customers); the coverage of
// identified orders is repeated wherever it matters, and gated numbers (approved minimum of identified customers) are shown as such.
const exCovPct = (v) => (v == null ? t('common.dash') : exShare(v));

function exCovNote(cu) {
  const cv = cu.coverage;
  return cv.previous_identified_share != null ? t('ex.covNotePrev', exCovPct(cv.identified_share), exCovPct(cv.previous_identified_share)) : t('ex.covNote', exCovPct(cv.identified_share));
}

function exCustKpiRow(d) {
  const cu = d.customers; const k = cu.kpis; const dl = k.delta || {};
  const note = exCovNote(cu);
  return h('div', { class: 'ex-kpi-row' },
    exKpi('clients', t('ex.kpi.activeCustomers'), String(k.active), dl.active_pct, note),
    exKpi('nouveauClient', t('ex.kpi.newCustomers'), String(k.new), dl.new_pct, t('ex.newDef')),
    exKpi('segmentClient', t('ex.kpi.returningCustomers'), String(k.returning), dl.returning_pct, t('ex.returningDef')),
    exKpi('chiffreAffaires', t('ex.kpi.identifiedRevenue'), exMoney(k.identified_net_sales_ex_tax, d.currency), dl.identified_net_sales_ex_tax_pct, note));
}

function exSegmentDonut(d, mode) {
  const cu = d.customers; const sg = cu.segments;
  const rows = [['new', t('ex.seg.new'), sg.new], ['returning', t('ex.seg.returning'), sg.returning], ['unknown', t('ex.seg.unknown'), sg.unknown]].filter(([, , g]) => (mode === 'revenue' ? g.net_sales_ex_tax > 0 : g.customers > 0));
  if (!rows.length) return NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noCustomers'));
  const total = rows.reduce((a, [, , g]) => a + (mode === 'revenue' ? g.net_sales_ex_tax : g.customers), 0);
  const items = rows.map(([, label, g]) => { const v = mode === 'revenue' ? g.net_sales_ex_tax : g.customers; return { name: label, pct: Math.round((v / total) * 1000) / 10, value: mode === 'revenue' ? exMoney(v, d.currency) : t('ex.nCustomers', v) }; });
  return NordlaCharts.donut(items, { totalValue: mode === 'revenue' ? exMoney(total, d.currency) : String(total), totalLabel: mode === 'revenue' ? t('ex.total') : t('ex.identifiedShort'), size: 160 });
}

function exNewVsReturningCard(d) {
  return h('div', { class: 'ex-card ex-cats' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.newVsReturningTitle'))),
    exSegmentDonut(d, 'customers'),
    h('div', { class: 'ex-foot' }, t('ex.segDefs')), h('div', { class: 'ex-foot' }, exCovNote(d.customers)));
}

function exCustRevenueCard(d) {
  return h('div', { class: 'ex-card ex-cats' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.custRevenueTitle'))),
    exSegmentDonut(d, 'revenue'),
    h('div', { class: 'ex-foot' }, t('ex.custRevenueNote', exCovPct(d.customers.coverage.identified_share))));
}

function exCustTrendCard(d) {
  const w = d.customers.weekly || [];
  let body;
  if (w.length < 2 || w.every((x) => x.active === 0)) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.insufficientSub'));
  else {
    const groups = w.map((x) => ({ label: fmtDay(x.week_start), a: x.new, b: x.active }));
    body = h('div', null,
      NordlaCharts.comparison(groups, [{ name: t('ex.seriesNew'), cls: 'alt' }, { name: t('ex.seriesActive'), cls: 'cur' }], { format: (v) => String(Math.round(v)), height: 230, label: t('ex.custTrendTitle') }),
      h('div', { class: 'ex-foot' }, t('ex.custTrendNote')), h('div', { class: 'ex-foot' }, exCovNote(d.customers)));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.custTrendTitle'))), body);
}

function exRecencyCard(d) {
  const r = d.customers.recency; const b = r.buckets;
  const rows = [['ex.rec.d30', b.d0_30], ['ex.rec.d60', b.d31_60], ['ex.rec.d90', b.d61_90], ['ex.rec.d90plus', b.d90_plus]];
  const max = Math.max(...rows.map(([, n]) => n), 1);
  const body = r.identified_customers
    ? h('div', null, h('div', { class: 'ex-conc' }, rows.map(([k, n]) => h('div', { class: 'ex-conc-row wide' }, h('span', null, t(k)), h('div', { class: 'ex-bar' }, h('i', { class: 'first', style: `width:${Math.round((n / max) * 100)}%` })), h('strong', null, String(n))))),
      h('div', { class: 'ex-foot' }, t('ex.recNote', r.history_days)))
    : NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noCustomers'));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.activityTitle'))), body);
}

function exTopClientsCard(d) {
  const rows = d.customers.top || [];
  let body;
  if (!rows.length) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noCustomers'));
  else body = h('div', null,
    h('div', { class: 'ex-movers cust' }, rows.map((r, i) => h('div', { class: 'ex-mover' },
      h('span', { class: 'ex-rk' }, String(i + 1)),
      h('span', { class: 'ex-cust-ico' }, NordlaIcon.semantic('clients', 'sm')),
      h('div', { class: 'ex-mover-main' },
        h('div', { class: 'ex-mover-name' }, t('ex.customerLabel', r.label), ' ', h('span', { class: `ex-chip${r.type === 'new' ? '' : ' mute'}` }, r.type === 'new' ? t('ex.seg.newShort') : r.type === 'returning' ? t('ex.seg.returningShort') : t('ex.seg.unknownShort'))),
        h('div', { class: 'ex-mover-sub' }, t('ex.lastOrder', new Date(`${r.last_order_date}T00:00:00Z`).toLocaleDateString(chartTag(), { day: 'numeric', month: 'short', timeZone: 'UTC' })))),
      h('div', { class: 'ex-mover-delta' }, h('strong', { class: 'ex-cust-rev' }, exMoney(r.net_sales_ex_tax, d.currency)), h('span', null, `${r.order_count === 1 ? t('ex.dayOrders1') : t('ex.dayOrdersN', r.order_count)} · ${t('ex.basketShort')} ${r.aov_ex_tax == null ? t('common.dash') : exMoney2(r.aov_ex_tax, d.currency)}`))))),
    h('div', { class: 'ex-foot' }, t('ex.customerNote', exCovPct(d.customers.coverage.identified_share))));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.topCustomers'))), body);
}

function exFrequencyCard(d) {
  const f = d.customers.frequency; const v = d.customers.value;
  const rows = [['ex.freq.one', f.one], ['ex.freq.two', f.two], ['ex.freq.three', f.three_plus]];
  const max = Math.max(...rows.map(([, n]) => n), 1);
  const body = h('div', null,
    h('div', { class: 'ex-conc' }, rows.map(([k, n]) => h('div', { class: 'ex-conc-row wide' }, h('span', null, t(k)), h('div', { class: 'ex-bar' }, h('i', { class: 'first', style: `width:${Math.round((n / max) * 100)}%` })), h('strong', null, String(n))))),
    h('div', { class: 'ex-foot' }, v.gated ? t('ex.gated', v.identified_customers, v.min_customers) : t('ex.avgOrders', v.avg_orders_per_customer)),
    h('div', { class: 'ex-foot' }, t('ex.freqNote')));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.frequencyTitle'))), body);
}

function exValueCard(d) {
  const v = d.customers.value;
  let body;
  if (v.gated) body = NordlaCharts.insufficient(t('ex.sampleTitle'), t('ex.gated', v.identified_customers, v.min_customers));
  else body = h('div', { class: 'ex-conc' },
    [['ex.val.avgRevenue', exMoney2(v.avg_revenue_per_customer, d.currency)], ['ex.val.median', exMoney2(v.median_revenue_per_customer, d.currency)], ['ex.val.basket', exMoney2(v.avg_basket_ex_tax, d.currency)]].map(([k, val]) => h('div', { class: 'ex-val-row' }, h('span', null, t(k)), h('strong', null, val))));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.valueTitle'))), body, h('div', { class: 'ex-foot' }, t('ex.noClv')));
}

function exCohortCard(d) {
  const c = d.customers.cohort;
  const reasons = c.reasons.map((r) => t(`ex.cohortReason.${r}`, c.history_days, c.required_history_days));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.cohortTitle'))),
    NordlaCharts.insufficient(t('ex.insufficient'), t('ex.cohortSub')),
    h('ul', { class: 'ex-reasons' }, reasons.map((r) => h('li', null, r))));
}

function renderCustomersTab(main, d) {
  if (!d.customers) { main.appendChild(h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noReport')))); return; }
  main.appendChild(exCustKpiRow(d));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exNewVsReturningCard(d), exCustRevenueCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2' }, exCustTrendCard(d), exRecencyCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exTopClientsCard(d), exFrequencyCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exValueCard(d), exCohortCard(d)));
}


// ---------- Canaux tab ----------
// A channel is the source's own channel name, unchanged in the data; only its DISPLAY label is translated (when a
// translation exists - any other source value is shown as is). One colour per channel, the same everywhere on the page.
let exChannelMetric = 'revenue';
const exChannelName = (name) => { if (name == null) return t('ex.channelUnknown'); const k = `ex.channelName.${name}`; const v = t(k); return v === k ? name : v; };
const exChCls = (cv) => new Map(cv.channels.map((r, i) => [r.name, `c${Math.min(i, 4) + 1}`]));

function exChKpiRow(d) {
  const cv = d.channels_view; const top = cv.channels[0];
  if (!top || !(top.net_sales_ex_tax > 0)) return null;
  const dl = top.delta || {};
  const prevShare = top.previous && top.previous.share > 0 ? t('ex.prevShare', exShare(top.previous.share)) : null;
  return h('div', { class: 'ex-kpi-row' },
    exKpi('chiffreAffaires', t('ex.kpi.topChannel'), exChannelName(top.name), top.status === 'compared' ? dl.net_sales_ex_tax_pct : null, exMoney(top.net_sales_ex_tax, d.currency), { text: true }),
    exKpi('stock', t('ex.kpi.topChannelShare'), exShare(top.share), null, null, { neutral: prevShare || t('ex.noComparison') }),
    exKpi('commandes', t('ex.kpi.topChannelOrders'), String(top.order_count), dl.order_count_pct),
    exKpi('panierMoyen', t('ex.kpi.topChannelAov'), top.aov_ex_tax == null ? t('common.dash') : exMoney2(top.aov_ex_tax, d.currency), dl.aov_ex_tax_pct));
}

function exChShareCard(d) {
  const cv = d.channels_view; const cls = exChCls(cv);
  const act = cv.channels.filter((r) => r.net_sales_ex_tax > 0);
  const body = act.length
    ? NordlaCharts.donut(act.map((r) => ({ name: exChannelName(r.name), pct: Math.round(r.share * 1000) / 10, value: exMoney(r.net_sales_ex_tax, d.currency), cls: cls.get(r.name) })), { totalValue: exMoney(cv.total_net_sales_ex_tax, d.currency), totalLabel: t('ex.total'), size: 160 })
    : NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noChannelData'));
  return h('div', { class: 'ex-card ex-cats' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.chShareTitle'))), body);
}

function exChPerfCard(d) {
  const cv = d.channels_view;
  const metrics = [['revenue', t('ex.kpi.revenue')], ['orders', t('ex.kpi.orders')], ['aov', t('ex.kpi.aov')]];
  const sel = h('select', { class: 'ex-select', 'aria-label': t('ex.metricLabel'), on: { change: (e) => { exChannelMetric = e.target.value; route(); } } }, metrics.map(([v, l]) => h('option', { value: v, selected: v === exChannelMetric ? '' : null }, l)));
  const rows = cv.channels.filter((r) => r.net_sales_ex_tax > 0 || (r.previous && r.previous.net_sales_ex_tax > 0));
  let body;
  if (!rows.length || !rows.some((r) => r.previous)) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noPrevious'));
  else {
    const val = (o) => (o == null ? 0 : exChannelMetric === 'revenue' ? o.net_sales_ex_tax : exChannelMetric === 'orders' ? o.order_count : (o.aov_ex_tax ?? 0));
    const fmt = exChannelMetric === 'orders' ? (v) => String(Math.round(v)) : (v) => fmtCompactMoney(v, d.currency);
    const groups = rows.map((r) => ({ label: exChannelName(r.name), a: val(r.previous), b: val(r) }));
    body = h('div', null, NordlaCharts.comparison(groups, [{ name: t('ex.cmpPrev'), cls: 'prev' }, { name: t('ex.cmpCur'), cls: 'cur' }], { format: fmt, height: 230, label: t('ex.chPerfTitle') }));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.chPerfTitle')), sel), body);
}

function exChTrendCard(d) {
  const cv = d.channels_view; const cls = exChCls(cv);
  const rows = cv.channels.filter((r) => r.net_sales_ex_tax > 0);
  let body;
  if (!rows.length || cv.weeks.length < 2) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.insufficientSub'));
  else body = h('div', null,
    NordlaCharts.trendLines(rows.map((r) => ({ name: exChannelName(r.name), cls: cls.get(r.name), values: r.weekly.map((w) => w.net_sales_ex_tax) })), cv.weeks.map((w) => fmtDay(w.week_start)), { format: (v) => fmtCompactMoney(v, d.currency), height: 230, label: t('ex.chTrendTitle') }),
    h('div', { class: 'ex-foot' }, t('ex.chTrendNote')));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.chTrendTitle'))), body);
}

function exChInsightCard(d) {
  const cv = d.channels_view; const act = cv.channels.filter((r) => r.net_sales_ex_tax > 0);
  let body;
  if (!act.length) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noChannelData'));
  else {
    const lines = act.map((r) => t('ex.insShare', exChannelName(r.name), exShare(r.share)));
    if (cv.aov_gap) lines.push(t('ex.insAov', exChannelName(cv.aov_gap.higher), exMoney2(cv.aov_gap.diff, d.currency), exChannelName(cv.aov_gap.lower)));
    body = h('div', null, h('ul', { class: 'ex-facts' }, lines.map((l) => h('li', null, l))), h('div', { class: 'ex-foot' }, t('ex.insNeutral')));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.chInsightTitle'))), body);
}

function exChVariationCard(d) {
  const cv = d.channels_view; const cls = exChCls(cv);
  const rows = cv.channels.filter((r) => r.previous);
  let body;
  if (!rows.length) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noPrevious'));
  else body = h('div', { class: 'ex-movers' }, rows.map((r) => {
    const dlt = r.delta.net_sales_ex_tax; const up = dlt >= 0;
    const tag = r.status === 'new' ? t('ex.statusNew') : r.status === 'absent' ? t('ex.noSalesPeriod') : r.delta.net_sales_ex_tax_pct != null ? exPct(r.delta.net_sales_ex_tax_pct) : t('common.dash');
    return h('div', { class: 'ex-mover' },
      h('i', { class: `nc-dot ${cls.get(r.name)}` }),
      h('div', { class: 'ex-mover-main' }, h('div', { class: 'ex-mover-name' }, exChannelName(r.name)), h('div', { class: 'ex-mover-sub' }, `${exMoney(r.previous.net_sales_ex_tax, d.currency)} → ${exMoney(r.net_sales_ex_tax, d.currency)}`)),
      h('div', { class: `ex-mover-delta ${dlt === 0 ? '' : up ? 'up' : 'down'}` }, h('strong', null, exSigned(dlt, d.currency)), h('span', null, tag)));
  }));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.chVarTitle'))), body);
}

function exChContributionCard(d) {
  const cv = d.channels_view;
  const items = cv.channels.filter((r) => r.delta && r.delta.net_sales_ex_tax !== 0).sort((a, b) => b.delta.net_sales_ex_tax - a.delta.net_sales_ex_tax).map((r) => ({ label: exChannelName(r.name), value: r.delta.net_sales_ex_tax }));
  const body = items.length && cv.total_delta != null
    ? h('div', null, NordlaCharts.contributionBars(items, { format: (v) => fmtCompactMoney(v, d.currency) }), h('div', { class: 'ex-foot' }, t('ex.contribNote', exSigned(cv.total_delta, d.currency))))
    : NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noContrib'));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.chContribTitle'))), body);
}

function exChProductsCard(d) {
  const cv = d.channels_view; const cls = exChCls(cv);
  const act = cv.channels.filter((r) => r.net_sales_ex_tax > 0 && r.top_products.length);
  const body = act.length
    ? h('div', null, act.map((r) => h('div', { class: 'ex-chprod' },
      h('div', { class: 'ex-chprod-head' }, h('i', { class: `nc-dot ${cls.get(r.name)}` }), exChannelName(r.name)),
      h('div', { class: 'ex-movers' }, r.top_products.map((p) => h('div', { class: 'ex-mover' },
        rankThumb({ imageUrl: p.image_url, title: exProdTitle(p) }),
        h('div', { class: 'ex-mover-main' }, h('div', { class: 'ex-mover-name' }, exProdTitle(p)), h('div', { class: 'ex-mover-sub' }, p.units_sold === 1 ? t('ex.unit1') : t('ex.units', p.units_sold))),
        h('div', { class: 'ex-mover-delta' }, h('strong', { class: 'ex-cust-rev' }, exMoney(p.net_sales_ex_tax, d.currency)))))))))
    : NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noProducts'));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.chProductsTitle'))), body);
}

function exChCustomersCard(d) {
  const cv = d.channels_view; const cls = exChCls(cv);
  const act = cv.channels.filter((r) => r.net_sales_ex_tax > 0);
  const body = act.length
    ? h('div', null, h('div', { class: 'ex-movers' }, act.map((r) => h('div', { class: 'ex-mover' },
      h('i', { class: `nc-dot ${cls.get(r.name)}` }),
      h('div', { class: 'ex-mover-main' }, h('div', { class: 'ex-mover-name' }, exChannelName(r.name)), h('div', { class: 'ex-mover-sub' }, t('ex.chCustLine', r.customers.customers, r.customers.identified_share == null ? t('common.dash') : exShare(r.customers.identified_share)))),
      h('div', { class: 'ex-mover-delta' }, h('strong', { class: 'ex-cust-rev' }, String(r.customers.customers)), h('span', null, t('ex.chCustSplit', r.customers.new, r.customers.returning)))))),
      h('div', { class: 'ex-foot' }, t('ex.chCustNote')))
    : NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noCustomers'));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.chCustomersTitle'))), body);
}

function renderChannelsTab(main, d) {
  if (!d.channels_view) { main.appendChild(h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noReport')))); return; }
  const kpis = exChKpiRow(d);
  if (!kpis) { main.appendChild(h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noChannelData')))); return; }
  main.appendChild(kpis);
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exChShareCard(d), exChPerfCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2' }, exChTrendCard(d), exChInsightCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exChVariationCard(d), exChContributionCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exChProductsCard(d), exChCustomersCard(d)));
}

// ---------- Zones tab ----------
// The sync stores no shipping/billing address: the only geographic signal is the sale location (a store).
// With no usable zone the page shows what exists, what is missing and what would unlock it - never a fake chart.
function exGeoKpiRow(g) {
  return h('div', { class: 'ex-kpi-row' },
    exKpi('stock', t('ex.geo.kpiCoverage'), exShare(g.usable_coverage ?? 0), null, t('ex.geo.covNote', g.usable_orders, g.total_orders), { neutral: t('ex.geo.covNeutral') }),
    exKpi('commandes', t('ex.geo.kpiSaleLoc'), exShare(g.sale_location_coverage ?? 0), null, t('ex.geo.saleLocNote', g.orders_with_sale_location, g.total_orders), { neutral: t('ex.geo.saleLocNeutral') }),
    exKpi('chiffreAffaires', t('ex.geo.kpiZones'), String(g.usable_orders > 0 ? g.sale_locations.length : 0), null, t('ex.geo.zonesNote'), { neutral: t('ex.noComparison') }),
    exKpi('commandes', t('ex.geo.kpiOrders'), String(g.total_orders), null, null, { neutral: t('ex.geo.kpiOrdersNote') }));
}

function exGeoFoundCard(g) {
  const rows = g.sale_locations.map((l) => h('tr', null,
    h('td', null, h('div', null, t('ex.geo.saleLocation', l.name)), h('div', { class: 'ex-foot' }, t('ex.geo.saleLocMeaning'))), h('td', { class: 'num' }, String(l.orders)), h('td', null, t('ex.geo.no'))));
  const body = rows.length
    ? h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table slim' },
      h('thead', null, h('tr', null, h('th', null, t('ex.geo.colField')), h('th', { class: 'num' }, t('ex.geo.colOrders')), h('th', null, t('ex.geo.colUsable')))),
      h('tbody', null, rows)))
    : h('p', { class: 'ex-foot' }, t('ex.geo.noSaleLocation'));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.geo.foundTitle'))), body,
    h('div', { class: 'ex-card-head ex-geo-sub' }, h('h3', null, t('ex.geo.absentTitle'))), h('div', { class: 'ex-foot' }, t('ex.geo.absentLine')));
}

function exGeoUnlockCard(g) {
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.geo.unlockTitle'))),
    h('ul', { class: 'ex-facts' }, [t('ex.geo.unlock1'), t('ex.geo.unlock2'), t('ex.geo.unlock3')].map((l) => h('li', null, l))),
    h('div', { class: 'ex-foot' }, t('ex.geo.privacy')));
}

function renderZonesTab(main, d) {
  const g = d.geo_view;
  if (!g) { main.appendChild(h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noReport')))); return; }
  main.appendChild(exGeoKpiRow(g));
  main.appendChild(h('div', { class: 'ex-card ex-mb' }, NordlaCharts.insufficient(t('ex.geo.blockedTitle'), g.status === 'zones_available' ? t('ex.geo.pendingSub') : t('ex.geo.blockedSub', exShare(g.usable_coverage ?? 0)))));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exGeoFoundCard(g), exGeoUnlockCard(g)));
}

// ---------- Période tab ----------
const exSignedFull = (v, cur) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${exMoney(Math.abs(v), cur)}`;
const exLocDate = (iso, opts) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(chartTag(), { timeZone: 'UTC', ...opts });

function exPerKpiRow(d) {
  const k = d.kpis; const pv = k.previous; const cur = d.currency;
  const abs = pv ? k.net_sales_ex_tax - pv.net_sales_ex_tax : null;
  const pctv = k.delta ? k.delta.net_sales_ex_tax_pct : null;
  const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : null);
  return h('div', { class: 'ex-kpi-row' },
    exKpi('chiffreAffaires', t('ex.per.kpiCur'), exMoney(k.net_sales_ex_tax, cur), null, null, { neutral: t('ex.per.last30') }),
    exKpi('chiffreAffaires', t('ex.per.kpiPrev'), pv ? exMoney(pv.net_sales_ex_tax, cur) : t('common.dash'), null, null, { neutral: pv ? t('ex.per.prev30') : t('ex.per.noPrev') }),
    exKpi('croissance', t('ex.per.kpiAbs'), abs == null ? t('common.dash') : exSignedFull(round0(abs), cur), null, null, { tone: abs == null ? null : tone(abs), neutral: abs == null ? t('ex.per.noPrev') : t('ex.vsPrevious') }),
    exKpi('croissance', t('ex.per.kpiPct'), pctv == null ? t('common.dash') : exPct(pctv), null, null, { tone: pctv == null ? null : tone(pctv), neutral: pctv == null ? (pv ? t('ex.per.pctInvalid') : t('ex.per.noPrev')) : t('ex.vsPrevious') }));
}
const round0 = (v) => Math.round(v);

/** Neutral horizontal bars (navy; terracotta only on the focused row). items: [{label, value, text, sub, focus}] */
function exHBars(items) {
  const max = Math.max(...items.map((i) => i.value), 0) || 1;
  return h('div', { class: 'ex-hb' }, items.map((i) => h('div', { class: 'ex-hb-row' },
    h('span', { class: 'ex-hb-label' }, i.label),
    h('div', { class: 'ex-bar' }, h('i', { class: i.focus ? 'first' : '', style: `width:${i.value > 0 ? Math.max(3, Math.round((i.value / max) * 100)) : 0}%` })),
    h('span', { class: 'ex-hb-val' }, h('strong', null, i.text), i.sub ? h('em', null, i.sub) : null))));
}

const exWeekLabel = (w) => t('ex.per.weekOf', exLocDate(w.week_start, { day: 'numeric', month: 'short' }));

function exPerDaysRow(d) {
  const p = d.period_view; const dy = d.days || {};
  const bw = p.best_week ? t('ex.per.bestWeek', exWeekLabel(p.best_week), exMoney(p.best_week.net_sales_ex_tax, d.currency)) : null;
  const ww = p.weakest_week ? t('ex.per.weakWeek', exWeekLabel(p.weakest_week), exMoney(p.weakest_week.net_sales_ex_tax, d.currency)) : null;
  return h('div', { class: 'ex-grid-2 even' },
    exDayCard('croissance', t('ex.per.bestTitle'), dy.best, d, bw),
    exDayCard('baisse', t('ex.per.weakTitle'), dy.weakest, d, [t('ex.weakNote'), dy.days_total ? t('ex.daysNoSale', dy.days_without_sales, dy.days_total) : null, ww].filter(Boolean).join(' ')));
}

function exPerActivityCard(d) {
  const s = d.period_view.stats;
  const body = !s ? NordlaCharts.insufficient(t('ex.insufficient'), t('ex.per.noData'))
    : h('div', null, h('ul', { class: 'ex-facts' }, [t('ex.per.daysWith', s.active_days), t('ex.per.daysWithout', s.days_without_sales), t('ex.per.daysAbove', s.days_above_mean), t('ex.per.daysBelow', s.days_below_mean)].map((l) => h('li', null, l))),
      h('div', { class: 'ex-foot' }, t('ex.per.activityNote', s.days_total)));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.per.activityTitle'))), body);
}

function exPerWeeksCard(d) {
  const w = d.period_view.weeks.filter((x) => x.share != null);
  let body;
  if (w.length < 2) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.per.noData'));
  else {
    const top = w.reduce((b, x) => (x.net_sales_ex_tax > b.net_sales_ex_tax ? x : b));
    const partial = w.filter((x) => x.partial);
    body = h('div', null, exHBars(w.map((x) => ({ label: exLocDate(x.week_start, { day: 'numeric', month: 'short' }), value: x.net_sales_ex_tax, text: exShare(x.share), sub: exMoney(x.net_sales_ex_tax, d.currency) + (x.partial ? ` · ${x.days} j` : ''), focus: x === top }))),
      partial.length ? h('div', { class: 'ex-foot' }, t('ex.per.weeksNote', partial.map((x) => x.days).join(' / '))) : null);
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.per.weeksTitle'))), body);
}

function exPerRegularityCard(d) {
  const s = d.period_view.stats; let body;
  if (!s) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.per.noData'));
  else {
    const row = (l, v) => h('div', { class: 'ex-stat' }, h('span', null, l), h('strong', null, v));
    body = h('div', null, h('div', { class: 'ex-stats' },
      row(t('ex.per.mean'), exMoney2(s.mean_daily_net_sales_ex_tax, d.currency)), row(t('ex.per.median'), exMoney2(s.median_daily_net_sales_ex_tax, d.currency)),
      row(t('ex.per.sd'), exMoney2(s.std_dev_daily_net_sales_ex_tax, d.currency)), row(t('ex.per.cv'), s.coefficient_of_variation == null ? t('common.dash') : exShare(s.coefficient_of_variation))),
      h('div', { class: 'ex-foot' }, t('ex.per.regNote', s.days_total)));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.per.regTitle'))), body);
}

function exPerWeekdayCard(d) {
  const wd = d.period_view.weekdays.filter((w) => w.occurrences > 0); let body;
  if (wd.length < 2) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.per.noData'));
  else {
    const top = wd.reduce((b, x) => (x.avg_net_sales_ex_tax > b.avg_net_sales_ex_tax ? x : b));
    body = h('div', null, exHBars(wd.map((w) => ({ label: new Date(Date.UTC(2024, 0, 1 + w.weekday)).toLocaleDateString(chartTag(), { weekday: 'long', timeZone: 'UTC' }), value: w.avg_net_sales_ex_tax, text: exMoney(w.avg_net_sales_ex_tax, d.currency), sub: t('ex.per.weekdayLine', w.order_count, w.occurrences), focus: w === top && w.avg_net_sales_ex_tax > 0 }))),
      h('div', { class: 'ex-foot' }, t('ex.per.weekdayNote')));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.per.weekdayTitle'))), body);
}

function exPerTimeCard(d) {
  const tod = d.period_view.time_of_day; let body;
  if (!tod || tod.timed_orders < 1) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.per.noData'));
  else {
    const top = tod.buckets.reduce((b, x) => (x.net_sales_ex_tax > b.net_sales_ex_tax ? x : b));
    body = h('div', null, exHBars(tod.buckets.map((b) => ({ label: t(`ex.per.tod.${b.key}`), value: b.net_sales_ex_tax, text: exMoney(b.net_sales_ex_tax, d.currency), sub: t('ex.per.orders', b.order_count), focus: b === top && b.net_sales_ex_tax > 0 }))),
      h('div', { class: 'ex-foot' }, t('ex.per.todNote', tod.time_zone, tod.timed_orders, tod.total_orders)));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.per.todTitle'))), body);
}

function exPerWhyCard(d) {
  const k = d.kpis; const dl = k.delta; const pv = k.previous; let body;
  if (!dl || !pv || dl.order_count_pct == null) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noPrevious'));
  else {
    const lines = [t('ex.per.whyOrders', exPct(dl.order_count_pct), String(k.order_count), String(pv.order_count))];
    if (dl.aov_ex_tax_pct != null) lines.push(t('ex.per.whyAov', exPct(dl.aov_ex_tax_pct), exMoney2(k.aov_ex_tax, d.currency), exMoney2(pv.aov_ex_tax, d.currency)));
    body = h('div', null, h('ul', { class: 'ex-facts' }, lines.map((l) => h('li', null, l))), h('div', { class: 'ex-foot' }, t('ex.per.whyNote')));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.per.whyTitle'))), body);
}

function renderPeriodTab(main, d) {
  if (!d.period_view) { main.appendChild(h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('ex.insufficient'), t('ex.noReport')))); return; }
  main.appendChild(exPerKpiRow(d));
  main.appendChild(h('div', { class: 'ex-grid-2' }, exSalesCard(d, t('ex.per.trendTitle')), exPerWhyCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exComparisonCard(d), exPerWeeksCard(d)));
  main.appendChild(exPerDaysRow(d));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exPerActivityCard(d), exPerRegularityCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exPerWeekdayCard(d), exPerTimeCard(d)));
}

// ---------- Comparaison tab ----------
const exCpRange = (a, b) => `${exLocDate(a, { day: 'numeric', month: 'short' })} – ${exLocDate(b, { day: 'numeric', month: 'short', year: 'numeric' })}`;
const exCpCatName = (n) => (n == null ? t('ex.cp.noCategory') : n);

function exCpPeriods(cv) {
  const pr = cv.periods;
  return h('div', { class: 'ex-cp-periods' },
    h('div', { class: 'ex-cp-period cur' }, h('i', { class: 'nc-dot cur' }), h('span', null, h('strong', null, t('ex.cp.periodCur')), ` ${exCpRange(pr.current.start, pr.current.end)} · ${pr.current.days} ${t('ex.days')}`)),
    h('div', { class: 'ex-cp-period' }, h('i', { class: 'nc-dot prev' }), h('span', null, h('strong', null, t('ex.cp.periodPrev')), ` ${exCpRange(pr.previous.start, pr.previous.end)} · ${pr.previous.days} ${t('ex.days')}`)));
}

function exCpKpiRow(d) {
  const cv = d.comparison_view; const cur = d.currency;
  const spec = { net_sales_ex_tax: ['chiffreAffaires', 'ex.kpi.revenue', (v) => exMoney(v, cur), (v) => exSignedFull(v, cur)], order_count: ['commandes', 'ex.kpi.orders', (v) => String(v), (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}`],
    aov_ex_tax: ['panierMoyen', 'ex.kpi.aov', (v) => exMoney2(v, cur), (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${exMoney2(Math.abs(v), cur)}`], units_sold: ['produits', 'ex.kpi.items', (v) => String(v), (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}`] };
  return h('div', { class: 'ex-kpi-row' }, cv.kpis.map((k) => {
    const [ic, label, f, fs] = spec[k.key];
    const note = k.previous == null ? null : `${t('ex.cp.previousValue', f(k.previous))}${k.delta_abs == null ? '' : ` · ${t('ex.cp.change', fs(k.delta_abs))}`}`;
    return exKpi(ic, t(label), k.current == null ? t('common.dash') : f(k.current), k.delta_pct, note);
  }));
}

function exCpBlocksCard(d) {
  const cv = d.comparison_view; const b = cv.blocks; let body;
  if (!b || b.length < 2) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.cp.noPrevious'));
  else {
    const groups = b.map((x) => ({ label: x.partial ? t('ex.cp.blockLabelPartial', x.index, x.days) : t('ex.cp.blockLabel', x.index),
      title: t('ex.cp.blockTip', t('ex.cp.blockLabel', x.index), exLocDate(x.start_date, { day: 'numeric', month: 'short' }), exLocDate(x.end_date, { day: 'numeric', month: 'short' }), exLocDate(x.previous_start_date, { day: 'numeric', month: 'short' }), exLocDate(x.previous_end_date, { day: 'numeric', month: 'short' })), a: x.previous, b: x.current }));
    const last = b[b.length - 1];
    body = h('div', null, NordlaCharts.comparison(groups, [{ name: t('ex.cmpPrev'), cls: 'prev' }, { name: t('ex.cmpCur'), cls: 'cur' }], { format: (v) => fmtCompactMoney(v, d.currency), height: 240, label: t('ex.cp.blocksTitle') }),
      h('div', { class: 'ex-foot' }, last.partial ? t('ex.cp.blocksNote', last.days) : t('ex.cp.blocksNoteFull')));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.cp.blocksTitle'))), body);
}

function exCpTrendCard(d) {
  const a = d.comparison_view.aligned_days; let body;
  if (!a || a.length < 2) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.cp.noPrevious'));
  else body = h('div', null, NordlaCharts.trendLines([{ name: t('ex.cp.periodCur'), cls: 'c1', values: a.map((x) => x.current) }, { name: t('ex.cp.periodPrev'), cls: 'c4', values: a.map((x) => x.previous) }],
    a.map((x) => t('ex.cp.dayN', x.index)), { format: (v) => fmtCompactMoney(v, d.currency), height: 240, label: t('ex.cp.trendTitle') }),
  h('div', { class: 'ex-foot' }, t('ex.cp.trendNote', a.length)));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.cp.trendTitle'))), body);
}

function exCpWaterfallCard(d) {
  const w = d.comparison_view.waterfall; let body;
  if (!w || !w.reconciles) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.cp.noPrevious'));
  else {
    const short = (s) => (s.length > 9 ? `${s.slice(0, 8)}…` : s);
    const steps = [{ label: t('ex.cp.wfPrev'), short: t('ex.cp.wfPrevShort'), value: w.previous_total, total: true },
      ...w.steps.map((s) => { const label = s.other ? t('ex.cp.wfOther', s.count) : exCpCatName(s.name); return { label, short: s.other ? t('ex.cp.wfOtherShort') : short(label), value: s.delta }; }),
      { label: t('ex.cp.wfCur'), short: t('ex.cp.wfCurShort'), value: w.current_total, total: true }];
    body = h('div', null, NordlaCharts.waterfall(steps, { format: (v) => fmtCompactMoney(v, d.currency), signedFormat: (v) => fmtCompactMoney(Math.abs(v), d.currency).replace(/^/, v < 0 ? '−' : ''), height: 250, label: t('ex.cp.wfTitle') }),
      h('div', { class: 'ex-foot' }, t('ex.cp.wfNote')));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.cp.wfTitle'))), body);
}

/** One comparable row: name, before -> after, signed change, and a % or a status chip (never +inf). */
function exCpRow({ dot, name, prev, cur, delta, pctv, status, extra }, currency) {
  const up = delta >= 0;
  const evo = status === 'new' ? h('span', { class: 'ex-chip' }, t('ex.cp.statusNew')) : status === 'absent' ? h('span', { class: 'ex-chip mute' }, t('ex.cp.statusAbsent'))
    : pctv == null ? h('span', { class: 'ex-dash' }, t('common.dash')) : h('span', { class: `ex-evo ${pctv >= 0 ? 'up' : 'down'}` }, icon(pctv >= 0 ? 'up' : 'down', 12), exPct(pctv));
  return h('div', { class: 'ex-cp-row' },
    h('div', { class: 'ex-cp-name' }, dot ? h('i', { class: `nc-dot ${dot}` }) : null, h('span', null, name)),
    h('div', { class: 'ex-cp-vals' }, h('span', null, `${exMoney(prev, currency)} → ${exMoney(cur, currency)}`), extra ? h('em', null, extra) : null),
    h('div', { class: 'ex-cp-delta' }, h('strong', { class: delta === 0 ? '' : up ? 'up' : 'down' }, exSignedFull(Math.round(delta), currency)), evo));
}

function exCpChannelsCard(d) {
  const cv = d.channels_view; const cls = exChCls(cv);
  const rows = cv.channels.filter((r) => r.net_sales_ex_tax > 0 || (r.previous && r.previous.net_sales_ex_tax > 0)); let body;
  if (!rows.length || !rows.some((r) => r.previous)) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.cp.noPrevious'));
  else body = h('div', { class: 'ex-cp-list' }, rows.map((r) => {
    const prev = r.previous ? r.previous.net_sales_ex_tax : 0; const dl = r.net_sales_ex_tax - prev;
    return exCpRow({ dot: cls.get(r.name), name: exChannelName(r.name), prev, cur: r.net_sales_ex_tax, delta: dl, pctv: r.delta ? r.delta.net_sales_ex_tax_pct : null, status: r.status === 'new' ? 'new' : r.status === 'absent' ? 'absent' : null,
      extra: cv.total_delta ? t('ex.cp.shareOfChange', exShare(dl / cv.total_delta)) : null }, d.currency);
  }));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.cp.channelsTitle'))), body);
}

function exCpCategoriesCard(d) {
  const cats = d.comparison_view.categories; let body;
  if (!cats.length) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.cp.noPrevious'));
  else body = h('div', { class: 'ex-cp-list' }, cats.map((c) => exCpRow({ name: exCpCatName(c.name), prev: c.previous, cur: c.current, delta: c.delta, pctv: c.delta_pct, status: c.status === 'new' ? 'new' : c.status === 'absent' ? 'absent' : null }, d.currency)));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.cp.categoriesTitle'))), body);
}

const exCpTrend = (pctv) => (pctv == null ? null : pctv > 0 ? 'up' : pctv < 0 ? 'down' : 'flat');
function exCpVolumeCard(d) {
  const dl = d.kpis.delta; let body;
  if (!dl || (dl.order_count_pct == null && dl.aov_ex_tax_pct == null)) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.cp.noPrevious'));
  else {
    const o = exCpTrend(dl.order_count_pct); const a = exCpTrend(dl.aov_ex_tax_pct);
    const line = (key, v) => h('div', { class: 'ex-cp-vol' }, h('span', null, t(key, v == null ? t('ex.cp.unavailable') : exPct(v))));
    body = h('div', null, line('ex.cp.ordersLine', dl.order_count_pct), line('ex.cp.aovLine', dl.aov_ex_tax_pct),
      o && a ? h('div', { class: 'ex-foot' }, t('ex.cp.volumeSentence', t(`ex.cp.${o}`), t(`ex.cp.${a}`))) : null);
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.cp.volumeTitle'))), body);
}

function exCpCustomersCard(d) {
  const k = d.customers && d.customers.kpis; const cov = d.customers && d.customers.coverage; const q = d.comparison_view.checks.find((c) => c.id === 'customer_coverage'); let body;
  if (!k || !k.previous) body = NordlaCharts.insufficient(t('ex.insufficient'), t('ex.cp.noPrevious'));
  else {
    const row = (label, c, p, f = String) => h('div', { class: 'ex-stat' }, h('span', null, label), h('strong', null, p == null ? f(c) : `${f(p)} → ${f(c)}`));
    body = h('div', null, h('div', { class: 'ex-stats' },
      row(t('ex.cp.custActive'), k.active, k.previous.active), row(t('ex.cp.custRevenue'), k.identified_net_sales_ex_tax, k.previous.identified_net_sales_ex_tax, (v) => exMoney(v, d.currency)),
      row(t('ex.cp.custNew'), k.new, k.previous.new), row(t('ex.cp.custReturning'), k.returning, k.previous.returning)),
    cov && cov.identified_share != null && cov.previous_identified_share != null ? h('div', { class: 'ex-foot strong' }, t('ex.cp.coverage', exShare(cov.identified_share), exShare(cov.previous_identified_share))) : null,
    h('div', { class: 'ex-foot' }, q && q.gap != null ? (Math.round(q.current * 100) !== Math.round(q.previous * 100) ? t('ex.cp.coverageWarn') : t('ex.cp.coverageOk')) : t('ex.cp.q.coverageUnknown')));
  }
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.cp.customersTitle'))), body);
}

function exCpWatchCard(d, kind) {
  const rows = d.products[kind] || [];
  const m = rows.length ? rows.reduce((b, r) => (kind === 'growth' ? (r.delta > b.delta ? r : b) : (r.delta < b.delta ? r : b))) : null;
  const title = t(kind === 'growth' ? 'ex.cp.watchUp' : 'ex.cp.watchDown');
  if (!m || (kind === 'growth' ? m.delta <= 0 : m.delta >= 0)) return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, title)), NordlaCharts.insufficient(t('ex.insufficient'), t('ex.cp.noMove')));
  const isNew = m.previous_net_sales_ex_tax === 0; const gone = m.net_sales_ex_tax === 0;
  return h('div', { class: 'ex-card ex-day' },
    rankThumb({ imageUrl: m.image_url, title: exProdTitle(m) }),
    h('div', { class: 'ex-kpi-body' },
      h('div', { class: 'ex-kpi-label' }, title),
      h('div', { class: 'ex-day-date' }, exProdTitle(m)),
      h('div', { class: 'ex-day-figs' }, h('strong', { class: m.delta >= 0 ? 'up' : 'down' }, exSignedFull(Math.round(m.delta), d.currency)),
        isNew ? h('span', { class: 'ex-chip' }, t('ex.cp.statusNew')) : gone ? h('span', { class: 'ex-chip mute' }, t('ex.cp.statusAbsent')) : m.delta_pct == null ? null : h('span', null, exPct(m.delta_pct))),
      h('div', { class: 'ex-kpi-note' }, `${exMoney(m.previous_net_sales_ex_tax, d.currency)} → ${exMoney(m.net_sales_ex_tax, d.currency)} · ${t('ex.cp.watchNote')}`)));
}

function exCpMostCard(d) {
  const cv = d.comparison_view; const k = cv.kpis; const cur = d.currency; const lines = [];
  const rev = k.find((x) => x.key === 'net_sales_ex_tax'); const ord = k.find((x) => x.key === 'order_count'); const aov = k.find((x) => x.key === 'aov_ex_tax');
  const pctTxt = (x) => (x.delta_pct == null ? '' : ` (${exPct(x.delta_pct)})`);
  if (rev.delta_abs != null) lines.push(t('ex.cp.mostRevenue', `${exSignedFull(rev.delta_abs, cur).replace(/^([+−])(\d)/, '$1$2')}${pctTxt(rev)}`));
  if (ord.delta_abs != null) lines.push(t('ex.cp.mostOrders', `${ord.delta_abs > 0 ? '+' : ord.delta_abs < 0 ? '−' : ''}${Math.abs(ord.delta_abs)}${pctTxt(ord)}`));
  if (aov.delta_abs != null) lines.push(t('ex.cp.mostAov', `${aov.delta_abs > 0 ? '+' : aov.delta_abs < 0 ? '−' : ''}${exMoney2(Math.abs(aov.delta_abs), cur)}${pctTxt(aov)}`));
  const c = d.contributions; const topP = c && [...c.positive, ...c.negative].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  if (topP) lines.push(t('ex.cp.mostProduct', topP.title, exSignedFull(Math.round(topP.delta), cur)));
  const chs = d.channels_view.channels.filter((r) => r.previous).map((r) => ({ r, dl: r.net_sales_ex_tax - r.previous.net_sales_ex_tax }));
  const nc = d.channels_view.channels.map((r) => ({ r, dl: r.net_sales_ex_tax - (r.previous ? r.previous.net_sales_ex_tax : 0) })).sort((a, b) => Math.abs(b.dl) - Math.abs(a.dl))[0];
  if (nc && chs.length && nc.dl !== 0) lines.push(t('ex.cp.mostChannel', exChannelName(nc.r.name), exSignedFull(Math.round(nc.dl), cur)));
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.cp.mostTitle'))),
    lines.length ? h('ul', { class: 'ex-facts' }, lines.map((l) => h('li', null, l))) : NordlaCharts.insufficient(t('ex.insufficient'), t('ex.cp.noPrevious')));
}

function exCpQualityCard(d) {
  const ck = d.comparison_view.checks;
  const detail = (c) => (c.id === 'days' ? t('ex.cp.q.daysDetail', c.current, c.previous)
    : c.id === 'last_block' ? (c.days != null && c.days < 7 ? t('ex.cp.q.lastBlockPartial', c.days, c.days) : t('ex.cp.q.lastBlockFull'))
    : c.id === 'customer_coverage' ? (c.gap == null ? t('ex.cp.q.coverageUnknown') : t('ex.cp.coverage', exShare(c.current), exShare(c.previous)))
    : c.id === 'categories' ? t('ex.cp.q.categoriesDetail', exShare(c.uncategorised_share))
    : t('ex.cp.q.costsDetail', exShare(c.cost_coverage ?? 0), exShare(c.verified_cost_coverage ?? 0)));
  const chipCls = { comparable: 'ex-chip', caution: 'ex-chip caut', partial: 'ex-chip mute' };
  return h('div', { class: 'ex-card' }, h('div', { class: 'ex-card-head' }, h('h3', null, t('ex.cp.qualityTitle'))),
    h('div', { class: 'ex-cp-list' }, ck.map((c) => h('div', { class: 'ex-cp-q' },
      h('div', null, h('strong', null, t(`ex.cp.q.${c.id}`)), h('div', { class: 'ex-foot' }, detail(c))),
      h('span', { class: chipCls[c.status] }, t(`ex.cp.q.${c.status}`))))),
    h('div', { class: 'ex-foot' }, t('ex.cp.qualityNote')));
}

function renderComparisonTab(main, d) {
  const cv = d.comparison_view;
  if (!cv) { main.appendChild(h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('ex.insufficient'), t('ex.cp.noPrevious')))); return; }
  main.appendChild(exCpPeriods(cv));
  main.appendChild(exCpKpiRow(d));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exCpBlocksCard(d), exCpTrendCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exCpWaterfallCard(d), exContributionCard(d, t('ex.cp.productsTitle'))));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exCpChannelsCard(d), exCpCategoriesCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exCpVolumeCard(d), exCpCustomersCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exCpWatchCard(d, 'growth'), exCpWatchCard(d, 'decline')));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exCpMostCard(d), exCpQualityCard(d)));
}

function exExportComparison(d) {
  const cv = d.comparison_view; const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`; const lines = [['section', 'label', 'current', 'previous', 'change', 'change_pct', 'note'].map(q).join(',')];
  const row = (...c) => lines.push(c.map(q).join(','));
  row('period', 'current', cv.periods.current.start, cv.periods.current.end, cv.periods.current.days, '', '');
  row('period', 'previous', cv.periods.previous.start, cv.periods.previous.end, cv.periods.previous.days, '', '');
  for (const k of cv.kpis) row('kpi', k.key, k.current, k.previous, k.delta_abs, k.delta_pct, '');
  for (const b of cv.blocks || []) row('block', `${b.start_date}..${b.end_date}`, b.current, b.previous, '', '', `previous ${b.previous_start_date}..${b.previous_end_date}${b.partial ? ` partial(${b.days} days)` : ''}`);
  for (const a of cv.aligned_days || []) row('aligned_day', a.index, a.current, a.previous, '', '', `${a.date} vs ${a.previous_date}`);
  if (cv.waterfall) for (const s of cv.waterfall.steps) row('waterfall_category', s.other ? `other(${s.count})` : s.name ?? t('ex.uncategorised'), '', '', s.delta, '', '');
  const c = d.contributions; if (c) for (const m of [...c.positive, ...c.negative]) row('product_contribution', m.title, '', '', m.delta, '', '');
  for (const r of d.channels_view.channels) row('channel', r.name ?? '', r.net_sales_ex_tax, r.previous ? r.previous.net_sales_ex_tax : '', r.delta ? r.delta.net_sales_ex_tax : '', r.delta ? r.delta.net_sales_ex_tax_pct : '', r.status);
  for (const r of cv.categories) row('category', r.name ?? t('ex.uncategorised'), r.current, r.previous, r.delta, r.delta_pct, r.status);
  const kc = d.customers && d.customers.kpis; const cov = d.customers && d.customers.coverage;
  if (kc && kc.previous) { row('customers_identified_active', '', kc.active, kc.previous.active, '', '', ''); row('customers_identified_revenue', '', kc.identified_net_sales_ex_tax, kc.previous.identified_net_sales_ex_tax, '', '', ''); }
  if (cov) row('customer_identification_coverage', '', cov.identified_share, cov.previous_identified_share, '', '', 'share of orders with an identified customer');
  for (const k of cv.checks) row('quality_check', k.id, '', '', '', '', k.status);
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `explorer-comparison-${(d.generatedAt || '').slice(0, 10) || 'export'}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Factual notice shown instead of a meaningless comparison when the previous period is not fully inside the business history. */
function cmpCoverageNotice(cov) {
  if (!cov || cov.sufficient) return null;
  return h('div', { class: 'ex-card ex-cov-notice', role: 'note' },
    h('strong', null, t('cmp.insufficientHistory')), ' ',
    h('span', { class: 'ex-foot' }, t('cmp.insufficientDetail', cov.previous_days_with_history, cov.previous_days, cov.history_start)));
}

/** Money movements of the period from the same deterministic aggregate: discounts, product refunds and product VAT (shipping has its own note). */
function exMoneyNote(d) {
  const k = d.kpis; if (!k || k.discounts == null) return null;
  return h('div', { class: 'ex-foot ex-money-note' }, t('ex.money.note', exMoney(k.discounts, d.currency), exMoney(k.refunds, d.currency), exMoney(k.tax, d.currency)));
}

/** Shipping, kept apart from the product KPIs on purpose; only shown when the source reported some. */
function exShippingNote(d) {
  const sh = d.kpis && d.kpis.shipping;
  if (!sh || (!sh.orders_with_shipping && !sh.refunds_incl_tax)) return null;
  return h('div', { class: 'ex-foot ex-ship-note' },
    t('ex.ship.note', exMoney(sh.net_ex_tax_after_refunds, d.currency), exMoney(d.kpis.total_net_sales_ex_tax_with_shipping, d.currency)),
    sh.coverage === 'PARTIAL' ? ' ' + t('ex.ship.partial', sh.orders_without_shipping_data) : '');
}

function renderExplorerPage(main) {
  main.appendChild(topbar(cachedExplorer, () => route(), { periodPicker: () => route() }));
  const d = cachedExplorer;
  main.appendChild(h('div', { class: 'ex-head' },
    h('div', null, h('h1', { class: 'ex-title' }, t('ex.title')), h('p', { class: 'ex-sub' }, t('ex.subtitle'))),
    h('button', { class: 'ex-export', type: 'button', disabled: d && d.available ? null : 'disabled', on: { click: () => { if (d && d.available) { if (exActiveTab() === 'comparison' && d.comparison_view) exExportComparison(d); else exExport(d); } } } }, svg(['M12 4v10', 'M8 10l4 4 4-4', 'M5 19h14'], 15), t('ex.export'))));
  main.appendChild(exTabs());
  if (!d || !d.available) { main.appendChild(h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('ex.insufficient'), d && d.periodError ? t(periodErrorKey(d.periodError)) : t('ex.noReport')))); return; }
  { const rl = periodRangeLine(d); if (rl) main.appendChild(rl); }
  { const n = cmpCoverageNotice(d.comparison_coverage); if (n) main.appendChild(n); }
  if (d.kpis && d.kpis.order_count === 0) main.appendChild(h('div', { class: 'ex-card ex-empty-period', role: 'status' }, t('period.empty')));
  if (exActiveTab() === 'sales') { renderSalesTab(main, d); return; }
  if (exActiveTab() === 'products') { renderProductsTab(main, d); return; }
  if (exActiveTab() === 'customers') { renderCustomersTab(main, d); return; }
  if (exActiveTab() === 'channels') { renderChannelsTab(main, d); return; }
  if (exActiveTab() === 'zones') { renderZonesTab(main, d); return; }
  if (exActiveTab() === 'period') { renderPeriodTab(main, d); return; }
  if (exActiveTab() === 'comparison') { renderComparisonTab(main, d); return; }
  main.appendChild(exKpiRow(d));
  { const n = exMoneyNote(d); if (n) main.appendChild(n); }
  { const n = exShippingNote(d); if (n) main.appendChild(n); }
  main.appendChild(h('div', { class: 'ex-grid-2' }, exSalesCard(d), exCategoryCard(d)));
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, exTopProducts(d), exTopCustomers(d)));
}
