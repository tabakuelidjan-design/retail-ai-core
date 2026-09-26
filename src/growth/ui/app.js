'use strict';
// Nordla Growth - shell (navigation, top bar, router) + Growth Overview page; the Opportunités page lives in
// opportunities.js. Plain DOM, no framework, same conventions as Analytics Premium:
// every visual is an existing Nordla component (Analytics' ex-* cards/tabs/KPI tiles/tables, the shared rail,
// NordlaCharts, NordlaIcon); growth.css only adds the Growth grid and the few list rows Analytics has no
// equivalent for. All copy goes through NORDLA_I18N.t() (lang-fr/nl/en.js); demo content carries its own
// fr/nl/en strings. The data is DEMONSTRATION data (payload.demo === true) and the page always says so.

const t = NORDLA_I18N.t;

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') { if (v != null) el.className = v; }
    else if (k === 'style') el.style.cssText = v; // CSSOM, allowed by the strict CSP (no inline style attributes)
    else if (k === 'on' && v) for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
// Same stroke arrows as Analytics' exDelta() (icon('up'/'down')).
function arrow(dir, size = 13) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  for (const d of dir === 'up' ? ['M7 17L17 7', 'M9 7h8v8'] : ['M7 7L17 17', 'M9 17h8v-8']) { const p = document.createElementNS(s.namespaceURI, 'path'); p.setAttribute('d', d); s.appendChild(p); }
  return s;
}

// ---------- icons ----------
// Two official sources only (no other icon library):
//  1. The Nordla Growth Icon Pack (final), Growth's own icons: src/growth/ui/assets/icons/, served at /growth-assets/icons/.
//     Files are transparent 256px exports of the supplied 1254px originals (downscaled only: never redrawn, recoloured or
//     cropped).
//  2. The shared official Nordla icons (NordlaIcon.semantic) for generic business concepts (revenue, stock, ...).
const GROWTH_PACK = {
  overview: 'growth-overview', opportunities: 'opportunities', campaigns: 'campaigns', content: 'content',
  storeGrowth: 'store-growth', audience: 'audience', experiments: 'experiments', settings: 'settings',
  aiInsights: 'ai-insights', needsAttention: 'needs-attention', approvals: 'approvals',
};
const ICON_PX = { sm: 16, md: 20, lg: 28 };
function packIcon(file, size) {
  const img = document.createElement('img');
  img.src = `/growth-assets/icons/${file}.png`;
  img.width = img.height = ICON_PX[size] || ICON_PX.md;
  img.className = `nordla-icon nordla-icon-${ICON_PX[size] ? size : 'md'} gr-pack-icon`;
  img.alt = ''; img.setAttribute('aria-hidden', 'true');
  return img;
}
// Growth concept -> 'pack:<key>' (Growth pack) or an official Nordla icon name.
const GROWTH_ICONS = {
  // navigation
  overview: 'pack:overview', opportunities: 'pack:opportunities', campaigns: 'pack:campaigns', content: 'pack:content',
  storeGrowth: 'pack:storeGrowth', audience: 'pack:audience', experiments: 'pack:experiments', settings: 'pack:settings',
  // Overview page
  revenueInfluenced: 'chiffreAffaires', activeOpportunities: 'pack:opportunities', topOpportunities: 'pack:opportunities',
  activeCampaigns: 'pack:campaigns', roas: 'croissance', experimentsRunning: 'pack:experiments', aiInsights: 'pack:aiInsights',
  needsAttention: 'pack:needsAttention', growthPulse: 'croissance', channelPerformance: 'croissance', contentPerformance: 'meilleurProduit',
  // Opportunités page
  potentialRevenue: 'chiffreAffaires', approvals: 'pack:approvals', inProgress: 'synchronisation', wins: 'meilleurProduit',
  impactEffort: 'croissance', segments: 'pack:audience',
  // Row icons, chosen from the data item's `kind` (the data source never names icons: presentation stays in the UI).
  insightMomentum: 'produitEnHausse', insightCampaign: 'croissance', insightTraffic: 'ventes', insightStock: 'stock',
  attentionApproval: 'approval', attentionOpportunity: 'stock', attentionExperiment: 'calendrier',
  opportunityTraffic: 'ventes', opportunityStock: 'stock', opportunityCustomers: 'segmentClient',
  recoStock: 'stock', recoCampaign: 'croissance', recoSegment: 'segmentClient', recoStore: 'pack:storeGrowth',
};
const kindIcon = (group, kind) => `${group}${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
function gi(name, size = 'md') {
  const v = GROWTH_ICONS[name] || name;
  return v.startsWith('pack:') ? packIcon(GROWTH_PACK[v.slice(5)], size) : NordlaIcon.semantic(v, size);
}

// ---------- formatting (same rules as Analytics' Explorer: Intl per language, whole euros, "+28 %") ----------
const LANG_TAG = { fr: 'fr-BE', nl: 'nl-BE', en: 'en-GB' };
const tag = () => LANG_TAG[NORDLA_I18N.getLang()] || 'fr-BE';
const loc = (o) => (o && typeof o === 'object' ? o[NORDLA_I18N.getLang()] ?? o.fr : o);
// Currency comes from the current page's payload, never assumed by the UI.
const cur = () => ((PAGES[currentPage()].get() || {}).currency) || 'EUR';
const money = (v) => new Intl.NumberFormat(tag(), { style: 'currency', currency: cur(), maximumFractionDigits: 0 }).format(v);
const compactMoney = (v) => new Intl.NumberFormat(tag(), { style: 'currency', currency: cur(), notation: 'compact', maximumFractionDigits: 1 }).format(v);
const num = (v) => new Intl.NumberFormat(tag(), { maximumFractionDigits: 0 }).format(v);
const compactNum = (v) => new Intl.NumberFormat(tag(), { notation: 'compact', maximumFractionDigits: 1 }).format(v);
const pct1 = (v) => new Intl.NumberFormat(tag(), { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);
const signedPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))} %`;
const roasFmt = (v) => (v == null ? t('gr.dash') : `${new Intl.NumberFormat(tag(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v)}x`);
const dayFmt = (isoDate, withYear) => new Date(`${isoDate}T00:00:00Z`).toLocaleDateString(tag(), { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/** Delta line: same markup/classes as Analytics' exDelta() (a real comparison coloured, the rest neutral). */
function delta(pct) {
  const up = pct >= 0;
  return h('div', { class: `ex-delta ${up ? 'up' : 'down'}` }, arrow(up ? 'up' : 'down'), h('strong', null, signedPct(pct)), h('span', null, t('gr.vsPrevious')));
}
const chip = (text, tone) => h('span', { class: `ex-chip${tone ? ` ${tone}` : ''}` }, text);
const cardHead = (iconName, title, right) => h('div', { class: 'ex-card-head' }, h('h3', { class: 'gr-card-title' }, iconName ? gi(iconName) : null, title), right || null);
const icoBubble = (iconName) => h('span', { class: 'gr-ico' }, gi(iconName));

// ---------- Growth navigation (this module's own menu) ----------
// Growth is a standalone Nordla module: like Finance and Analytics it has its own navigation and needs no other module
// to work. It shares the Nordla design system with them: same rail component and tokens (.sidebar/.nav-item,
// --nordla-menu-*; <html data-module="growth"> selects Growth's menu colour). Built pages have an href (hash routes of
// this module only); the others are visibly disabled ("coming soon"), never a dead link. `mobile: true` = one of the 5
// entries of the mobile bottom bar (same density as Analytics); the others are desktop-only while they are not built.
const GROWTH_NAV = [
  { key: 'overview', icon: 'overview', href: '#/', mobile: true },
  { key: 'opportunities', icon: 'opportunities', href: '#/opportunities', mobile: true },
  { key: 'campaigns', icon: 'campaigns', mobile: true },
  { key: 'content', icon: 'content', mobile: true },
  { key: 'storeGrowth', icon: 'storeGrowth' },
  { key: 'audience', icon: 'audience' },
  { key: 'experiments', icon: 'experiments' },
];
// Secondary zone (bottom of the rail). Nordla AI keeps the official "Parle à Nordla" asset, as in Analytics.
const GROWTH_NAV_FOOT = [
  { key: 'ai', parle: true, mobile: true },
  { key: 'settings', icon: 'settings' },
];
function navItem(n, active) {
  const ico = h('span', { class: 'ico' }, n.parle ? NordlaIcon.parle('onTerracotta', 'md') : gi(n.icon, 'md'));
  const on = n.key === active;
  const cls = `nav-item${on ? ' active' : ''}${n.href ? '' : ' inert'}${n.mobile ? '' : ' gr-desktop-only'}${n.parle ? ' gr-ai' : ''}`;
  return n.href
    ? h('a', { class: cls, href: n.href, ...(on ? { 'aria-current': 'page' } : {}) }, ico, t(`gr.nav.${n.key}`))
    : h('span', { class: cls, title: t('gr.nav.soon'), 'aria-disabled': 'true' }, ico, t(`gr.nav.${n.key}`));
}
function sidebar(active) {
  return h('nav', { class: 'sidebar', 'aria-label': t('gr.nav.aria') },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }), h('div', { class: 'brand-name' }, t('gr.brand'))),
    h('div', { class: 'nav' }, GROWTH_NAV.map((n) => navItem(n, active))),
    h('div', { class: 'nav gr-nav-foot' }, GROWTH_NAV_FOOT.map((n) => navItem(n, active))));
}

function langSwitch() {
  const NAMES = { fr: 'Français', nl: 'Nederlands', en: 'English' };
  return h('div', { class: 'langswitch', role: 'group', 'aria-label': 'Interface language' },
    NORDLA_I18N.SUPPORTED.map((l) => h('button', { type: 'button', class: NORDLA_I18N.getLang() === l ? 'on' : '', title: NAMES[l], on: { click: () => { NORDLA_I18N.setLang(l); render(); } } }, l.toUpperCase())));
}

function topbar(d) {
  return h('div', { class: 'topbar' },
    h('div', { class: 'topbar-title' }, t('gr.brand')),
    h('div', { class: 'topbar-right' },
      d && d.demo ? h('span', { class: 'wc-pill partial gr-demo', title: t('gr.demoTitle') }, h('span', { class: 'gr-demo-long' }, t('gr.demo')), h('span', { class: 'gr-demo-short', 'aria-hidden': 'true' }, t('gr.demoShort'))) : null,
      h('span', { class: 'period-pill locked', title: t('gr.period.fixedNote'), 'aria-disabled': 'true' }, NordlaIcon.semantic('calendrier', 'sm'), t('gr.period.last30'), h('span', { class: 'period-fixed' }, t('gr.period.fixed'))),
      langSwitch()));
}

// ---------- KPI row (Analytics' ex-kpi tile) ----------
function kpi(iconName, label, value, line) {
  return h('div', { class: 'ex-kpi' },
    h('span', { class: 'ex-kpi-ico' }, gi(iconName, 'lg')),
    h('div', { class: 'ex-kpi-body' }, h('div', { class: 'ex-kpi-label' }, label), h('div', { class: 'ex-kpi-value' }, value), line));
}
const kpiNote = (count, text, tone) => h('div', { class: `ex-delta gr-kpi-note${tone ? ` ${tone}` : ''}` }, h('strong', null, String(count)), h('span', null, text));
function kpiRow(d) {
  const k = d.kpis;
  return h('div', { class: 'ex-kpi-row gr-kpi-row' },
    kpi('revenueInfluenced', t('gr.kpi.revenueInfluenced'), money(k.revenueInfluenced.value), delta(k.revenueInfluenced.deltaPct)),
    kpi('activeOpportunities', t('gr.kpi.activeOpportunities'), num(k.activeOpportunities.value), kpiNote(k.activeOpportunities.highPriority, t('gr.kpi.highPriority'), 'warn')),
    kpi('activeCampaigns', t('gr.kpi.activeCampaigns'), num(k.activeCampaigns.value), kpiNote(k.activeCampaigns.performingWell, t('gr.kpi.performingWell'), 'good')),
    kpi('roas', t('gr.kpi.roas'), roasFmt(k.roas.value), delta(k.roas.deltaPct)),
    kpi('experimentsRunning', t('gr.kpi.experimentsRunning'), num(k.experimentsRunning.value), kpiNote(k.experimentsRunning.endingThisWeek, t('gr.kpi.endingThisWeek'))));
}

// ---------- Growth Pulse (NordlaCharts.trendLines / trendLine, the Analytics/Finance chart components) ----------
// Revenue and store visitors have different units, so they are never drawn on one axis: a selector switches the view.
let pulseView = 'revenue';
function pulseCard(d) {
  const p = d.pulse; const labels = p.dates.map((x) => dayFmt(x));
  const sel = h('select', { class: 'ex-select', 'aria-label': t('gr.pulse.metric'), on: { change: (e) => { pulseView = e.target.value; render(); } } },
    ['revenue', 'traffic'].map((v) => h('option', { value: v, ...(v === pulseView ? { selected: 'selected' } : {}) }, t(`gr.pulse.${v}`))));
  let head; let chart;
  if (pulseView === 'traffic') {
    head = NordlaCharts.head({ title: t('gr.pulse.visitors'), value: num(p.totals.storeVisitors), delta: Math.round(p.deltas.storeVisitors * 1000) / 10, good: p.deltas.storeVisitors >= 0, vs: t('gr.vsPrevious') });
    chart = NordlaCharts.trendLine(p.storeVisitors.map((v, i) => ({ label: labels[i], value: v })), { format: compactNum, height: 230, label: t('gr.pulse.visitors') });
  } else {
    head = NordlaCharts.head({ title: t('gr.pulse.influenced'), value: money(p.totals.influencedRevenue), delta: Math.round(p.deltas.influencedRevenue * 1000) / 10, good: p.deltas.influencedRevenue >= 0, vs: t('gr.vsPrevious') });
    chart = NordlaCharts.trendLines([
      { name: t('gr.pulse.total'), cls: 'c1', values: p.totalRevenue },
      { name: t('gr.pulse.influenced'), cls: 'c2', values: p.influencedRevenue },
    ], labels, { format: compactMoney, height: 230, label: t('gr.pulse.title') });
  }
  const aside = pulseView === 'revenue'
    ? h('div', { class: 'gr-pulse-aside' }, h('span', null, t('gr.pulse.total')), h('strong', null, money(p.totals.totalRevenue)), h('span', { class: 'gr-muted' }, t('gr.pulse.share', Math.round((p.totals.influencedRevenue / p.totals.totalRevenue) * 100))))
    : null;
  return h('div', { class: 'ex-card gr-pulse' },
    cardHead('growthPulse', t('gr.pulse.title'), sel),
    h('div', { class: 'gr-pulse-top' }, head, aside),
    chart,
    h('div', { class: 'ex-foot' }, t('gr.pulse.foot', dayFmt(d.period.from), dayFmt(d.period.to, true))));
}

// ---------- AI insights (Nordla AI as an integrated layer, not a chat) ----------
function insightsCard(d) {
  return h('div', { class: 'ex-card gr-ai' },
    h('div', { class: 'ex-card-head' }, h('h3', { class: 'gr-card-title' }, gi('aiInsights'), t('gr.ai.title')), chip(t('gr.ai.badge'), 'mute')),
    h('div', { class: 'ex-movers' }, d.insights.map((i) => h('div', { class: 'ex-mover gr-row' },
      icoBubble(kindIcon('insight', i.kind)),
      h('div', { class: 'ex-mover-main' }, h('div', { class: 'ex-mover-name' }, loc(i.title)), h('div', { class: 'ex-mover-sub gr-wrap' }, loc(i.text))),
      h('span', { class: `gr-dot ${i.tone}`, 'aria-hidden': 'true' })))),
    h('div', { class: 'ex-foot' }, t('gr.ai.foot')));
}

// ---------- Needs your attention (actions become real with the Approvals page; disabled until then) ----------
const ATT_TONE = { pending: '', new: 'mute', endingSoon: 'gr-warn' };
function attentionCard(d) {
  return h('div', { class: 'ex-card gr-att' },
    cardHead('needsAttention', t('gr.att.title'), chip(String(d.attention.length), '')),
    h('div', { class: 'ex-movers' }, d.attention.map((a) => h('div', { class: 'ex-mover gr-row gr-att-row' },
      icoBubble(kindIcon('attention', a.kind)),
      h('div', { class: 'ex-mover-main' },
        h('div', { class: 'ex-mover-name' }, loc(a.title)),
        h('div', { class: 'ex-mover-sub' }, loc(a.sub)),
        h('div', { class: 'gr-att-meta' }, chip(t(`gr.att.status.${a.status}`), ATT_TONE[a.status]), h('span', { class: 'gr-muted' }, dayFmt(a.date)),
          h('button', { type: 'button', class: 'btn-outline gr-action', disabled: 'disabled', title: t('gr.att.soon') }, t(`gr.att.action.${a.action}`))))))));
}

// ---------- Channel performance (Analytics' ex-table) ----------
// Channel logos: files of the Nordla Growth Icon Pack v2 (channels/), 128px transparent exports in
// src/growth/ui/assets/channels/, served at /growth-assets/channels/<file>. Never redrawn, never downloaded.
// CHANNEL_FALLBACK: the monogram shown only for a channel without a logo file or if its file fails to load.
const CHANNEL_LOGOS = { 'google-search': 'google-search.png', instagram: 'instagram.png', tiktok: 'tiktok.png', facebook: 'facebook.png', 'google-business': 'google-business.png' };
const CHANNEL_FALLBACK = { 'google-search': 'G', instagram: 'IG', tiktok: 'TT', facebook: 'FB', 'google-business': 'GB' };
const fallbackMark = (id) => h('span', { class: 'gr-ch gr-ch-fallback', 'data-channel': id, 'aria-hidden': 'true' }, CHANNEL_FALLBACK[id] || '·');
// Channel display names come from the payload (data.channels), not from the UI.
const channelName = (id) => ((data && data.channels.find((c) => c.id === id)) || {}).name || id;
function channelMark(id) {
  const file = CHANNEL_LOGOS[id];
  if (!file) return fallbackMark(id);
  const img = h('img', { class: 'gr-ch gr-ch-logo', src: `/growth-assets/channels/${file}`, alt: '', 'aria-hidden': 'true' });
  img.addEventListener('error', () => img.replaceWith(fallbackMark(id)));
  return img;
}
function channelCard(d) {
  const rows = d.channels.map((c) => h('tr', null,
    h('td', null, h('span', { class: 'gr-ch-cell' }, channelMark(c.id), h('span', null, c.name))),
    h('td', { class: 'num' }, h('strong', null, money(c.revenue))),
    h('td', { class: 'num' }, compactNum(c.reach), h('span', { class: 'gr-unit' }, t(`gr.ch.unit.${c.reachKind}`))),
    h('td', { class: 'num' }, c.conversion == null ? t('gr.dash') : pct1(c.conversion)),
    h('td', { class: 'num' }, c.roas == null ? h('span', { class: 'gr-muted' }, t('gr.ch.organic')) : h('strong', null, roasFmt(c.roas)))));
  return h('div', { class: 'ex-card gr-channels' },
    cardHead('channelPerformance', t('gr.ch.title')),
    h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table gr-table' },
      h('thead', null, h('tr', null, h('th', null, t('gr.ch.channel')), h('th', { class: 'num' }, t('gr.ch.revenue')), h('th', { class: 'num' }, t('gr.ch.reach')), h('th', { class: 'num' }, t('gr.ch.conversion')), h('th', { class: 'num' }, t('gr.ch.roas')))),
      h('tbody', null, rows))),
    h('div', { class: 'ex-foot' }, t('gr.ch.foot')));
}

// ---------- Campaigns ----------
const CAMP_TONE = { performing: 'gr-good', active: 'mute', watch: 'gr-warn' };
function campaignsCard(d) {
  return h('div', { class: 'ex-card gr-camps' },
    cardHead('campaigns', t('gr.camp.title'), chip(t('gr.camp.activeCount', d.campaigns.length), 'mute')),
    h('div', { class: 'ex-movers' }, d.campaigns.map((c) => {
      const pct = c.budget ? Math.min(100, Math.round((c.spend / c.budget) * 100)) : 0;
      return h('div', { class: 'ex-mover gr-row' },
        channelMark(c.channel),
        h('div', { class: 'ex-mover-main' },
          h('div', { class: 'ex-mover-name' }, loc(c.name)),
          c.budget
            ? h('div', null, h('div', { class: 'ex-bar gr-budget' }, h('i', { class: 'first', style: `width:${Math.max(3, pct)}%` })), h('div', { class: 'ex-mover-sub' }, t('gr.camp.spend', money(c.spend), money(c.budget))))
            : h('div', { class: 'ex-mover-sub' }, t('gr.camp.noBudget'))),
        h('div', { class: 'gr-side' }, chip(t(`gr.camp.status.${c.status}`), CAMP_TONE[c.status]),
          h('strong', null, c.roas == null ? t('gr.dash') : t('gr.camp.roas', roasFmt(c.roas))),
          h('span', { class: 'gr-muted' }, c.conversions == null ? t('gr.camp.actions', num(c.reach)) : t('gr.camp.conversions', num(c.conversions)))));
    })));
}

// ---------- Content performance ----------
const PERF_TONE = { best: 'gr-good', good: 'mute', below: 'gr-warn' };
function contentCard(d) {
  return h('div', { class: 'ex-card gr-content' },
    cardHead('contentPerformance', t('gr.content.title')),
    h('div', { class: 'ex-movers' }, d.content.map((c) => h('div', { class: 'ex-mover gr-row' },
      // PLACEHOLDER thumbnail: Analytics' neutral swatch + channel mark until real content thumbnails come from the data source
      // (never a stock or look-alike image).
      h('div', { class: 'rank-thumb gr-thumb' }, channelMark(c.channel)),
      h('div', { class: 'ex-mover-main' }, h('div', { class: 'ex-mover-name' }, loc(c.title)), h('div', { class: 'ex-mover-sub' }, `${channelName(c.channel)} · ${t(`gr.content.kind.${c.kind}`)}`)),
      h('div', { class: `ex-mover-delta ${c.deltaPct >= 0 ? 'up' : 'down'}` },
        h('strong', { class: 'gr-ink' }, t('gr.content.views', compactNum(c.views))),
        h('span', null, signedPct(c.deltaPct)),
        chip(t(`gr.content.perf.${c.performance}`), PERF_TONE[c.performance]))))));
}

// ---------- Store growth (NordlaCharts.sparkline = Analytics' KPI sparkline) ----------
function storeMetric(label, value, deltaEl, series) {
  return h('div', { class: 'gr-store-metric' },
    h('div', { class: 'ex-kpi-label' }, label),
    h('div', { class: 'gr-store-value' }, value),
    deltaEl,
    h('div', { class: 'kpi-spark' }, NordlaCharts.sparkline(series)));
}
function storeCard(d) {
  const s = d.store;
  const pp = s.conversion.deltaPp;
  const ppLine = h('div', { class: `ex-delta ${pp >= 0 ? 'up' : 'down'}` }, arrow(pp >= 0 ? 'up' : 'down'), h('strong', null, t('gr.store.pts', `${pp >= 0 ? '+' : '−'}${new Intl.NumberFormat(tag(), { maximumFractionDigits: 1 }).format(Math.abs(pp))}`)), h('span', null, t('gr.vsPrevious')));
  return h('div', { class: 'ex-card gr-store' },
    cardHead('storeGrowth', t('gr.store.title')),
    h('div', { class: 'gr-store-grid' },
      storeMetric(t('gr.store.traffic'), num(s.traffic.value), delta(s.traffic.deltaPct), s.traffic.series),
      storeMetric(t('gr.store.conversion'), pct1(s.conversion.value), ppLine, s.conversion.series),
      storeMetric(t('gr.store.revenue'), money(s.revenue.value), delta(s.revenue.deltaPct), s.revenue.series)));
}

// ---------- Top opportunities ----------
const PRIO_TONE = { high: '', medium: 'mute' };
function opportunitiesCard(d) {
  return h('div', { class: 'ex-card gr-opps' },
    cardHead('topOpportunities', t('gr.opp.title')),
    h('div', { class: 'ex-movers' }, d.opportunities.map((o) => h('div', { class: 'ex-mover gr-row' },
      icoBubble(kindIcon('opportunity', o.kind)),
      h('div', { class: 'ex-mover-main' },
        h('div', { class: 'ex-mover-name' }, loc(o.title)),
        h('div', { class: 'ex-mover-sub' }, t('gr.opp.source', loc(o.source))),
        h('div', { class: 'gr-att-meta' }, chip(t(`gr.opp.priority.${o.priority}`), PRIO_TONE[o.priority]), h('span', { class: 'gr-muted' }, t(`gr.opp.status.${o.status}`)))),
      h('div', { class: 'gr-side' }, h('strong', { class: 'gr-pos' }, `+${money(o.estimate)}`), h('span', { class: 'gr-muted' }, t('gr.opp.estimate')))))),
    h('div', { class: 'ex-foot' }, t('gr.opp.foot')));
}

// ---------- Experiments ----------
const EXP_TONE = { running: 'mute', endingSoon: 'gr-warn' };
function experimentsCard(d) {
  return h('div', { class: 'ex-card gr-exps' },
    cardHead('experiments', t('gr.exp.title')),
    h('div', { class: 'ex-movers' }, d.experiments.map((x) => h('div', { class: 'ex-mover gr-row' },
      icoBubble('experiments'),
      h('div', { class: 'ex-mover-main' },
        h('div', { class: 'ex-mover-name' }, loc(x.name)),
        h('div', { class: 'ex-mover-sub' }, t('gr.exp.kpi', loc(x.kpi))),
        h('div', { class: 'gr-att-meta' }, chip(t(`gr.exp.status.${x.status}`), EXP_TONE[x.status]), h('span', { class: 'gr-muted' }, t('gr.exp.duration', daysBetween(x.start, x.end))))),
      h('div', { class: 'gr-side' }, h('span', { class: 'gr-muted' }, t('gr.exp.ends')), h('strong', null, dayFmt(x.end)))))));
}

// ---------- pages + router ----------
// Hash routes inside Growth only: '#/' = Overview, '#/opportunities' = Opportunités. Each page's payload is fetched once
// and cached; a language or filter change re-renders from the cache.
let data = null; let oppData = null; const loadFailed = {};
const PAGES = {
  overview: { title: 'gr.title', subtitle: 'gr.subtitle', url: '/api/growth/overview', get: () => data, set: (v) => { data = v; }, render: renderOverview },
  opportunities: { title: 'gr.op.title', subtitle: 'gr.op.subtitle', url: '/api/growth/opportunities', get: () => oppData, set: (v) => { oppData = v; }, render: renderOpportunities },
};
function currentPage() { return location.hash.replace(/^#\/?/, '') === 'opportunities' ? 'opportunities' : 'overview'; }

function renderOverview(main, safe) {
  main.appendChild(safe(kpiRow));
  main.appendChild(h('div', { class: 'gr-grid gr-grid-main' }, safe(pulseCard), safe(insightsCard), safe(attentionCard)));
  main.appendChild(h('div', { class: 'gr-grid gr-grid-wide' }, safe(channelCard), safe(campaignsCard), safe(contentCard)));
  main.appendChild(h('div', { class: 'gr-grid gr-grid-wide' }, safe(storeCard), safe(opportunitiesCard), safe(experimentsCard)));
}

function render() {
  const key = currentPage(); const page = PAGES[key]; const d = page.get();
  document.documentElement.lang = NORDLA_I18N.getLang();
  const app = document.getElementById('app');
  const main = h('main', { class: 'main gr-main' });
  app.replaceChildren(h('div', { class: 'shell' }, sidebar(key), main));
  main.appendChild(topbar(d));
  main.appendChild(h('div', { class: 'ex-head' }, h('div', null, h('h1', { class: 'ex-title' }, t(page.title)), h('p', { class: 'ex-sub' }, t(page.subtitle)))));
  if (!d) { main.appendChild(h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('gr.noData'), loadFailed[key] ? t('gr.loadError') : ''))); return; }
  // Each section is built on its own: a failing section is replaced by an empty state, the rest of the page still renders.
  const safe = (fn) => { try { return fn(d); } catch (e) { console.error('growth section failed', e); return h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('gr.noData'), '')); } };
  page.render(main, safe);
}

async function route() {
  const key = currentPage(); const page = PAGES[key];
  render();
  if (!page.get()) {
    try { const r = await fetch(page.url); if (r.ok) page.set(await r.json()); else loadFailed[key] = true; } catch (e) { loadFailed[key] = true; }
    if (currentPage() === key) render();
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();
