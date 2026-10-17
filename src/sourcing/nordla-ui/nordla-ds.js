// Nordla Design System v1 - shared components as pure HTML builders (no framework, no DOM access: testable in Node).
// Every text goes through esc(). Components only SHOW what they are given; they never decide availability or status themselves
// (that comes from the server, through nordla-view.js). Styles: nordla-ds.css.
import { iconUrl } from './nordla-view.js';

export const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toneClass = (t) => ({ ok: 'is-ok', warn: 'is-warn', error: 'is-error', info: 'is-info' }[t] ?? '');

/** Official icon (never recoloured) or a neutral initial when the pack has none. */
export const icon = (name, { cls = 'nd-nav-icon', initial = null, alt = '' } = {}) => {
  const u = iconUrl(name);
  return u ? `<img class="${cls}" src="${esc(u)}" alt="${esc(alt)}" width="20" height="20" loading="lazy" decoding="async">` : `<span class="nd-nav-initial" aria-hidden="true">${esc(initial ?? '·')}</span>`;
};

export const statusBadge = ({ tone, label }) => `<span class="nd-badge ${toneClass(tone)}">${esc(label)}</span>`;

/** Official brand files (pack NORDLA Brand Assets V1, unchanged), served by the shared reader at /nordla-assets/brand/. */
export const BRAND = Object.freeze({ monogram: '/nordla-assets/brand/nordla-monogram.svg', monogramFlat: '/nordla-assets/brand/nordla-monogram-flat.svg', appNavy: '/nordla-assets/brand/nordla-app-navy.svg' });

/** Logo: the official monogram (shaded; drawn at 36-40 px, where its light bronze tones keep their edge) + the wordmark in Montserrat. */
export const brand = () => `<a class="nd-brand" href="#accueil"><img class="nd-brand-mark" src="${BRAND.monogram}" alt="" width="40" height="40">Nordla</a>`;

/** NordlaSidebar: items with href=null are shown disabled with their note (never a dead link). */
export const sidebar = (items, footer = '') => `<nav class="nd-sidebar" aria-label="Navigation Nordla">${brand()}
  ${items.map((it) => (it.href
    ? `<a class="nd-nav-item" href="${esc(it.href)}"${it.current ? ' aria-current="page"' : ''}>${icon(it.icon)}${esc(it.label)}</a>`
    : `<span class="nd-nav-item" aria-disabled="true" title="${esc(it.note ?? 'non disponible')}">${icon(it.icon)}${esc(it.label)}<span class="nd-nav-note">${esc(it.note ?? '')}</span></span>`)).join('')}
  <div class="nd-sidebar-foot">${footer}</div></nav>`;

/** NordlaTopbar: brand on mobile, search on desktop (filters this app's modules and cases), session initials. */
export const topbar = ({ initials = '', query = '' } = {}) => `<header class="nd-topbar">${brand()}
  <form class="nd-search" role="search" data-nd-search><label class="nd-sr" for="nd-q">Rechercher dans Nordla</label><input id="nd-q" name="q" type="search" placeholder="Rechercher dans Nordla…" value="${esc(query)}" autocomplete="off"></form>
  <div class="nd-topbar-end">${initials ? `<span class="nd-avatar" title="Votre session">${esc(initials)}</span>` : ''}</div></header>`;

export const metricCard = ({ label, value, source }) => `<div class="nd-card nd-metric" data-nd-metric><span class="nd-metric-label">${esc(label)}</span>
  ${value === null || value === undefined ? `<span class="nd-metric-value is-na">Non disponible</span>` : `<span class="nd-metric-value">${esc(value)}</span>`}
  <span class="nd-metric-source">${esc(source)}</span></div>`;

/** NordlaAgentControl: the Core diagram. A node is a link only when it has a real destination. */
export const coreDiagram = (nodes) => `<div class="nd-core" data-nd-core><div class="nd-core-hub"><img src="${BRAND.monogram}" alt="Nordla Core" width="64" height="64"></div>
  ${nodes.map((n) => { const inner = `${icon(n.icon, { cls: 'nd-nav-icon' })}<div><b>${esc(n.title)}</b><span>${esc(n.detail)}</span></div>`;
    return n.href ? `<a class="nd-core-node" data-pos="${esc(n.pos)}" data-node="${esc(n.key)}" href="${esc(n.href)}">${inner}</a>` : `<div class="nd-core-node" data-pos="${esc(n.pos)}" data-node="${esc(n.key)}">${inner}</div>`; }).join('')}</div>`;

/** NordlaModuleCard */
export const moduleCard = (m) => { const tile = `<span class="nd-module-tile">${m.icon ? `<img src="${esc(iconUrl(m.icon))}" alt="" width="30" height="30" loading="lazy">` : `<span class="nd-initial" aria-hidden="true">${esc(m.initial ?? '·')}</span>`}</span>`;
  return `<a class="nd-module" href="${esc(m.href)}" data-module="${esc(m.key)}">${tile}<span class="nd-module-body"><span class="nd-module-name">${esc(m.name)}</span>
    <span class="nd-module-desc">${esc(m.short)}</span></span>${statusBadge({ tone: m.tone, label: m.state })}<span class="nd-chevron" aria-hidden="true">›</span></a>`; };

/** NordlaActivityFeed: null = not read (said), [] = nothing yet (said). */
export const activityFeed = (items) => (items === null ? '<div class="nd-empty">Activité non disponible : le journal Core n’a pas pu être lu.</div>'
  : !items.length ? '<div class="nd-empty">Aucune activité encore : aucune analyse ni décision au journal Core.</div>'
  : `<ul class="nd-feed" data-nd-feed>${items.map((i) => `<li><span class="nd-feed-dot ${toneClass(i.tone)}"></span><div><b>${esc(i.title)}</b><span>${esc(i.what)}</span></div><time>${esc(i.at)}</time></li>`).join('')}</ul>`);

/** NordlaChartCard: bars from a REAL numeric series only; anything else shows the empty state with its reason. */
export const chartCard = ({ title, series = null, reason = 'Aucune série disponible' }) => {
  const ok = Array.isArray(series) && series.length && series.every((p) => Number.isFinite(p.value) && p.value >= 0);
  const max = ok ? Math.max(...series.map((p) => p.value), 1) : 1;
  return `<section class="nd-card"><div class="nd-card-head"><h2 class="nd-h2">${esc(title)}</h2></div>${ok
    ? `<div class="nd-bars" role="img" aria-label="${esc(title)}">${series.map((p) => `<span class="nd-bar" style="height:${Math.round((p.value / max) * 100)}%" title="${esc(p.label)} : ${esc(p.value)}"></span>`).join('')}</div>`
    : `<div class="nd-empty">${esc(reason)}</div>`}</section>`;
};

/** NordlaGuardianIndicator */
export const guardianIndicator = (g) => `<div class="nd-guardian" data-nd-guardian>${icon('security', { cls: '' })}<div><b>${esc(g.title)}</b>${esc(g.detail)}</div></div>`;

/** NordlaMobileNavigation: 5 entries, Parle à Nordla in the centre. */
export const mobileNav = (route) => { const cur = (r) => (route === r || (r === 'modules' && route.startsWith('module/')) ? ' aria-current="page"' : '');
  const item = (r, label, ic) => `<a href="#${r}"${cur(r)}>${icon(ic, { cls: '' })}<span>${esc(label)}</span></a>`;
  return `<nav class="nd-mnav" aria-label="Navigation principale">${item('accueil', 'Accueil', 'accueil')}${item('modules', 'Modules', 'commandCenter')}
    <a href="#parle" class="is-parle"${cur('parle')}><span class="nd-mnav-fab"><img src="/nordla-assets/parle-a-nordla/white.webp" alt="" width="26" height="26"></span><span>Parle à Nordla</span></a>
    ${item('recherche', 'Recherche', 'recherche')}${item('plus', 'Plus', 'parametres')}</nav>`; };
