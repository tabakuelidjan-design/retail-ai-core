'use strict';
// Développement des ventes - Opportunités page. Loaded BEFORE app.js (same pattern as Analytics' explorer.js): nothing runs at load
// time; the functions below use app.js helpers (h, t, money, num, chip, cardHead, icoBubble, gi, kpi) only when app.js renders the
// page. Every item comes from /api/growth/opportunities = the priorities aggregated from the four real engines (Produits
// Potentiels, Audience, Croissance magasin, Contenu), recomputed on every request. Three sections (owner decision 2026-09-28):
//   À corriger maintenant       reliable data problems, grouped by problem;
//   Opportunités commerciales   only what an engine validated with its existing thresholds (may be empty: stated honestly);
//   À surveiller                signals too weak, or blocked by a guard, to become a recommendation.
// No action button: nothing here writes, approves or automates. Links only open the page where the items can be examined.

const OP_PAGE_HASH = { potential: '#/potential', audience: '#/audience', storeGrowth: '#/storeGrowth', content: '#/content' };
const opPct = (v) => new Intl.NumberFormat(tag(), { style: 'percent', maximumFractionDigits: 0 }).format(v);
const opDay = (d) => new Date(Date.UTC(2024, 0, 1 + d)).toLocaleDateString(tag(), { weekday: 'long', timeZone: 'UTC' });
// Decorative three dots of the clickable rows of Produits Potentiels / Audience (they open the row's detail panel).
function opDots() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 4'); s.setAttribute('width', '16'); s.setAttribute('height', '4');
  for (const cx of [2, 8, 14]) { const c = document.createElementNS(s.namespaceURI, 'circle'); c.setAttribute('cx', cx); c.setAttribute('cy', '2'); c.setAttribute('r', '1.6'); c.setAttribute('fill', 'currentColor'); s.appendChild(c); }
  return s;
}
// Largest-remainder rounding to 1 decimal, so a donut legend adds up to exactly 100 % (used by Contenu's priority donut).
function opPctRound(values) {
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const raw = values.map((v) => (v / total) * 1000); const out = raw.map(Math.floor);
  let left = 1000 - out.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i] += 1; left -= 1; } });
  return out.map((v) => v / 10);
}
/** A real link to the page where the items can be examined (navigation only). */
const opLink = (page) => h('a', { class: 'gr-op-link', href: OP_PAGE_HASH[page] }, t(`gr.op.link.${page}`));
const opNote = (text) => h('div', { class: 'ex-kpi-note' }, text);

// ---------- KPI row: one tile per section ----------
function opKpiRow(d) {
  return h('div', { class: 'ex-kpi-row gr-pr-kpis' },
    kpi('needsAttention', t('gr.op.kpi.fix'), num(d.counts.fix), opNote(t('gr.op.kpi.fixNote', num(d.counts.fixElements)))),
    kpi('opportunities', t('gr.op.kpi.commercial'), num(d.counts.commercial), opNote(t('gr.op.kpi.commercialNote'))),
    kpi(null, t('gr.op.kpi.watch'), num(d.counts.watch), opNote(t('gr.op.kpi.watchNote'))));
}

// ---------- À corriger maintenant: one row per problem, never one per product ----------
function opFixTitle(g) {
  return g.kind === 'purchaseCost' ? t('gr.op.fix.purchaseCost.title', num(g.evidence.count)) : t(`gr.op.fix.content.${g.problem}.title`, num(g.evidence.count));
}
function opFixRow(g) {
  const cost = g.kind === 'purchaseCost';
  const facts = cost
    ? [chip(t('gr.op.fix.purchaseCost.detail', num(g.evidence.unverified), num(g.evidence.missing)), 'mute'), g.evidence.blockedRecommendations ? chip(t('gr.op.fix.purchaseCost.blocked', num(g.evidence.blockedRecommendations)), 'gr-warn') : null]
    : [g.evidence.soldAffected ? chip(t('gr.op.fix.soldAffected', num(g.evidence.soldAffected)), 'mute') : null];
  return h('div', { class: 'ex-mover gr-row gr-pr-row', 'data-priority-id': g.id },
    icoBubble(cost ? 'srcCost' : 'content'),
    h('div', { class: 'ex-mover-main' },
      h('div', { class: 'ex-mover-name' }, opFixTitle(g)),
      h('div', { class: 'ex-mover-sub gr-wrap' }, t(cost ? 'gr.op.fix.purchaseCost.why' : `gr.op.fix.content.${g.problem}.why`)),
      cost ? h('div', { class: 'ex-mover-sub gr-wrap' }, t('gr.op.fix.purchaseCost.pending')) : null,
      g.examples.length ? h('div', { class: 'gr-pr-examples' }, h('span', { class: 'gr-muted' }, t('gr.op.fix.examples')), g.examples.map((e) => chip(e.title, 'mute'))) : null,
      h('div', { class: 'gr-att-meta' }, facts, opLink(g.sourcePage))));
}
function opFixCard(d) {
  const groups = d.sections.fix;
  return h('div', { class: 'ex-card gr-pr-card gr-pr-fix' },
    cardHead('needsAttention', t('gr.op.fix.title'), chip(num(groups.length), groups.length ? '' : 'mute')),
    h('p', { class: 'ex-sub gr-pr-intro' }, t('gr.op.fix.intro')),
    groups.length ? h('div', { class: 'ex-movers' }, groups.map(opFixRow)) : h('div', { class: 'gr-pp-empty' }, t('gr.op.fix.empty')));
}

// ---------- Opportunités commerciales: validated by an engine, or an honest empty state ----------
function opCommercialTitle(i) {
  if (i.kind === 'product') return t(`gr.op.item.product.${i.title.code.split('.')[1]}.title`, i.entity.title);
  if (i.kind === 'storeWeekday') return t('gr.op.item.store.weekday.title', opDay(i.title.params.day));
  if (i.kind === 'segment') return t('gr.op.item.segment.title', t(`gr.au.seg.${i.entity.id}`), num(i.evidence.customers));
  return i.id;
}
function opCommercialWhy(i) {
  if (i.kind === 'product') return t(`gr.op.item.product.${i.title.code.split('.')[1]}.why`);
  if (i.kind === 'storeWeekday') return t('gr.op.item.store.weekday.why', opPct(i.evidence.share));
  if (i.kind === 'segment') return t('gr.op.item.segment.commercial.why');
  return '';
}
const OP_ITEM_ICON = { product: 'produits', storeWeekday: 'calendrier', segment: 'segmentClient' };
function opCommercialRow(i) {
  return h('div', { class: 'ex-mover gr-row gr-pr-row', 'data-priority-id': i.id },
    icoBubble(OP_ITEM_ICON[i.kind]),
    h('div', { class: 'ex-mover-main' },
      h('div', { class: 'ex-mover-name' }, opCommercialTitle(i)),
      h('div', { class: 'ex-mover-sub gr-wrap' }, opCommercialWhy(i)),
      i.findings ? h('div', { class: 'gr-pr-findings' }, i.findings.map(opFinding)) : null,
      h('div', { class: 'gr-att-meta' }, chip(t('gr.op.rel.reliable'), 'gr-good'), opLink(i.sourcePage))));
}
function opCommercialCard(d) {
  const items = d.sections.commercial;
  const body = items.length
    ? h('div', { class: 'ex-movers' }, items.map(opCommercialRow))
    : h('div', { class: 'gr-pp-empty gr-pr-empty' },
      h('strong', { class: 'gr-ink' }, t('gr.op.com.emptyTitle')),
      h('span', null, t('gr.op.com.emptyText')),
      d.waiting.length ? h('ul', null, d.waiting.map((w) => h('li', null, opWaiting(w)))) : null);
  return h('div', { class: 'ex-card gr-pr-card gr-pr-commercial' },
    cardHead('opportunities', t('gr.op.com.title'), chip(num(items.length), items.length ? 'gr-good' : 'mute')),
    h('p', { class: 'ex-sub gr-pr-intro' }, t('gr.op.com.intro')),
    body);
}
function opWaiting(w) {
  const p = w.params || {};
  switch (w.code) {
    case 'productSales': return t('gr.op.wait.productSales', num(p.insufficient), num(p.total), num(p.weeks), num(p.minUnits));
    case 'verifiedCosts': return t('gr.op.wait.verifiedCosts', num(p.count), num(p.total));
    case 'identifiedCustomers': return t('gr.op.wait.identifiedCustomers', num(p.identified), num(p.min));
    case 'storeHistory': return t('gr.op.wait.storeHistory', num(p.weeks));
    case 'onlineOrders': return t('gr.op.wait.onlineOrders', num(p.orders), num(p.min));
    case 'storeOrders': return t('gr.op.wait.storeOrders', num(p.orders), num(p.min));
    default: return w.code;
  }
}

// ---------- À surveiller: one card per product (every engine's findings merged), and segments to watch ----------
function opFinding(f) {
  const p = f.params || {};
  if (f.source === 'products' && f.code.startsWith('potential.')) {
    const out = [chip(t(`gr.op.f.${f.code}`), f.code === 'potential.push' || f.code === 'potential.topSeller' ? 'gr-good' : 'mute')];
    if (p.trend === 'UP') out.push(chip(t('gr.op.f.risingDemand'), 'mute'));
    return out;
  }
  if (f.source === 'store') return chip(t(`gr.op.f.${f.code}`, num(p.rank)), f.code === 'storeTopBlocked' || f.code === 'storeSuggestedNotRecommended' ? 'gr-warn' : 'mute');
  return chip(t(`gr.op.f.${f.code}`), f.code === 'costUnverified' || f.code === 'costMissing' ? 'gr-warn' : 'mute');
}
function opMissing(m) {
  const p = m.params || {};
  return m.code === 'moreWeeks' ? t('gr.op.m.moreWeeks', num(p.weeks), num(p.units)) : t(`gr.op.m.${m.code}`);
}
function opWatchRow(i) {
  if (i.kind === 'segment') {
    return h('div', { class: 'ex-mover gr-row gr-pr-row', 'data-priority-id': i.id },
      icoBubble('segmentClient'),
      h('div', { class: 'ex-mover-main' },
        h('div', { class: 'ex-mover-name' }, t('gr.op.item.segment.title', t(`gr.au.seg.${i.entity.id}`), num(i.evidence.customers))),
        h('div', { class: 'ex-mover-sub gr-wrap' }, t('gr.op.item.segment.watch.why')),
        h('div', { class: 'gr-att-meta' }, chip(t('gr.op.rel.limited'), 'gr-warn'), opLink(i.sourcePage))));
  }
  const e = i.evidence;
  const volume = [e.units != null && e.weeks != null ? t('gr.op.volume', num(e.units), num(e.weeks)) : null, e.storeRank != null && e.storeShare != null ? t('gr.op.volumeStore', num(e.storeRank), opPct(e.storeShare)) : null].filter(Boolean).join(' · ');
  return h('div', { class: 'ex-mover gr-row gr-pr-row', 'data-priority-id': i.id },
    icoBubble('produits'),
    h('div', { class: 'ex-mover-main' },
      h('div', { class: 'ex-mover-name' }, i.entity.title),
      volume ? h('div', { class: 'ex-mover-sub' }, volume) : null,
      h('div', { class: 'gr-pr-findings' }, i.findings.map(opFinding)),
      h('div', { class: 'ex-mover-sub gr-wrap' }, t(`gr.op.why.${i.explanation.code.split('.').pop()}`)),
      i.missing.length ? h('div', { class: 'ex-mover-sub gr-wrap' }, h('strong', { class: 'gr-ink' }, t('gr.op.missing')), ' ', i.missing.map(opMissing).join(' · ')) : null,
      h('div', { class: 'gr-att-meta' }, chip(t('gr.op.rel.limited'), 'gr-warn'), i.relatedPages.map(opLink))));
}
function opWatchCard(d) {
  const items = d.sections.watch;
  return h('div', { class: 'ex-card gr-pr-card gr-pr-watch' },
    cardHead(null, t('gr.op.watch.title'), chip(num(items.length), 'mute')),
    h('p', { class: 'ex-sub gr-pr-intro' }, t('gr.op.watch.intro')),
    items.length ? h('div', { class: 'ex-movers' }, items.map(opWatchRow)) : h('div', { class: 'gr-pp-empty' }, t('gr.op.watch.empty')));
}

/** Sources that could not be read are named, never hidden. */
function opSourcesNote(d) {
  const down = Object.entries(d.sources).filter(([, v]) => v !== 'ok').map(([k]) => t(`gr.nav.${{ products: 'potential', audience: 'audience', store: 'storeGrowth', content: 'content' }[k]}`));
  return down.length ? h('div', { class: 'ex-card gr-pr-card' }, h('div', { class: 'gr-pp-empty' }, t('gr.op.srcUnavailable', down.join(', ')))) : null;
}

function renderOpportunities(main, safe) {
  main.appendChild(safe(opKpiRow));
  const note = safe(opSourcesNote);
  if (note) main.appendChild(note);
  main.appendChild(h('div', { class: 'gr-pr-sections' }, safe(opFixCard), safe(opCommercialCard), safe(opWatchCard)));
  main.appendChild(h('p', { class: 'ex-foot gr-pr-foot' }, t('gr.op.foot')));
}
