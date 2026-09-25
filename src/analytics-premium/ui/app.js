'use strict';
// Nordla AI - Analytics Premium - Brief page only (Step 1). Plain DOM, no framework, no dependency,
// matching the convention already used by the Finance module's UI.
// All display copy goes through NORDLA_I18N.t(key, ...args) - see i18n.js + lang-fr/nl/en.js. Never
// hardcode UI text here: add the key to all three dictionaries instead.

const t = NORDLA_I18N.t;

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'on' && v) for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const svg = (paths, size = 16) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  paths.forEach((d) => { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.appendChild(p); });
  return s;
};
const ICONS = {
  brief: ['M4 4h16v16H4z', 'M9 9h6M9 13h6M9 17h3'],
  changed: ['M4 18V6M4 6l4 4M10 6v12M16 6v12M16 6l4 4'],
  explore: ['M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0', 'M14.5 9.5l-2 5-5 2 2-5z'],
  customers: ['M17 20a5 5 0 0 0-10 0', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  products: ['M4 8l8-4 8 4-8 4-8-4z', 'M4 8v8l8 4 8-4V8', 'M12 12v8'],
  spark: ['M5 12l4-6 4 3 4-8 2 5'],
  check: ['M20 6L9 17l-5-5'],
  clock: ['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 7v5l3 3'],
  up: ['M7 17L17 7', 'M9 7h8v8'],
  down: ['M7 7L17 17', 'M9 17h8v-8'],
  info: ['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 11v5.5', 'M12 8.2v.1'],
  group: ['M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8', 'M23 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  chevronDown: ['M6 9l6 6 6-6'],
};
/** Small filled-dot vertical "more" icon - the shared icon() helper draws stroke-only outline icons,
 * which doesn't work for solid dots, so this builds its own tiny SVG instead. */
function dotsIcon(size = 14) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 4 16'); s.setAttribute('width', size * 0.25); s.setAttribute('height', size);
  for (const cy of [2, 8, 14]) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', '2'); c.setAttribute('cy', String(cy)); c.setAttribute('r', '1.6'); c.setAttribute('fill', 'currentColor');
    s.appendChild(c);
  }
  return s;
}
const icon = (name, size) => svg(ICONS[name] || ICONS.spark, size);

const fmtMoney = (v, cur) => (v == null ? t('common.dash') : `€ ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`.replace('€', cur === 'EUR' ? '€' : cur || ''));
const fmtPct = (v) => (v == null ? t('common.dash') : `${(v * 100).toFixed(1)}%`);
const fmtAgo = (iso) => {
  if (!iso) return t('common.dash');
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return t('time.justNow');
  if (mins < 60) return t('time.minAgo', mins);
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t('time.hAgo', hrs);
  return t('time.dAgo', Math.round(hrs / 24));
};
const greeting = () => { const h = new Date().getHours(); return h < 12 ? t('greeting.morning') : h < 18 ? t('greeting.afternoon') : t('greeting.evening'); };

/** Real daily sparkline (no fabricated/interpolated points - null days, e.g. no orders so no margin
 * ratio, are simply skipped rather than drawn as zero). Trend color (up/down) is derived from the
 * real first-vs-last known value, never an arbitrary/decorative color. */
// Real daily points only: a null day (e.g. no orders, so no AOV/margin that day) is skipped, never
// drawn as zero or interpolated. There is no real period-over-period comparison in this data yet
// (a real comparison exists in the report, but the sparkline itself is a single-period line), so it is never colored
// green/red - a same-period first-vs-last read is not a measured comparison and would misrepresent
// noise as a verdict. It always renders in the neutral Nordla chart color (muted slate) until a real
// previous-period series exists to compare against.
const MIN_SPARKLINE_POINTS = 2;
// Nordla Chart System (shared/nordla-charts.js). Every chart below only draws real daily values; a null day is skipped.
const LANG_TAG = { fr: 'fr-BE', nl: 'nl-BE', en: 'en-GB' };
const chartTag = () => LANG_TAG[NORDLA_I18N.getLang()] || 'en-GB';
const fmtCompactMoney = (v, cur) => new Intl.NumberFormat(chartTag(), { style: 'currency', currency: cur || 'EUR', notation: 'compact', maximumFractionDigits: 1 }).format(v);
const fmtDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(chartTag(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
/** Real [value, date] points only (nulls skipped, never drawn as zero or interpolated); null when fewer than 2 remain. */
function realPoints(values, dates) {
  const pts = values.map((v, i) => ({ value: v, date: dates ? dates[i] : null })).filter((p) => p.value != null);
  return pts.length >= MIN_SPARKLINE_POINTS ? pts : null;
}
/** 01 KPI Sparkline. */
function sparkline(values) {
  const pts = realPoints(values);
  return pts ? NordlaCharts.sparkline(pts.map((p) => p.value)) : null;
}
/** 02 Trend Line (real dated series). Returns null when there are not enough real points. */
function trendChart(values, dates, opts = {}) {
  const pts = realPoints(values, dates);
  if (!pts || !dates) return null;
  return NordlaCharts.trendLine(pts.map((p) => ({ label: fmtDay(p.date), value: p.value })), { format: opts.format, height: opts.height || 190, label: opts.label });
}

function kpiCard(label, value, note, series, detail) {
  const chart = series ? sparkline(series) : null;
  const insufficientData = series && !chart;
  return h('div', { class: 'kpi-card' },
    h('div', { class: 'kpi-label' }, label, h('span', { class: 'kpi-info', title: t('kpi.infoTitle') }, 'i')),
    h('div', { class: 'kpi-value' }, value),
    h('div', { class: 'kpi-delta-row' }, h('span', { class: 'kpi-period' }, t('kpi.thisPeriod')), note ? h('span', { class: 'kpi-note' }, note) : null),
    detail ? h('div', { class: 'kpi-cost-detail' }, detail) : null,
    chart ? h('div', { class: 'kpi-spark' }, chart) : null,
    insufficientData ? h('div', { class: 'kpi-spark-empty' }, t('kpi.insufficientHistory')) : null);
}

// Real product thumbnail (Shopify featuredImage) when the product has one; otherwise the same
// neutral swatch as before. Never another product's image or a stock photo as a stand-in.
function rankThumb(p) {
  if (!p.imageUrl) return h('div', { class: 'rank-thumb' });
  // If the real URL fails to load (e.g. gone since the report was generated), fall back to the
  // neutral swatch rather than showing a broken-image icon - never substitute another image.
  const img = h('img', { class: 'rank-thumb-img', src: p.imageUrl, alt: p.title, loading: 'lazy', on: { error: () => img.replaceWith(h('div', { class: 'rank-thumb' })) } });
  return img;
}

function rankRow(p, cur, maxValue, shareOfTop) {
  const pct = maxValue ? Math.max(4, Math.round((p.netSalesExTax / maxValue) * 100)) : 0;
  return h('div', { class: 'rank-row' },
    rankThumb(p),
    h('div', { class: 'rank-main' },
      h('div', { class: 'rank-name-row' }, h('span', { class: 'rank-name' }, p.title), h('span', { class: 'rank-share' }, `${shareOfTop}%`)),
      h('div', { class: 'rank-bar-track' }, h('div', { class: 'rank-bar-fill', style: `width:${pct}%` }))),
    h('div', { class: 'rank-value' }, h('strong', null, fmtMoney(p.netSalesExTax, cur)), h('div', { class: 'empty-note', style: 'margin-top:3px' }, t('insight.units', p.unitsSold))));
}

// route key -> [icon, nav label key, href]. Only 'brief' and 'changed' are real pages so far;
// the rest stay inert (no href) rather than link to a page that doesn't exist yet.
// [route key, official Nordla icon name, label key, href]
const NAV_ITEMS = [
  ['brief', 'resume', 'nav.brief', '#/'],
  ['changed', 'ceQuiAChange', 'nav.changed', '#/what-changed'],
  ['explore', 'explorer', 'nav.explore', '#/explorer'],
  ['customers', 'clients', 'nav.customers', null],
  ['products', 'produits', 'nav.products', null],
];
function sidebar(activeRoute) {
  return h('div', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }), h('div', { class: 'brand-name' }, t('brand.name'))),
    h('div', { class: 'nav' }, NAV_ITEMS.map(([route, ic, key, href]) => (href
      ? h('a', { class: `nav-item ${activeRoute === route ? 'active' : ''}`, href }, h('span', { class: 'ico' }, NordlaIcon.semantic(ic, 'md')), t(key))
      : h('span', { class: 'nav-item inert' }, h('span', { class: 'ico' }, NordlaIcon.semantic(ic, 'md')), t(key))))),
    h('div', { class: 'sidebar-foot' },
      h('span', { class: 'ico' }, NordlaIcon.parle('onTerracotta', 'md')),
      h('div', null, h('strong', null, t('nav.askNordla')), h('span', null, t('sidebar.askSubtitle')))));
}

// Same pattern as the Finance module's langSwitch(): a small FR/NL/EN segmented control that calls
// I18N.setLang() then re-renders the current view. Nordla has one page today, so "re-render" means
// rebuilding the Brief page from the already-fetched brief data - no re-fetch, no full reload.
function langSwitch(onChange) {
  const NAMES = { fr: 'Français', nl: 'Nederlands', en: 'English' };
  return h('div', { class: 'langswitch', role: 'group', 'aria-label': 'Interface language' },
    NORDLA_I18N.SUPPORTED.map((l) => h('button', { type: 'button', class: NORDLA_I18N.getLang() === l ? 'on' : '', title: NAMES[l], on: { click: () => { NORDLA_I18N.setLang(l); onChange(); } } }, l.toUpperCase())));
}

function topbar(brief, onLangChange, opts = {}) {
  return h('div', { class: 'topbar' },
    h('div', { class: 'topbar-title' }, t('topbar.title')),
    h('div', { class: 'topbar-right' },
      h('span', { class: 'sync-pill' }, h('span', { class: 'sync-dot' }), t('topbar.reportGenerated', brief ? fmtAgo(brief.generatedAt) : t('common.dash'))),
      opts.periodLocked
        ? h('span', { class: 'period-pill locked', title: t('period.fixedNote'), 'aria-disabled': 'true' }, NordlaIcon.semantic('calendrier', 'sm'), brief?.period ? t('period.last30Days') : t('common.dash'), h('span', { class: 'period-fixed' }, t('period.fixed')))
        : h('span', { class: 'period-pill' }, NordlaIcon.semantic('calendrier', 'sm'), brief?.period ? t('period.last30Days') : t('common.dash'), icon('chevronDown', 13)),
      langSwitch(onLangChange),
      h('span', { class: 'avatar-group' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, svg(['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5'], 16)), icon('chevronDown', 13))));
}

function hero() {
  return h('div', { class: 'hero' },
    h('h1', null, `${greeting()}.`, h('br'), t('hero.subtitle')),
    h('button', { class: 'cta-primary', type: 'button' }, NordlaIcon.parle('onTerracotta', 'md'), t('nav.askNordla'), h('kbd', null, '⌘K')));
}

const covPct = (v) => (v == null ? t('common.dash') : `${Math.round(v * 100)} %`);
function kpiRow(brief) {
  const k = brief.kpis;
  if (!k) return h('div', { class: 'kpi-grid' }, h('div', { class: 'kpi-card' }, h('div', { class: 'empty-note' }, t('kpi.noData'))));
  const sr = brief.series;
  return h('div', { class: 'kpi-grid' },
    kpiCard(t('kpi.netRevenue'), fmtMoney(k.netRevenue.value, brief.currency), null, sr?.netRevenue),
    kpiCard(t('kpi.orders'), k.orders.value ?? t('common.dash'), null, sr?.orders),
    kpiCard(t('kpi.aov'), fmtMoney(k.aov.value, brief.currency), null, sr?.aov),
    // The margin is only shown as a plain figure when it rests on verified costs; otherwise it is flagged partial with its coverage.
    kpiCard(t('kpi.grossMargin'), fmtPct(k.grossMargin.value), k.grossMargin.costCertain ? null : t('kpi.partialCostCoverage'), sr?.grossMargin,
      k.grossMargin.costCertain ? null : t('kpi.costCoverageDetail', covPct(k.grossMargin.costCoverage), covPct(k.grossMargin.verifiedCostCoverage))));
}

function insightCard(brief) {
  const top = brief.topProducts || [];
  const max = top.length ? Math.max(...top.map((p) => p.netSalesExTax)) : 0;
  const topTotal = top.reduce((a, p) => a + p.netSalesExTax, 0);
  const left = h('div', { class: 'insight-left' },
    h('span', { class: 'insight-badge' }, NordlaIcon.semantic('meilleurProduit', 'sm'), t('insight.badge')),
    h('h2', { class: 'insight-title' }, t('insight.title')),
    h('p', { class: 'insight-sub' }, t('insight.subtitle')),
    h('p', { class: 'insight-body' }, t('insight.body')),
    h('div', { class: 'insight-actions' },
      h('button', { class: 'btn-ghost', type: 'button', disabled: 'disabled', title: t('insight.seeWhyTitle') }, t('insight.seeWhy'), icon('up', 13)),
      h('button', { class: 'btn-primary-sm', type: 'button', disabled: 'disabled', title: t('insight.commandCenterTitle') }, NordlaIcon.semantic('commandCenter', 'sm'), t('insight.addToCommandCenter'))));
  const right = h('div', { class: 'insight-right' },
    h('div', { class: 'rank-title' }, h('span', null, t('insight.rankTitle')), h('span', null, brief.currency)),
    top.length ? top.map((p) => rankRow(p, brief.currency, max, topTotal ? Math.round((p.netSalesExTax / topTotal) * 100) : 0)) : h('div', { class: 'empty-note' }, t('insight.noProducts')),
    top.length ? h('div', { class: 'rank-note' }, t('insight.shareNote', top.length, fmtMoney(topTotal, brief.currency))) : null);
  return h('div', { class: 'insight-card' }, left, right);
}

function watchSection(brief) {
  // AOV card: reuses the same real daily AOV series already computed for the AOV KPI card above -
  // not a second/fabricated chart. Omitted entirely (never a blank box) if unavailable.
  // Dormant-customers card: deliberately has no chart - there is no real dormant-customer time
  // series to plot (see brief.missingCapabilities: DORMANT_CUSTOMER_METRIC). Drawing bars here would
  // fabricate data the product doesn't have.
  const aovSeries = brief?.series?.aov;
  const aovChart = aovSeries ? trendChart(aovSeries, brief.series.dates, { format: (v) => fmtCompactMoney(v, brief.currency), height: 120, label: t('kpi.aov') }) : null;
  return h('div', null,
    h('h3', { class: 'section-heading' }, t('watch.heading')),
    h('div', { class: 'watch-grid' },
      h('div', { class: 'watch-card' },
        h('span', { class: 'watch-ico ok' }, icon('up', 16)),
        h('div', { class: 'watch-body' }, h('div', { class: 'watch-title' }, t('watch.aovTitle')), h('div', { class: 'watch-text' }, brief.aovComparison ? t('watch.aovCompared', fmtMoney(brief.aovComparison.value, brief.currency), fmtMoney(brief.aovComparison.previous, brief.currency), fmtSignedPct(brief.aovComparison.pct)) : t('watch.aovText'))),
        aovChart ? h('div', { class: 'watch-spark' }, aovChart) : null),
      h('div', { class: 'watch-card' },
        h('span', { class: 'watch-ico warn' }, NordlaIcon.semantic('clientDormant', 'lg')),
        h('div', { class: 'watch-body' }, h('div', { class: 'watch-title' }, t('watch.dormantTitle')), h('div', { class: 'watch-text' }, t('watch.dormantText'))))));
}

function healthCard(brief) {
  return h('div', { class: 'health-card' },
    h('div', { class: 'health-left' },
      h('span', { class: 'health-ico' }, NordlaIcon.semantic('dataHealth', 'lg')),
      h('div', null, h('div', { class: 'health-title' }, t('health.title')), h('div', { class: 'health-value' }, t('health.upToDate'))),
    ),
    h('div', { class: 'health-right' },
      h('div', { class: 'health-sync' }, t('health.lastGenerated'), h('br'), brief.generatedAt ? fmtAgo(brief.generatedAt) : t('common.dash')),
      h('button', { class: 'btn-outline', type: 'button' }, NordlaIcon.semantic('dataHealth', 'sm'), t('health.viewSources'))));
}

// ---------- "Ce qui a changé" (What Changed) page - Step 2 ----------
const joinNatural = (items) => (items.length <= 1 ? (items[0] ?? '') : items.length === 2 ? `${items[0]} ${t('common.and')} ${items[1]}` : `${items.slice(0, -1).join(', ')} ${t('common.and')} ${items[items.length - 1]}`);
const fmtSignedPct = (v) => (v == null ? null : `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`);
const dirSuffix = (d) => (d === 'up' ? 'Up' : d === 'down' ? 'Down' : 'Flat');

function wcHero() {
  return h('div', { class: 'hero wc-hero' },
    h('div', null, h('h1', null, t('wc.title')), h('p', { class: 'hero-subtitle' }, t('wc.subtitle'))),
    h('button', { class: 'cta-primary', type: 'button' }, NordlaIcon.parle('onTerracotta', 'md'), t('nav.askNordla'), h('kbd', null, '⌘K')));
}

/** The main "what changed" insight: real period-over-period comparison (last 30 days vs the
 * immediately preceding 30 days) - see src/report/build.js's comparison/biggest_decline/
 * biggest_growth fields, both built from previousEquivalentWindow() + computeSalesMetrics(), the
 * same pure functions used everywhere else. Direction (up/down/flat) is read from the real sign of
 * the delta, never assumed - a real increase renders as "good performance", never forced into a
 * decline narrative. */
function wcInsightCard(data) {
  if (!data.comparisonAvailable || !data.insight) {
    return h('div', { class: 'insight-card' }, h('div', { class: 'insight-left', style: 'grid-column:1/-1' }, h('h2', { class: 'insight-title' }, t('wc.noComparison'))));
  }
  const ins = data.insight;
  const dir = dirSuffix(ins.direction);
  const deltaMoney = fmtMoney(ins.deltaAbs, data.currency);
  const contributors = ins.contributors ?? [];
  // Reconciled statement in euros only: top gainers and top losers offset each other, so no share of the net change is claimed.
  const parts = [];
  if (ins.gains?.count) parts.push(t('wc.gainsLine', ins.gains.count, fmtMoney(ins.gains.total, data.currency)));
  if (ins.losses?.count) parts.push(t('wc.lossesLine', ins.losses.count, fmtMoney(ins.losses.total, data.currency)));
  if (parts.length) parts.push(t('wc.netLine', `${ins.direction === 'down' ? '−' : '+'}${deltaMoney}`));
  const shareLine = ins.direction === 'flat' ? null : (parts.length ? parts.join(' ') : t('wc.noContributors'));
  const left = h('div', { class: 'insight-left' },
    h('span', { class: `insight-badge ${ins.direction === 'down' ? 'bad' : ins.direction === 'up' ? 'good' : ''}` }, icon(ins.direction === 'down' ? 'down' : 'up', 13), t(`wc.badge${dir}`)),
    h('h2', { class: 'insight-title' }, t(`wc.headline${dir}`, deltaMoney)),
    shareLine ? h('p', { class: 'insight-sub' }, shareLine) : null,
    h('p', { class: 'insight-body' }, t('wc.bodyText', ins.previousWindow.localStart, ins.previousWindow.localEnd, fmtMoney(ins.previousNetRevenue, data.currency), fmtMoney(ins.netRevenue, data.currency))),
    h('div', { class: 'insight-actions' },
      h('button', { class: 'btn-ghost', type: 'button', disabled: 'disabled', title: t('insight.seeWhyTitle') }, t('insight.seeWhy'), icon('up', 13)),
      h('button', { class: 'btn-primary-sm', type: 'button', disabled: 'disabled', title: t('insight.commandCenterTitle') }, NordlaIcon.semantic('commandCenter', 'sm'), t('insight.addToCommandCenter')),
      h('button', { class: 'btn-text', type: 'button', disabled: 'disabled', title: t('wc.dismissTitle') }, icon('down', 13), t('wc.dismiss'))));
  const deltaPct = ins.deltaPct == null ? null : Math.round(ins.deltaPct * 1000) / 10;
  const chart = trendChart(ins.series, data.insight.seriesDates, { format: (v) => fmtCompactMoney(v, data.currency), label: t('kpi.netRevenue') });
  const right = h('div', { class: 'insight-right' },
    h('div', { class: 'wc-metric-block' },
      NordlaCharts.head({ title: t('kpi.netRevenue'), value: fmtMoney(ins.netRevenue, data.currency), delta: deltaPct, good: ins.direction === 'flat' ? undefined : ins.direction === 'up', vs: t('wc.vsPreviousPeriod') }),
      chart ? h('div', { class: 'wc-area-chart' }, chart) : null),
    h('div', { class: 'rank-title' }, h('span', null, t('wc.contributorsTitle')), h('span', null, data.currency)),
    contributors.length ? NordlaCharts.contributionBars(contributors.map((m) => ({ label: m.title, value: m.delta })), { format: (v) => fmtCompactMoney(v, data.currency) }) : h('div', { class: 'empty-note' }, t('insight.noProducts')),
    h('div', { class: 'insight-confidence' }, NordlaIcon.semantic('dataHealth', 'sm'), t('wc.dataReliable')));
  return h('div', { class: 'insight-card' }, left, right);
}

function watchPill(kind) {
  return h('span', { class: `wc-pill ${kind}` }, t(kind === 'partial' ? 'wc.partialDataLabel' : 'wc.watchlistLabel'));
}

function wcWatchSection(data) {
  const cards = [];
  for (const w of data.watch ?? []) {
    if (w.kind === 'aov') {
      const dir = w.pct >= 0 ? 'up' : 'down';
      const chart = data.aovSeries ? trendChart(data.aovSeries, data.seriesDates, { format: (v) => fmtCompactMoney(v, w.currency), height: 120, label: t('kpi.aov') }) : null;
      cards.push(h('div', { class: 'watch-card wc-watch-card' },
        h('div', { class: 'wc-watch-top' }, h('span', { class: `watch-ico ${dir === 'up' ? 'ok' : 'bad'}` }, icon(dir, 16)), h('div', { class: 'wc-watch-top-right' }, watchPill('watchlist'), h('button', { class: 'wc-watch-menu', type: 'button', disabled: 'disabled', title: t('wc.dismissTitle') }, dotsIcon(14)))),
        h('div', { class: 'watch-body' },
          h('div', { class: 'watch-title' }, t(dir === 'up' ? 'wc.watchAovUp' : 'wc.watchAovDown', Math.abs(Math.round(w.pct * 100)))),
          h('div', { class: 'watch-text' }, t('wc.watchAovDetail', fmtMoney(w.previousValue, w.currency), fmtMoney(w.value, w.currency)))),
        NordlaCharts.head({ title: t('kpi.aov'), value: fmtMoney(w.value, w.currency), delta: Math.round(w.pct * 1000) / 10, good: dir === 'up', vs: t('wc.vsPreviousPeriod'), small: true }),
        chart ? h('div', { class: 'watch-spark' }, chart) : null));
    } else if (w.kind === 'movers') {
      // Mirrors the main insight's real direction (never its own independent read) - the point of
      // this card is "which products drove the change already described above", not a second verdict.
      const dir = data.insight?.direction === 'down' ? 'down' : 'up';
      const count = dir === 'down' ? w.declineCount : w.growthCount;
      if (!count) continue;
      cards.push(h('div', { class: 'watch-card wc-watch-card' },
        h('div', { class: 'wc-watch-top' }, h('span', { class: `watch-ico ${dir === 'up' ? 'ok' : 'bad'}` }, NordlaIcon.semantic(dir === 'up' ? 'produitEnHausse' : 'produitEnBaisse', 'lg')), h('div', { class: 'wc-watch-top-right' }, watchPill('watchlist'), h('button', { class: 'wc-watch-menu', type: 'button', disabled: 'disabled', title: t('wc.dismissTitle') }, dotsIcon(14)))),
        h('div', { class: 'watch-body' }, h('div', { class: 'watch-title' }, t(dir === 'up' ? 'wc.watchMoversUp' : 'wc.watchMoversDown', count)))));
    } else if (w.kind === 'costCoverage') {
      cards.push(h('div', { class: 'watch-card wc-watch-card' },
        h('div', { class: 'wc-watch-top' }, h('span', { class: 'watch-ico warn' }, NordlaIcon.semantic('dataHealth', 'lg')), h('div', { class: 'wc-watch-top-right' }, watchPill('partial'), h('button', { class: 'wc-watch-menu', type: 'button', disabled: 'disabled', title: t('wc.dismissTitle') }, dotsIcon(14)))),
        h('div', { class: 'watch-body' },
          h('div', { class: 'watch-title' }, t('wc.watchCostCoverage', Math.round(w.pct * 100))),
          h('div', { class: 'watch-text' }, t('wc.watchCostCoverageDetail'))),
        NordlaCharts.dataQuality({ pct: w.pct * 100, label: t('wc.dqLabel') }),
        h('button', { class: 'btn-outline wc-watch-btn', type: 'button' }, NordlaIcon.semantic('dataHealth', 'sm'), t('health.viewSources'))));
    }
  }
  if (!cards.length) return null;
  return h('div', null, h('h3', { class: 'section-heading' }, t('wc.watchHeading')), h('div', { class: 'watch-grid wc-watch-grid' }, cards));
}

function otherChangeRow(c, currency) {
  if (c.kind === 'orders') {
    return h('div', { class: 'wc-row' },
      h('span', { class: `wc-row-ico ${c.delta >= 0 ? 'ok' : 'bad'}` }, icon(c.delta >= 0 ? 'up' : 'down', 14)),
      h('div', { class: 'wc-row-body' }, h('div', { class: 'wc-row-title' }, t('wc.rowOrdersTitle')), h('div', { class: 'wc-row-text' }, t('wc.rowOrdersDetail', c.value, c.previousValue))),
      h('div', { class: 'wc-row-value' }, `${c.value} vs ${c.previousValue}`, c.pct != null ? h('span', { class: `wc-row-delta ${c.delta >= 0 ? 'ok' : 'bad'}` }, fmtSignedPct(c.pct)) : null));
  }
  if (c.kind === 'grossMargin') {
    const pp = Math.round(c.deltaPp * 1000) / 10;
    // Verified costs: coloured by the sign of the change. Otherwise neutral Nordla styling and an explicit caveat.
    const tone = c.costCertain ? (c.deltaPp >= 0 ? 'ok' : 'bad') : 'neutral';
    return h('div', { class: 'wc-row' },
      h('span', { class: `wc-row-ico ${tone}` }, icon(c.deltaPp >= 0 ? 'up' : 'down', 14)),
      h('div', { class: 'wc-row-body' }, h('div', { class: 'wc-row-title' }, t('wc.rowGrossMarginTitle')),
        h('div', { class: 'wc-row-text' }, t('wc.rowGrossMarginDetail', fmtPct(c.value).replace('%', ''), fmtPct(c.previousValue).replace('%', ''))),
        c.costCertain ? null : h('div', { class: 'wc-row-caveat' }, t('wc.marginCaveat', covPct(c.costCoverage), covPct(c.verifiedCostCoverage)))),
      h('div', { class: 'wc-row-value' }, `${fmtPct(c.value)} vs ${fmtPct(c.previousValue)}`, h('span', { class: `wc-row-delta ${tone}` }, `${pp >= 0 ? '+' : ''}${pp}pp`)));
  }
  if (c.kind === 'activeProducts') {
    return h('div', { class: 'wc-row' },
      h('span', { class: `wc-row-ico ${c.delta >= 0 ? 'ok' : 'bad'}` }, icon(c.delta >= 0 ? 'up' : 'down', 14)),
      h('div', { class: 'wc-row-body' }, h('div', { class: 'wc-row-title' }, t('wc.rowActiveProductsTitle')), h('div', { class: 'wc-row-text' }, t('wc.rowActiveProductsDetail', c.value, c.previousValue))),
      h('div', { class: 'wc-row-value' }, `${c.value} vs ${c.previousValue}`, h('span', { class: `wc-row-delta ${c.delta >= 0 ? 'ok' : 'bad'}` }, `${c.delta >= 0 ? '+' : ''}${c.delta}`)));
  }
  return null;
}

function wcOtherChanges(data) {
  const rows = (data.otherChanges ?? []).map((c) => otherChangeRow(c, data.currency)).filter(Boolean);
  if (!rows.length) return null;
  const body = h('div', null, rows);
  const toggle = h('button', { class: 'wc-other-toggle', type: 'button', 'aria-expanded': 'true' }, icon('up', 14));
  toggle.addEventListener('click', () => {
    const collapsed = body.style.display === 'none';
    body.style.display = collapsed ? '' : 'none';
    toggle.setAttribute('aria-expanded', String(collapsed));
    toggle.style.transform = collapsed ? '' : 'rotate(180deg)';
  });
  return h('div', { class: 'card wc-other-changes' },
    h('div', { class: 'wc-other-heading' }, h('span', null, t('wc.otherChangesHeading', rows.length)), toggle),
    body);
}

let cachedWhatChanged = null;
async function loadWhatChangedIfNeeded() {
  if (cachedWhatChanged) return;
  try {
    const res = await fetch('/api/what-changed');
    if (res.ok) cachedWhatChanged = await res.json();
  } catch (e) { /* network error surfaces as the empty state below */ }
}

function renderWhatChangedPage(main) {
  main.appendChild(topbar(cachedWhatChanged, () => route()));
  main.appendChild(wcHero());
  if (!cachedWhatChanged) {
    main.appendChild(h('div', { class: 'kpi-card' }, h('div', { class: 'empty-note' }, t('app.noReport'))));
    return;
  }
  main.appendChild(wcInsightCard(cachedWhatChanged));
  const watch = wcWatchSection(cachedWhatChanged);
  if (watch) main.appendChild(watch);
  const other = wcOtherChanges(cachedWhatChanged);
  if (other) main.appendChild(other);
}

let cachedBrief = null;

/** Rebuilds the Brief page from already-fetched data - no re-fetch, no full reload. Unchanged from
 * before the router existed: same shell, same content, same behavior. */
function renderBriefPage(main) {
  main.appendChild(topbar(cachedBrief, () => route()));
  main.appendChild(hero());
  if (!cachedBrief) {
    main.appendChild(h('div', { class: 'kpi-card' }, h('div', { class: 'empty-note' }, t('app.noReport'))));
    return;
  }
  main.appendChild(kpiRow(cachedBrief));
  main.appendChild(insightCard(cachedBrief));
  main.appendChild(watchSection(cachedBrief));
  main.appendChild(healthCard(cachedBrief));
}

async function loadBriefIfNeeded() {
  if (cachedBrief) return;
  try {
    const res = await fetch('/api/brief');
    if (res.ok) cachedBrief = await res.json();
  } catch (e) { /* network error surfaces as the empty state in renderBriefPage() */ }
}

/** Minimal hash router: '#/' -> Brief, '#/what-changed' -> What Changed. Anything else falls back to
 * Brief rather than a blank page. Each page's own data is fetched once and cached; a language change
 * re-renders the current route from that cache, never re-fetching. */
const ROUTES = {
  '': { key: 'brief', load: loadBriefIfNeeded, render: renderBriefPage },
  'what-changed': { key: 'changed', load: loadWhatChangedIfNeeded, render: renderWhatChangedPage },
  explorer: { key: 'explore', load: loadExplorerIfNeeded, render: renderExplorerPage },
  'explorer/sales': { key: 'explore', load: loadExplorerIfNeeded, render: renderExplorerPage },
  'explorer/products': { key: 'explore', load: loadExplorerIfNeeded, render: renderExplorerPage },
  'explorer/customers': { key: 'explore', load: loadExplorerIfNeeded, render: renderExplorerPage },
  'explorer/channels': { key: 'explore', load: loadExplorerIfNeeded, render: renderExplorerPage },
  'explorer/zones': { key: 'explore', load: loadExplorerIfNeeded, render: renderExplorerPage },
  'explorer/period': { key: 'explore', load: loadExplorerIfNeeded, render: renderExplorerPage },
  'explorer/comparison': { key: 'explore', load: loadExplorerIfNeeded, render: renderExplorerPage },
};
async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const r = ROUTES[hash] ?? ROUTES[''];
  const app = document.getElementById('app');
  document.documentElement.lang = NORDLA_I18N.getLang();
  app.innerHTML = '';
  const main = h('div', { class: 'main' });
  app.appendChild(h('div', { class: 'shell' }, sidebar(r.key), main));
  await r.load();
  main.innerHTML = '';
  r.render(main);
}

window.addEventListener('hashchange', route);
route();
