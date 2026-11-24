// Paramètres (hub) and Paramètres › Connexions (list + detail), one script, two routes. Everything comes from GET /api/settings and GET /api/connections (the registry + the real state):
// the page never names a provider. All text from the server is inserted with textContent.
(() => {
  'use strict';
  const CSRF_COOKIES = ['__Host-nordla_sourcing_csrf'];
  const csrf = () => { for (const part of String(document.cookie).split(';')) { const i = part.indexOf('='); if (i > 0 && CSRF_COOKIES.includes(part.slice(0, i).trim())) return part.slice(i + 1).trim(); } return ''; };
  const app = document.getElementById('app');
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : String(v)); } for (const k of kids.flat(Infinity)) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
  const svg = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'cx-ico'); s.setAttribute('aria-hidden', 'true'); for (const p of d) { const e = document.createElementNS('http://www.w3.org/2000/svg', 'path'); e.setAttribute('d', p); s.append(e); } return s; };
  const ICONS = {
    home: ['M3 11l9-8 9 8', 'M5 10v10h14V10'], sourcing: ['M11 4a7 7 0 100 14 7 7 0 000-14z', 'M21 21l-5-5'], procurement: ['M3 4h2l2 11h11l2-8H7', 'M9 20h.01', 'M17 20h.01'], finance: ['M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z', 'M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7', 'M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5'],
    analytics: ['M5 20V12', 'M12 20V5', 'M19 20v-9'], growth: ['M3 17l6-6 4 4 8-8', 'M15 7h6v6'], marketing: ['M4 10v4l12 5V5L4 10z', 'M7 14l1 5h3l-1-4'], settings: ['M12 9a3 3 0 100 6 3 3 0 000-6z', 'M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.5-2.3 1a7 7 0 00-2-1.2L14 3h-4l-.6 2.6a7 7 0 00-2 1.2l-2.3-1-2 3.5 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.3-1a7 7 0 002 1.2L10 21h4l.6-2.6a7 7 0 002-1.2l2.3 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z'],
    gear: ['M12 9a3 3 0 100 6 3 3 0 000-6z', 'M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.5-2.3 1a7 7 0 00-2-1.2L14 3h-4l-.6 2.6a7 7 0 00-2 1.2l-2.3-1-2 3.5 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.3-1a7 7 0 002 1.2L10 21h4l.6-2.6a7 7 0 002-1.2l2.3 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z'],
    users: ['M9 11a4 4 0 100-8 4 4 0 000 8z', 'M2 21v-1a6 6 0 0112 0v1', 'M16 4a4 4 0 010 7', 'M18 14a6 6 0 013 5v2'], plug: ['M9 2v6', 'M15 2v6', 'M6 8h12v4a6 6 0 01-12 0V8z', 'M12 18v4'],
    bell: ['M6 9a6 6 0 0112 0c0 6 2 7 2 8H4c0-1 2-2 2-8z', 'M10 21h4'], sliders: ['M4 6h10', 'M18 6h2', 'M4 12h4', 'M12 12h8', 'M4 18h12', 'M20 18h0', 'M14 4v4', 'M8 10v4', 'M16 16v4'], shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z'], chevron: ['M9 6l6 6-6 6'], back: ['M15 6l-6 6 6 6'], menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  };
  const ico = (name) => svg(ICONS[name] ?? ICONS.gear);
  const api = async (path, body) => {
    const r = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json', 'x-nordla-csrf': csrf() } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* none */ }
    return { ok: r.ok, status: r.status, json: j };
  };
  const when = (iso) => { try { return new Date(iso).toLocaleString('fr-BE', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Brussels' }); } catch { return iso; } };
  const ERR = {
    APP_NOT_CONFIGURED: 'L’application du fournisseur n’est pas encore configurée sur ce serveur.', FORBIDDEN_ROLE: 'Votre rôle ne permet pas de gérer les connexions.', SESSION_INVALID: 'Votre session n’est plus valide : reconnectez-vous.', CSRF_INVALID: 'Session expirée : rechargez la page.',
    TENANT_MISMATCH: 'Cette connexion appartient à une autre boutique.', PC_TARGET_INELIGIBLE: 'Ce compte ne peut pas être utilisé : un compte professionnel est nécessaire.', PC_TARGET_NOT_FOUND: 'Ce compte ne fait pas partie de ceux que vous avez autorisés.',
    PC_SESSION_NOT_FOUND: 'Cette autorisation est introuvable ou expirée : recommencez la connexion.', PC_SESSION_STATE_CONFLICT: 'Cette autorisation a déjà été utilisée : recommencez la connexion.', PC_VAULT_UNAVAILABLE: 'Le coffre des jetons est indisponible : rien n’a été enregistré.',
    USER_DENIED: 'Vous avez refusé l’accès : rien n’a été connecté.', INVALID_STATE: 'La réponse du fournisseur ne correspond à aucune demande en cours : recommencez.', SESSION_EXPIRED: 'La demande a expiré : recommencez.', CODE_EXCHANGE_FAILED: 'Le fournisseur a refusé l’autorisation : recommencez.',
    REAUTH_REQUIRED: 'Instagram a refusé l’accès : reconnectez le compte.', RATE_LIMITED: 'Instagram a demandé de ralentir : réessayez plus tard.', SOURCE_UNREACHABLE: 'Instagram est injoignable pour le moment : réessayez plus tard.', NOT_CONNECTED: 'Ce compte n’est pas connecté.',
    SCOPE_MISSING: 'Une permission de lecture n’a pas été accordée : recommencez et acceptez-les toutes.', PROVIDER_UNAVAILABLE: 'Le fournisseur ne répond pas pour le moment : réessayez plus tard.', PROVIDER_UNSUPPORTED: 'Ce fournisseur n’est pas encore connectable.', CALLBACK_FAILED: 'La connexion n’a pas abouti : recommencez.',
  };
  const errText = (r) => ERR[r.json?.error?.code ?? r.json?.oauth] ?? `Action refusée (${r.status}).`;

  // ------------------------------------------------------------------ shell: the Nordla menu (left) + the page
  const INITIALS = { shopify: 'S', instagram: 'Ig', tiktok: 'Tk', google_business_profile: 'G', bank: 'B', odoo: 'odoo', woocommerce: 'Woo', prestashop: 'Ps' };
  const SETTINGS_NAV = [
    { id: 'overview', label: 'Vue d’ensemble', href: '/settings', icon: 'home', colour: '#0F1B2D' },
    { id: 'general', label: 'Général', href: '/settings/general', icon: 'settings', colour: '#6B7280' },
    { id: 'team', label: 'Équipe et accès', href: '/settings/team', icon: 'users', colour: '#46778D' },
    { id: 'connections', label: 'Connexions', href: '/settings/connections', icon: 'plug', colour: '#7842B8' },
    { id: 'notifications', label: 'Notifications', href: '/settings/notifications', icon: 'bell', colour: '#E87924' },
    { id: 'preferences', label: 'Préférences', href: '/settings/preferences', icon: 'sliders', colour: '#D1A44F' },
    { id: 'security', label: 'Sécurité', href: '/settings/security', icon: 'shield', colour: '#B92335' },
  ];
  function shell(settings, current, content) {
    const path = location.pathname.endsWith('/') ? location.pathname.slice(0, -1) || '/' : location.pathname;
    const nav = h('nav', { class: 'cx-nav', 'aria-label': 'Navigation Paramètres' }, SETTINGS_NAV.map((n) => {
      const active = n.id === 'overview' ? path === '/settings' : path === n.href;
      const itemIcon = ico(n.icon); itemIcon.style.color = n.colour;
      return h('a', { class: 'cx-nav-item', href: n.href, 'aria-current': active ? 'page' : null }, itemIcon, h('span', { text: n.label }));
    }));
    return h('div', { class: 'cx-shell' },
      h('div', { class: 'cx-main' },
        h('header', { class: 'cx-top' }, h('strong', { class: 'cx-module-title', text: 'Paramètres' }), h('span', { class: 'cx-top-spacer' }), h('span', { class: 'cx-shop', text: settings.merchant?.name ?? 'Boutique' }), settings.environment ? h('span', { class: 'cx-env', text: settings.environment }) : null),
        nav,
        h('main', { class: 'cx-page' }, content)));
  }
  const signIn = () => app.replaceChildren(h('div', { class: 'cx-wrap' }, h('h1', { text: 'Paramètres' }), h('p', { class: 'cx-sub', text: 'Connectez-vous avec votre compte Nordla.' }), h('a', { class: 'cx-btn', href: '/', text: 'Ouvrir Nordla' })));
  const guard = (r) => (r.status === 401 || (r.status === 403 && r.json?.error?.code !== 'FORBIDDEN_ROLE') ? (signIn(), true) : false);

  // ------------------------------------------------------------------ Paramètres (hub)
  async function hub() {
    const r = await api('/api/settings'); if (guard(r)) return;
    if (!r.ok) return app.replaceChildren(h('div', { class: 'cx-wrap' }, h('h1', { text: 'Paramètres' }), h('p', { class: 'cx-msg err', text: 'Cette page est indisponible pour le moment.' })));
    const s = r.json; const T = s.texts ?? { title: 'Paramètres', subtitle: 'Aperçu général.' }; if (s.lang) document.documentElement.lang = s.lang; // the person's saved language (Préférences); no saved language = French as before
    const card = (c) => {
      const body = [h('div', { class: 'cx-card-head' }, h('span', { class: 'cx-card-ico' }, ico(c.icon)), h('h2', { text: c.label }), c.available ? h('span', { class: 'cx-chev' }, ico('chevron')) : h('span', { class: 'cx-avail', 'data-available': 'false', text: c.availabilityLabel })),
        h('p', { class: 'cx-card-desc', text: c.description }),
        c.available && c.providers ? h('ul', { class: 'cx-prov' }, c.providers.map((p) => h('li', { 'data-tone': p.status === 'PLANNED' ? 'planned' : p.statusLabel === 'Connecté' ? 'ok' : 'todo' }, h('span', { class: 'cx-badge', text: INITIALS[p.id] ?? p.label.slice(0, 2) }), h('span', { class: 'cx-prov-text' }, h('span', { class: 'cx-prov-name', text: p.label }), h('span', { class: 'cx-prov-state', text: p.statusLabel }))))) : null,
        !c.available && c.note ? h('p', { class: 'cx-card-note', text: c.note }) : null];
      return c.available ? h('a', { class: 'cx-set-card highlight', href: c.href, 'data-section': c.id }, body) : h('div', { class: 'cx-set-card', 'data-section': c.id, 'aria-disabled': 'true' }, body);
    };
    app.replaceChildren(shell(s, 'settings', [h('h1', { text: T.title }), h('p', { class: 'cx-sub', text: T.subtitle }), h('div', { class: 'cx-set-grid' }, s.cards.map(card))]));
  }

  // ------------------------------------------------------------------ Paramètres › Connexions (list + detail)
  let data = null; let settings = null; let flash = null; let pick = null; let selected = null;
  const wide = () => window.matchMedia('(min-width: 900px)').matches;
  const listState = (p) => (p.connections.some((c) => c.state === 'VERIFIED' || c.state === 'LINKED') ? ['Connecté', 'ok'] : p.status === 'PLANNED' ? ['Prévu', 'planned'] : p.status === 'WAITING' ? ['En attente', 'wait'] : p.source === 'shopify' ? ['Non reliée', 'todo'] : p.setup.state === 'APP_MISSING' ? ['À configurer', 'todo'] : p.connections.length ? [p.connections[0].stateLabel, 'wait'] : ['Prêt', 'wait']);
  const providers = () => data.categories.flatMap((c) => c.providers);

  async function startOAuth(path, body) { const r = await api(path, body); if (r.ok && r.json.authorizationUrl) { location.assign(r.json.authorizationUrl); return; } setFlash('err', errText(r)); }
  async function runAction(connectionId, action) {
    if (action === 'reconnect') return startOAuth(`/api/connections/${connectionId}/reconnect`, {});
    if (action === 'disconnect' && !window.confirm('Déconnecter ce compte ? Les jetons enregistrés seront détruits ; rien ne change chez le fournisseur.')) return;
    const r = await api(`/api/connections/${connectionId}/${action}`, {});
    if (r.ok) { data = r.json; setFlash('ok', action === 'verify' ? 'État revérifié auprès du fournisseur.' : action === 'read' ? (r.json.read?.outcome === 'OK' ? 'Lecture réussie : voir « Données lues ».' : 'Lecture terminée avec des réserves : voir « Données lues ».') : 'Compte déconnecté.'); } else { if (action === 'read') { const f = await api('/api/connections'); if (f.ok) data = f.json; } setFlash('err', errText(r)); }
  }
  async function choose(target) {
    const r = await api('/api/connections/select', { session_ref: pick.ref, external_id: target.externalId });
    if (r.ok) { data = r.json; pick = null; setFlash('ok', r.json.state === 'CONFIGURED' ? `Compte ${target.displayName ?? target.externalId} connecté et vérifié (lecture seule).` : 'Compte lié ; la vérification n’est pas concluante : voir l’état ci-dessous.'); } else setFlash('err', errText(r));
  }
  const setFlash = (tone, text) => { flash = { tone, text }; renderConnections(); };
  const go = (id) => { selected = id; history.replaceState(null, '', id ? `#/${id}` : location.pathname); renderConnections(); window.scrollTo(0, 0); };

  // The return address is never printed inline (it overflows a phone): it sits behind a button; if the clipboard is refused, it is shown selectable instead.
  function copyBlock(c) {
    const out = h('span', { class: 'cx-copy-out', 'aria-live': 'polite' });
    const btn = h('button', { class: 'cx-btn ghost cx-copy', type: 'button', text: c.label, on: { click: async () => {
      try { await navigator.clipboard.writeText(c.value); out.textContent = 'Adresse copiée.'; btn.textContent = 'Adresse copiée'; setTimeout(() => { btn.textContent = c.label; }, 2500); }
      catch { out.textContent = ''; out.append(h('code', { class: 'cx-code', text: c.value })); }
    } } });
    return h('div', { class: 'cx-copy-row' }, c.what ? h('p', { class: 'cx-step-detail', text: c.what }) : null, btn, out);
  }
  function stepList(steps) {
    return steps.length ? h('ol', { class: 'cx-steps' }, steps.map((s, i) => h('li', { class: s.state },
      h('span', { class: 'cx-num', text: s.state === 'done' ? '✓' : String(i + 1), 'aria-hidden': 'true' }),
      h('div', {}, h('strong', { text: s.title }), s.owner ? h('span', { class: 'cx-who', text: { owner: 'Vous', provider: 'Fournisseur', nordla: 'Nordla' }[s.owner] ?? '' }) : null, s.detail ? h('p', { class: 'cx-step-detail', text: s.detail }) : null,
        s.facts && s.facts.length ? h('ul', { class: 'cx-facts' }, s.facts.map((f) => h('li', { text: f }))) : null,
        s.copy ? copyBlock(s.copy) : null)))) : null;
  }
  // ---- "Données lues": what Nordla REALLY read from the connected account, and when. Four states for every figure, never a bare number:
  //   a measured value, a measured ZERO, UNAVAILABLE (the provider did not return it), PERMISSION_MISSING (the permission is named).
  const nf = new Intl.NumberFormat('fr-BE');
  const UNAVAILABLE_WHY = { METRIC_NOT_SUPPORTED: 'Instagram ne fournit pas cette statistique pour cette publication.', NOT_RETURNED: 'Instagram ne l’a pas communiquée.', SOURCE_ERROR: 'Instagram a répondu par une erreur pour cette statistique.' };
  const PROBLEM_TEXT = { TOKEN_REJECTED: 'Instagram a refusé l’accès : reconnectez le compte.', RATE_LIMITED: 'Instagram a demandé de ralentir : réessayez plus tard.', SOURCE_UNREACHABLE: 'Instagram était injoignable.', READ_FAILED: 'La lecture a échoué.', PC_REAUTH_REQUIRED: 'Le compte doit être reconnecté.' };
  function figureCell(f) {
    if (!f) return h('span', { class: 'cx-fig', 'data-state': 'UNAVAILABLE', text: 'Indisponible' });
    if (f.state === 'VALUE') return h('span', { class: 'cx-fig', 'data-state': 'VALUE', text: nf.format(f.value) });
    if (f.state === 'ZERO') return h('span', { class: 'cx-fig', 'data-state': 'ZERO' }, h('strong', { text: '0' }), h('span', { class: 'cx-fig-note', text: ' mesuré : zéro' }));
    if (f.state === 'PERMISSION_MISSING') return h('span', { class: 'cx-fig', 'data-state': 'PERMISSION_MISSING' }, h('strong', { text: 'Permission manquante' }), h('span', { class: 'cx-fig-note', text: ` : ${f.permission ?? 'permission de lecture'}` }));
    return h('span', { class: 'cx-fig', 'data-state': 'UNAVAILABLE' }, h('strong', { text: 'Indisponible' }), h('span', { class: 'cx-fig-note', text: ` ${UNAVAILABLE_WHY[f.reason] ?? ''}` }));
  }
  function missingNote(permission) { return h('p', { class: 'cx-perm', role: 'note' }, h('strong', { text: `Permission manquante : ${permission}. ` }), 'Reconnectez le compte et acceptez toutes les permissions de lecture demandées.'); }
  function readPanel(c) {
    const attempt = c.lastRead; const lr = attempt && attempt.profile ? attempt : c.lastReadData; // the latest attempt that answered, else the last data really read
    const out = [h('h4', { class: 'cx-read-title', text: 'Données lues' })];
    out.push(h('p', { class: 'cx-meta cx-readdate', 'data-state': c.lastReadOkAt ? 'ok' : 'none', text: c.lastReadOkAt ? `Dernière lecture réussie : ${when(c.lastReadOkAt)}.` : 'Aucune lecture réussie pour l’instant : Nordla n’a encore lu aucune donnée de ce compte.' }));
    if (attempt && attempt.at && attempt.at !== c.lastReadOkAt) out.push(h('p', { class: 'cx-meta warn', text: `Dernière tentative : ${when(attempt.at)} — ${attempt.outcome === 'FAILED' ? (PROBLEM_TEXT[attempt.problem] ?? 'la lecture a échoué.') : attempt.outcome === 'PARTIAL' ? 'lecture partielle (voir ci-dessous).' : 'lecture incomplète.'}` }));
    if (attempt && !attempt.profile && lr) out.push(h('p', { class: 'cx-meta', text: 'Les données ci-dessous datent de la dernière lecture réussie.' }));
    if (!lr || !lr.profile) { out.push(h('p', { class: 'cx-meta', text: 'Cliquez sur « Lire maintenant » pour lire le profil et la dernière publication (lecture seule).' })); return h('div', { class: 'cx-read' }, out); }
    const p = lr.profile;
    if (p.state === 'PERMISSION_MISSING') out.push(missingNote(p.permission ?? 'instagram_business_basic'));
    else if (p.state !== 'OK' || !p.data) out.push(h('p', { class: 'cx-perm', text: 'Le profil n’a pas pu être lu.' }));
    else out.push(h('dl', { class: 'cx-read-dl' }, h('dt', { text: 'Nom' }), h('dd', { text: p.data.name ?? '—' }), h('dt', { text: 'Compte' }), h('dd', { text: p.data.username ? `@${p.data.username}${p.data.accountType ? ` · ${p.data.accountType}` : ''}` : '—' }),
      h('dt', { text: 'Abonnés' }), h('dd', {}, figureCell(p.data.followers)), h('dt', { text: 'Abonnements' }), h('dd', {}, figureCell(p.data.follows)), h('dt', { text: 'Publications' }), h('dd', {}, figureCell(p.data.mediaCount))));
    const pub = lr.publication;
    out.push(h('h4', { class: 'cx-read-title', text: 'Publication récente' }));
    if (pub.state === 'PERMISSION_MISSING') out.push(missingNote(pub.permission ?? 'instagram_business_basic'));
    else if (pub.state === 'NONE') out.push(h('p', { class: 'cx-meta', text: 'Ce compte n’a aucune publication à lire.' }));
    else if (pub.state !== 'OK' || !pub.item) out.push(h('p', { class: 'cx-perm', text: 'La dernière publication n’a pas pu être lue.' }));
    else {
      const it = pub.item;
      out.push(h('p', { class: 'cx-meta', text: `${it.type ?? 'Publication'} du ${it.postedAt ? when(it.postedAt) : 'date inconnue'}${it.caption ? ` — « ${it.caption} »` : ''}` }));
      if (it.permalink) out.push(h('p', { class: 'cx-meta' }, h('a', { class: 'cx-link', href: it.permalink, target: '_blank', rel: 'noopener noreferrer', text: 'Voir la publication sur Instagram' })));
      out.push(h('table', { class: 'cx-fig-table' }, h('tbody', {}, it.stats.map((s) => h('tr', {}, h('th', { scope: 'row', text: s.label }), h('td', {}, figureCell(s)))))));
      const missing = it.stats.find((s) => s.state === 'PERMISSION_MISSING'); if (missing) out.push(missingNote(missing.permission ?? 'instagram_business_manage_insights'));
    }
    return h('div', { class: 'cx-read' }, out);
  }
  function connRow(c) {
    const labels = { read: 'Lire maintenant', verify: 'Revérifier', reconnect: 'Reconnecter', disconnect: 'Déconnecter' };
    return h('div', { class: 'cx-conn' },
      h('div', { class: 'cx-conn-head' }, h('strong', { text: c.account }), h('span', { class: 'cx-state', 'data-tone': c.tone, text: c.stateLabel })),
      c.accountType ? h('p', { class: 'cx-meta', text: `Type de compte : ${c.accountType}` }) : null,
      c.sync ? h('p', { class: 'cx-meta', text: `${c.sync.label}${c.sync.at ? ` — ${when(c.sync.at)}` : ''}` }) : null,
      c.verifiedAt ? h('p', { class: 'cx-meta', text: `Dernière vérification : ${when(c.verifiedAt)}` }) : null,
      c.scopes.length ? h('p', { class: 'cx-meta', text: c.readOnly ? 'Permissions : lecture seule.' : 'Permissions : attention, ce compte a une permission d’écriture.' }) : null,
      c.needs.includes('REAUTH_REQUIRED') ? h('p', { class: 'cx-meta warn', text: 'Le fournisseur demande de nouveau votre accord.' }) : null,
      c.canRead ? readPanel(c) : null,
      c.actions.length ? h('div', { class: 'cx-actions' }, c.actions.map((a) => h('button', { class: `cx-btn ${a === 'disconnect' ? 'warn' : a === 'read' ? '' : 'ghost'}`, type: 'button', text: labels[a], on: { click: () => runAction(c.id, a) } }))) : null);
  }
  function picker(p) {
    if (!pick || pick.provider !== p.id.replace('google_business_profile', 'google_business_profile')) return null;
    return h('div', { class: 'cx-pick' }, h('h3', { text: 'Choisissez le compte à connecter' }), h('p', { class: 'cx-meta', text: 'Nordla ne choisit jamais un compte à votre place. Seul un compte professionnel peut être relié.' }),
      pick.targets.length ? pick.targets.map((t) => h('div', { class: 'cx-conn' }, h('strong', { text: t.displayName ?? t.externalId }), h('span', { class: 'cx-meta', text: ` ${t.accountType ?? ''}${t.locationName ? ` · ${t.locationName}` : ''}` }),
        t.eligible ? h('div', { class: 'cx-actions' }, h('button', { class: 'cx-btn', type: 'button', text: 'Relier ce compte', on: { click: () => choose(t) } })) : h('p', { class: 'cx-meta warn', text: 'Non éligible : compte professionnel requis.' }))) : h('p', { class: 'cx-meta', text: 'Aucun compte autorisé n’a été trouvé.' }),
      h('button', { class: 'cx-btn ghost', type: 'button', text: 'Annuler', on: { click: () => { pick = null; renderConnections(); } } }));
  }
  function detail(p) {
    const [stateLabel, tone] = listState(p);
    const connectLabel = p.connections.length ? `Ajouter un autre compte ${p.label}` : 'Connecter';
    const canClick = p.status === 'AVAILABLE' && p.setup.canConnect && p.setup.state === 'READY';
    const showConnect = p.status === 'AVAILABLE' && p.source === 'oauth';
    return h('section', { class: 'cx-detail', 'data-provider': p.id },
      !wide() ? h('button', { class: 'cx-back', type: 'button', on: { click: () => go(null) } }, ico('back'), 'Retour') : null,
      h('div', { class: 'cx-dhead' }, h('span', { class: 'cx-badge big', text: INITIALS[p.id] ?? p.label.slice(0, 2) }), h('div', {}, h('h2', { text: p.label }), data.merchant?.name ? h('p', { class: 'cx-dsub', text: p.source === 'oauth' || p.source === 'bank' || p.source === 'shopify' ? data.merchant.name : '' }) : null)),
      h('p', { class: 'cx-desc', text: p.description }),
      h('dl', { class: 'cx-facts-table' },
        h('dt', { text: 'Statut' }), h('dd', {}, h('span', { class: 'cx-pill', 'data-tone': tone, text: p.setup.state === 'APP_MISSING' ? p.setup.label : stateLabel })),
        h('dt', { text: 'Accès prévu' }), h('dd', { text: p.status === 'PLANNED' ? '—' : p.accessLabel === 'Aucun accès pour l’instant' ? 'Lecture seule (prévu)' : p.accessLabel }),
        h('dt', { text: 'Données accessibles' }), h('dd', { text: p.dataLabel ?? '—' }),
        h('dt', { text: 'Capacités' }), h('dd', { text: p.capabilities.map((c) => c.label).join(', ') + (p.multiCapability && p.category === 'commerce_gestion' ? ' — une seule connexion, plusieurs capacités' : '') })),
      p.status === 'WAITING' && p.setup.detail ? h('p', { class: 'cx-hold', text: p.setup.detail }) : null,
      p.setup.steps.length ? [h('h3', { text: 'Étapes' }), stepList(p.setup.steps)] : null,
      p.connections.length ? [h('h3', { text: p.connections.length > 1 ? 'Comptes connectés' : 'Compte connecté' }), p.connections.map(connRow)] : (p.status === 'AVAILABLE' && p.setup.state !== 'APP_MISSING' ? h('p', { class: 'cx-meta', text: p.source === 'shopify' ? 'Aucune boutique de Shopify n’est reliée à ce marchand dans Nordla.' : 'Aucun compte connecté.' }) : null),
      picker(p),
      p.bank ? h('details', { class: 'cx-banks' }, h('summary', { text: `Banques belges proposées par ${p.bank.provider ? p.bank.provider.label : 'le fournisseur prévu'} (${p.bank.banks.length}) — à confirmer à la première lecture réelle` }), h('ul', {}, p.bank.banks.map((b) => h('li', {}, h('strong', { text: b.label }), b.key === p.bank.pilot ? ' · banque du pilote' : '', b.aliasOf ? ' · même banque que Crelan' : '')))) : null,
      showConnect ? h('div', { class: 'cx-actions' }, h('button', { class: 'cx-btn', type: 'button', disabled: !canClick, text: connectLabel, on: { click: () => startOAuth('/api/connections/connect', { provider: p.id }) } }),
        !canClick ? h('span', { class: 'cx-meta', text: p.setup.state === 'APP_MISSING' ? 'Disponible dès que l’application est configurée.' : !data.canManage ? 'Réservé au propriétaire ou à un administrateur.' : '' }) : null) : null);
  }
  function renderConnections() {
    const list = providers();
    if (wide() && !selected) selected = (list.find((p) => p.id === 'instagram') ?? list[0]).id;
    const cur = list.find((p) => p.id === selected) ?? null;
    const left = h('div', { class: 'cx-list', role: 'list' }, data.categories.map((c) => [h('p', { class: 'cx-cat-label', text: c.label }), c.providers.map((p) => { const [t, tone] = listState(p); return h('button', { class: 'cx-row', type: 'button', role: 'listitem', 'aria-current': p.id === selected ? 'true' : null, 'data-provider': p.id, on: { click: () => go(p.id) } }, h('span', { class: 'cx-badge', text: INITIALS[p.id] ?? p.label.slice(0, 2) }), h('span', { class: 'cx-row-name', text: p.label }), h('span', { class: 'cx-pill sm', 'data-tone': tone, text: t }), h('span', { class: 'cx-chev' }, ico('chevron'))); })]));
    const showDetail = cur && (wide() || selected);
    const content = [h('p', { class: 'cx-crumb' }, h('a', { class: 'cx-link', href: '/settings', text: 'Paramètres' }), ' › ', h('strong', { text: 'Connexions' })), h('h1', { text: 'Connexions' }),
      h('div', { class: 'cx-banner' }, h('strong', { text: 'Lecture seule. ' }), 'Nordla ne publie, ne modifie et ne paie rien depuis ces connexions. ', data.canManage ? '' : 'Votre rôle permet de consulter, pas de modifier.'),
      flash ? h('p', { class: `cx-flash ${flash.tone}`, role: 'status', text: flash.text }) : null,
      h('div', { class: `cx-split ${!wide() && showDetail ? 'show-detail' : 'show-list'}` }, !wide() && showDetail ? null : left, showDetail ? detail(cur) : null)];
    app.replaceChildren(shell(settings, 'settings', content));
  }
  async function connections() {
    const [a, b] = await Promise.all([api('/api/connections'), api('/api/settings')]);
    if (guard(a)) return;
    if (!a.ok || !b.ok) return app.replaceChildren(h('div', { class: 'cx-wrap' }, h('h1', { text: 'Connexions' }), h('p', { class: 'cx-msg err', text: 'Cette page est indisponible pour le moment.' })));
    data = a.json; settings = b.json;
    const q = new URLSearchParams(location.search); const ref = q.get('connect'); const err = q.get('connect_error'); const provider = q.get('provider');
    if (err) flash = { tone: 'err', text: ERR[err] ?? 'La connexion n’a pas abouti.' };
    if (ref && data.canManage) { const t = await api(`/api/connections/targets?session=${encodeURIComponent(ref)}`); if (t.ok) { pick = { ref, provider, targets: t.json.targets }; selected = provider; } else flash = { tone: 'err', text: errText(t) }; }
    const hash = location.hash.replace(/^#\//, ''); if (!selected && providers().some((p) => p.id === hash)) selected = hash;
    if (ref || err) history.replaceState(null, '', selected ? `${location.pathname}#/${selected}` : location.pathname);
    renderConnections();
    window.matchMedia('(min-width: 900px)').addEventListener('change', () => { if (data) renderConnections(); });
  }

    const path = location.pathname.endsWith('/') ? location.pathname.slice(0, -1) || '/' : location.pathname;
  if (path === '/settings/connections') connections(); else { document.title = 'Nordla AI · Paramètres'; hub(); }
})();
