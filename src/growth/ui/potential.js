'use strict';
// Nordla Growth - Potentiel produits page. Loaded BEFORE app.js (same pattern as opportunities.js / campaigns.js): nothing
// runs at load time; the functions below use app.js helpers (h, t, money, num, chip, cardHead, gi, kpi, render) only when
// app.js renders the page. Every figure, status, reason and filter membership comes from the payload
// (/api/growth/products = the merchant's real Nordla data, src/growth/products/potential.js); the UI only words and lays
// them out. An unknown value is shown as unknown (never 0). Layout: Analytics > Produits' list + drawer pattern (copied
// under .gr-pp-* in growth.css), Growth's KPI tiles, cards and chips.

const PP_TONE = { push: 'gr-good', restock: 'gr-warn', topSeller: 'gr-info', watch: 'gr-warn', declining: 'gr-bad', lowMargin: 'gr-bad', returns: 'gr-bad', insufficient: 'mute', stable: 'mute' };
const PP_ACTION_TONE = { increaseVisibility: 'gr-good', restockFirst: 'gr-warn', doNotPromote: 'gr-bad', reviewReturns: 'gr-warn', checkCost: 'gr-warn', checkStock: 'gr-warn', watch: 'mute', keep: 'gr-info', none: 'mute' };
const PP_SORTS = ['sales', 'evolution', 'cover', 'margin'];
let ppState = { filter: 'all', q: '', cat: 'all', sort: 'sales', sel: null };

const ppNorm = (s) => String(s || '').toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const ppPct = (v) => `${Math.round(v * 100)} %`;
const ppDays = (v) => t('gr.pp.days', num(Math.round(v)));
const ppDate = (iso) => new Date(iso).toLocaleDateString(tag(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
// Unit counts: singular / plural wording ("1 unité vendue", "2 unités vendues").
const ppSold = (n) => t(n === 1 ? 'gr.pp.unit1' : 'gr.pp.units', num(n));
const ppUnitsN = (n) => t(n === 1 ? 'gr.pp.u1' : 'gr.pp.uN', num(n));
const ppNA = (text) => h('span', { class: 'gr-pp-na' }, text);

function ppThumb(r, size) {
  const cls = `gr-pp-thumb${size ? ` ${size}` : ''}`;
  if (!r.imageUrl) return h('span', { class: cls, title: t('gr.pp.noImage') }, NordlaIcon.semantic('produits', 'sm'));
  const img = h('img', { class: cls, src: r.imageUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: cls, title: t('gr.pp.noImage') }, NordlaIcon.semantic('produits', 'sm'))));
  return img;
}

// ---------- cell wording (one place, reused by the list and the drawer) ----------
function ppEvolution(r) {
  if (r.evolution != null) return h('span', { class: `gr-pp-evo ${r.evolution > 0 ? 'up' : r.evolution < 0 ? 'down' : 'none'}` }, signedPct(r.evolution));
  if (r.trend === 'INSUFFICIENT_DATA') return ppNA(t('gr.pp.evo.insufficient'));
  return h('span', { class: `gr-pp-evo ${r.trend === 'UP' ? 'up' : r.trend === 'DOWN' ? 'down' : 'none'}` }, t(`gr.pp.trend.${r.trend}`));
}
function ppMargin(r) {
  const m = r.margin;
  if (m.tier === 'MISSING') return h('span', { class: 'gr-pp-na gr-pp-warn' }, t('gr.pp.margin.MISSING'));
  return h('span', { class: 'gr-pp-name-wrap' }, m.pct == null ? ppNA(t('gr.dash')) : h('strong', null, ppPct(m.pct)), h('span', { class: `gr-pp-sub${m.tier === 'RELIABLE' ? '' : ' gr-pp-warn'}` }, t(`gr.pp.margin.${m.tier}`)));
}
function ppStock(r) {
  if (r.stock.usable) return h('strong', null, num(r.stock.units ?? 0));
  return h('span', { class: 'gr-pp-na gr-pp-warn' }, t(r.stock.quality === 'STALE' ? 'gr.pp.stock.stale' : 'gr.pp.stock.unavailable'));
}
function ppCover(r) {
  if (r.cover.status === 'CALCULATED') return h('strong', null, ppDays(r.cover.days));
  if (r.stock.usable && (r.stock.units ?? 0) <= 0) return h('span', { class: 'gr-pp-na gr-pp-warn' }, t('gr.pp.cover.OUT'));
  return h('span', { class: 'gr-pp-na', title: t(`gr.pp.cover.${r.cover.status || 'UNKNOWN'}`) }, t('gr.dash'));
}
function ppSignal(r) {
  const s = r.signal; const th = PAGES.potential.get().thresholds;
  switch (s.code) {
    case 'newProduct': return t('gr.pp.signal.newProduct', th.minObservableWeeks);
    case 'thinSample': return t('gr.pp.signal.thinSample', ppUnitsN(s.units));
    case 'outOfStock': return t('gr.pp.signal.outOfStock');
    case 'coverDays': return t('gr.pp.signal.coverDays', num(Math.round(s.days)));
    case 'returnRate': return t('gr.pp.signal.returnRate', ppPct(s.rate));
    case 'margin': return t('gr.pp.signal.margin', ppPct(s.pct));
    case 'evolution': return t('gr.pp.signal.evolution', signedPct(s.pct), r.evidence.weeksEachSide);
    case 'topRank': return t('gr.pp.signal.topRank', s.rank);
    default: return t('gr.pp.signal.none');
  }
}
const ppStatusChip = (r) => chip(t(`gr.pp.status.${r.status}`), PP_TONE[r.status]);
const ppActionChip = (r) => chip(t(`gr.pp.action.${r.action}`), PP_ACTION_TONE[r.action]);

// ---------- KPI row: four of Growth's KPI tiles ----------
function ppKpiRow(d) {
  const k = d.kpis;
  return h('div', { class: 'ex-kpi-row gr-kpi-row gr-pp-kpis' },
    kpi('produits', t('gr.pp.kpi.active'), num(k.activeProducts), h('div', { class: 'ex-kpi-note' }, t('gr.pp.kpi.activeNote', d.window.weeks))),
    kpi('produitEnHausse', t('gr.pp.kpi.push'), num(k.push), h('div', { class: 'ex-kpi-note' }, k.push && d.totals.pushShare != null ? t('gr.pp.kpi.pushNote', ppPct(d.totals.pushShare)) : t('gr.pp.kpi.pushNone'))),
    kpi('needsAttention', t('gr.pp.kpi.watch'), num(k.watch), h('div', { class: 'ex-kpi-note' }, t('gr.pp.kpi.watchNote'))),
    kpi('stock', t('gr.pp.kpi.restock'), num(k.restock), h('div', { class: 'ex-kpi-note' }, t('gr.pp.kpi.restockNote'))));
}

// ---------- product list: pills + search + category + sort, rows (cards below 1024px) ----------
function ppRows(d) {
  const q = ppNorm(ppState.q);
  const rows = d.rows.filter((r) => r.filters.includes(ppState.filter)
    && (ppState.cat === 'all' || (ppState.cat === '' ? r.category == null : r.category === ppState.cat))
    && (!q || ppNorm(`${r.title} ${r.category || ''}`).includes(q)));
  const last = (v, dir) => (v == null ? Infinity : dir * v); // unknown values always sort last
  const by = {
    sales: null, // payload order = net sales, highest first
    evolution: (a, b) => last(a.evolution, -1) - last(b.evolution, -1),
    cover: (a, b) => last(a.cover.days, 1) - last(b.cover.days, 1),
    margin: (a, b) => last(a.margin.pct, -1) - last(b.margin.pct, -1),
  }[ppState.sort];
  return by ? rows.slice().sort(by) : rows;
}
function ppSearch() {
  const input = h('input', { class: 'gr-pp-search-input', type: 'search', placeholder: t('gr.pp.search'), 'aria-label': t('gr.pp.search'), value: ppState.q, autocomplete: 'off' });
  input.addEventListener('input', (e) => {
    ppState.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const again = document.querySelector('.gr-pp-search-input');
    if (again && again.focus) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (err) { /* type=search may refuse */ } }
  });
  return h('label', { class: 'gr-pp-search' }, NordlaIcon.semantic('recherche', 'sm'), input);
}
function ppSelect(label, value, options, onChange) {
  return h('select', { class: 'ex-select', 'aria-label': label, on: { change: (e) => onChange(e.target.value) } },
    options.map(([v, text]) => h('option', { value: v, ...(v === value ? { selected: 'selected' } : {}) }, text)));
}
function ppToolbar(d) {
  const cats = [...new Set(d.rows.map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, tag()));
  const catOptions = [['all', t('gr.pp.f.allCategories')], ...cats.map((c) => [c, c]), ...(d.rows.some((r) => r.category == null) ? [['', t('gr.pp.noCategory')]] : [])];
  return h('div', { class: 'gr-pp-toolbar' },
    h('div', { class: 'gr-pp-filters', role: 'group', 'aria-label': t('gr.pp.f.aria') }, Object.keys(d.filters).map((k) => h('button', {
      type: 'button', class: `gr-pp-filter${ppState.filter === k ? ' on' : ''}`, 'aria-pressed': ppState.filter === k ? 'true' : 'false',
      on: { click: () => { ppState.filter = k; render(); } },
    }, t(`gr.pp.f.${k}`), h('span', { class: 'gr-pp-filter-n' }, num(d.filters[k]))))),
    ppSearch(),
    h('div', { class: 'gr-pp-selects' },
      ppSelect(t('gr.pp.f.category'), ppState.cat, catOptions, (v) => { ppState.cat = v; render(); }),
      ppSelect(t('gr.pp.f.sort'), ppState.sort, PP_SORTS.map((s) => [s, t(`gr.pp.f.sort.${s}`)]), (v) => { ppState.sort = v; render(); })));
}
function ppOpen(id) { ppState.sel = id; render(); }
function ppRow(r) {
  const cell = (cls, k, ...c) => h('div', { class: `gr-pp-c ${cls}`, ...(k ? { 'data-k': k } : {}) }, ...c);
  return h('button', { type: 'button', class: `gr-pp-row${ppState.sel === r.id ? ' sel' : ''}`, 'aria-label': t('gr.pp.openDetail', r.title), on: { click: () => ppOpen(r.id) } },
    // The category sits under the name (and in the category filter) rather than in its own column: the list keeps room for
    // the decision columns next to the right-hand blocks.
    cell('gr-pp-c-name', null, ppThumb(r), h('span', { class: 'gr-pp-name-wrap' }, h('span', { class: 'gr-pp-name' }, r.title),
      h('span', { class: 'gr-pp-sub' }, `${r.category || t('gr.pp.noCategory')} · ${ppSold(r.units)}`))),
    cell('gr-pp-c-num', t('gr.pp.col.sales'), h('strong', null, money(r.netSales))),
    cell('gr-pp-c-evo', t('gr.pp.col.evolution'), ppEvolution(r)),
    cell('gr-pp-c-num', t('gr.pp.col.margin'), ppMargin(r)),
    cell('gr-pp-c-num', t('gr.pp.col.stock'), ppStock(r)),
    cell('gr-pp-c-num', t('gr.pp.col.cover'), ppCover(r)),
    cell('gr-pp-c-status', null, ppStatusChip(r), h('span', { class: 'gr-pp-signal' }, ppSignal(r))),
    cell('gr-pp-c-more', null, h('span', { class: 'gr-pp-dots', 'aria-hidden': 'true' }, opDots())));
}
function ppListCard(d) {
  const head = cardHead('produits', t('gr.pp.list.title'));
  if (!d.rows.length) {
    return h('div', { class: 'ex-card gr-pp-list' }, head, NordlaCharts.insufficient(t('gr.pp.empty.title'), t('gr.pp.empty.text', d.window.weeks)));
  }
  const rows = ppRows(d);
  const cols = ['product', 'sales', 'evolution', 'margin', 'stock', 'cover', 'status'];
  const q = d.dataQuality || {};
  return h('div', { class: 'ex-card gr-pp-list' }, head,
    h('p', { class: 'gr-card-desc' }, t('gr.pp.list.desc', d.window.weeks)),
    ppToolbar(d),
    h('div', { class: 'gr-pp-table', role: 'list' },
      h('div', { class: 'gr-pp-thead', 'aria-hidden': 'true' }, cols.map((c) => h('span', { class: ['sales', 'evolution', 'margin', 'stock', 'cover'].includes(c) ? 'num' : null }, t(`gr.pp.col.${c}`))), h('span', null)),
      rows.length ? rows.map(ppRow) : h('div', { class: 'gr-pp-empty' }, t('gr.pp.noMatch'))),
    h('div', { class: 'ex-foot' },
      t('gr.pp.list.foot', rows.length, d.rows.length),
      q.latestStockSnapshotAt ? ` · ${t('gr.pp.quality.stock', ppDate(q.latestStockSnapshotAt), q.maxStockSnapshotAgeHours)}` : ` · ${t('gr.pp.quality.noStock')}`));
}

// ---------- right column: to push / to protect / by status ----------
function ppItem(r, metric, action) {
  return h('button', { type: 'button', class: 'gr-pp-item', on: { click: () => ppOpen(r.id) } },
    ppThumb(r, 'sm'),
    h('span', { class: 'gr-pp-item-main' }, h('span', { class: 'gr-pp-name' }, r.title), h('span', { class: 'gr-pp-sub' }, ppSignal(r))),
    h('span', { class: 'gr-pp-item-side' }, metric, action));
}
function ppPushCard(d) {
  const th = d.thresholds;
  const body = d.toPush.length
    ? h('div', { class: 'gr-pp-items' }, d.toPush.map((r) => ppItem(r, h('strong', { class: 'gr-ink' }, money(r.netSales)), ppActionChip(r))))
    : h('div', { class: 'gr-pp-empty' }, t('gr.pp.push.none'), h('ul', null,
      h('li', null, t('gr.pp.push.cond.demand')), h('li', null, t('gr.pp.push.cond.cover', th.lowCoverWeeks)),
      h('li', null, t('gr.pp.push.cond.cost')), h('li', null, t('gr.pp.push.cond.returns', ppPct(th.maxRefundRateToPush)))));
  return h('div', { class: 'ex-card gr-pp-push' }, cardHead('produitEnHausse', t('gr.pp.push.title'), chip(num(d.kpis.push), d.kpis.push ? 'gr-good' : 'mute')), body,
    h('div', { class: 'ex-foot' }, t('gr.pp.push.foot')));
}
function ppProtectCard(d) {
  const body = d.toProtect.length
    ? h('div', { class: 'gr-pp-items' }, d.toProtect.map((r) => ppItem(r, ppStatusChip(r), ppActionChip(r))))
    : h('div', { class: 'gr-pp-empty' }, t('gr.pp.protect.none'));
  // No icon: the dedicated "À protéger" icon is not in the Growth pack yet (never substituted).
  return h('div', { class: 'ex-card gr-pp-protect' }, cardHead(null, t('gr.pp.protect.title'), chip(num(d.toProtect.length), d.toProtect.length ? 'gr-warn' : 'mute')), body,
    h('div', { class: 'ex-foot' }, t('gr.pp.protect.foot')));
}
function ppStatusCard(d) {
  const max = Math.max(...d.byStatus.map((s) => s.count), 1);
  return h('div', { class: 'ex-card gr-op-status' },
    cardHead('pipelineStatus', t('gr.pp.byStatus.title')),
    d.byStatus.length
      ? h('div', { class: 'ex-conc' }, d.byStatus.map((s) => h('div', { class: 'ex-conc-row wide gr-pp-status-row' },
        h('span', null, chip(t(`gr.pp.status.${s.status}`), PP_TONE[s.status])),
        h('div', { class: 'ex-bar' }, h('i', { class: s.status === 'push' ? 'first' : '', style: `width:${Math.max(4, Math.round((s.count / max) * 100))}%` })),
        h('span', { class: 'gr-status-val' }, h('strong', null, num(s.count))))))
      : h('div', { class: 'gr-pp-empty' }, t('gr.pp.empty.title')),
    h('div', { class: 'ex-foot' }, t('gr.pp.byStatus.foot', d.rows.length)));
}

// ---------- detail drawer: why this status, the evidence, the recommended action ----------
function ppWhy(r, d) {
  const th = d.thresholds; const e = r.evidence;
  switch (r.rule) {
    case 'NEW_PRODUCT': return t('gr.pp.rule.NEW_PRODUCT', e.observableWeeks, th.minObservableWeeks);
    case 'THIN_SAMPLE': return t('gr.pp.rule.THIN_SAMPLE', ppSold(r.units), th.minUnits, d.window.weeks);
    case 'DEMAND_BUT_OUT_OF_STOCK': return t('gr.pp.rule.DEMAND_BUT_OUT_OF_STOCK');
    case 'DEMAND_BUT_LOW_COVER': return t('gr.pp.rule.DEMAND_BUT_LOW_COVER', num(Math.round(r.cover.days)), th.lowCoverWeeks);
    case 'DEMAND_BUT_HIGH_RETURNS': return t('gr.pp.rule.DEMAND_BUT_HIGH_RETURNS', ppPct(r.refunds.rate));
    case 'HIGH_RETURNS': return t('gr.pp.rule.HIGH_RETURNS', ppPct(r.refunds.rate), ppPct(th.highRefunds.minRate));
    case 'LOW_RELIABLE_MARGIN': return t('gr.pp.rule.LOW_RELIABLE_MARGIN', ppPct(r.margin.pct), ppPct(th.lowMarginPct));
    case 'TREND_DOWN': return t('gr.pp.rule.TREND_DOWN', e.weeksEachSide, num(e.recentUnits), num(e.priorUnits));
    case 'RISING_DEMAND_COVERED_RELIABLE_MARGIN': return t('gr.pp.rule.PUSH', num(e.recentUnits), num(e.priorUnits), e.weeksEachSide);
    case 'RISING_DEMAND_BLOCKED': return t('gr.pp.rule.BLOCKED', num(e.recentUnits), num(e.priorUnits), e.weeksEachSide, t(`gr.pp.blocked.${r.action}`, ppPct(th.maxRefundRateToPush)));
    case 'TOP_SELLER': return t('gr.pp.rule.TOP_SELLER', r.topRank);
    default: return t('gr.pp.rule.NO_SIGNAL');
  }
}
function ppStat(label, value, note) {
  return h('div', { class: 'gr-pp-stat' }, h('span', { class: 'gr-pp-stat-label' }, label), h('strong', { class: 'gr-pp-stat-value' }, value), note ? h('span', { class: 'gr-pp-stat-note' }, note) : null);
}
function ppDrawer(d) {
  const r = d.rows.find((x) => x.id === ppState.sel);
  if (!r) return null;
  const e = r.evidence;
  const close = () => { ppState.sel = null; render(); };
  const evoNote = e.recentUnits != null && e.priorUnits != null ? t('gr.pp.ev.evoNote', num(e.recentUnits), num(e.priorUnits), e.weeksEachSide) : t('gr.pp.ev.evoNone', d.thresholds.trend.minObservableWeeks);
  const stockNote = r.stock.usable ? (e.snapshotAt ? t('gr.pp.ev.snapshot', ppDate(e.snapshotAt)) : null) : e.snapshotAt ? t('gr.pp.ev.snapshotOld', ppDate(e.snapshotAt)) : t('gr.pp.ev.noSnapshot');
  const coverNote = r.cover.status === 'CALCULATED' ? t('gr.pp.ev.coverNote', d.thresholds.lowCoverWeeks) : t(`gr.pp.cover.${r.cover.status || 'UNKNOWN'}`);
  const refundNote = r.refunds.rate == null ? null : t('gr.pp.ev.refundNote', num(r.refunds.units));
  return h('div', { class: 'gr-pp-drawer-wrap' },
    h('div', { class: 'gr-pp-backdrop', on: { click: close } }),
    h('aside', { class: 'gr-pp-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': r.title },
      h('div', { class: 'gr-pp-drawer-head' }, ppThumb(r, 'lg'),
        h('div', { class: 'gr-pp-drawer-id' }, h('h2', null, r.title),
          h('div', { class: 'gr-pp-drawer-meta' }, ppStatusChip(r), h('span', { class: 'gr-pp-sub' }, r.category || t('gr.pp.noCategory')))),
        h('button', { type: 'button', class: 'gr-pp-close', 'aria-label': t('gr.pp.close'), on: { click: close } }, '×')),
      h('div', { class: 'gr-pp-drawer-body' },
        h('section', { class: 'gr-pp-sec' }, h('h3', null, t('gr.pp.d.why')), h('p', { class: 'gr-pp-why' }, ppWhy(r, d)),
          r.reasons.length ? h('div', { class: 'gr-pp-reasons' }, r.reasons.map((x) => chip(t(`gr.pp.reason.${x}`), 'mute'))) : null),
        h('section', { class: 'gr-pp-sec' }, h('h3', null, t('gr.pp.d.evidence', d.window.weeks)),
          h('div', { class: 'gr-pp-stats' },
            ppStat(t('gr.pp.ev.sales'), money(r.netSales), t('gr.pp.ev.salesNote', r.topRank)),
            ppStat(t('gr.pp.ev.units'), num(r.units), e.velocityWeekly != null ? t('gr.pp.ev.velocity', new Intl.NumberFormat(tag(), { maximumFractionDigits: 1 }).format(e.velocityWeekly)) : null),
            ppStat(t('gr.pp.col.evolution'), ppEvolution(r), evoNote),
            ppStat(t('gr.pp.col.margin'), r.margin.tier === 'MISSING' || r.margin.pct == null ? t('gr.dash') : ppPct(r.margin.pct), t(`gr.pp.margin.${r.margin.tier}`)),
            ppStat(t('gr.pp.col.stock'), r.stock.usable ? num(r.stock.units ?? 0) : t('gr.dash'), stockNote),
            ppStat(t('gr.pp.col.cover'), r.cover.status === 'CALCULATED' ? ppDays(r.cover.days) : t('gr.dash'), coverNote),
            ppStat(t('gr.pp.ev.refunds'), r.refunds.rate == null ? t('gr.dash') : ppPct(r.refunds.rate), refundNote),
            ppStat(t('gr.pp.ev.history'), t('gr.pp.ev.weeks', e.observableWeeks), e.observableWeeks < d.thresholds.minObservableWeeks ? t('gr.pp.reason.TREND_INSUFFICIENT') : null))),
        h('section', { class: 'gr-pp-sec gr-pp-action' }, h('h3', null, t('gr.pp.d.action')), ppActionChip(r),
          h('p', { class: 'gr-pp-action-text' }, t(`gr.pp.actionText.${r.action}`)),
          r.opportunity ? h('button', { type: 'button', class: 'btn-outline gr-action', disabled: 'disabled', title: t('gr.pp.d.opportunitySoon') }, t('gr.pp.d.opportunity')) : null),
        h('section', { class: 'gr-pp-sec' }, h('p', { class: 'gr-pp-action-text' }, t('gr.pp.d.method'))))));
}
// Escape closes the drawer (registered once, only acts while one is open).
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ppState.sel && currentPage() === 'potential') { ppState.sel = null; render(); } });
}

function renderPotential(main, safe) {
  const d = PAGES.potential.get();
  if (ppState.sel && !d.rows.some((r) => r.id === ppState.sel)) ppState.sel = null;
  main.appendChild(safe(ppKpiRow));
  main.appendChild(h('div', { class: 'gr-grid-pipe gr-grid-pp' }, safe(ppListCard), h('div', { class: 'gr-stack' }, safe(ppPushCard), safe(ppProtectCard), safe(ppStatusCard))));
  const drawer = ppState.sel ? safe(ppDrawer) : null;
  if (drawer) main.appendChild(drawer);
  if (document.body && document.body.classList) document.body.classList.toggle('gr-pp-lock', !!drawer);
}
// Leaving the page (back button, hash link) never leaves the drawer open or the page scroll locked.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('hashchange', () => { ppState.sel = null; if (document.body && document.body.classList) document.body.classList.remove('gr-pp-lock'); });
}
