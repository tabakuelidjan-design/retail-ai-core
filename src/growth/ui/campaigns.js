'use strict';
// Nordla Growth - Campagnes page. Loaded BEFORE app.js (same pattern as opportunities.js): nothing runs at load time;
// the functions below use app.js / opportunities.js helpers (h, t, loc, money, num, chip, cardHead, gi, kpi, delta,
// arrow, channelMark, channelName, opSelect, opDots) only when app.js renders the page. Same components as the other
// Growth pages; every figure comes from the payload (/api/growth/campaigns, demonstration data).

const CP_STATUS_TONE = { running: 'gr-info', ready: '', planned: 'mute' };
let cpFilter = { q: '', channel: 'all', status: 'all', sort: 'default' };

const cpNorm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const cpDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(tag(), { day: 'numeric', month: 'short', timeZone: 'UTC' });

// ---------- KPI row (Explorer's 4-tile row) ----------
function cpAbsDelta(diff) {
  const up = diff >= 0;
  const v = new Intl.NumberFormat(tag(), { maximumFractionDigits: 1 }).format(Math.abs(diff));
  return h('div', { class: `ex-delta ${up ? 'up' : 'down'}` }, arrow(up ? 'up' : 'down'), h('strong', null, `${up ? '+' : '−'}${v}`), h('span', null, t('gr.vsPrevious')));
}
function cpKpiRow(d) {
  const k = d.kpis;
  const rel = (x) => delta(x.value / x.previous - 1);
  return h('div', { class: 'ex-kpi-row gr-cp-kpis' },
    kpi('campaignRevenue', t('gr.cp.kpi.revenue'), money(k.revenue.value), rel(k.revenue)),
    kpi('clicks', t('gr.cp.kpi.clicks'), num(k.clicks.value), rel(k.clicks)),
    kpi('newCustomers', t('gr.cp.kpi.newCustomers'), num(k.newCustomers.value), rel(k.newCustomers)),
    kpi('roas', t('gr.cp.kpi.roas'), new Intl.NumberFormat(tag(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(k.roas.value), cpAbsDelta(Math.round((k.roas.value - k.roas.previous) * 10) / 10)));
}

// ---------- Revenue vs spend, last 30 days: Growth Pulse's chart (NordlaCharts.head + trendLines), no new chart ----------
function cpTrendCard(d) {
  const tr = d.trend; const labels = tr.dates.map((x) => dayFmt(x));
  const roas = new Intl.NumberFormat(tag(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(d.kpis.roas.value);
  return h('div', { class: 'ex-card gr-pulse gr-cp-trend' },
    cardHead('growthPulse', t('gr.cp.trend.title')),
    h('div', { class: 'gr-pulse-top' },
      NordlaCharts.head({ title: t('gr.cp.trend.revenue'), value: money(tr.totals.revenue), delta: Math.round((d.kpis.revenue.value / d.kpis.revenue.previous - 1) * 1000) / 10, good: d.kpis.revenue.value >= d.kpis.revenue.previous, vs: t('gr.vsPrevious') }),
      h('div', { class: 'gr-pulse-aside' }, h('span', null, t('gr.cp.trend.spend')), h('strong', null, money(tr.totals.spend)), h('span', { class: 'gr-muted' }, t('gr.cp.trend.roas', roas)))),
    NordlaCharts.trendLines([
      { name: t('gr.cp.trend.revenue'), cls: 'c1', values: tr.revenue },
      { name: t('gr.cp.trend.spend'), cls: 'c2', values: tr.spend },
    ], labels, { format: compactMoney, height: 200, label: t('gr.cp.trend.title') }),
    h('div', { class: 'ex-foot' }, t('gr.cp.trend.foot', dayFmt(d.period.from), dayFmt(d.period.to, true))));
}

// ---------- Campaigns table (Analytics' ex-table + the Opportunités filters) ----------
function cpRows(d) {
  const q = cpNorm(cpFilter.q.trim());
  const rows = d.campaigns.filter((c) => (cpFilter.channel === 'all' || c.channel === cpFilter.channel)
    && (cpFilter.status === 'all' || c.status === cpFilter.status)
    && (!q || cpNorm(`${loc(c.title)} ${loc(c.subtitle)}`).includes(q)));
  // Sort (same select pattern as Opportunités / Analytics Produits): highest first; no performance yet = last.
  const perf = (c) => (c.performance == null ? -1 : c.performance);
  if (cpFilter.sort === 'budget') return rows.slice().sort((a, b) => b.budget - a.budget);
  if (cpFilter.sort === 'performance') return rows.slice().sort((a, b) => perf(b) - perf(a));
  return rows;
}
function cpSearch() {
  const input = h('input', { class: 'gr-search-input', type: 'search', placeholder: t('gr.cp.search'), 'aria-label': t('gr.cp.search'), value: cpFilter.q, autocomplete: 'off' });
  input.addEventListener('input', (e) => {
    cpFilter.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    // Keep typing in the rebuilt field.
    const again = document.querySelector('.gr-search-input');
    if (again && again.focus) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (err) { /* type=search may refuse */ } }
  });
  return h('label', { class: 'gr-search' }, NordlaIcon.semantic('recherche', 'sm'), input);
}
function campaignsTableCard(d) {
  const uniq = (key) => [...new Set(d.campaigns.map((c) => c[key]))];
  const tools = h('div', { class: 'gr-filters gr-cp-tools' },
    cpSearch(),
    opSelect(t('gr.cp.f.channel'), cpFilter.channel, [['all', t('gr.cp.f.allChannels')], ...d.channels.map((c) => [c.id, c.name])], (v) => { cpFilter.channel = v; render(); }),
    opSelect(t('gr.cp.f.status'), cpFilter.status, [['all', t('gr.cp.f.allStatuses')], ...uniq('status').map((s) => [s, t(`gr.cp.status.${s}`)])], (v) => { cpFilter.status = v; render(); }),
    opSelect(t('gr.cp.f.sort'), cpFilter.sort, ['default', 'budget', 'performance'].map((s) => [s, t(`gr.cp.f.sort.${s}`)]), (v) => { cpFilter.sort = v; render(); }),
    h('button', { type: 'button', class: 'btn-ghost gr-cp-new', disabled: 'disabled', title: t('gr.cp.newSoon') }, t('gr.cp.new')));
  const rows = cpRows(d);
  const body = rows.length
    ? rows.map((c) => h('tr', null,
      h('td', { class: 'gr-cp-name' }, h('span', { class: 'gr-cp-camp' },
        // Thumbnail: the icon of the campaign's theme on the neutral tile, until the data source provides the real campaign
        // visual (never a stock or generated image).
        h('span', { class: 'gr-cp-thumb', 'aria-hidden': 'true' }, gi(kindIcon('theme', c.theme), 'md')),
        h('span', null, h('strong', null, loc(c.title)), h('span', { class: 'gr-muted gr-cp-sub' }, loc(c.subtitle))))),
      h('td', null, h('span', { class: 'gr-cp-ch', title: channelName(c.channel) }, channelMark(c.channel), h('span', { class: 'gr-sr' }, channelName(c.channel)))),
      h('td', null, t(`gr.cp.objective.${c.objective}`)),
      h('td', null, h('span', { class: 'gr-nowrap' }, `${cpDate(c.start)} – ${cpDate(c.end)}`)),
      h('td', { class: 'num' }, money(c.budget)),
      h('td', null, chip(t(`gr.cp.status.${c.status}`), CP_STATUS_TONE[c.status])),
      // No performance yet for a campaign not launched: an empty track and a dash, never an invented figure.
      h('td', null, c.performance == null
        ? h('span', { class: 'gr-cp-perf', title: t('gr.cp.perfNone') }, h('span', { class: 'ex-bar' }), h('strong', { class: 'gr-muted' }, t('gr.dash')))
        : h('span', { class: 'gr-cp-perf' }, h('span', { class: 'ex-bar' }, h('i', { class: 'first', style: `width:${Math.min(100, Math.round(c.performance * 100))}%` })), h('strong', null, `${Math.round(c.performance * 100)} %`))),
      h('td', { class: 'gr-op-act' }, h('button', { type: 'button', class: 'gr-more', disabled: 'disabled', title: t('gr.op.actionsSoon'), 'aria-label': t('gr.op.actionsSoon') }, opDots()))))
    : [h('tr', null, h('td', { colspan: '8' }, h('span', { class: 'gr-muted' }, t('gr.cp.noMatch'))))];
  const cols = ['campaign', 'channel', 'objective', 'period', 'budget', 'status', 'performance'];
  return h('div', { class: 'ex-card gr-cp-table' },
    cardHead('campaigns', t('gr.cp.table.title', d.campaigns.length)),
    tools,
    h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table gr-table gr-cp-grid' },
      h('thead', null, h('tr', null, cols.map((c) => h('th', c === 'budget' ? { class: 'num' } : null, t(`gr.cp.col.${c}`))), h('th', { class: 'gr-op-act' }, h('span', { class: 'gr-sr' }, t('gr.op.col.actions'))))),
      h('tbody', null, body))),
    h('div', { class: 'ex-foot' }, t('gr.cp.table.foot', rows.length, d.campaigns.length)));
}

// ---------- Priority actions (tied to campaign rows; not clickable in this phase) ----------
function cpActionsCard(d) {
  const byId = Object.fromEntries(d.campaigns.map((c) => [c.id, c]));
  return h('div', { class: 'ex-card gr-cp-actions' },
    cardHead('needsAttention', t('gr.cp.actions.title'), chip(String(d.actions.length), '')),
    h('div', { class: 'ex-movers' }, d.actions.map((a) => {
      const c = byId[a.campaignId];
      return h('div', { class: 'ex-mover gr-row' },
        c ? channelMark(c.channel) : null,
        h('div', { class: 'ex-mover-main' },
          h('div', { class: 'ex-mover-name' }, loc(a.title)),
          h('div', { class: 'ex-mover-sub gr-wrap' }, loc(a.text)),
          c ? h('div', { class: 'gr-att-meta' }, h('span', { class: 'gr-muted' }, `${channelName(c.channel)} · ${loc(c.title)}`)) : null));
    })));
}

// ---------- Performance by channel (Explorer's bars) ----------
function cpChannelsCard(d) {
  const max = Math.max(...d.channels.map((c) => c.share), 0.0001);
  return h('div', { class: 'ex-card gr-cp-channels' },
    cardHead('channelPerformance', t('gr.cp.channels.title')),
    h('div', { class: 'gr-cp-chrows' }, d.channels.map((c, i) => h('div', { class: 'gr-cp-chrow' },
      channelMark(c.id),
      h('div', { class: 'gr-cp-chmain' },
        h('div', { class: 'gr-cp-chname' }, h('span', null, c.name), h('span', { class: 'gr-muted' }, money(c.revenue))),
        h('div', { class: 'ex-bar' }, h('i', { class: i === 0 ? 'first' : '', style: `width:${Math.max(3, Math.round((c.share / max) * 100))}%` })),
        h('div', { class: 'gr-muted gr-cp-chsub' }, c.roas == null ? t('gr.cp.channels.noSpend') : t('gr.cp.channels.spendRoas', money(c.spend), new Intl.NumberFormat(tag(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(c.roas)))),
      h('strong', { class: 'gr-cp-chpct' }, `${Math.round(c.share * 100)} %`)))),
    h('div', { class: 'ex-foot' }, t('gr.cp.channels.foot', money(d.kpis.revenue.value))));
}

function renderCampaigns(main, safe) {
  main.appendChild(safe(cpKpiRow));
  main.appendChild(h('div', { class: 'gr-cp-trend-row' }, safe(cpTrendCard)));
  main.appendChild(h('div', { class: 'gr-grid-pipe gr-grid-cp' }, safe(campaignsTableCard), h('div', { class: 'gr-stack' }, safe(cpActionsCard), safe(cpChannelsCard))));
}
