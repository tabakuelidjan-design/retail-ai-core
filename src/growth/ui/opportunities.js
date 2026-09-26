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

// ---------- KPI row (same 5-tile row as Overview) ----------
function opKpiRow(d) {
  const k = d.kpis;
  return h('div', { class: 'ex-kpi-row gr-kpi-row' },
    kpi('opportunities', t('gr.op.kpi.priority'), num(k.priority.value), [opCountDelta(k.priority.value - k.priority.previous), opNote(t('gr.op.kpi.highPriority', k.priority.high))]),
    kpi('potentialRevenue', t('gr.op.kpi.potential'), money(k.potentialRevenue.value), [delta(k.potentialRevenue.value / k.potentialRevenue.previous - 1), opNote(t('gr.op.kpi.active', k.potentialRevenue.active))]),
    kpi('approvals', t('gr.op.kpi.ready'), num(k.readyToApprove.value), opNote(t('gr.op.kpi.readyNote'))),
    kpi('inProgress', t('gr.op.kpi.inProgress'), num(k.inProgress.value), opNote(t('gr.op.kpi.inProgressNote'))),
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
      h('td', { class: 'gr-op-src' }, h('span', { class: 'gr-muted' }, t(`gr.op.src.${o.source}`))),
      h('td', null, chip(t(`gr.op.priority.${o.priority}`), OP_PRIORITY_TONE[o.priority])),
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
      h('thead', null, h('tr', null, ['name', 'source', 'priority', 'revenue', 'confidence', 'effort', 'status'].map((c) => h('th', { class: ['revenue', 'confidence'].includes(c) ? 'num' : null }, t(`gr.op.col.${c}`))), h('th', { class: 'gr-op-act' }, h('span', { class: 'gr-sr' }, t('gr.op.col.actions'))))),
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
          o ? h('div', { class: 'gr-att-meta' }, h('span', { class: 'gr-muted' }, t('gr.op.ai.potential')), h('strong', { class: 'gr-ink gr-small' }, money(o.revenue)), h('span', { class: 'gr-muted' }, `· ${t('gr.op.ai.confidence', opPct(o.confidence))}`)) : null));
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
      h('div', { class: 'gr-mx-x' }, h('span', null, t('gr.op.mx.effortLow')), h('span', null, t('gr.op.mx.effortHigh')))),
    h('div', { class: 'ex-foot' }, t('gr.op.mx.foot', shown.length)));
}

// ---------- Needs your approval (the "ready" rows; the approval workflow is not built: buttons disabled) ----------
function approvalsCard(d) {
  return h('div', { class: 'ex-card gr-approvals' },
    cardHead('approvals', t('gr.op.appr.title'), chip(String(d.approvals.length), '')),
    h('div', { class: 'ex-movers' }, d.approvals.map((a) => h('div', { class: 'ex-mover gr-row' },
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
      h('span', null, loc(s.label)),
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
        h('div', { class: 'ex-mover-main' },
          h('div', { class: 'ex-mover-name' }, loc(w.title)),
          h('div', { class: 'ex-mover-sub' }, rtf.format(ago, 'day')),
          ratio == null ? null : h('div', { class: `gr-win-target${ratio >= 1 ? ' up' : ''}` }, t('gr.op.wins.target', money(w.target), `${Math.round(ratio * 100)} %`))),
        h('div', { class: 'gr-side' }, h('strong', { class: 'gr-pos' }, `+${money(w.result)}`)));
    })));
}

function renderOpportunities(main, safe) {
  main.appendChild(safe(opKpiRow));
  // Pipeline + (Nordla AI recommendations, segments) side by side from 1360px; then the decision row.
  main.appendChild(h('div', { class: 'gr-grid-pipe' }, safe(pipelineCard), h('div', { class: 'gr-stack' }, safe(recommendationsCard), safe(segmentsCard))));
  main.appendChild(h('div', { class: 'gr-grid gr-grid-wide' }, safe(impactEffortCard), safe(approvalsCard), safe(winsCard)));
}
