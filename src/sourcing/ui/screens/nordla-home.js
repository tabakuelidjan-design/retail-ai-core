// Nordla home (Core entry). One card per module from GET /api/core/modules: the state and the detail are the server's own words.
// An action is shown only when the server confirms it (dashboard, growth_sso, creator_screen, video_screen). Sourcing is always a card.
// Nothing here invents a page, a figure or a right. Offline, only the Sourcing card is actionable and the screen says so.
import { esc } from '../dom.js';

// One colour per module: the left menu and the card border change from module to module (the person sees the change of module).
export const MODULE_COLOURS = Object.freeze({
  sourcing: '#8a1d22', finance: '#1b5e7f', analytics: '#5b3f8c', procurement: '#8a4b12',
  branding: '#7a2f6b', marketing: '#b35c00', creative: '#2d6a4f', growth: '#1f6f5c',
});

const SAFE_HTTPS = /^https:\/\/[^\s"'<>]+$/;

/** The cards of the home, in the server's order. Pure: no DOM, no network. */
export function homeCards(modules, { online = true } = {}) {
  const list = Array.isArray(modules) ? modules : [];
  const byKey = new Map(list.map((m) => [m.key, m]));
  const cards = [];
  // Sourcing is a module like the others. It works offline, so it is the only card that stays actionable without the server.
  cards.push({ key: 'sourcing', label: 'Sourcing', state: 'DISPONIBLE', detail: 'Fournisseurs, photos, analyses d’achat ; fonctionne hors ligne.', colour: MODULE_COLOURS.sourcing, action: { type: 'local', to: 'sourcing', label: 'Ouvrir Sourcing' } });
  for (const m of list) {
    if (!m || typeof m.key !== 'string' || m.key === 'core' || m.key === 'sourcing') continue; // Core is this home; Sourcing is added above from the same rule
    const colour = MODULE_COLOURS[m.key] ?? '#44506a';
    const card = { key: m.key, label: String(m.label ?? m.key), state: String(m.state ?? 'NON RACCORDÉ'), detail: String(m.detail ?? ''), colour, action: null };
    if (online) card.action = actionOf(m, byKey);
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
  return null; // Achats, Brand, and any module without a confirmed screen: state only
}

function actionHtml(c) {
  const a = c.action;
  if (!a) return '';
  if (a.type === 'local') return `<button type="button" class="btn" data-act="sl-nav" data-key="home">${esc(a.label)}</button>`;
  // A Growth link keeps its https href: the single sign-on handler reads it as the plain fallback.
  if (a.type === 'nx' && a.href) return `<a class="btn" href="${esc(a.href)}" data-act="${esc(a.act)}" data-to="${esc(a.to)}" target="_blank" rel="noopener">${esc(a.label)}</a>`;
  if (a.type === 'nx') return `<button type="button" class="btn" data-act="${esc(a.act)}">${esc(a.label)}</button>`;
  return `<a class="btn" href="${esc(a.href)}">${esc(a.label)}</a>`;
}

/** The home screen. `modules` is null while loading. */
export function nordlaHomeHtml({ modules, online = true, error = '' } = {}) {
  const loading = online && modules === null;
  const cards = homeCards(modules ?? [], { online });
  const note = !online
    ? '<p class="small warn">Hors connexion : seul China Sourcing fonctionne. Les autres modules reprendront avec la connexion au serveur.</p>'
    : loading ? '<p class="small muted">Chargement des modules…</p>' : '';
  const err = error ? `<p class="small warn">${esc(error)}</p>` : '';
  return `<section class="nx-home" aria-label="Accueil Nordla">
    <h1>Nordla</h1>
    <p class="small muted">Votre entreprise, un accueil commun. Chaque module garde ses propres droits.</p>
    ${note}${err}
    <div class="nx-home-grid">${cards.map((c) => `<article class="card nx-home-card" data-module="${esc(c.key)}" style="border-left:6px solid ${esc(c.colour)}">
      <h2>${esc(c.label)}</h2>
      <p class="small"><b>${esc(c.state)}</b></p>
      ${c.detail ? `<p class="small muted">${esc(c.detail)}</p>` : ''}
      ${actionHtml(c)}
    </article>`).join('')}</div>
  </section>`;
}

/** The return link shown on every module screen: one way back to the Nordla home. */
export function nordlaBackBar() {
  return '<div class="nx-back"><button type="button" class="btn sec" data-act="sl-nordla">← Accueil Nordla</button></div>';
}
