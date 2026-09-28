'use strict';
// Nordla Développement des ventes - shell (navigation, top bar, router) + Vue d'ensemble; the Opportunités page lives in
// opportunities.js. Plain DOM, no framework, same conventions as Analytics Premium: every visual is an existing Nordla
// component (Analytics' ex-* cards/tabs/KPI tiles/tables, the shared rail, NordlaCharts, NordlaIcon); growth.css only adds the
// Growth grid and the few list rows Analytics has no equivalent for. All copy goes through NORDLA_I18N.t() (lang-fr/nl/en.js).
// Real data or honest states only (owner decision 2026-09-28): Vue d'ensemble shows the real store sales and the Opportunités
// priorities; every figure no engine produces shows "Source non connectée". No demonstration data, no Campagnes page, and no
// action button that performs no action.

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
  overview: 'growth-overview', opportunities: 'opportunities', content: 'content', storeGrowth: 'store-growth', audience: 'audience',
  settings: 'settings', aiInsights: 'ai-insights', needsAttention: 'needs-attention', pipelineStatus: 'pipeline-status',
  // Used by Produits Potentiels, Audience and Croissance magasin ('pack:<key>' in those pages).
  priorityHigh: 'priority-high', local: 'local', gifts: 'gifts', returningCustomers: 'returning-customers',
  bundle: 'bundle', loyalty: 'loyalty', retargeting: 'retargeting',
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
  overview: 'pack:overview', opportunities: 'pack:opportunities', content: 'pack:content',
  storeGrowth: 'pack:storeGrowth', audience: 'pack:audience', settings: 'pack:settings',
  // Vue d'ensemble
  revenueInfluenced: 'chiffreAffaires', topOpportunities: 'pack:opportunities', aiInsights: 'pack:aiInsights',
  needsAttention: 'pack:needsAttention', growthPulse: 'croissance', contentPerformance: 'meilleurProduit',
  // shared by the pages
  pipelineStatus: 'pack:pipelineStatus', srcCost: 'prix',
};
function gi(name, size = 'md') {
  const v = GROWTH_ICONS[name] || name;
  return v.startsWith('pack:') ? packIcon(GROWTH_PACK[v.slice(5)], size) : NordlaIcon.semantic(v, size);
}

// ---------- formatting (same rules as Analytics' Explorer: Intl per language, whole euros, "+28 %") ----------
const LANG_TAG = { fr: 'fr-BE', nl: 'nl-BE', en: 'en-GB' };
const tag = () => LANG_TAG[NORDLA_I18N.getLang()] || 'fr-BE';
// Currency comes from the current page's payload, never assumed by the UI.
const cur = () => ((PAGES[currentPage()].get() || {}).currency) || 'EUR';
const money = (v) => new Intl.NumberFormat(tag(), { style: 'currency', currency: cur(), maximumFractionDigits: 0 }).format(v);
const compactMoney = (v) => new Intl.NumberFormat(tag(), { style: 'currency', currency: cur(), notation: 'compact', maximumFractionDigits: 1 }).format(v);
const num = (v) => new Intl.NumberFormat(tag(), { maximumFractionDigits: 0 }).format(v);
const signedPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))} %`;
const dayFmt = (isoDate, withYear) => new Date(`${isoDate}T00:00:00Z`).toLocaleDateString(tag(), { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });

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
// unreachable on mobile. Campagnes is not part of this version (no advertising connector): Contenu takes its slot.
const GROWTH_NAV = [
  { key: 'overview', icon: 'overview', href: '#/', mobile: true },
  { key: 'opportunities', icon: 'opportunities', href: '#/opportunities', mobile: true },
  // Produits Potentiels: official "produits" icon until a dedicated Growth pack icon exists.
  { key: 'potential', icon: 'produits', href: '#/potential', mobile: true },
  { key: 'content', icon: 'content', href: '#/content', mobile: true },
  { key: 'storeGrowth', icon: 'storeGrowth', href: '#/storeGrowth', more: true },
  { key: 'audience', icon: 'audience', href: '#/audience', mobile: true },
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

/** Top bar. The period comes from the PAGE definition (PAGES), so the pill is identical in every state; it is the window the page's engines use. */
function topbar(page) {
  const p = page.period;
  const pill = p.weeks
    ? h('span', { class: 'period-pill locked', title: t('gr.period.weeksNote', p.weeks), 'aria-disabled': 'true' }, NordlaIcon.semantic('calendrier', 'sm'), t('gr.period.lastWeeks', p.weeks), h('span', { class: 'period-fixed' }, t('gr.period.fixed')))
    : p.days === 30
      ? h('span', { class: 'period-pill locked', title: t('gr.period.fixedNote'), 'aria-disabled': 'true' }, NordlaIcon.semantic('calendrier', 'sm'), t('gr.period.last30'), h('span', { class: 'period-fixed' }, t('gr.period.fixed')))
      : h('span', { class: 'period-pill locked', title: t('gr.period.daysNote', p.days), 'aria-disabled': 'true' }, NordlaIcon.semantic('calendrier', 'sm'), t('gr.period.lastDays', p.days), h('span', { class: 'period-fixed' }, t('gr.period.fixed')));
  return h('div', { class: 'topbar' },
    h('div', { class: 'topbar-title' }, t('gr.brand')),
    h('div', { class: 'topbar-right' }, pill, langSwitch()));
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
  // 4 tiles (same layout as the other 4-tile Growth rows, gr-pp-kpis). Priorities = the Opportunités aggregator (real engines).
  const note = (text) => h('div', { class: 'ex-kpi-note' }, text);
  const pr = (key, icon, label, text) => (k[key] ? kpi(icon, label, num(k[key].value), note(text)) : kpi(icon, label, t('gr.dash'), note(t('gr.src.unavailable'))));
  return h('div', { class: 'ex-kpi-row gr-kpi-row gr-pp-kpis' },
    kpi('revenueInfluenced', t('gr.kpi.revenueInfluenced'), t('gr.dash'), ncNote()),
    pr('fix', 'needsAttention', t('gr.kpi.fix'), k.fix ? t('gr.kpi.fixNote', num(k.fix.elements)) : ''),
    pr('commercial', 'topOpportunities', t('gr.kpi.commercial'), t('gr.kpi.commercialNote')),
    pr('watch', null, t('gr.kpi.watch'), t('gr.kpi.watchNote')));
}

// ---------- Sales pulse: revenue influenced by sales actions and store visitors have no source today (stated, nothing drawn) ----------
// Revenue and store visitors have different units, so they would never share one axis: the selector switches the stated view.
let pulseView = 'revenue';
function pulseCard() {
  const sel = h('select', { class: 'ex-select', 'aria-label': t('gr.pulse.metric'), on: { change: (e) => { pulseView = e.target.value; render(); } } },
    ['revenue', 'traffic'].map((v) => h('option', { value: v, ...(v === pulseView ? { selected: 'selected' } : {}) }, t(`gr.pulse.${v}`))));
  return h('div', { class: 'ex-card gr-pulse' }, cardHead('growthPulse', t('gr.pulse.title'), sel),
    pulseView === 'traffic' ? NordlaCharts.insufficient(t('gr.pulse.visitorsNotConnected'), t('gr.pulse.visitorsNotConnectedText')) : NordlaCharts.insufficient(t('gr.src.notConnected'), t('gr.ov.nc.influenced')));
}

// ---------- AI insights: no Nordla engine produces them yet (stated, nothing invented) ----------
function insightsCard() {
  return h('div', { class: 'ex-card gr-ai' },
    h('div', { class: 'ex-card-head' }, h('h3', { class: 'gr-card-title' }, gi('aiInsights'), t('gr.ai.title')), chip(t('gr.ai.badge'), 'mute')),
    ncBody(t('gr.ov.nc.ai')));
}

// ---------- Needs your attention = the first "À corriger maintenant" groups of Opportunités (real, grouped by problem) ----------
const ovLink = () => h('a', { class: 'gr-op-link', href: '#/opportunities' }, t('gr.ov.toOpportunities'));
function attentionCard(d) {
  if (!d.attention) return h('div', { class: 'ex-card gr-att' }, cardHead('needsAttention', t('gr.att.title')), h('div', { class: 'gr-pp-empty' }, t('gr.ov.prioritiesUnavailable')));
  return h('div', { class: 'ex-card gr-att' },
    cardHead('needsAttention', t('gr.att.title'), chip(num(d.kpis.fix ? d.kpis.fix.value : d.attention.length), d.attention.length ? '' : 'mute')),
    d.attention.length
      ? h('div', { class: 'ex-movers' }, d.attention.map((g) => h('div', { class: 'ex-mover gr-row', 'data-priority-id': g.id },
        icoBubble(g.kind === 'purchaseCost' ? 'srcCost' : 'content'),
        h('div', { class: 'ex-mover-main' },
          h('div', { class: 'ex-mover-name' }, opFixTitle(g)),
          h('div', { class: 'ex-mover-sub gr-wrap' }, t(g.kind === 'purchaseCost' ? 'gr.op.fix.purchaseCost.why' : `gr.op.fix.content.${g.problem}.why`))))))
      : h('div', { class: 'gr-pp-empty' }, t('gr.op.fix.empty')),
    h('div', { class: 'ex-foot' }, ovLink()));
}

// ---------- Content performance: no social account is connected (stated, nothing invented) ----------
function contentCard() {
  return h('div', { class: 'ex-card gr-content' }, cardHead('contentPerformance', t('gr.content.title')), ncBody(t('gr.ov.nc.content')));
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

// ---------- Commercial opportunities = Opportunités' validated section (may be empty: stated honestly) ----------
function opportunitiesCard(d) {
  if (!d.opportunities) return h('div', { class: 'ex-card gr-opps' }, cardHead('topOpportunities', t('gr.opp.title')), h('div', { class: 'gr-pp-empty' }, t('gr.ov.prioritiesUnavailable')));
  return h('div', { class: 'ex-card gr-opps' },
    cardHead('topOpportunities', t('gr.opp.title'), chip(num(d.kpis.commercial ? d.kpis.commercial.value : d.opportunities.length), d.opportunities.length ? 'gr-good' : 'mute')),
    d.opportunities.length
      ? h('div', { class: 'ex-movers' }, d.opportunities.map((i) => h('div', { class: 'ex-mover gr-row', 'data-priority-id': i.id },
        icoBubble(OP_ITEM_ICON[i.kind]),
        h('div', { class: 'ex-mover-main' }, h('div', { class: 'ex-mover-name' }, opCommercialTitle(i)), h('div', { class: 'ex-mover-sub gr-wrap' }, opCommercialWhy(i))))))
      : h('div', { class: 'gr-pp-empty gr-pr-empty' }, h('strong', { class: 'gr-ink' }, t('gr.op.com.emptyTitle')), h('span', null, t('gr.opp.emptyText'))),
    h('div', { class: 'ex-foot' }, ovLink()));
}

// ---------- pages + router ----------
// Hash routes inside Growth only: '#/' = Overview, '#/opportunities' = Opportunités, '#/potential' = Produits Potentiels,
// '#/audience' = Audience, '#/content' = Contenu, '#/storeGrowth' = Croissance magasin. Any other hash (e.g. a former '#/campaigns'
// link) shows Vue d'ensemble. Each page's payload is fetched once and cached; a language or filter change re-renders from the cache.
let data = null; let oppData = null; let potData = null; let audData = null; let ctData = null; let stData = null;
// Load state per page: undefined (not requested), 'loading', or { code } after a failed request (safe, known codes only).
const loadState = {};
const ERROR_CODES = ['TENANT_NOT_CONFIGURED', 'DATA_UNAVAILABLE', 'NETWORK', 'UNKNOWN'];
// `period` = the window the page's engines really use (the top bar shows it in every state).
const PAGES = {
  overview: { title: 'gr.title', subtitle: 'gr.subtitle', url: '/api/growth/overview', period: { weeks: 8 }, get: () => data, set: (v) => { data = v; }, render: renderOverview },
  opportunities: { title: 'gr.op.title', subtitle: 'gr.op.subtitle', url: '/api/growth/opportunities', period: { weeks: 8 }, get: () => oppData, set: (v) => { oppData = v; }, render: renderOpportunities },
  potential: { title: 'gr.pp.title', subtitle: 'gr.pp.subtitle', url: '/api/growth/products', period: { weeks: 8 }, get: () => potData, set: (v) => { potData = v; }, render: renderPotential },
  audience: { title: 'gr.au.title', subtitle: 'gr.au.subtitle', url: '/api/growth/audience', period: { days: 90 }, get: () => audData, set: (v) => { audData = v; }, render: renderAudience },
  content: { title: 'gr.ct.title', subtitle: 'gr.ct.subtitle', url: '/api/growth/content', period: { weeks: 8 }, get: () => ctData, set: (v) => { ctData = v; }, render: renderContent },
  storeGrowth: { title: 'gr.st.title', subtitle: 'gr.st.subtitle', url: '/api/growth/store', period: { weeks: 8 }, get: () => stData, set: (v) => { stData = v; }, render: renderStore },
};
function currentPage() { const p = location.hash.replace(/^#\/?/, ''); return PAGES[p] && p !== 'overview' ? p : 'overview'; }

function renderOverview(main, safe) {
  main.appendChild(safe(kpiRow));
  main.appendChild(h('div', { class: 'gr-grid gr-grid-main' }, safe(attentionCard), safe(opportunitiesCard), safe(storeCard)));
  main.appendChild(h('div', { class: 'gr-grid gr-grid-wide' }, safe(pulseCard), safe(insightsCard), safe(contentCard)));
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
