'use strict';
// Nordla Growth - Opportunités page. Loaded BEFORE app.js (same pattern as Analytics' explorer.js): nothing runs at load
// time; the functions below use app.js helpers (h, t, loc, money, num, chip, cardHead, icoBubble, gi, kpi, arrow,
// kindIcon) only when app.js renders the page. Same components as Growth Overview (Analytics' ex-* cards, KPI tiles,
// table, selects, chips, bars); every figure comes from the payload (/api/growth/opportunities, demonstration data).

const OP_PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const OP_PRIORITY_TONE = { high: '', medium: 'mute', low: 'mute' };
const OP_STATUS_TONE = { ready: 'gr-warn', inProgress: 'gr-good', analysis: 'mute', planned: 'mute' };
let opFilter = { source: 'all', status: 'all', sort: 'priority' };

const opPct = (v) => `${Math.round(v * 100)} %`;
function opCountDelta(diff) {
  const up = diff >= 0;
  return h('div', { class: `ex-delta ${up ? 'up' : 'down'}` }, arrow(up ? 'up' : 'down'), h('strong', null, `${up ? '+' : '−'}${Math.abs(diff)}`), h('span', null, t('gr.vsPrevious')));
}
const opNote = (text) => h('div', { class: 'ex-kpi-note' }, text);
// 30-day mini-curve inside a KPI tile: the same NordlaCharts.sparkline as Growth Overview's store metrics.
const opSpark = (values) => h('div', { class: 'kpi-spark gr-kpi-spark' }, NordlaCharts.sparkline(values));

// ---------- KPI row (same 5-tile row as Overview) ----------
function opKpiRow(d) {
  const k = d.kpis;
  return h('div', { class: 'ex-kpi-row gr-kpi-row' },
    kpi('opportunities', t('gr.op.kpi.priority'), num(k.priority.value), [opCountDelta(k.priority.value - k.priority.previous), opNote(t('gr.op.kpi.highPriority', k.priority.high)), opSpark(d.history.priority)]),
    kpi('potentialRevenue', t('gr.op.kpi.potential'), money(k.potentialRevenue.value), [delta(k.potentialRevenue.value / k.potentialRevenue.previous - 1), opNote(t('gr.op.kpi.active', k.potentialRevenue.active)), opSpark(d.history.potentialRevenue)]),
    kpi('approvals', t('gr.op.kpi.ready'), num(k.readyToApprove.value), [opNote(t('gr.op.kpi.readyNote')), opSpark(d.history.readyToApprove)]),
    kpi('inProgress', t('gr.op.kpi.inProgress'), num(k.inProgress.value), [opNote(t('gr.op.kpi.inProgressNote')), opSpark(d.history.inProgress)]),
    kpi('wins', t('gr.op.kpi.wins'), num(k.winsThisMonth.value), opNote(t('gr.op.kpi.winsNote', money(k.winsThisMonth.revenue)))));
}

// ---------- Pipeline (Analytics' ex-table + ex-select filters, working on the loaded rows) ----------
function opSelect(label, value, options, onChange) {
  return h('select', { class: 'ex-select', 'aria-label': label, on: { change: (e) => onChange(e.target.value) } },
    options.map(([v, text]) => h('option', { value: v, ...(v === value ? { selected: 'selected' } : {}) }, text)));
}
function opDots() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 4'); s.setAttribute('width', '16'); s.setAttribute('height', '4');
  for (const cx of [2, 8, 14]) { const c = document.createElementNS(s.namespaceURI, 'circle'); c.setAttribute('cx', cx); c.setAttribute('cy', '2'); c.setAttribute('r', '1.6'); c.setAttribute('fill', 'currentColor'); s.appendChild(c); }
  return s;
}
function opRows(d) {
  let rows = d.pipeline.filter((o) => (opFilter.source === 'all' || o.source === opFilter.source) && (opFilter.status === 'all' || o.status === opFilter.status));
  const by = { priority: (a, b) => OP_PRIORITY_RANK[a.priority] - OP_PRIORITY_RANK[b.priority] || b.revenue - a.revenue, revenue: (a, b) => b.revenue - a.revenue, confidence: (a, b) => b.confidence - a.confidence };
  return rows.slice().sort(by[opFilter.sort] || by.priority);
}
function pipelineCard(d) {
  const uniq = (key) => [...new Set(d.pipeline.map((o) => o[key]))];
  const filters = h('div', { class: 'gr-filters' },
    opSelect(t('gr.op.f.source'), opFilter.source, [['all', t('gr.op.f.allSources')], ...uniq('source').map((s) => [s, t(`gr.op.src.${s}`)])], (v) => { opFilter.source = v; render(); }),
    opSelect(t('gr.op.f.status'), opFilter.status, [['all', t('gr.op.f.allStatuses')], ...uniq('status').map((s) => [s, t(`gr.op.status.${s}`)])], (v) => { opFilter.status = v; render(); }),
    opSelect(t('gr.op.f.sort'), opFilter.sort, ['priority', 'revenue', 'confidence'].map((s) => [s, t(`gr.op.f.sort.${s}`)]), (v) => { opFilter.sort = v; render(); }));
  const rows = opRows(d);
  const body = rows.length
    ? rows.map((o) => h('tr', null,
      h('td', { class: 'gr-op-name' }, loc(o.title)),
      h('td', { class: 'gr-op-src' }, h('span', { class: 'gr-op-srcin' }, gi(kindIcon('src', o.source), 'md'), h('span', { class: 'gr-muted' }, t(`gr.op.src.${o.source}`)))),
      h('td', null, h('span', { class: 'gr-op-prio' }, o.priority === 'high' ? gi('priorityHigh', 'sm') : null, chip(t(`gr.op.priority.${o.priority}`), OP_PRIORITY_TONE[o.priority]))),
      h('td', { class: 'num' }, h('strong', null, money(o.revenue))),
      h('td', { class: 'num' }, h('span', { class: 'gr-conf' }, opPct(o.confidence), h('span', { class: 'ex-bar' }, h('i', { class: 'first', style: `width:${Math.round(o.confidence * 100)}%` })))),
      h('td', null, h('span', { class: 'gr-nowrap' }, t(`gr.op.effort.${o.effort}`))),
      h('td', null, chip(t(`gr.op.status.${o.status}`), OP_STATUS_TONE[o.status])),
      h('td', { class: 'gr-op-act' }, h('button', { type: 'button', class: 'gr-more', disabled: 'disabled', title: t('gr.op.actionsSoon'), 'aria-label': t('gr.op.actionsSoon') }, opDots()))))
    : [h('tr', null, h('td', { colspan: '8' }, h('span', { class: 'gr-muted' }, t('gr.op.noMatch'))))];
  const total = rows.reduce((a, o) => a + o.revenue, 0);
  return h('div', { class: 'ex-card gr-pipeline' },
    cardHead('opportunities', t('gr.op.pipe.title')),
    h('p', { class: 'gr-card-desc' }, t('gr.op.pipe.desc')),
    filters,
    h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table gr-table gr-pipe-table' },
      h('thead', null, h('tr', null, ['name', 'source', 'priority', 'revenue', 'confidence', 'effort', 'status'].map((c) => h('th', { class: ['revenue', 'confidence'].includes(c) ? 'num' : null }, ['confidence', 'effort'].includes(c) ? h('span', { class: 'gr-th-ico' }, gi(c, 'sm'), t(`gr.op.col.${c}`)) : t(`gr.op.col.${c}`))), h('th', { class: 'gr-op-act' }, h('span', { class: 'gr-sr' }, t('gr.op.col.actions'))))),
      h('tbody', null, body))),
    h('div', { class: 'ex-foot' }, t('gr.op.pipe.foot', rows.length, money(total))));
}

// ---------- Nordla AI recommendations (integrated layer, each tied to a pipeline row) ----------
function recommendationsCard(d) {
  const byId = Object.fromEntries(d.pipeline.map((o) => [o.id, o]));
  return h('div', { class: 'ex-card gr-ai' },
    h('div', { class: 'ex-card-head' }, h('h3', { class: 'gr-card-title' }, gi('aiInsights'), t('gr.op.ai.title')), chip(t('gr.ai.badge'), 'mute')),
    h('div', { class: 'ex-movers' }, d.recommendations.map((r) => {
      const o = byId[r.opportunityId];
      return h('div', { class: 'ex-mover gr-row' },
        icoBubble(kindIcon('reco', r.kind)),
        h('div', { class: 'ex-mover-main' },
          h('div', { class: 'ex-mover-name' }, loc(r.title)),
          h('div', { class: 'ex-mover-sub gr-wrap' }, loc(r.text)),
          o ? h('div', { class: 'gr-att-meta' }, h('span', { class: 'gr-muted' }, t('gr.op.ai.potential')), h('strong', { class: 'gr-ink gr-small' }, money(o.revenue)), h('span', { class: 'gr-muted gr-inline-ico' }, '· ', gi('confidence', 'sm'), t('gr.op.ai.confidence', opPct(o.confidence)))) : null));
    })),
    h('div', { class: 'ex-foot' }, t('gr.ai.foot')));
}

// ---------- Impact vs effort: a 2x2 matrix built from existing cards/chips (no new chart style) ----------
function impactEffortCard(d) {
  const shown = d.pipeline.filter((o) => o.priority !== 'low');
  const cell = (impact, effortHigh) => {
    const items = shown.filter((o) => o.impact === impact && (o.effort !== 'low') === effortHigh);
    return h('div', { class: `gr-mx-cell${impact === 'high' && !effortHigh ? ' gr-mx-best' : ''}` },
      h('div', { class: 'gr-mx-label' }, t(`gr.op.mx.${impact}${effortHigh ? 'High' : 'Low'}`)),
      h('div', { class: 'gr-mx-items' }, items.length ? items.map((o) => chip(loc(o.short), impact === 'high' && !effortHigh ? '' : 'mute')) : h('span', { class: 'gr-muted' }, t('gr.dash'))));
  };
  return h('div', { class: 'ex-card gr-impact' },
    cardHead('impactEffort', t('gr.op.mx.title')),
    h('div', { class: 'gr-mx' },
      h('div', { class: 'gr-mx-y' }, h('span', null, t('gr.op.mx.impact'))),
      h('div', { class: 'gr-mx-grid' }, cell('high', false), cell('high', true), cell('low', false), cell('low', true)),
      h('div', { class: 'gr-mx-x' }, h('span', { class: 'gr-inline-ico' }, gi('effort', 'sm'), t('gr.op.mx.effortLow')), h('span', { class: 'gr-inline-ico' }, gi('effort', 'sm'), t('gr.op.mx.effortHigh')))),
    h('div', { class: 'ex-foot' }, t('gr.op.mx.foot', shown.length)));
}

// ---------- Needs your approval (the "ready" rows; the approval workflow is not built: buttons disabled) ----------
function approvalsCard(d) {
  return h('div', { class: 'ex-card gr-approvals' },
    cardHead('approvals', t('gr.op.appr.title'), chip(String(d.approvals.length), '')),
    h('div', { class: 'ex-movers' }, d.approvals.map((a) => h('div', { class: 'ex-mover gr-row' },
      icoBubble(kindIcon('src', (d.pipeline.find((o) => o.id === a.opportunityId) || {}).source || 'sales')),
      h('div', { class: 'ex-mover-main' },
        h('div', { class: 'ex-mover-name' }, loc(a.title)),
        h('div', { class: 'ex-mover-sub' }, t('gr.op.appr.budget', money(a.budget)), ' · ', t('gr.op.appr.expected', money(a.expectedRevenue)))),
      h('button', { type: 'button', class: 'btn-outline gr-action', disabled: 'disabled', title: t('gr.op.appr.soon') }, t('gr.op.appr.approve'))))),
    h('div', { class: 'ex-foot' }, t('gr.op.appr.foot')));
}

// ---------- High-potential segments (Explorer's concentration bars) ----------
function segmentsCard(d) {
  const max = Math.max(...d.segments.map((s) => s.growthPct), 0.0001);
  return h('div', { class: 'ex-card gr-segments' },
    cardHead('segments', t('gr.op.seg.title')),
    h('div', { class: 'ex-conc' }, d.segments.map((s, i) => h('div', { class: 'ex-conc-row wide' },
      h('span', { class: 'gr-inline-ico gr-seg-label' }, gi(kindIcon('seg', s.id), 'md'), loc(s.label)),
      h('div', { class: 'ex-bar' }, h('i', { class: i === 0 ? 'first' : '', style: `width:${Math.max(4, Math.round((s.growthPct / max) * 100))}%` })),
      h('strong', null, signedPct(s.growthPct))))),
    h('div', { class: 'ex-foot' }, t('gr.op.seg.foot')));
}

// ---------- Recent wins ----------
function winsCard(d) {
  const rtf = new Intl.RelativeTimeFormat(tag(), { numeric: 'auto' });
  const today = new Date(`${d.generatedAt.slice(0, 10)}T00:00:00Z`);
  return h('div', { class: 'ex-card gr-wins-card' },
    cardHead('wins', t('gr.op.wins.title')),
    h('div', { class: 'ex-movers' }, d.wins.map((w) => {
      const ratio = w.target ? w.result / w.target : null;
      const ago = Math.round((new Date(`${w.date}T00:00:00Z`) - today) / 86400000);
      return h('div', { class: 'ex-mover gr-row' },
        icoBubble('wins'),
        h('div', { class: 'ex-mover-main' },
          h('div', { class: 'ex-mover-name' }, loc(w.title)),
          h('div', { class: 'ex-mover-sub' }, rtf.format(ago, 'day')),
          ratio == null ? null : h('div', { class: `gr-win-target${ratio >= 1 ? ' up' : ''}` }, t('gr.op.wins.target', money(w.target), `${Math.round(ratio * 100)} %`))),
        h('div', { class: 'gr-side' }, h('strong', { class: 'gr-pos' }, `+${money(w.result)}`)));
    })));
}

// ---------- Potential revenue by source: Analytics' donut (NordlaCharts.donut), 4 largest sources + "Autres" ----------
// The Nordla chart palette has 5 series colours, so the tail is grouped (never a repeated colour for two sources).
function opPctRound(values) { // largest-remainder rounding to 1 decimal, so the legend adds up to exactly 100 %
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const raw = values.map((v) => (v / total) * 1000); const out = raw.map(Math.floor);
  let left = 1000 - out.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i] += 1; left -= 1; } });
  return out.map((v) => v / 10);
}
function sourcesCard(d) {
  const top = d.bySource.slice(0, 4); const rest = d.bySource.slice(4);
  const groups = [...top.map((g) => ({ name: t(`gr.op.src.${g.source}`), revenue: g.revenue })),
    ...(rest.length ? [{ name: t('gr.op.bySource.others', rest.length), revenue: rest.reduce((a, g) => a + g.revenue, 0) }] : [])];
  const pcts = opPctRound(groups.map((g) => g.revenue));
  const total = groups.reduce((a, g) => a + g.revenue, 0);
  return h('div', { class: 'ex-card gr-op-sources ex-cats' },
    cardHead('revenueBySource', t('gr.op.bySource.title')),
    NordlaCharts.donut(groups.map((g, i) => ({ name: g.name, pct: pcts[i], value: money(g.revenue), cls: `c${i + 1}` })), { totalValue: compactMoney(total), totalLabel: t('gr.op.bySource.total'), size: 150 }),
    h('div', { class: 'ex-foot' }, t('gr.op.bySource.foot', money(total), d.bySource.length)));
}

// ---------- Pipeline by status: Explorer's horizontal bars (count + potential revenue per status) ----------
function statusCard(d) {
  const max = Math.max(...d.byStatus.map((s) => s.revenue), 1);
  return h('div', { class: 'ex-card gr-op-status' },
    cardHead('pipelineStatus', t('gr.op.byStatus.title')),
    h('div', { class: 'ex-conc' }, d.byStatus.map((s) => h('div', { class: 'ex-conc-row wide gr-status-row' },
      h('span', null, chip(t(`gr.op.status.${s.status}`), OP_STATUS_TONE[s.status])),
      h('div', { class: 'ex-bar' }, h('i', { class: s.status === 'ready' ? 'first' : '', style: `width:${Math.max(4, Math.round((s.revenue / max) * 100))}%` })),
      h('span', { class: 'gr-status-val' }, h('strong', null, money(s.revenue)), h('span', { class: 'gr-muted' }, t('gr.op.byStatus.count', s.count)))))),
    h('div', { class: 'ex-foot' }, t('gr.op.byStatus.foot', d.byStatus.reduce((a, s) => a + s.count, 0), money(d.byStatus.reduce((a, s) => a + s.revenue, 0)))));
}

// No opportunity source is connected (server/opportunities.js): the same cards, in the same places, each state it - no demo
// priority, potential revenue, confidence, effort, approval or win. The connected rendering below stays for when a source exists.
function opNcCard(cls, iconName, title, text, right) {
  return h('div', { class: `ex-card ${cls}` }, cardHead(iconName, title, right), ncBody(text));
}
function opNcKpiRow() {
  const tile = (icon, key) => kpi(icon, t(key), t('gr.dash'), ncNote());
  return h('div', { class: 'ex-kpi-row gr-kpi-row' },
    tile('opportunities', 'gr.op.kpi.priority'), tile('potentialRevenue', 'gr.op.kpi.potential'), tile('approvals', 'gr.op.kpi.ready'),
    tile('inProgress', 'gr.op.kpi.inProgress'), tile('wins', 'gr.op.kpi.wins'));
}
function renderOpportunitiesNotConnected(main) {
  main.appendChild(opNcKpiRow());
  main.appendChild(h('div', { class: 'gr-grid-pipe' },
    h('div', { class: 'ex-card gr-pipeline' }, cardHead('opportunities', t('gr.op.pipe.title')), h('p', { class: 'gr-card-desc' }, t('gr.op.pipe.desc')), ncBody(t('gr.op.nc.pipeline'))),
    h('div', { class: 'gr-stack' },
      opNcCard('gr-ai', 'aiInsights', t('gr.op.ai.title'), t('gr.ov.nc.ai'), chip(t('gr.ai.badge'), 'mute')),
      opNcCard('gr-op-status', 'pipelineStatus', t('gr.op.byStatus.title'), t('gr.op.nc.pipeline')))));
  main.appendChild(h('div', { class: 'gr-grid gr-grid-wide' },
    opNcCard('gr-op-sources ex-cats', 'revenueBySource', t('gr.op.bySource.title'), t('gr.op.nc.revenue')),
    opNcCard('gr-segments', 'segments', t('gr.op.seg.title'), t('gr.op.nc.segments')),
    opNcCard('gr-impact', 'impactEffort', t('gr.op.mx.title'), t('gr.op.nc.effort'))));
  main.appendChild(h('div', { class: 'ex-grid-2 even' },
    opNcCard('gr-approvals', 'approvals', t('gr.op.appr.title'), t('gr.op.nc.approvals')),
    opNcCard('gr-wins-card', 'wins', t('gr.op.wins.title'), t('gr.op.nc.wins'))));
}

function renderOpportunities(main, safe) {
  if (PAGES.opportunities.get().connected === false) { renderOpportunitiesNotConnected(main); return; }
  main.appendChild(safe(opKpiRow));
  // 1. Pipeline + (Nordla AI recommendations, pipeline by status) side by side from 1360px.
  main.appendChild(h('div', { class: 'gr-grid-pipe' }, safe(pipelineCard), h('div', { class: 'gr-stack' }, safe(recommendationsCard), safe(statusCard))));
  // 2. Secondary analysis: where the potential comes from, which segments, impact vs effort.
  main.appendChild(h('div', { class: 'gr-grid gr-grid-wide' }, safe(sourcesCard), safe(segmentsCard), safe(impactEffortCard)));
  // 3. Decisions and results.
  main.appendChild(h('div', { class: 'ex-grid-2 even' }, safe(approvalsCard), safe(winsCard)));
}
