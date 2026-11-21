// Nordla Core home, the commercial layout of the client reference (PC and phone). Left: the indicators of the sales (Ventes, Commandes, Panier
// moyen). Centre: the Nordla ring with its four elements. Right: the sales evolution and the sales split by channel. Bottom: four Core functions
// (À traiter pour vous, Parle à Nordla, Connexions, Activité récente). Every figure comes from the server (Analytics' own sales engine, the
// decisions journal, the connections overview). When a source is missing the panel says « Données indisponibles » and draws nothing: no zero,
// no invented figure. The example figures live only in the demonstration (?demo=1), with a « DÉMO » tag.
import { esc } from '../dom.js';
import { DEMO_TAG, DEMO_BANNER, DEMO_SALES, DEMO_CONNECTIONS, DEMO_MENU, DEMO_SPARKS } from './nordla-demo.js';

// One colour per module (menu dot), taken from the module colours of the reference.
export const MODULE_COLOURS = Object.freeze({
  sourcing: '#B92335', finance: '#46778D', analytics: '#7842B8', procurement: '#E87924',
  branding: '#9E2F86', marketing: '#F17821', creative: '#C84FA4', growth: '#D1A44F',
});
// Colours of the sales split (channels), taken from the reference: green-teal, orange, blue-grey, gold, grey, navy.
const CHANNEL_COLOURS = ['#1E5B52', '#E0822B', '#7594B5', '#C9A24A', '#9AA3AE', '#2F4A6D'];
const CONNECTION_IDS = ['shopify', 'instagram', 'tiktok', 'google_business_profile'];
const CONNECTION_LABEL = { shopify: 'Shopify', instagram: 'Instagram', tiktok: 'TikTok', google_business_profile: 'Google Business Profile' };

const SAFE_HTTPS = /^https:\/\/[^\s"'<>]+$/;
const SHORT = { sourcing: 'Sourcing', analytics: 'Analyses', procurement: 'Stock & Achats', growth: 'Croissance', creative: 'Création', marketing: 'Marketing', branding: 'Branding' };
const APPROVED = ['APPROVED', 'APPROVED_ALTERNATIVE'];
export const NO_DATA = 'Données indisponibles';

/** The menu of the home, in the order of the Menu principal (the list validated by the owner). Sourcing is in its place in that list, not last. */
export const MENU_ORDER = Object.freeze(['finance', 'analytics', 'procurement', 'sourcing', 'growth', 'branding', 'marketing', 'creative']);

/** The menu entries, in MENU_ORDER, each with its single action when the server confirms one. A module the server does not list is not shown. Pure. */
export function homeCards(modules, { online = true } = {}) {
  const list = Array.isArray(modules) ? modules : [];
  const byKey = new Map(list.filter((m) => m && typeof m.key === 'string').map((m) => [m.key, m]));
  const cards = [];
  for (const key of MENU_ORDER) {
    if (key === 'sourcing') { cards.push({ key: 'sourcing', label: 'Sourcing', state: 'DISPONIBLE', detail: 'Fournisseurs, photos, analyses d’achat ; fonctionne hors ligne.', colour: MODULE_COLOURS.sourcing, action: { type: 'local', to: 'sourcing', label: 'Ouvrir Sourcing' } }); continue; }
    const m = byKey.get(key);
    if (!m) continue;
    const card = { key, label: SHORT[key] ?? String(m.label ?? key), state: String(m.state ?? 'NON RACCORDÉ'), detail: String(m.detail ?? ''), colour: MODULE_COLOURS[key] ?? '#44506a', action: null };
    if (online) card.action = actionOf(m);
    cards.push(card);
  }
  return cards;
}

function actionOf(m) {
  if (m.key === 'finance' && m.dashboard === true) return { type: 'nx', act: 'nx-open-finance', label: 'Ouvrir Finance' };
  if (m.key === 'analytics' && m.dashboard === true) return { type: 'nx', act: 'nx-open-analytics', label: 'Ouvrir Analyses' };
  if (m.key === 'growth' && m.growth_sso === true && typeof m.growth_url === 'string' && SAFE_HTTPS.test(m.growth_url)) return { type: 'nx', act: 'nx-open-growth', to: 'dropoff', href: `${m.growth_url}/#/dropoff`, label: 'Ouvrir Développement des ventes' };
  if (m.key === 'creative' && m.creator_screen === true) return { type: 'link', href: '/creator', label: 'Ouvrir le Créateur' };
  if (m.key === 'marketing' && m.video_screen === true) return { type: 'link', href: '/videos', label: 'Ajouter une vidéo' };
  return null;
}

// Menu icons and module colours, as the « Mes modules » reference: one line icon per entry, in the module's colour.
// Every entry sets --m (its colour): the menu row takes a light tint of it, the icon and a darker shade of it carry the label, an accent bar
// marks the module, and the active row is filled with the module colour (white text). Entries without a reference colour keep their colour.
const NAV_PATHS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M3 4h2l2.4 11h10.2L20 7H7"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5"/><circle cx="17" cy="9" r="2.5"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  megaphone: '<path d="M4 10v4h3l8 4V6L7 10z"/>',
  paint: '<path d="M4 20l4-1 11-11-3-3L5 16z"/>',
};
// Entry key -> icon and colour. Module colours from the reference; the example entries of the demonstration take their reference colour too.
const NAV_STYLE = {
  core: ['grid', '#0F1B2D'], ask: ['chat', '#0F1B2D'],
  finance: ['card', '#46778D'], procurement: ['box', '#E87924'], ventes: ['cart', '#2F6FD6'], produits: ['tag', '#5B5BD6'],
  analytics: ['chart', '#7842B8'], fournisseurs: ['people', '#7A8699'], conformite: ['shield', '#4B5563'], parametres: ['gear', '#6B7280'],
  sourcing: ['globe', '#B92335'], growth: ['chart', '#D1A44F'], creative: ['paint', '#C84FA4'], marketing: ['megaphone', '#F17821'],
  branding: ['tag', '#9E2F86'],
};

function navHtml(c) {
  const [name, colour] = NAV_STYLE[c.key] ?? ['grid', '#44506a'];
  const ico = `<span class="nx-h-navico" aria-hidden="true">${icon(NAV_PATHS[name], 19)}</span>`;
  const m = ` style="--m:${esc(colour)}"`;
  const a = c.action;
  const label = `<span title="${esc(c.state ?? '')}">${esc(c.label)}</span>`;
  if (a?.type === 'local') return `<button type="button" class="nx-h-nav" data-key="${esc(c.key)}"${m} data-act="sl-nav">${ico}${label}</button>`;
  if (a?.type === 'nx' && a.href) return `<a class="nx-h-nav" data-key="${esc(c.key)}"${m} href="${esc(a.href)}" data-act="${esc(a.act)}" data-to="${esc(a.to)}" target="_blank" rel="noopener">${ico}${label}</a>`;
  if (a?.type === 'nx') return `<button type="button" class="nx-h-nav" data-key="${esc(c.key)}"${m} data-act="${esc(a.act)}">${ico}${label}</button>`;
  if (a?.type === 'link') return `<a class="nx-h-nav" data-key="${esc(c.key)}"${m} href="${esc(a.href)}">${ico}${label}</a>`;
  return `<span class="nx-h-nav nx-h-nav-off" data-key="${esc(c.key)}"${m}>${ico}${label}</span>`;
}

/** The decisions journal, read as Core's activity and its pending validations. Anything that is not a list means Core could not answer. */
export function coreSummary(decisions) {
  if (!Array.isArray(decisions)) return { available: false, awaiting: null, approved: null, recent: [], pending: [] };
  const pending = decisions.filter((d) => !d.human_decision && d.recommendation);
  const approved = decisions.filter((d) => d.human_decision && APPROVED.includes(d.human_decision.decision)).length;
  const recent = [...decisions].sort((a, b) => (String(a.created_at) < String(b.created_at) ? 1 : -1)).slice(0, 5);
  return { available: true, awaiting: pending.length, approved, recent, pending };
}

/** The sales of the period, as the Core home shows them. Pure: the server's figures in, the figures of the screen out. The average basket is
 *  computed as Nordla defines it everywhere else (net sales excl. VAT divided by the number of orders). Null when the server did not confirm sales. */
export function salesModel(sales) {
  if (!sales || sales.status !== 'AVAILABLE') return { available: false };
  const val = (list, key) => { const f = (list ?? []).find((x) => x?.key === key); return typeof f?.value === 'number' ? f.value : null; };
  const net = val(sales.values, 'net_sales_ex_tax');
  const orders = val(sales.values, 'order_count');
  const delta = (key) => { const r = (sales.comparison?.rows ?? []).find((x) => x?.key === key); return typeof r?.delta_pct === 'number' ? r.delta_pct : null; };
  const weekly = (sales.weekly ?? []).slice(-7).map((w) => ({
    label: isoWeekLabel(w.week_start), month: monthShort(w.week_start), net: typeof w.net_sales_ex_tax === 'number' ? w.net_sales_ex_tax : null,
    orders: typeof w.order_count === 'number' ? w.order_count : null,
    basket: typeof w.net_sales_ex_tax === 'number' && w.order_count > 0 ? w.net_sales_ex_tax / w.order_count : null,
  }));
  const raw = (sales.channels ?? []).map((c) => ({ label: String(c.label ?? c.ref ?? 'Canal'), net: val(c.values, 'net_sales_ex_tax') })).filter((c) => c.net != null && c.net > 0);
  const total = raw.reduce((s, c) => s + c.net, 0);
  return {
    available: true, currency: sales.currency ?? 'EUR', source: String(sales.source ?? ''),
    net, orders, basket: net != null && orders > 0 ? net / orders : null,
    deltas: { net: delta('net_sales_ex_tax'), orders: delta('order_count'), basket: delta('aov_ex_tax') },
    weekly, channels: raw.map((c, i) => ({ ...c, share: total > 0 ? c.net / total : 0, colour: CHANNEL_COLOURS[i % CHANNEL_COLOURS.length] })),
  };
}

/** The four Core connections, with the state the server returned for each (never a generic label). Pure. */
export function connectionRows(overview) {
  if (!overview || !Array.isArray(overview.categories)) return null;
  const all = overview.categories.flatMap((c) => c.providers ?? []);
  return CONNECTION_IDS.map((id) => {
    const p = all.find((x) => x?.id === id);
    if (!p) return { id, label: CONNECTION_LABEL[id], statusLabel: 'Statut non disponible', connected: false };
    const connected = (p.connections ?? []).some((c) => c.state === 'VERIFIED' || c.state === 'LINKED');
    return { id, label: String(p.label ?? CONNECTION_LABEL[id]), statusLabel: connected ? 'Connecté' : String(p.statusLabel ?? 'Statut non disponible'), connected };
  });
}

const DECIDED = { APPROVED: 'Validée', APPROVED_ALTERNATIVE: 'Validée (alternative)', REJECTED: 'Refusée', DEFERRED: 'Reportée' };
const dateFr = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const dayLabel = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return Number.isNaN(d.getTime()) ? String(iso ?? '') : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' }); };
const money = (v, cur = 'EUR', digits = 2) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cur, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
const pct = (v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1).replace('.', ',')} %`;
const bars = (values) => { const max = Math.max(...values.map((v) => (v ?? 0)), 0); return values.map((v) => (max > 0 && v != null ? Math.max(4, Math.round((v / max) * 100)) : 0)); };
// The four functions of the circle are links: Agents IA and Règles open the Nordla panel (questions, validations); Données goes to Paramètres; Outils to Connexions.
const CIRCLE_LINKS = { top: { act: 'nx-open-panel' }, left: { href: '/settings' }, right: { href: '/settings/connections' }, bottom: { act: 'nx-open-panel' } };
const linkWrap = (p, g) => {
  const t = CIRCLE_LINKS[p.key];
  if (!t) return g;
  if (t.href) return `<a href="${t.href}" class="nx-h-svg-link" aria-label="${esc(p.name)}">${g}</a>`;
  return `<g class="nx-h-svg-link" data-act="${t.act}" role="button" tabindex="0" aria-label="${esc(p.name)}">${g}</g>`;
};
const icon = (paths, size = 24) => `<svg class="nx-h-ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** Four pillars of Core: name, sub-line and an icon. They describe the parts of Core, not the live state of any connection. */
const PILLARS = [
  { key: 'top', name: 'Agents IA', sub: 'Orchestration', mobileIcon: '<path d="M4 20h16"/><path d="M7 16v-4M12 16V8M17 16v-7"/>', icon: '<circle cx="9" cy="8" r="3"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.5"/>' },
  { key: 'left', name: 'Données', sub: 'Sécurisées', icon: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>' },
  { key: 'right', name: 'Outils', sub: 'Connectés', mobileIcon: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>', icon: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z"/>' },
  { key: 'bottom', name: 'Règles', sub: 'et validations', icon: '<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"/><path d="M9 12l2 2 4-4"/>' },
];

/** A commercial indicator card. `spark` = values (0-100) from the real weekly series, drawn only when it exists; `line` draws a line (Ventes), otherwise bars. */
function kpiCard({ title, value, delta, spark, sparkMobile = null, colour = '#C9A24A', line = false, caption, demo }) {
  const v = value == null ? `<b class="nx-h-kpi-v na">Indisponible</b>` : `<b class="nx-h-kpi-v">${esc(value)}</b>`;
  const d = typeof delta === 'number' ? `<span class="nx-h-delta ${delta < 0 ? 'down' : 'up'}">${delta < 0 ? '↘' : '↗'} ${esc(pct(delta))}</span>` : '';
  const barsOf = (vals, cls) => `<div class="nx-h-spark ${cls}" aria-hidden="true">${vals.map((h) => `<span style="height:${h}%;background:${colour}"></span>`).join('')}</div>`;
  const s = !spark ? '' : line ? sparkLine(spark, colour) : sparkMobile ? barsOf(spark, 'nx-h-spark-pc') + barsOf(sparkMobile, 'nx-h-spark-ph') : barsOf(spark, '');
  return `<article class="nx-h-panel nx-h-kpi-card"><header class="nx-h-ph"><h2>${esc(title)}</h2>${demo ? DEMO_TAG : ''}</header><div class="nx-h-kpi-row"><div class="nx-h-kpi-l">${v}${d}</div>${s}</div><small>${esc(caption)}</small></article>`;
}

/** A line through the values (0-100 heights), with its soft area and a dot on the last value, as the reference. Pure SVG; no data invented. */
function sparkLine(values, colour) {
  const n = values.length;
  const lo = Math.min(...values), hi = Math.max(...values);
  const xy = values.map((h, i) => [n > 1 ? (i * 120) / (n - 1) : 60, 40 - 3 - ((h - lo) / (hi - lo || 1)) * 34]);
  const pts = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = xy[xy.length - 1];
  const area = `0,46 ${pts} 120,46`;
  return `<svg class="nx-h-line" viewBox="0 0 120 46" preserveAspectRatio="none" aria-hidden="true"><polygon points="${area}" fill="${colour}" fill-opacity=".14"/><polyline fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${pts}"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="${colour}" vector-effect="non-scaling-stroke"/></svg>`;
}

/** Short month of a week (phone chart, as the reference: Jan, Fév…). */
const monthShort = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR', { month: 'short', timeZone: 'UTC' }).replace('.', ''); };
/** ISO week label of a Monday (S40 for the week of 28 September 2026). */
function isoWeekLabel(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return `S${1 + Math.round(((d - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7)}`;
}

/** The mobile and PC ring: the four pillars around Nordla. Same content in both layouts. */
function ringSvg() {
  const dots = Array.from({ length: 12 }, (_, i) => { const a = (i * 30 * Math.PI) / 180; return `<circle cx="${(320 + 190 * Math.cos(a)).toFixed(1)}" cy="${(230 + 190 * Math.sin(a)).toFixed(1)}" r="3.2" fill="#A87932"/>`; }).join('');
  const card = (p, cx, cy) => linkWrap(p, `<g class="nx-h-svg-node">
      <rect x="${cx - 100}" y="${cy - 40}" width="200" height="80" rx="16" fill="#FFFFFF" stroke="#E5E7EB"/>
      <rect x="${cx - 88}" y="${cy - 22}" width="44" height="44" rx="12" fill="#A87932"/>
      <g transform="translate(${cx - 77} ${cy - 11})" fill="none" stroke="#FFFFFF" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p.icon}</g>
      <text x="${cx - 32}" y="${cy - 4}" font-size="17" font-weight="700" fill="#111827">${esc(p.name)}</text>
      <text x="${cx - 32}" y="${cy + 16}" font-size="13" fill="#566170">${esc(p.sub)}</text>
    </g>`);
  return `<svg class="nx-h-svg" viewBox="0 0 640 460" role="img" aria-label="Nordla et ses quatre piliers">
      ${dots}
      <circle cx="320" cy="230" r="150" fill="none" stroke="#A87932" stroke-width="1.2" stroke-dasharray="3 5"/>
      <circle cx="320" cy="230" r="108" fill="#FFFFFF" stroke="#A87932" stroke-width="2.5"/>
      <text x="320" y="256" text-anchor="middle" font-family="Georgia, serif" font-size="96" fill="#A87932">N</text>
      <line x1="320" y1="130" x2="320" y2="90" stroke="#A87932" stroke-width="2"/>
      <line x1="212" y1="230" x2="120" y2="230" stroke="#A87932" stroke-width="2"/>
      <line x1="428" y1="230" x2="520" y2="230" stroke="#A87932" stroke-width="2"/>
      <line x1="320" y1="330" x2="320" y2="370" stroke="#A87932" stroke-width="2"/>
      ${card(PILLARS[0], 320, 50)}
      ${card(PILLARS[1], 120, 230)}
      ${card(PILLARS[2], 520, 230)}
      ${card(PILLARS[3], 320, 410)}
    </svg>`;
}

/** The Core home. `sales`, `connections` and `decisions` are null while loading; `sales` = { status: 'AVAILABLE' | 'RESERVED' | 'NOT_CONNECTED' | 'UNAVAILABLE' } otherwise.
 *  `demo` shows the example figures instead, each with a « DÉMO » tag, and the banner. */
export function nordlaHomeHtml({ modules = null, decisions = null, sales = null, connections = null, online = true, error = '', role = null, demo = false, linkConnections = false } = {}) {
  const shown = demo ? [] : modules;
  const sh = demo ? DEMO_SALES : sales;
  const conn = demo ? DEMO_CONNECTIONS : connections;
  const dec = demo ? [] : decisions;
  const loading = online && !demo && modules === null && !error;
  const cards = homeCards(Array.isArray(shown) ? shown : [], { online: online && !demo });
  const menu = demo ? DEMO_MENU.map((m) => ({ key: m.key, label: m.label, action: null })) : cards;
  const sum = coreSummary(dec);
  const sm = salesModel(sh);
  const status = demo ? 'Système opérationnel' : online ? 'Connecté au serveur' : 'Hors connexion';
  const statusClass = demo || online ? 'ok' : 'off';
  const note = !online && !demo ? '<p class="nx-h-note warn">Hors connexion : seul Sourcing fonctionne. Les autres fonctions reprendront avec la connexion au serveur.</p>' : loading ? '<p class="nx-h-note">Chargement…</p>' : '';
  const salesNote = !demo && sh?.status === 'UNAVAILABLE' ? '<p class="nx-h-note warn">' + esc(NO_DATA) + ' : Analytics ne répond pas pour le moment. Les autres fonctions restent disponibles.</p>' : '';
  const err = error ? `<p class="nx-h-note warn">${esc(error)}</p>` : '';
  // Why a sales figure is missing, as the server said it: loading, reserved, not connected, or unavailable (never a zero).
  const WHY = { RESERVED: 'Accès réservé au propriétaire, à un administrateur ou au comptable', NOT_CONNECTED: 'Source commerciale non raccordée' };
  const waitOr = () => (!online && !demo ? 'Hors connexion' : sh === null ? 'Chargement…' : (WHY[sh.status] ?? 'Indisponible'));
  const caption = (text) => (demo ? '' : text);

  // ---- commercial indicators (left on PC, top on phone)
  const ventes = sm.available
    ? kpiCard({ title: 'Ventes', value: money(sm.net, sm.currency, 0), delta: sm.deltas.net, spark: demo ? DEMO_SPARKS.ventes : bars(sm.weekly.map((w) => w.net)), line: true, colour: '#E8891C', caption: caption(`Ventes nettes HT, 30 derniers jours · ${sm.source}`), demo })
    : kpiCard({ title: 'Ventes', value: null, caption: waitOr(false), demo });
  const commandes = sm.available
    ? kpiCard({ title: 'Commandes', value: String(sm.orders), delta: sm.deltas.orders, spark: demo ? DEMO_SPARKS.commandes : bars(sm.weekly.map((w) => w.orders)), colour: '#3FA58A', caption: caption(`30 derniers jours · ${sm.source}`), demo })
    : kpiCard({ title: 'Commandes', value: null, caption: waitOr(false), demo });
  const panier = sm.available && sm.basket != null
    ? kpiCard({ title: 'Panier moyen', value: money(sm.basket, sm.currency), delta: sm.deltas.basket, spark: demo ? DEMO_SPARKS.panier : bars(sm.weekly.map((w) => w.basket)), sparkMobile: demo ? DEMO_SPARKS.panierPh : null, colour: '#8FA7C6', caption: caption(`Ventes nettes HT ÷ commandes · ${sm.source}`), demo })
    : kpiCard({ title: 'Panier moyen', value: null, caption: waitOr(false), demo });

  // ---- charts: evolution (weekly bars) and split by channel (donut)
  const topNet = sm.available ? sm.weekly.reduce((m, w) => Math.max(m, w.net ?? 0), 0) : 0;
  const axisHtml = sm.available ? `<div class="nx-h-axis" aria-hidden="true">${[1, 0.75, 0.5, 0.25, 0].map((k) => `<span>${esc(Math.round((topNet * k) / 50) * 50 === 0 ? '0' : Math.round((topNet * k) / 50) * 50 >= 1000 ? (Math.round((topNet * k) / 50) * 50).toLocaleString('fr-FR') : String(Math.round((topNet * k) / 50) * 50))}</span>`).join('')}</div>` : '';
  const weeklyOk = sm.available && sm.weekly.some((w) => w.net != null);
  // demonstration: the chart of the reference (image 106), fifteen thin gold bars; production keeps the weekly bars
  const evoDemo = `<div class="nx-h-chart nx-h-chart-ref" role="img" aria-label="Évolution des ventes">${DEMO_SPARKS.evoRef.map((hh) => `<span style="height:${hh}%"></span>`).join('')}</div>`;
  const evo = demo ? evoDemo : weeklyOk
    ? `<div class="nx-h-chart" role="img" aria-label="Ventes par semaine">${axisHtml}${(demo ? DEMO_SPARKS.evo : bars(sm.weekly.map((w) => w.net))).map((h, i) => `<div class="nx-h-cbar"><span style="height:${h}%" title="${esc(money(sm.weekly[i].net, sm.currency))}"></span><small class="nx-h-lbl-w">${esc(sm.weekly[i].label)}</small><small class="nx-h-lbl-m">${esc(sm.weekly[i].month)}</small></div>`).join('')}</div>`
    : `<p class="nx-h-quiet-line">${esc(waitOr(false))}</p>`;
  const split = sm.available && sm.channels.length
    ? `<div class="nx-h-split"><div class="nx-h-donut" style="background:conic-gradient(${sm.channels.reduce((acc, c) => { const from = acc.at; const to = from + c.share * 100; acc.parts.push(`${c.colour} ${from.toFixed(2)}% ${to.toFixed(2)}%`); acc.at = to; return acc; }, { at: 0, parts: [] }).parts.join(', ')})" role="img" aria-label="Répartition des ventes par canal"><span>${esc(money(sm.net, sm.currency, 0))}<small>${esc(demo ? '' : 'Ventes nettes HT')}</small></span></div>
        <ul class="nx-h-legend">${sm.channels.map((c) => `<li><i style="background:${c.colour}"></i><span>${esc(c.label)}</span>${demo ? DEMO_TAG : ''}<b>${Math.round(c.share * 100)} %</b></li>`).join('')}<li class="nx-h-total"><i></i><span>Total</span>${demo ? DEMO_TAG : ''}<b>100 %</b></li></ul></div>`
    : `<p class="nx-h-quiet-line">${esc(waitOr(false))}</p>`;
  const evoHead = sm.available
    ? `<b class="nx-h-kpi-v nx-h-evo-v">${esc(money(sm.net, sm.currency, 0))}</b>${typeof sm.deltas.net === 'number' ? `<span class="nx-h-delta ${sm.deltas.net < 0 ? 'down' : 'up'}">${sm.deltas.net < 0 ? '↘' : '↗'} ${esc(pct(sm.deltas.net))}</span>` : ''}`
    : '';
  const evoCard = `<article class="nx-h-panel nx-h-chart-card"><header class="nx-h-ph"><h2>Évolution des ventes</h2>${demo ? DEMO_TAG : ''}</header>${evoHead}${evo}<small>${esc(caption('Ventes nettes HT par semaine, rapport Analyses'))}</small></article>`;
  const splitCard = `<article class="nx-h-panel nx-h-chart-card"><header class="nx-h-ph"><h2>Répartition des ventes</h2>${demo ? DEMO_TAG : ''}</header>${split}<small>${esc(caption('Canaux tels qu’enregistrés dans votre boutique'))}</small></article>`;

  // ---- four Core functions (bottom)
  const todo = dec === null ? '<p class="nx-h-quiet-line">Chargement…</p>' : !Array.isArray(dec) ? `<p class="nx-h-quiet-line">${esc(NO_DATA)} : le journal des décisions ne répond pas.</p>`
    : sum.pending.length === 0 ? '<p class="nx-h-quiet-line">Aucune validation en attente</p>'
    : `<ul class="nx-h-list">${sum.pending.slice(0, 3).map((d) => `<li><span>${esc(d.subject?.title ?? 'Décision d’achat')}</span></li>`).join('')}</ul><button type="button" class="nx-h-btn" data-act="nx-open-panel">Ouvrir les validations</button>`;
  const connBody = conn === null ? '<p class="nx-h-quiet-line">Chargement…</p>'
    : conn === 'UNAVAILABLE' ? `<p class="nx-h-quiet-line">${esc(NO_DATA)} : l’état des connexions ne répond pas.</p>`
    : `<ul class="nx-h-conn">${conn.map((c) => `<li><span class="nx-h-cdot${c.connected ? ' ok' : ''}" aria-hidden="true"></span><b>${esc(c.label)}</b><em class="nx-h-pill${c.connected ? ' ok' : ''}">${esc(c.statusLabel)}</em></li>`).join('')}</ul>${linkConnections && !demo ? '<a class="nx-h-link" href="/settings/connections">Voir les connexions</a>' : ''}`;
  const act = sum.available && sum.recent.length
    ? sum.recent.map((d) => `<li><div><b>${esc(d.subject?.title ?? 'Décision d’achat')}</b><span>${esc(dateFr(d.created_at))}</span></div><em class="nx-h-state">${esc(d.human_decision ? (DECIDED[d.human_decision.decision] ?? d.human_decision.decision) : 'En attente de décision')}</em></li>`).join('')
    : `<li class="nx-h-empty">${sum.available ? 'Les dernières actions enregistrées apparaîtront ici.' : 'Le journal des décisions est indisponible.'}</li>`;
  const CHECK = '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>';
  const CHAT = '<path d="M4 5h16v11H9l-5 4z"/>';
  const LINK = '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>';
  const TIMELINE = '<circle cx="12" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M12 8.5v7"/>';
  const CHEV = '<path d="M9 6l6 6-6 6"/>';
  const SEARCH = '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>';
  const ARROW = '<path d="M5 12h14M13 6l6 6-6 6"/>';
  const fnHead = (title, paths, extra = '', phPaths = null) => `<header class="nx-h-ph"><span class="nx-h-fn-ico">${phPaths ? `<span class="nx-h-ico-pc">${icon(paths, 18)}</span><span class="nx-h-ico-ph">${icon(phPaths, 18)}</span>` : icon(paths, 18)}</span><h2>${esc(title)}</h2>${extra}<span class="nx-h-chev" aria-hidden="true">${icon(CHEV, 16)}</span></header>`;
  const bottom = `<section class="nx-h-bottom" aria-label="Fonctions Core">
      <div class="nx-h-bcol"><article class="nx-h-panel nx-h-fn">${fnHead('À traiter pour vous', CHECK, demo ? DEMO_TAG : '')}${todo}</article>
      <article class="nx-h-panel nx-h-fn">${fnHead('Connexions', LINK, demo ? DEMO_TAG : '')}${connBody}</article></div>
      <div class="nx-h-bcol"><article class="nx-h-panel nx-h-fn">${fnHead('Parle à Nordla', CHAT, '<span class="nx-h-readonly">Lecture seule</span>')}
        <div class="nx-h-ask"><span class="nx-h-ask-ico">${icon(SEARCH, 15)}</span><input id="nx-home-q" maxlength="1000" placeholder="Posez une question sur vos données…" aria-label="Votre question"><button type="button" class="nx-h-ask-go" data-act="nx-home-ask" aria-label="Demander">${icon(ARROW, 16)}</button></div>
        <small>Nordla répond sur vos données, sans exécuter aucune action.</small></article>
      <article class="nx-h-panel nx-h-fn nx-h-activity">${fnHead('Activité récente', TIMELINE, '', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')}<ul class="nx-h-acts">${act}</ul></article></div>
    </section>`;

  // ---- ring (PC SVG + phone grid, the same four elements)
  const pillarM = (p, cls) => `<div class="nx-h-rm ${cls}"><span class="nx-h-pillar-ico">${icon(p.mobileIcon ?? p.icon, 20)}</span><b>${esc(p.name)}</b><span>${esc(p.sub)}</span></div>`;
  const ringM = `<div class="nx-h-ring-m" role="img" aria-label="Nordla et ses quatre piliers">
      ${pillarM(PILLARS[0], 'nx-h-rm-top')}
      ${pillarM(PILLARS[1], 'nx-h-rm-left')}
      <div class="nx-h-rm-core"><span>N</span></div>
      ${pillarM(PILLARS[2], 'nx-h-rm-right')}
      ${pillarM(PILLARS[3], 'nx-h-rm-bottom')}
    </div>`;

  // Phone ring, as the reference (image 77): white background, wide pill cards with a soft outline, gold tiles filling the card height, a white circle with the Nordla N, grey connectors, a dotted gold ring behind.
  const BARS_ICON = '<path d="M6 20v-7M11.5 20V9M17 20V5"/>';
  const LAYERS_ICON = '<path d="M12 3l8.5 4.5L12 12 3.5 7.5z"/><path d="M3.5 12.5l8.5 4.5 8.5-4.5"/><path d="M3.5 17l8.5 4.5 8.5-4.5"/>';
  const phCard = (p, x, y) => linkWrap(p, `<g class="nx-h-svg-node">
      <rect x="${x}" y="${y}" width="200" height="60" rx="30" fill="#FFFFFF" stroke="#EDF0F4" filter="url(#nx-ph-shadow)"/>
      <rect x="${x + 3}" y="${y + 3}" width="54" height="54" rx="16" fill="url(#nx-ph-gold)"/>
      <g transform="translate(${x + 30} ${y + 30}) scale(0.92) translate(-12 -12)" fill="none" stroke="#FFFFFF" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${p.key === 'top' ? BARS_ICON : p.key === 'right' ? LAYERS_ICON : p.icon}</g>
      <text x="${x + 72}" y="${y + 28}" font-size="22" font-weight="700" fill="#0B1220">${esc(p.name)}</text>
      <text x="${x + 72}" y="${y + 47}" font-size="15" fill="#3A4A5F">${esc(p.sub)}</text>
    </g>`);
  const dotsPh = Array.from({ length: 8 }, (_, i) => { const a = (i * 45 * Math.PI) / 180; return `<circle cx="${(282 + 150 * Math.cos(a)).toFixed(1)}" cy="${(165 + 150 * Math.sin(a)).toFixed(1)}" r="4.2" fill="#E8A51E"/>`; }).join('');
  const ringPh = `<svg class="nx-h-svg-ph" viewBox="0 0 564 330" role="img" aria-label="Nordla et ses quatre piliers">
      <defs>
        <linearGradient id="nx-ph-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E9A93F"/><stop offset="1" stop-color="#C98A27"/></linearGradient>
        <filter id="nx-ph-shadow" filterUnits="userSpaceOnUse" x="-20" y="-20" width="604" height="370"><feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#0F1B2D" flood-opacity="0.08"/></filter>
      </defs>
      <circle cx="282" cy="165" r="150" fill="none" stroke="#E8A51E" stroke-width="1.6" stroke-dasharray="2 6" stroke-linecap="round"/>
      ${dotsPh}
      <line x1="282" y1="74" x2="282" y2="115" stroke="#8B939D" stroke-width="2"/>
      <line x1="200" y1="165" x2="232" y2="165" stroke="#8B939D" stroke-width="2"/>
      <line x1="332" y1="165" x2="364" y2="165" stroke="#8B939D" stroke-width="2"/>
      <line x1="282" y1="215" x2="282" y2="256" stroke="#8B939D" stroke-width="2"/>
      <circle cx="282" cy="165" r="50" fill="#FFFFFF" stroke="#EDF0F4" filter="url(#nx-ph-shadow)"/>
      <svg x="252" y="135" width="60" height="60" viewBox="0 0 60 60" overflow="hidden"><image href="/assets/nordla-logo.png" x="-3" y="-3" width="205" height="60" preserveAspectRatio="xMinYMin meet"/></svg>
      ${phCard(PILLARS[0], 182, 14)}
      ${phCard(PILLARS[1], 0, 135)}
      ${phCard(PILLARS[2], 364, 135)}
      ${phCard(PILLARS[3], 182, 256)}
    </svg>`;
  // The PC circle is the reference picture (image 102). Its four functions are links placed over the four cards.
  const PC_HITS = [
    { key: 'top', act: 'nx-open-panel', label: 'Agents IA' },
    { key: 'left', href: '/settings', label: 'Données' },
    { key: 'right', href: '/settings/connections', label: 'Outils' },
    { key: 'bottom', act: 'nx-open-panel', label: 'Règles' },
  ];
  const hitOf = (h) => {
    const cls = `nx-h-hit nx-h-hit-${h.key}`;
    return h.href
      ? `<a class="${cls}" href="${h.href}" aria-label="${esc(h.label)}"></a>`
      : `<button type="button" class="${cls}" data-act="${h.act}" aria-label="${esc(h.label)}"></button>`;
  };
  const ringPc = `<div class="nx-h-ring-pc"><img src="/assets/core-ring.svg" alt="Nordla et ses quatre piliers" width="460" height="380">${PC_HITS.map(hitOf).join('')}</div>`;
  const searchBar = `<div class="nx-h-search" aria-hidden="true"><span class="nx-h-search-ico">${icon('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>', 16)}</span><span class="nx-h-search-txt">Rechercher dans Nordla…</span></div>`;
  return `<section class="nx-home${demo ? ' nx-home-demo' : ''}" aria-label="Nordla Core">
    <header class="nx-h-top">
      <button type="button" class="nx-h-burger" data-act="nx-menu" aria-label="Menu des modules">☰</button>
      <img class="nx-h-logo-img nx-h-logo-top" src="/assets/nordla-logo.png" alt="Nordla" width="120" height="34">
      <span class="nx-h-avatar nx-h-top-av" aria-label="Profil">JD</span>
    </header>
    ${demo ? DEMO_BANNER : ''}
    <aside class="nx-home-side" aria-label="Menu principal">
      <img class="nx-h-logo-img" src="/assets/nordla-logo.png" alt="Nordla, vos données en action" width="150" height="43">
      <p class="nx-h-menu-title">Menu principal</p>
      <ul>
        <li class="nx-h-cur"><span class="nx-h-navico" style="color:#0F1B2D">${icon('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>', 16)}</span><span>Tableau de bord</span></li>
        <li><button type="button" class="nx-h-nav" data-act="nx-open-panel"><span class="nx-h-navico" style="color:#0F1B2D">${icon('<path d="M4 5h16v11H9l-5 4z"/>', 16)}</span><span>Parle à Nordla</span></button></li>
        ${menu.map((c) => `<li>${navHtml(c)}</li>`).join('')}
      </ul>
      <section class="nx-h-settings" aria-label="Réglages"><p class="nx-h-menu-title">Réglages</p><ul>
        <li><a class="nx-h-nav" href="/settings/connections"><span class="nx-h-navico" style="color:#46778D" aria-hidden="true">${icon('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>', 19)}</span><span>Connexions</span></a></li>
        <li><a class="nx-h-nav" href="/settings"><span class="nx-h-navico" style="color:#6B7280" aria-hidden="true">${icon(NAV_PATHS.gear, 19)}</span><span>Paramètres</span></a></li>
      </ul></section>
    </aside>
    <div class="nx-h-main">
      <div class="nx-h-bar">
        ${searchBar}
        <div class="nx-h-bar-r">
          <button type="button" class="nx-h-iconbtn" disabled aria-label="Notifications (non disponible)">${icon('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>', 18)}</button>
          <span class="nx-h-avatar" aria-label="Profil">${icon('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>', 18)}</span>
        </div>
      </div>
      <header class="nx-h-hero">
        <div class="nx-h-hero-txt">
          <h1>Nordla Core</h1>
          <p>Votre entreprise, augmentée par l’IA</p>
          <span class="nx-h-status ${statusClass}">${esc(status)}</span>${demo ? ` ${DEMO_TAG}` : ''}${role ? ` <span class="nx-h-chip">Rôle : ${esc(role)}</span>` : ''}
        </div>
        <div class="nx-h-hero-art" aria-hidden="true"><img class="nx-h-hero-img" src="/assets/nordla-hero.png" alt="" width="521" height="165"><span class="nx-h-claim">Des idées<br>des résultats.</span></div>
      </header>
      ${note}${salesNote}${err}
      <div class="nx-h-band">
        <div class="nx-h-kcol">${ventes}${commandes}${panier}</div>
        <section class="nx-h-stage" aria-label="Nordla">${ringPc}${ringPh}</section>
        <div class="nx-h-ccol">${evoCard}${splitCard}</div>
      </div>
      ${bottom}
      ${role ? `<p class="nx-h-role-line">Rôle : ${esc(role)}</p>` : ''}
    </div>
  </section>`;
}

/** The return link shown on every module screen: one way back to the Core home. */
export function nordlaBackBar() {
  return '<div class="nx-back"><button type="button" class="btn sec" data-act="sl-nordla">← Accueil Nordla</button></div>';
}
