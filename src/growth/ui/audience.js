'use strict';
// Nordla Growth - Audience page. Loaded BEFORE app.js (same pattern as potential.js): nothing runs at load time; the
// functions below use app.js helpers (h, t, money, num, chip, cardHead, gi, kpi, arrow, render, PAGES) only when app.js
// renders the page. Every figure, segment, status, signal and action comes from the payload (/api/growth/audience = the
// merchant's own synced data, src/growth/audience/audience.js); the UI only words and lays them out. Segments are aggregates:
// no customer, key or label is ever shown. The list + detail panel reuse Produits Potentiels' components (.gr-pp-*).

const AU_TONE = { priority: 'gr-good', activate: 'gr-warn', develop: 'gr-info', watch: 'gr-bad', insufficient: 'mute' };
const AU_SEG_ICON = { loyal: 'clientFidele', returning: 'pack:returningCustomers', newReturned: 'nouveauClient', new: 'nouveauClient', reactivate: 'clientDormant', occasional: 'segmentClient', unknown: 'dataHealth' };
const AU_ACTION_ICON = { reactivation: 'pack:retargeting', loyalty: 'pack:loyalty', secondPurchase: 'pack:gifts', targetedOffer: 'segmentClient', growSample: 'dataHealth', enableCustomerKey: 'dataHealth' };
let auState = { sel: null };

const auPct = (v) => `${Math.round(v * 100)} %`;
const auNA = (text) => h('span', { class: 'gr-pp-na' }, text);
const auSeg = (key) => t(`gr.au.seg.${key}`);
const auSegIcon = (key) => h('span', { class: 'gr-au-segico' }, gi(AU_SEG_ICON[key], 'md'));
const auStatus = (s) => chip(t(`gr.au.status.${s}`), AU_TONE[s]);

/** KPI comparison line: a real previous value -> Analytics' delta; none -> an explicit note, never a fake 0. */
function auDelta(value, previous, kind) {
  if (value == null || previous == null) return h('div', { class: 'ex-kpi-note' }, t(previous == null ? 'gr.au.kpi.noPrevious' : 'gr.au.kpi.notComputable'));
  if (kind === 'rate') {
    const pts = Math.round((value - previous) * 1000) / 10;
    const up = pts >= 0;
    return h('div', { class: `ex-delta ${pts === 0 ? '' : up ? 'up' : 'down'}` }, pts === 0 ? null : arrow(up ? 'up' : 'down'), h('strong', null, t('gr.au.pts', `${up ? '+' : '−'}${new Intl.NumberFormat(tag(), { maximumFractionDigits: 1 }).format(Math.abs(pts))}`)), h('span', null, t('gr.au.vsPrevious')));
  }
  if (previous === 0) return h('div', { class: 'ex-kpi-note' }, t('gr.au.kpi.fromZero'));
  const pct = (value - previous) / previous;
  if (pct === 0) return h('div', { class: 'ex-delta' }, h('strong', null, '0 %'), h('span', null, t('gr.au.vsPrevious')));
  return h('div', { class: `ex-delta ${pct > 0 ? 'up' : 'down'}` }, arrow(pct > 0 ? 'up' : 'down'), h('strong', null, signedPct(pct)), h('span', null, t('gr.au.vsPrevious')));
}

// ---------- KPI row: five of Growth's KPI tiles (customer mode) or five order-level tiles (no customer key) ----------
function auKpiRow(d) {
  const k = d.kpis;
  if (d.mode === 'aggregate') {
    return h('div', { class: 'ex-kpi-row gr-kpi-row' },
      kpi('commandes', t('gr.au.kpi.orders'), num(k.orders.value), auDelta(k.orders.value, k.orders.previous)),
      kpi('chiffreAffaires', t('gr.au.kpi.netSales'), money(k.netSales.value), auDelta(k.netSales.value, k.netSales.previous)),
      kpi('panierMoyen', t('gr.au.kpi.aov'), k.aov.value == null ? t('gr.dash') : money(k.aov.value), auDelta(k.aov.value, k.aov.previous)),
      kpi('pack:returningCustomers', t('gr.au.kpi.returningOrders'), k.returningOrderShare.value == null ? t('gr.dash') : auPct(k.returningOrderShare.value),
        k.returningOrderShare.value == null ? h('div', { class: 'ex-kpi-note' }, t('gr.au.kpi.indexMissing')) : auDelta(k.returningOrderShare.value, k.returningOrderShare.previous, 'rate')),
      kpi('pack:bundle', t('gr.au.kpi.multiProduct'), k.multiProductShare.value == null ? t('gr.dash') : auPct(k.multiProductShare.value), auDelta(k.multiProductShare.value, k.multiProductShare.previous, 'rate')));
  }
  return h('div', { class: 'ex-kpi-row gr-kpi-row' },
    kpi('clients', t('gr.au.kpi.active'), num(k.activeCustomers.value), auDelta(k.activeCustomers.value, k.activeCustomers.previous)),
    kpi('nouveauClient', t('gr.au.kpi.new'), num(k.newCustomers.value), auDelta(k.newCustomers.value, k.newCustomers.previous)),
    kpi('pack:returningCustomers', t('gr.au.kpi.repeatRate'), k.repeatRate.value == null ? t('gr.dash') : auPct(k.repeatRate.value),
      k.repeatRate.value == null ? h('div', { class: 'ex-kpi-note' }, t('gr.au.kpi.sampleGate', d.thresholds.minCustomers)) : auDelta(k.repeatRate.value, k.repeatRate.previous, 'rate')),
    kpi('panierMoyen', t('gr.au.kpi.aov'), k.aov.value == null ? t('gr.dash') : money(k.aov.value), auDelta(k.aov.value, k.aov.previous)),
    kpi('clientDormant', t('gr.au.kpi.toReactivate'), k.toReactivate.value == null ? t('gr.dash') : num(k.toReactivate.value),
      k.toReactivate.value == null ? h('div', { class: 'ex-kpi-note' }, t('gr.au.kpi.historyGate', d.window.days)) : auDelta(k.toReactivate.value, k.toReactivate.previous)));
}

// ---------- Répartition: a stacked bar only because the groups are a partition (exclusive, sum = 100 %) ----------
function auBar(parts, total, note) {
  const shown = parts.filter((p) => p.n > 0);
  return h('div', { class: 'gr-au-dist' },
    h('div', { class: 'gr-au-bar', role: 'img', 'aria-label': shown.map((p) => `${p.name} ${auPct(p.n / total)}`).join(', ') },
      shown.map((p) => h('span', { class: `gr-au-bar-seg gr-au-c-${p.key}`, style: `flex-grow:${p.n}` }, p.n / total >= 0.08 ? auPct(p.n / total) : ''))),
    h('div', { class: 'gr-au-legend' }, shown.map((p) => h('div', { class: 'gr-au-legend-item' },
      h('span', { class: `gr-au-dot gr-au-c-${p.key}`, 'aria-hidden': 'true' }),
      h('span', { class: 'gr-au-legend-text' }, h('span', null, p.name), h('strong', null, t('gr.au.dist.value', auPct(p.n / total), num(p.n))), p.extra ? h('span', { class: 'gr-pp-sub' }, p.extra) : null)))),
    note ? h('div', { class: 'ex-foot' }, note) : null);
}
function auDistCard(d) {
  if (d.mode === 'aggregate') {
    const g = d.orderFacts.current.groups; const total = d.orderFacts.current.orders;
    const parts = ['new', 'returning', 'first_recorded_pos', 'unknown'].map((key) => ({ key: `o-${key}`, n: g[key], name: t(`gr.au.orderGroup.${key}`) }));
    return h('div', { class: 'ex-card gr-au-distcard' }, cardHead('segmentClient', t('gr.au.dist.ordersTitle')),
      // No order carries a source index: a 100 % "unknown" bar would be decoration, so the fact is stated instead.
      !total ? h('div', { class: 'gr-pp-empty' }, t('gr.au.empty.window', d.window.days))
        : d.orderFacts.current.knownIndexOrders === 0 ? h('div', { class: 'gr-pp-empty' }, t('gr.au.dist.noIndex', num(total)))
          : auBar(parts, total, t('gr.au.dist.ordersFoot', d.window.days)));
  }
  const segs = d.segments.filter((s) => s.customers > 0);
  const total = segs.reduce((a, s) => a + s.customers, 0);
  const parts = d.segments.slice().sort((a, b) => SEG_ORDER.indexOf(a.key) - SEG_ORDER.indexOf(b.key))
    .map((s) => ({ key: s.key, n: s.customers, name: auSeg(s.key), extra: s.revenueShare != null ? t('gr.au.dist.revenue', auPct(s.revenueShare)) : null }));
  return h('div', { class: 'ex-card gr-au-distcard' }, cardHead('segmentClient', t('gr.au.dist.title')),
    total ? auBar(parts, total, t('gr.au.dist.foot', num(total), d.window.days)) : h('div', { class: 'gr-pp-empty' }, t('gr.au.empty.window', d.window.days)));
}
const SEG_ORDER = ['loyal', 'returning', 'newReturned', 'new', 'unknown', 'reactivate', 'occasional'];

// ---------- Segments prioritaires ----------
function auNoCustomerLevel() {
  return h('div', { class: 'gr-pp-empty' }, t('gr.au.noKey.text'), h('ul', null, ['loyal', 'reactivate', 'new', 'occasional'].map((k) => h('li', null, auSeg(k)))));
}
// Detail panel: focus handled by the shell (dialogOpened / dialogClosed + data-focus-id on every trigger).
function auOpen(key, trigger) { dialogOpened(trigger); auState.sel = key; render(); }
function auClose() { auState.sel = null; dialogClosed(); render(); }
function auPriorityCard(d) {
  const head = cardHead('pack:priorityHigh', t('gr.au.prio.title'));
  if (d.mode !== 'customer') return h('div', { class: 'ex-card gr-au-prio' }, head, auNoCustomerLevel());
  const rows = d.segments.filter((s) => s.customers > 0).slice(0, 5);
  return h('div', { class: 'ex-card gr-au-prio' }, head,
    h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table gr-table gr-au-prio-table' },
      h('thead', null, h('tr', null, h('th', null, t('gr.au.col.segment')), h('th', { class: 'num' }, t('gr.au.col.size')), h('th', { class: 'num' }, t('gr.au.col.revenueShare')), h('th', null, t('gr.au.col.status')), h('th', null, t('gr.au.col.action')), h('th', { class: 'gr-op-act' }, h('span', { class: 'gr-sr' }, t('gr.au.open'))))),
      h('tbody', null, rows.map((s) => h('tr', null,
        h('td', null, h('span', { class: 'gr-au-segcell' }, auSegIcon(s.key), h('strong', null, auSeg(s.key)))),
        h('td', { class: 'num' }, num(s.customers)),
        h('td', { class: 'num' }, s.revenueShare == null ? auNA(t('gr.dash')) : auPct(s.revenueShare)),
        h('td', null, auStatus(s.status)),
        h('td', { class: 'gr-au-actcell' }, t(`gr.au.action.${s.action}`)),
        h('td', { class: 'gr-op-act' }, h('button', { type: 'button', class: 'gr-au-go', 'aria-label': t('gr.au.openSegment', auSeg(s.key)), 'data-focus-id': `au-go:${s.key}`, on: { click: (e) => auOpen(s.key, e && e.currentTarget) } }, arrowRight()))))))),
    h('div', { class: 'ex-foot' }, t('gr.au.prio.foot')));
}
function arrowRight() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '16'); s.setAttribute('height', '16'); s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  for (const dd of ['M5 12h14', 'M13 6l6 6-6 6']) { const p = document.createElementNS(s.namespaceURI, 'path'); p.setAttribute('d', dd); s.appendChild(p); }
  return s;
}

// ---------- Signaux d'audience: fact -> comparison -> why it matters ----------
function auSignalText(s, d) {
  switch (s.code) {
    case 'repeatRevenueShare': return [t('gr.au.sig.repeatRevenueShare.title', auPct(s.revenueShare)), t('gr.au.sig.repeatRevenueShare.text', auPct(s.customerShare), auPct(s.revenueShare), d.window.days)];
    case 'reactivation': return [t('gr.au.sig.reactivation.title', num(s.customers), s.days), t('gr.au.sig.reactivation.text', money(s.historyNet))];
    case 'repeatRateChange': return [t(s.value > s.previous ? 'gr.au.sig.repeatRateUp.title' : 'gr.au.sig.repeatRateDown.title'), t('gr.au.sig.repeatRateChange.text', auPct(s.value), auPct(s.previous), d.window.days)];
    case 'aovGap': return [t('gr.au.sig.aovGap.title'), t('gr.au.sig.aovGap.text', money(s.repeat), money(s.new))];
    case 'coverage': return [t('gr.au.sig.coverage.title', auPct(s.identifiedShare)), t('gr.au.sig.coverage.text', num(s.anonymousOrders))];
    case 'returningOrders': return [t('gr.au.sig.returningOrders.title', auPct(s.share)), t('gr.au.sig.returningOrders.text', num(s.knownIndexOrders))];
    case 'aovChange': return [t(s.value > s.previous ? 'gr.au.sig.aovUp.title' : 'gr.au.sig.aovDown.title'), t('gr.au.sig.aovChange.text', money(s.value), money(s.previous), d.window.days)];
    case 'multiProduct': return [t('gr.au.sig.multiProduct.title', auPct(s.share)), t('gr.au.sig.multiProduct.text', num(s.orders))];
    default: return [t('gr.au.sig.customerLevelMissing.title'), t('gr.au.sig.customerLevelMissing.text')];
  }
}
const AU_SIG_ICON = { repeatRevenueShare: 'clientFidele', reactivation: 'clientDormant', repeatRateChange: 'pack:returningCustomers', aovGap: 'panierMoyen', coverage: 'dataHealth', returningOrders: 'pack:returningCustomers', aovChange: 'panierMoyen', multiProduct: 'pack:bundle', customerLevelMissing: 'dataHealth' };
function auSignalsCard(d) {
  return h('div', { class: 'ex-card gr-au-signals' }, cardHead('pack:audience', t('gr.au.sig.title')),
    d.signals.length
      ? h('div', { class: 'ex-movers' }, d.signals.map((s) => { const [title, text] = auSignalText(s, d); return h('div', { class: 'ex-mover gr-row' }, icoBubble(AU_SIG_ICON[s.code]), h('div', { class: 'ex-mover-main' }, h('div', { class: 'ex-mover-name' }, title), h('div', { class: 'ex-mover-sub gr-wrap' }, text))); }))
      : h('div', { class: 'gr-pp-empty' }, t('gr.au.sig.none', d.thresholds.minCustomers)),
    h('div', { class: 'ex-foot' }, t('gr.au.sig.foot')));
}

// ---------- Segments clients (main list; cards below 1024px) ----------
function auSegRow(s) {
  const cell = (cls, k, ...c) => h('div', { class: `gr-pp-c ${cls}`, ...(k ? { 'data-k': k } : {}) }, ...c);
  return h('button', { type: 'button', class: `gr-pp-row gr-au-row${auState.sel === s.key ? ' sel' : ''}`, 'aria-label': t('gr.au.openSegment', auSeg(s.key)), 'data-focus-id': `au-row:${s.key}`, on: { click: (e) => auOpen(s.key, e && e.currentTarget) } },
    cell('gr-pp-c-name', null, auSegIcon(s.key), h('span', { class: 'gr-pp-name-wrap' }, h('span', { class: 'gr-pp-name' }, auSeg(s.key)), h('span', { class: 'gr-pp-sub' }, t(`gr.au.segDef.${s.key}`)))),
    cell('gr-pp-c-num', t('gr.au.col.customers'), h('strong', null, num(s.customers))),
    cell('gr-pp-c-num', t('gr.au.col.frequency'), s.ordersPerCustomer == null ? auNA(t('gr.dash')) : new Intl.NumberFormat(tag(), { maximumFractionDigits: 1 }).format(s.ordersPerCustomer)),
    cell('gr-pp-c-num', t('gr.au.col.revenue', 90), money(s.windowNet)),
    cell('gr-pp-c-num', t('gr.au.col.aov'), s.aov == null ? auNA(t('gr.dash')) : money(s.aov)),
    cell('gr-pp-c-num', t('gr.au.col.recency'), s.medianRecencyDays == null ? auNA(t('gr.dash')) : t('gr.au.daysAgo', num(Math.round(s.medianRecencyDays)))),
    cell('gr-pp-c-status', null, auStatus(s.status), h('span', { class: 'gr-pp-signal' }, t(`gr.au.action.${s.action}`))),
    cell('gr-pp-c-more', null, h('span', { class: 'gr-pp-dots', 'aria-hidden': 'true' }, opDots())));
}
function auSegmentsCard(d) {
  const segs = d.mode === 'customer' ? d.segments.filter((s) => s.customers > 0) : [];
  const head = cardHead('clients', t('gr.au.list.title', segs.length),
    h('button', { type: 'button', class: 'btn-outline gr-action', disabled: 'disabled', title: t('gr.au.newSegmentSoon') }, t('gr.au.newSegment')));
  if (d.mode !== 'customer') return h('div', { class: 'ex-card gr-au-list' }, head, auNoCustomerLevel());
  const cols = ['segment', 'customers', 'frequency', 'revenue', 'aov', 'recency', 'statusAction'];
  return h('div', { class: 'ex-card gr-au-list' }, head,
    h('p', { class: 'gr-card-desc' }, t('gr.au.list.desc', d.window.days)),
    h('div', { class: 'gr-pp-table', role: 'list' },
      h('div', { class: 'gr-pp-thead gr-au-thead', 'aria-hidden': 'true' }, cols.map((c) => h('span', { class: c === 'segment' || c === 'statusAction' ? null : 'num' }, t(`gr.au.col.${c}`, d.window.days))), h('span', null)),
      segs.length ? segs.map(auSegRow) : h('div', { class: 'gr-pp-empty' }, t('gr.au.empty.window', d.window.days))),
    h('div', { class: 'ex-foot' }, t('gr.au.list.foot', num(d.identifiedCustomers), d.coverage.identifiedOrderShare == null ? t('gr.dash') : auPct(d.coverage.identifiedOrderShare))));
}

// ---------- Actions recommandées (3 to 5, from the payload; qualitative benefit, never an amount) ----------
function auActionsCard(d) {
  const segOf = (k) => d.segments.find((s) => s.key === k);
  // No icon: the official "action recommandée" asset is defective in the pack (needs re-export) - never substituted.
  return h('div', { class: 'ex-card gr-au-actions' }, cardHead(null, t('gr.au.act.title', d.actions.length)),
    d.actions.length
      ? h('div', { class: 'gr-pp-items' }, d.actions.map((a) => {
        const s = a.segment ? segOf(a.segment) : null;
        const body = [h('span', { class: 'gr-pp-name' }, t(`gr.au.actTitle.${a.code}`)),
          h('span', { class: 'gr-pp-sub' }, s ? t('gr.au.act.target', auSeg(s.key), num(s.customers)) : t(`gr.au.actWhy.${a.code}`)),
          h('span', { class: 'gr-pp-sub' }, t(`gr.au.actBenefit.${a.code}`))];
        const inner = [icoBubble(AU_ACTION_ICON[a.code]), h('span', { class: 'gr-pp-item-main' }, body), h('span', { class: 'gr-pp-item-side' }, chip(t(a.status === 'insufficient' ? 'gr.au.act.prerequisite' : 'gr.au.act.toTest'), a.status === 'insufficient' ? 'mute' : 'gr-info'), s ? arrowRight() : null)];
        return s ? h('button', { type: 'button', class: 'gr-pp-item gr-au-item', 'data-focus-id': `au-act:${a.code}`, on: { click: (e) => auOpen(s.key, e && e.currentTarget) } }, inner) : h('div', { class: 'gr-pp-item gr-au-item gr-au-static' }, inner);
      }))
      : h('div', { class: 'gr-pp-empty' }, t('gr.au.act.none')),
    h('div', { class: 'ex-foot' }, t('gr.au.act.foot')));
}

// ---------- detail panel of a segment (Produits Potentiels' drawer) ----------
function auStat(label, value, note) {
  return h('div', { class: 'gr-pp-stat' }, h('span', { class: 'gr-pp-stat-label' }, label), h('strong', { class: 'gr-pp-stat-value' }, value), note ? h('span', { class: 'gr-pp-stat-note' }, note) : null);
}
function auDrawer(d) {
  const s = d.segments.find((x) => x.key === auState.sel);
  if (!s) return null;
  const close = () => auClose();
  const th = d.thresholds;
  const evo = s.previousCustomers == null ? t('gr.au.d.noPrevious') : s.customers === s.previousCustomers ? t('gr.au.d.same', num(s.previousCustomers)) : t('gr.au.d.previous', num(s.previousCustomers));
  return h('div', { class: 'gr-pp-drawer-wrap' },
    h('div', { class: 'gr-pp-backdrop', on: { click: close } }),
    h('aside', { class: 'gr-pp-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': auSeg(s.key) },
      h('div', { class: 'gr-pp-drawer-head' }, h('span', { class: 'gr-pp-thumb lg' }, gi(AU_SEG_ICON[s.key], 'lg')),
        h('div', { class: 'gr-pp-drawer-id' }, h('h2', null, auSeg(s.key)), h('div', { class: 'gr-pp-drawer-meta' }, auStatus(s.status), h('span', { class: 'gr-pp-sub' }, t('gr.au.d.window', d.window.days)))),
        h('button', { type: 'button', class: 'gr-pp-close', 'aria-label': t('gr.pp.close'), on: { click: close } }, '×')),
      h('div', { class: 'gr-pp-drawer-body' },
        h('section', { class: 'gr-pp-sec' }, h('h3', null, t('gr.au.d.definition')), h('p', { class: 'gr-pp-why' }, t(`gr.au.segRule.${s.key}`, d.window.days))),
        h('section', { class: 'gr-pp-sec' }, h('h3', null, t('gr.au.d.sizeValue')),
          h('div', { class: 'gr-pp-stats' },
            auStat(t('gr.au.d.size'), num(s.customers), s.customerShare == null ? null : t('gr.au.d.sizeNote', auPct(s.customerShare))),
            auStat(t('gr.au.d.evolution'), s.previousCustomers == null ? t('gr.dash') : num(s.previousCustomers), evo),
            auStat(t('gr.au.col.revenue', d.window.days), money(s.windowNet), s.revenueShare == null ? t('gr.au.d.noWindowPurchase') : t('gr.au.d.revenueShare', auPct(s.revenueShare))),
            auStat(t('gr.au.d.historyRevenue'), money(s.historyNet), t('gr.au.d.historyNote', d.window.historyDays)),
            auStat(t('gr.au.col.aov'), s.aov == null ? t('gr.dash') : money(s.aov), t('gr.au.d.aovNote')),
            auStat(t('gr.au.col.frequency'), s.ordersPerCustomer == null ? t('gr.dash') : new Intl.NumberFormat(tag(), { maximumFractionDigits: 1 }).format(s.ordersPerCustomer), t('gr.au.d.frequencyNote')),
            auStat(t('gr.au.col.recency'), s.medianRecencyDays == null ? t('gr.dash') : t('gr.au.daysAgo', num(Math.round(s.medianRecencyDays))), t('gr.au.d.recencyNote')))),
        h('section', { class: 'gr-pp-sec' }, h('h3', null, t('gr.au.d.why')),
          h('p', { class: 'gr-pp-why' }, t(`gr.au.rule.${s.rule}`, auPct(s.revenueShare ?? 0), auPct(s.activeShare ?? 0), num(s.previousCustomers ?? 0), th.minGroup)),
          s.reasons.length ? h('div', { class: 'gr-pp-reasons' }, s.reasons.map((r) => chip(t(`gr.au.reason.${r}`, th.minCustomers, th.minGroup), 'mute'))) : null),
        h('section', { class: 'gr-pp-sec gr-pp-action' }, h('h3', null, t('gr.au.d.action')), chip(t(`gr.au.action.${s.action}`), s.action === 'none' ? 'mute' : 'gr-info'),
          h('p', { class: 'gr-pp-action-text' }, t(`gr.au.actionText.${s.action}`)),
          s.opportunity ? h('button', { type: 'button', class: 'btn-outline gr-action', disabled: 'disabled', title: t('gr.pp.d.opportunitySoon') }, t('gr.pp.d.opportunity')) : null),
        h('section', { class: 'gr-pp-sec' }, h('p', { class: 'gr-pp-action-text' }, t('gr.au.d.method'))))));
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && auState.sel && currentPage() === 'audience') auClose(); });
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('hashchange', () => { auState.sel = null; if (document.body && document.body.classList) document.body.classList.remove('gr-pp-lock'); });
}

function renderAudience(main, safe) {
  const d = PAGES.audience.get();
  if (d.mode === 'empty') { main.appendChild(h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('gr.au.empty.title'), t('gr.au.empty.text')))); return; }
  if (auState.sel && !d.segments.some((s) => s.key === auState.sel)) auState.sel = null;
  if (d.mode === 'aggregate') main.appendChild(h('div', { class: 'gr-au-banner', role: 'note' }, gi('dataHealth', 'md'), h('span', null, t('gr.au.noKey.banner'))));
  main.appendChild(safe(auKpiRow));
  main.appendChild(h('div', { class: 'gr-au-top' }, safe(auDistCard), safe(auPriorityCard), safe(auSignalsCard)));
  main.appendChild(h('div', { class: 'gr-grid-pipe gr-grid-au' }, safe(auSegmentsCard), h('div', { class: 'gr-stack' }, safe(auActionsCard))));
  const drawer = auState.sel ? safe(auDrawer) : null;
  if (drawer) main.appendChild(drawer);
  if (document.body && document.body.classList) document.body.classList.toggle('gr-pp-lock', !!drawer);
}
