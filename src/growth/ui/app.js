'use strict';
// Nordla Growth - shell (navigation, top bar, router) + Growth Overview page; the Opportunités page lives in
// opportunities.js and the Campagnes page in campaigns.js. Plain DOM, no framework, same conventions as Analytics Premium:
// every visual is an existing Nordla component (Analytics' ex-* cards/tabs/KPI tiles/tables, the shared rail,
// NordlaCharts, NordlaIcon); growth.css only adds the Growth grid and the few list rows Analytics has no
// equivalent for. All copy goes through NORDLA_I18N.t() (lang-fr/nl/en.js); demo content carries its own
// fr/nl/en strings. Vue d'ensemble: campaign figures come from Campagnes (demonstration data, badged), store sales are real,
// every other figure shows "Source non connectée". Opportunités: no source connected yet, stated card by card.

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
  // Opportunités detail icons (Nordla_Opportunities_Icons_Separate).
  priorityHigh: 'priority-high', confidence: 'confidence', effort: 'effort', local: 'local', students: 'students',
  gifts: 'gifts', business: 'business', returningCustomers: 'returning-customers', impactEffort: 'impact-effort',
  pipelineStatus: 'pipeline-status', revenueBySource: 'revenue-by-source',
  clicks: 'clicks', goalAwareness: 'goal-awareness', goalRecruitment: 'goal-recruitment',
  collectionAutumn: 'collection-autumn', bundle: 'bundle', loyalty: 'loyalty', newArrivals: 'new-arrivals',
  retargeting: 'retargeting', tutorial: 'tutorial',
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
  impactEffort: 'pack:impactEffort', segments: 'pack:audience', priorityHigh: 'pack:priorityHigh', confidence: 'pack:confidence',
  effort: 'pack:effort', pipelineStatus: 'pack:pipelineStatus', revenueBySource: 'pack:revenueBySource',
  // Opportunity sources and segments, by the data item's id/kind (the data never names icons).
  srcStore: 'pack:storeGrowth', srcStock: 'stock', srcMarket: 'croissance', srcAi: 'pack:aiInsights', srcCustomers: 'segmentClient',
  srcExperiment: 'pack:experiments', srcSeasonality: 'calendrier', srcSales: 'ventes', srcLocal: 'pack:local', srcMargin: 'margeBrute',
  segStudents: 'pack:students', segGifts: 'pack:gifts', segLocal: 'pack:local', segBusiness: 'pack:business', segReturning: 'pack:returningCustomers',
  // Campagnes page
  campaignRevenue: 'chiffreAffaires', newCustomers: 'nouveauClient', clicks: 'pack:clicks',
  // Campaign thumbnail = the icon of what the campaign is about (its `theme`), one per real concept, until real campaign
  // visuals come from the source. Never a generic icon repeated across unrelated campaigns.
  themeCollection: 'pack:collectionAutumn', themeStudents: 'pack:students', themeChallenge: 'pack:goalAwareness',
  themeGifts: 'pack:gifts', themeStoreOpening: 'pack:storeGrowth', themeBundle: 'pack:bundle', themeLoyalty: 'pack:loyalty',
  themeRecruitment: 'pack:goalRecruitment', themeBrandSearch: 'recherche', themeNewArrivals: 'pack:newArrivals',
  themeRetargeting: 'pack:retargeting', themeTutorial: 'pack:tutorial',
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
// this module only); the others are visibly disabled ("coming soon"), never a dead link.
// Mobile (owner decision 2026-09-28): the bottom bar has 6 slots max - the 5 central pages (`mobile: true`) + "Plus", which
// opens a panel with every other entry (`more: true`: built pages as links, the others disabled). No built page is ever
// unreachable on mobile. The desktop rail is unchanged.
const GROWTH_NAV = [
  { key: 'overview', icon: 'overview', href: '#/', mobile: true },
  { key: 'opportunities', icon: 'opportunities', href: '#/opportunities', mobile: true },
  { key: 'campaigns', icon: 'campaigns', href: '#/campaigns', mobile: true },
  // Produits Potentiels: official "produits" icon until a dedicated Growth pack icon exists.
  { key: 'potential', icon: 'produits', href: '#/potential', mobile: true },
  { key: 'content', icon: 'content', href: '#/content', more: true },
  { key: 'storeGrowth', icon: 'storeGrowth', href: '#/storeGrowth', more: true },
  { key: 'audience', icon: 'audience', href: '#/audience', mobile: true },
  { key: 'experiments', icon: 'experiments', more: true },
];
// Secondary zone (bottom of the rail). Nordla AI keeps the official "Parle à Nordla" asset, as in Analytics.
const GROWTH_NAV_FOOT = [
  // Nordla AI and Paramètres (not built yet, disabled): desktop rail + the mobile "Plus" panel.
  { key: 'ai', parle: true, more: true },
  { key: 'settings', icon: 'settings', more: true },
];
function navItem(n, active) {
  const ico = h('span', { class: 'ico' }, n.parle ? NordlaIcon.parle('onTerracotta', 'md') : gi(n.icon, 'md'));
  const on = n.key === active;
  const cls = `nav-item${on ? ' active' : ''}${n.href ? '' : ' inert'}${n.mobile ? '' : ' gr-desktop-only'}${n.parle ? ' gr-ai' : ''}`;
  return n.href
    ? h('a', { class: cls, href: n.href, ...(on ? { 'aria-current': 'page' } : {}) }, ico, t(`gr.nav.${n.key}`))
    : h('span', { class: cls, title: t('gr.nav.soon'), 'aria-disabled': 'true' }, ico, t(`gr.nav.${n.key}`));
}
// ---- mobile "Plus" menu (only shown below 901px) ----
let navMoreOpen = false;
const MORE_ITEMS = () => [...GROWTH_NAV, ...GROWTH_NAV_FOOT].filter((n) => n.more);
function moreDots() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '20'); s.setAttribute('height', '20'); s.setAttribute('aria-hidden', 'true');
  for (const cx of [5, 12, 19]) { const c = document.createElementNS(s.namespaceURI, 'circle'); c.setAttribute('cx', cx); c.setAttribute('cy', '12'); c.setAttribute('r', '2.2'); c.setAttribute('fill', 'currentColor'); s.appendChild(c); }
  return s;
}
function setMoreOpen(open, focusBack) {
  navMoreOpen = open; render();
  if (open) { const first = document.querySelector('.gr-more-panel a, .gr-more-panel .gr-more-close'); if (first && first.focus) first.focus(); }
  else if (focusBack) { const b = document.querySelector('.gr-more-btn'); if (b && b.focus) b.focus(); }
}
function moreButton(active) {
  const inMore = MORE_ITEMS().some((n) => n.key === active);
  return h('button', { type: 'button', class: `nav-item gr-more-btn${inMore ? ' active' : ''}${navMoreOpen ? ' open' : ''}`, 'aria-haspopup': 'dialog', 'aria-expanded': navMoreOpen ? 'true' : 'false', 'aria-controls': 'gr-more-panel', ...(inMore ? { 'aria-current': 'page' } : {}), on: { click: () => setMoreOpen(!navMoreOpen) } },
    h('span', { class: 'ico gr-more-ico' }, moreDots()), t('gr.nav.more'));
}
function morePanel(active) {
  if (!navMoreOpen) return null;
  const item = (n) => {
    const on = n.key === active;
    const ico = h('span', { class: 'gr-more-item-ico' }, n.parle ? NordlaIcon.parle('onTerracotta', 'md') : gi(n.icon, 'md'));
    return n.href
      ? h('a', { class: `gr-more-item${on ? ' active' : ''}`, href: n.href, ...(on ? { 'aria-current': 'page' } : {}), on: { click: () => { navMoreOpen = false; } } }, ico, h('span', { class: 'gr-more-item-label' }, t(`gr.nav.${n.key}`)))
      : h('span', { class: 'gr-more-item inert', 'aria-disabled': 'true' }, ico, h('span', { class: 'gr-more-item-label' }, t(`gr.nav.${n.key}`), h('span', { class: 'gr-more-soon' }, t('gr.nav.soon'))));
  };
  return h('div', { class: 'gr-more-wrap' },
    h('div', { class: 'gr-more-backdrop', on: { click: () => setMoreOpen(false, true) } }),
    h('div', { class: 'gr-more-panel', id: 'gr-more-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('gr.nav.moreTitle') },
      h('div', { class: 'gr-more-head' }, h('strong', null, t('gr.nav.moreTitle')), h('button', { type: 'button', class: 'gr-more-close', 'aria-label': t('gr.pp.close'), on: { click: () => setMoreOpen(false, true) } }, '×')),
      h('div', { class: 'gr-more-list' }, MORE_ITEMS().map(item))));
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && navMoreOpen) setMoreOpen(false, true); });
}
function sidebar(active) {
  return h('nav', { class: 'sidebar', 'aria-label': t('gr.nav.aria') },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }), h('div', { class: 'brand-name' }, t('gr.brand'))),
    h('div', { class: 'nav' }, GROWTH_NAV.map((n) => navItem(n, active)), moreButton(active)),
    h('div', { class: 'nav gr-nav-foot' }, GROWTH_NAV_FOOT.map((n) => navItem(n, active))));
}

function langSwitch() {
  const NAMES = { fr: 'Français', nl: 'Nederlands', en: 'English' };
  return h('div', { class: 'langswitch', role: 'group', 'aria-label': 'Interface language' },
    NORDLA_I18N.SUPPORTED.map((l) => h('button', { type: 'button', class: NORDLA_I18N.getLang() === l ? 'on' : '', title: NAMES[l], on: { click: () => { NORDLA_I18N.setLang(l); render(); } } }, l.toUpperCase())));
}

/**
 * Top bar. The period and the demo flag come from the PAGE definition (PAGES), not from the payload, so the pill is identical
 * while loading, on an error, on an empty page and on a full page. Each page's period is the window its engine really uses.
 */
function topbar(page) {
  const p = page.period;
  const pill = p.weeks
    ? h('span', { class: 'period-pill locked', title: t('gr.period.weeksNote', p.weeks), 'aria-disabled': 'true' }, NordlaIcon.semantic('calendrier', 'sm'), t('gr.period.lastWeeks', p.weeks), h('span', { class: 'period-fixed' }, t('gr.period.fixed')))
    : p.days === 30
      ? h('span', { class: 'period-pill locked', title: t('gr.period.fixedNote'), 'aria-disabled': 'true' }, NordlaIcon.semantic('calendrier', 'sm'), t('gr.period.last30'), h('span', { class: 'period-fixed' }, t('gr.period.fixed')))
      : h('span', { class: 'period-pill locked', title: t('gr.period.daysNote', p.days), 'aria-disabled': 'true' }, NordlaIcon.semantic('calendrier', 'sm'), t('gr.period.lastDays', p.days), h('span', { class: 'period-fixed' }, t('gr.period.fixed')));
  return h('div', { class: 'topbar' },
    h('div', { class: 'topbar-title' }, t('gr.brand')),
    h('div', { class: 'topbar-right' },
      page.demo ? h('span', { class: 'wc-pill partial gr-demo', title: t(page.demoTitle || 'gr.demoTitle') }, h('span', { class: 'gr-demo-long' }, t('gr.demo')), h('span', { class: 'gr-demo-short', 'aria-hidden': 'true' }, t('gr.demoShort'))) : null,
      pill,
      langSwitch()));
}

// ---------- KPI row (Analytics' ex-kpi tile) ----------
function kpi(iconName, label, value, line) {
  return h('div', { class: 'ex-kpi' },
    iconName ? h('span', { class: 'ex-kpi-ico' }, gi(iconName, 'lg')) : null,
    h('div', { class: 'ex-kpi-body' }, h('div', { class: 'ex-kpi-label' }, label), h('div', { class: 'ex-kpi-value' }, value), line));
}
// "Source non connectée": the honest state of a figure no Nordla source produces today (in a KPI note or inside a card).
const ncNote = () => h('div', { class: 'ex-kpi-note' }, t('gr.src.notConnected'));
const ncBody = (text) => h('div', { class: 'gr-pp-empty gr-nc' }, h('strong', { class: 'gr-ink' }, t('gr.src.notConnected')), h('span', null, text));
const kpiNote = (count, text, tone) => h('div', { class: `ex-delta gr-kpi-note${tone ? ` ${tone}` : ''}` }, h('strong', null, String(count)), h('span', null, text));
function kpiRow(d) {
  const k = d.kpis;
  return h('div', { class: 'ex-kpi-row gr-kpi-row' },
    k.revenueInfluenced ? kpi('revenueInfluenced', t('gr.kpi.revenueInfluenced'), money(k.revenueInfluenced.value), delta(k.revenueInfluenced.deltaPct)) : kpi('revenueInfluenced', t('gr.kpi.revenueInfluenced'), t('gr.dash'), ncNote()),
    k.activeOpportunities ? kpi('activeOpportunities', t('gr.kpi.activeOpportunities'), num(k.activeOpportunities.value), kpiNote(k.activeOpportunities.highPriority, t('gr.kpi.highPriority'), 'warn')) : kpi('activeOpportunities', t('gr.kpi.activeOpportunities'), t('gr.dash'), ncNote()),
    kpi('activeCampaigns', t('gr.kpi.activeCampaigns'), num(k.activeCampaigns.value), kpiNote(k.activeCampaigns.performingWell, t('gr.kpi.performingWell'), 'good')),
    kpi('roas', t('gr.kpi.roas'), roasFmt(k.roas.value), delta(k.roas.deltaPct)),
    // Expériences is not built: no running-experiment figure (never a demo count).
    kpi('experimentsRunning', t('gr.kpi.experimentsRunning'), k.experimentsRunning && k.experimentsRunning.value != null ? num(k.experimentsRunning.value) : t('gr.dash'), h('div', { class: 'ex-kpi-note' }, t('gr.kpi.experimentsSoon'))));
}

// ---------- Growth Pulse (NordlaCharts.trendLines / trendLine, the Analytics/Finance chart components) ----------
// Revenue and store visitors have different units, so they are never drawn on one axis: a selector switches the view.
let pulseView = 'revenue';
function pulseCard(d) {
  const p = d.pulse;
  const sel = h('select', { class: 'ex-select', 'aria-label': t('gr.pulse.metric'), on: { change: (e) => { pulseView = e.target.value; render(); } } },
    ['revenue', 'traffic'].map((v) => h('option', { value: v, ...(v === pulseView ? { selected: 'selected' } : {}) }, t(`gr.pulse.${v}`))));
  // No attribution source (revenue influenced by Growth) and no footfall source: stated in the same card, nothing drawn.
  if (!p) {
    return h('div', { class: 'ex-card gr-pulse' }, cardHead('growthPulse', t('gr.pulse.title'), sel),
      pulseView === 'traffic' ? NordlaCharts.insufficient(t('gr.pulse.visitorsNotConnected'), t('gr.pulse.visitorsNotConnectedText')) : NordlaCharts.insufficient(t('gr.src.notConnected'), t('gr.ov.nc.influenced')));
  }
  const labels = p.dates.map((x) => dayFmt(x));
  let head; let chart;
  if (pulseView === 'traffic') {
    // Store footfall is not connected: stated, never drawn (no demo visitors).
    head = null;
    chart = NordlaCharts.insufficient(t('gr.pulse.visitorsNotConnected'), t('gr.pulse.visitorsNotConnectedText'));
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
  if (!d.insights) {
    return h('div', { class: 'ex-card gr-ai' },
      h('div', { class: 'ex-card-head' }, h('h3', { class: 'gr-card-title' }, gi('aiInsights'), t('gr.ai.title')), chip(t('gr.ai.badge'), 'mute')),
      ncBody(t('gr.ov.nc.ai')));
  }
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
  if (!d.attention) return h('div', { class: 'ex-card gr-att' }, cardHead('needsAttention', t('gr.att.title')), ncBody(t('gr.ov.nc.attention')));
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
const channelName = (id) => {
  const pages = [PAGES[currentPage()].get(), data];
  for (const p of pages) { const c = p && Array.isArray(p.channels) && p.channels.find((x) => x.id === id); if (c && c.name) return c.name; }
  return id;
};
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
    h('td', { class: 'num' }, c.reach == null ? h('span', { class: 'gr-muted', title: t('gr.src.notConnected') }, t('gr.dash')) : [compactNum(c.reach), h('span', { class: 'gr-unit' }, t(`gr.ch.unit.${c.reachKind}`))]),
    h('td', { class: 'num' }, c.conversion == null ? h('span', { class: 'gr-muted', title: t('gr.src.notConnected') }, t('gr.dash')) : pct1(c.conversion)),
    h('td', { class: 'num' }, c.roas == null ? h('span', { class: 'gr-muted' }, t('gr.ch.organic')) : h('strong', null, roasFmt(c.roas)))));
  return h('div', { class: 'ex-card gr-channels' },
    cardHead('channelPerformance', t('gr.ch.title'), d.sources && d.sources.campaigns === 'demo' ? chip(t('gr.ov.fromCampaigns'), 'mute') : null),
    h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table gr-table' },
      h('thead', null, h('tr', null, h('th', null, t('gr.ch.channel')), h('th', { class: 'num' }, t('gr.ch.revenue')), h('th', { class: 'num' }, t('gr.ch.reach')), h('th', { class: 'num' }, t('gr.ch.conversion')), h('th', { class: 'num' }, t('gr.ch.roas')))),
      h('tbody', null, rows))),
    h('div', { class: 'ex-foot' }, t(d.sources && d.sources.campaigns === 'demo' ? 'gr.ov.chFoot' : 'gr.ch.foot')));
}

// ---------- Campaigns ----------
const CAMP_TONE = { performing: 'gr-good', active: 'mute', watch: 'gr-warn' };
function campaignsCard(d) {
  return h('div', { class: 'ex-card gr-camps' },
    cardHead('campaigns', t('gr.camp.title'), chip(t('gr.camp.activeCount', d.kpis.activeCampaigns.value), 'mute')),
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
          h('span', { class: 'gr-muted' }, t('gr.camp.newCustomers', num(c.newCustomers)))));
    })));
}

// ---------- Content performance ----------
const PERF_TONE = { best: 'gr-good', good: 'mute', below: 'gr-warn' };
function contentCard(d) {
  if (!d.content) return h('div', { class: 'ex-card gr-content' }, cardHead('contentPerformance', t('gr.content.title')), ncBody(t('gr.ov.nc.content')));
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
function storeMetric(label, value, deltaEl, series, note) {
  return h('div', { class: 'gr-store-metric' },
    h('div', { class: 'ex-kpi-label' }, label),
    h('div', { class: 'gr-store-value' }, value),
    deltaEl,
    note ? h('div', { class: 'ex-kpi-note' }, note) : null,
    series ? h('div', { class: 'kpi-spark' }, NordlaCharts.sparkline(series)) : null);
}
// Store footfall and conversion are NOT connected (no source): stated as such. Store sales are REAL (Croissance magasin's engine,
// its own 8-week window) or explicitly unavailable - never a demo value.
function storeCard(d) {
  const r = (d.real && d.real.store) || { mode: 'unavailable' };
  const notConnected = (label) => storeMetric(label, t('gr.store.notConnected'), null, null, t('gr.store.footfallNote'));
  const revenue = r.mode === 'store'
    ? storeMetric(t('gr.store.realRevenue', r.weeks), new Intl.NumberFormat(tag(), { style: 'currency', currency: r.currency || 'EUR', maximumFractionDigits: 0 }).format(r.net), r.change == null ? null : delta(r.change), r.weekly)
    : storeMetric(t('gr.store.revenue'), t('gr.dash'), null, null, t(r.mode === 'noStore' ? 'gr.store.noStore' : 'gr.store.unavailable'));
  return h('div', { class: 'ex-card gr-store' },
    cardHead('storeGrowth', t('gr.store.title'), r.mode === 'store' ? chip(t('gr.store.realChip'), 'gr-good') : null),
    h('div', { class: 'gr-store-grid' }, notConnected(t('gr.store.traffic')), notConnected(t('gr.store.conversion')), revenue));
}

// ---------- Top opportunities ----------
const PRIO_TONE = { high: '', medium: 'mute' };
function opportunitiesCard(d) {
  if (!d.opportunities) return h('div', { class: 'ex-card gr-opps' }, cardHead('topOpportunities', t('gr.opp.title')), ncBody(t('gr.ov.nc.opportunities')));
  return h('div', { class: 'ex-card gr-opps' },
    cardHead('topOpportunities', t('gr.opp.title')),
    h('div', { class: 'ex-movers' }, d.opportunities.map((o) => h('div', { class: 'ex-mover gr-row' },
      icoBubble(kindIcon('src', o.source)),
      h('div', { class: 'ex-mover-main' },
        h('div', { class: 'ex-mover-name' }, loc(o.title)),
        h('div', { class: 'ex-mover-sub' }, t('gr.opp.source', t(`gr.op.src.${o.source}`))),
        h('div', { class: 'gr-att-meta' }, chip(t(`gr.opp.priority.${o.priority}`), PRIO_TONE[o.priority]), h('span', { class: 'gr-muted' }, t(`gr.op.status.${o.status}`)))),
      h('div', { class: 'gr-side' }, h('strong', { class: 'gr-pos' }, `+${money(o.estimate)}`), h('span', { class: 'gr-muted' }, t('gr.opp.estimate')))))),
    h('div', { class: 'ex-foot' }, t('gr.opp.foot')));
}

// ---------- Experiments ----------
// The Expériences page is not built yet: the card states it (same card, no demo experiment).
function experimentsCard() {
  return h('div', { class: 'ex-card gr-exps' },
    cardHead('experiments', t('gr.exp.title')),
    h('div', { class: 'gr-pp-empty' }, t('gr.exp.soon')));
}

// ---------- pages + router ----------
// Hash routes inside Growth only: '#/' = Overview, '#/opportunities' = Opportunités, '#/campaigns' = Campagnes, '#/potential' = Produits Potentiels, '#/audience' = Audience, '#/content' = Contenu, '#/storeGrowth' = Croissance magasin. Each page's payload is fetched once
// and cached; a language or filter change re-renders from the cache.
let data = null; let oppData = null; let campData = null; let potData = null; let audData = null; let ctData = null; let stData = null;
// Load state per page: undefined (not requested), 'loading', or { code } after a failed request (safe, known codes only).
const loadState = {};
const ERROR_CODES = ['TENANT_NOT_CONFIGURED', 'DATA_UNAVAILABLE', 'NETWORK', 'UNKNOWN'];
// `period` = the window the page's engine really uses (the top bar shows it in every state); `demo` = demonstration page.
const PAGES = {
  overview: { title: 'gr.title', subtitle: 'gr.subtitle', url: '/api/growth/overview', period: { days: 30 }, demo: true, demoTitle: 'gr.ov.demoTitle', get: () => data, set: (v) => { data = v; }, render: renderOverview },
  opportunities: { title: 'gr.op.title', subtitle: 'gr.op.subtitle', url: '/api/growth/opportunities', period: { days: 30 }, get: () => oppData, set: (v) => { oppData = v; }, render: renderOpportunities },
  campaigns: { title: 'gr.cp.title', subtitle: 'gr.cp.subtitle', url: '/api/growth/campaigns', period: { days: 30 }, demo: true, get: () => campData, set: (v) => { campData = v; }, render: renderCampaigns },
  potential: { title: 'gr.pp.title', subtitle: 'gr.pp.subtitle', url: '/api/growth/products', period: { weeks: 8 }, get: () => potData, set: (v) => { potData = v; }, render: renderPotential },
  audience: { title: 'gr.au.title', subtitle: 'gr.au.subtitle', url: '/api/growth/audience', period: { days: 90 }, get: () => audData, set: (v) => { audData = v; }, render: renderAudience },
  content: { title: 'gr.ct.title', subtitle: 'gr.ct.subtitle', url: '/api/growth/content', period: { weeks: 8 }, get: () => ctData, set: (v) => { ctData = v; }, render: renderContent },
  storeGrowth: { title: 'gr.st.title', subtitle: 'gr.st.subtitle', url: '/api/growth/store', period: { weeks: 8 }, get: () => stData, set: (v) => { stData = v; }, render: renderStore },
};
function currentPage() { const p = location.hash.replace(/^#\/?/, ''); return PAGES[p] && p !== 'overview' ? p : 'overview'; }

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
  app.replaceChildren(h('div', { class: 'shell' }, sidebar(key), main, morePanel(key)));
  main.appendChild(topbar(page));
  main.appendChild(h('div', { class: 'ex-head' }, h('div', null, h('h1', { class: 'ex-title' }, t(page.title)), h('p', { class: 'ex-sub' }, t(page.subtitle)))));
  if (!d) { main.appendChild(loadStateCard(key)); applyDialogFocus(); return; }
  // Each section is built on its own: a failing section is replaced by an empty state, the rest of the page still renders.
  const safe = (fn) => { try { return fn(d); } catch (e) { console.error('growth section failed', e); return h('div', { class: 'ex-card' }, NordlaCharts.insufficient(t('gr.noData'), '')); } };
  page.render(main, safe);
  applyDialogFocus();
}

// ---------- shared states: loading (never "unavailable") and error (safe category + retry). Empty / partial stay per page. ----------
function loadStateCard(key) {
  const s = loadState[key];
  if (s && s !== 'loading') {
    return h('div', { class: 'ex-card gr-state gr-state-error', role: 'alert' },
      h('strong', { class: 'gr-state-title' }, t('gr.state.errorTitle')),
      h('p', { class: 'gr-state-text' }, t(`gr.state.error.${s.code}`)),
      h('button', { type: 'button', class: 'btn-outline gr-state-retry', on: { click: () => loadPage(key) } }, t('gr.state.retry')));
  }
  return h('div', { class: 'ex-card gr-state gr-state-loading', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'gr-spinner', 'aria-hidden': 'true' }), h('span', { class: 'gr-state-text' }, t('gr.state.loading')));
}
async function loadPage(key) {
  const page = PAGES[key];
  loadState[key] = 'loading';
  if (currentPage() === key) render();
  try {
    const r = await fetch(page.url);
    if (r.ok) { page.set(await r.json()); delete loadState[key]; }
    else {
      let code = 'UNKNOWN';
      try { const j = await r.json(); if (j && j.error && ERROR_CODES.includes(j.error.code)) code = j.error.code; } catch (e) { /* not JSON: stays UNKNOWN */ }
      loadState[key] = { code };
    }
  } catch (e) { loadState[key] = { code: 'NETWORK' }; }
  if (currentPage() === key) render();
}

// ---------- dialogs (detail panels + mobile "Plus"): focus moved in on open, Tab trapped inside, restored on close ----------
// Pages call dialogOpened(trigger) / dialogClosed() and give their triggers a stable data-focus-id: a re-render replaces the DOM,
// so the trigger is found again by that id to restore the focus.
const dialogFocus = { restoreId: null, pending: null };
function dialogOpened(trigger) { dialogFocus.restoreId = trigger && trigger.getAttribute ? trigger.getAttribute('data-focus-id') : null; dialogFocus.pending = 'in'; }
function dialogClosed() { dialogFocus.pending = 'restore'; }
function applyDialogFocus() {
  if (typeof document.querySelector !== 'function') return;
  if (dialogFocus.pending === 'in') {
    const target = document.querySelector('.gr-pp-drawer .gr-pp-close');
    if (target && target.focus) target.focus();
  } else if (dialogFocus.pending === 'restore') {
    const id = dialogFocus.restoreId;
    const el = id && typeof document.querySelectorAll === 'function' ? [...document.querySelectorAll('[data-focus-id]')].find((x) => x.getAttribute('data-focus-id') === id) : null;
    if (el && el.focus) el.focus();
    dialogFocus.restoreId = null;
  }
  dialogFocus.pending = null;
}
const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || typeof document.querySelector !== 'function') return;
    const dlg = document.querySelector('.gr-pp-drawer') || (navMoreOpen ? document.querySelector('.gr-more-panel') : null);
    if (!dlg) return;
    const items = [...dlg.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (!items.length) return;
    const first = items[0]; const last = items[items.length - 1];
    if (!dlg.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

async function route() {
  navMoreOpen = false; // a navigation always closes the mobile "Plus" menu
  const key = currentPage(); const page = PAGES[key];
  if (!page.get() && loadState[key] !== 'loading') await loadPage(key);
  else render();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();
