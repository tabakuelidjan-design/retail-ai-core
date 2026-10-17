// Nordla Core - desktop dashboard and mobile shell (/nordla). Reads ONLY what the server answers (status, modules, journal, backups,
// session) and shows it with the Nordla Design System (nordla-ds.*). It changes nothing on the server except asking Parle à Nordla
// (read-only answers) and signing out. Every action stays where it already is and keeps its server checks: decisions, approvals,
// China Sourcing (field app at /). Routes: #accueil #modules #module/<key> #parle #recherche #plus.
import { buildDashboard, navItems } from './nordla-view.js';
import { esc, sidebar, topbar, metricCard, coreDiagram, moduleCard, activityFeed, guardianIndicator, mobileNav, statusBadge, icon } from './nordla-ds.js';

const CSRF_COOKIE = '__Host-nordla_sourcing_csrf';
const csrf = () => { for (const p of String(document.cookie).split(';')) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i).trim() === CSRF_COOKIE) return p.slice(i + 1).trim(); } return ''; };
const localToken = () => { try { return JSON.parse(localStorage.getItem('nordla.sourcing.token') ?? '""') || ''; } catch { return ''; } };
const QUICK = { finance: [['Factures fournisseurs à payer', 'quelles factures fournisseurs dois-je payer et quelles sont les échéances ?'], ['Trésorerie', 'ma trésorerie'], ['Achats du mois', 'mes achats du mois']], analytics: [['Évolution des ventes', 'comment évoluent mes ventes et pourquoi certaines performances changent-elles ?']], procurement: [['Commandes d’achat ouvertes', 'quelles commandes d’achat sont ouvertes ?']] };

const S = { session: null, data: null, loading: true, error: '', answer: null, asking: false, cases: null, query: '' };
const route = () => (location.hash.replace(/^#/, '') || 'accueil');

async function api(path, opts = {}) {
  const headers = { accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(S.session?.mode === 'session' ? (opts.method && opts.method !== 'GET' ? { 'x-nordla-csrf': csrf() } : {}) : { 'x-sourcing-token': localToken() }) };
  const r = await fetch(path, { ...opts, credentials: 'same-origin', headers });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

async function load() {
  S.loading = true; S.error = ''; paint();
  try { S.session = (await api('/api/auth/session')).body; } catch { S.session = null; }
  if (S.session?.mode === 'session' && !S.session.authenticated) { S.loading = false; return paint(); }
  const get = async (p) => { try { const r = await api(p); return r.ok || p === '/healthz/backup' ? r.body : null; } catch { return null; } };
  const [status, modules, decisions, backup] = await Promise.all([get('/api/core/status'), get('/api/core/modules'), get('/api/core/decisions'), get('/healthz/backup')]);
  const online = status !== null || modules !== null;
  S.data = buildDashboard({ status, modules: modules?.modules ?? null, decisions: decisions?.decisions ?? null, backup: backup?.status ? backup : null, session: S.session, online, now: new Date().toISOString() });
  S.raw = { modules: modules?.modules ?? null };
  if (!online) S.error = 'Le serveur ne répond pas : rien n’est affiché comme disponible.';
  S.loading = false; paint();
}

async function ask(text) {
  if (!text.trim() || S.asking) return;
  S.asking = true; S.answer = null; paint();
  try { const r = await api('/api/core/ask', { method: 'POST', body: JSON.stringify({ text: text.slice(0, 1000) }) }); S.answer = r.ok ? { q: text, ...r.body } : { q: text, error: r.body?.message ?? `Le serveur a refusé la question (${r.status}).` }; }
  catch { S.answer = { q: text, error: 'Le serveur ne répond pas.' }; }
  S.asking = false; paint();
}

const head = (title, sub, extra = '') => `<div class="nd-card-head" style="margin:8px 0 0"><div><h1 class="nd-h1">${esc(title)}</h1>${sub ? `<p class="nd-sub">${esc(sub)}</p>` : ''}</div>${extra}</div>`;
const answerCard = (a) => (!a ? '' : `<section class="nd-card nd-answer" data-nd-answer aria-live="polite"><p class="nd-muted" style="font-size:13px">${esc(a.q)}</p>${a.error ? `<div class="nd-alert is-error">${esc(a.error)}</div>`
  : `${String(a.answer ?? '').split('\n').map((l) => `<p>${esc(l)}</p>`).join('')}${a.sources?.length ? `<p class="nd-muted" style="font-size:12px">Sources : ${esc(a.sources.map((s) => (typeof s === 'string' ? s : s.label ?? s.source ?? JSON.stringify(s))).join(' · '))}</p>` : ''}${a.limits?.length ? `<p class="nd-muted" style="font-size:12px">Limites : ${esc(a.limits.join(' · '))}</p>` : ''}`}</section>`);

function dashboard(d) {
  const mods = d.modules.slice(0, 8);
  return `${head('Nordla Core', 'Décisions, modules et suivi de votre entreprise', statusBadge({ tone: d.system.tone, label: d.system.label }))}
    ${d.system.tone !== 'ok' ? `<div class="nd-alert is-info" data-nd-system>${esc(d.system.detail)}</div>` : ''}
    <div class="nd-grid nd-grid-main">
      <div class="nd-grid">
        <section class="nd-card"><div class="nd-card-head"><h2 class="nd-h2">Nordla Core</h2></div>${coreDiagram(d.nodes)}</section>
        <div class="nd-grid nd-grid-3">${d.metrics.map(metricCard).join('')}${metricCard({ label: d.ai.label, value: d.ai.value, source: d.ai.source })}</div>
        <section class="nd-card"><div class="nd-card-head"><h2 class="nd-h2">Activité Nordla Core</h2><span class="nd-muted" style="font-size:12px">journal</span></div>${activityFeed(d.activity)}</section>
      </div>
      <div class="nd-grid">
        <section class="nd-card"><div class="nd-card-head"><h2 class="nd-h2">Mes modules</h2><a href="#modules" style="font-size:13px">Voir tout</a></div>
          ${mods.length ? `<div class="nd-modules">${mods.map(moduleCard).join('')}</div>` : '<div class="nd-empty">Modules non disponibles : le serveur n’a pas répondu.</div>'}</section>
        ${guardianIndicator(d.guardian)}
      </div>
    </div>`;
}

function moduleScreen(key) {
  const m = S.data.modules.find((x) => x.key === key);
  if (!m) return `${head('Module', '')}<div class="nd-empty">Ce module n’est pas raccordé à ce serveur.</div>`;
  const quick = (QUICK[key] ?? []).map(([l, q]) => `<button class="nd-btn is-secondary" data-ask="${esc(q)}" ${m.tone === 'neutral' || m.tone === 'error' ? 'disabled' : ''}>${esc(l)}</button>`).join('');
  return `${head(m.name, m.short, statusBadge({ tone: m.tone, label: m.state }))}
    <section class="nd-card"><h2 class="nd-h2">Sur ce serveur</h2><p>${esc(m.detail)}</p>
      ${m.external ? '<a class="nd-btn" href="/">Ouvrir China Sourcing</a>' : ''}
      ${quick ? `<h2 class="nd-h2" style="margin-top:12px">Questions en lecture seule</h2><p class="nd-sub">Réponses calculées par le serveur, avec leur source. Rien n’est modifié.</p><div class="nd-chips" style="margin-top:8px">${quick}</div>` : ''}
      ${!m.external && !quick ? '<p class="nd-sub">Les actions de ce module (décisions, approbations) se font dans l’application terrain, menu « Nordla », avec leurs contrôles serveur.</p><a class="nd-btn is-secondary" href="/">Ouvrir l’application terrain</a>' : ''}
    </section>${answerCard(S.answer)}`;
}

const parleScreen = () => `${head('Parle à Nordla', 'Questions en texte ; réponses calculées par le serveur, en lecture seule')}
  <section class="nd-card"><form data-nd-ask><label class="nd-sr" for="nd-ask">Votre question</label><textarea id="nd-ask" class="nd-input" style="height:96px;padding:10px" maxlength="1000" placeholder="Ex. quelles factures fournisseurs dois-je payer ?"></textarea>
    <div class="nd-chips" style="margin-top:12px"><button class="nd-btn" type="submit" ${S.asking ? 'disabled' : ''}>${S.asking ? 'Nordla répond…' : 'Demander'}</button><a class="nd-btn is-secondary" href="/">Dictée vocale (application terrain)</a></div></form>
    <p class="nd-sub" style="margin-top:12px">Nordla n’exécute rien : il répond, ou dit pourquoi il ne peut pas. La dictée vocale reste dans l’application terrain (micro traité sur le téléphone).</p></section>${answerCard(S.answer)}`;

function searchScreen() {
  const q = S.query.trim().toLowerCase();
  const mods = q ? S.data.modules.filter((m) => `${m.name} ${m.short}`.toLowerCase().includes(q)) : [];
  const cases = q && Array.isArray(S.cases) ? S.cases.filter((c) => String(c.name ?? c.id).toLowerCase().includes(q)).slice(0, 20) : [];
  return `${head('Recherche', 'Modules et dossiers China Sourcing de ce serveur')}
    <section class="nd-card"><form data-nd-search><label class="nd-sr" for="nd-q2">Rechercher</label><input id="nd-q2" class="nd-input" name="q" type="search" value="${esc(S.query)}" placeholder="Nom de module ou de dossier"></form></section>
    ${!q ? '' : `<section class="nd-card"><h2 class="nd-h2">Modules</h2>${mods.length ? `<div class="nd-modules">${mods.map(moduleCard).join('')}</div>` : '<p class="nd-sub">Aucun module.</p>'}
      <h2 class="nd-h2" style="margin-top:12px">Dossiers</h2>${S.cases === null ? '<p class="nd-sub">Dossiers non disponibles (serveur).</p>' : cases.length ? `<ul class="nd-feed">${cases.map((c) => `<li><div><b>${esc(c.name ?? c.id)}</b><span>Ouvrir dans l’application terrain</span></div></li>`).join('')}</ul>` : '<p class="nd-sub">Aucun dossier.</p>'}</section>`}`;
}

const plusScreen = () => `${head('Plus', '')}
  <section class="nd-card"><h2 class="nd-h2">Session</h2><p class="nd-sub">${S.session?.mode === 'session' ? (S.session.authenticated ? `Connecté${S.session.role ? ` (${esc(S.session.role)})` : ''}` : 'Non connecté') : 'Serveur local (jeton)'}</p>
    <div class="nd-chips" style="margin-top:12px"><a class="nd-btn is-secondary" href="/">Application terrain (China Sourcing)</a>${S.session?.mode === 'session' && S.session.authenticated ? '<button class="nd-btn is-secondary" data-nd-logout>Se déconnecter</button>' : ''}</div></section>
  ${S.data ? guardianIndicator(S.data.guardian) : ''}`;

function content() {
  if (S.loading) return `${head('Nordla Core', 'Chargement de l’état réel du serveur…')}<div class="nd-empty" aria-busy="true">Chargement…</div>`;
  if (S.session?.mode === 'session' && !S.session.authenticated) return `${head('Nordla', 'Connexion requise')}<section class="nd-card"><p>Connectez-vous avec votre compte Nordla dans l’application, puis revenez ici.</p><a class="nd-btn" href="/">Se connecter</a></section>`;
  const r = route();
  const err = S.error ? `<div class="nd-alert is-error" role="alert">${esc(S.error)}</div>` : '';
  if (r === 'modules') return `${err}${head('Modules', 'État réel de chaque module sur ce serveur')}<div class="nd-modules is-grid" data-nd-modules>${S.data.modules.map(moduleCard).join('') || '<div class="nd-empty">Modules non disponibles.</div>'}</div>`;
  if (r.startsWith('module/')) return err + moduleScreen(r.slice(7));
  if (r === 'parle') return err + parleScreen();
  if (r === 'recherche') return err + searchScreen();
  if (r === 'plus') return err + plusScreen();
  return err + dashboard(S.data);
}

function paint() {
  const r = route();
  const items = navItems({ modules: S.raw?.modules ?? null, route: r });
  document.getElementById('nd-app').innerHTML = `<div class="nd-shell">${sidebar(items, S.data ? guardianIndicator(S.data.guardian) : '')}
    <main class="nd-main" id="nd-main" tabindex="-1">${topbar({ initials: S.session?.authenticated ? 'Moi' : '', query: S.query })}<div class="nd-content">${content()}</div></main>${mobileNav(r)}</div>`;
}

document.addEventListener('submit', (ev) => {
  const f = ev.target;
  if (f.matches('[data-nd-ask]')) { ev.preventDefault(); ask(document.getElementById('nd-ask').value); }
  if (f.matches('[data-nd-search]')) { ev.preventDefault(); S.query = new FormData(f).get('q') ?? ''; if (S.cases === null || S.cases === undefined) api('/api/cases').then((r) => { S.cases = r.ok ? r.body.cases ?? [] : null; paint(); }).catch(() => {}); if (route() !== 'recherche') location.hash = '#recherche'; else paint(); }
});
document.addEventListener('click', async (ev) => {
  const q = ev.target.closest('[data-ask]'); if (q && !q.disabled) return ask(q.dataset.ask);
  if (ev.target.closest('[data-nd-logout]')) { try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* the server decides */ } return load(); }
});
window.addEventListener('hashchange', () => { S.answer = null; paint(); document.getElementById('nd-main')?.focus({ preventScroll: true }); window.scrollTo(0, 0); });
S.cases = undefined;
load();
window.nordlaCore = { state: () => S, reload: load };
