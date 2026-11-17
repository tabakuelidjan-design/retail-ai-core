// Paramètres -> Connexions. Everything comes from GET /api/connections (the registry + the real state): the page never names a provider. All text is inserted with textContent.
(() => {
  'use strict';
  const CSRF_COOKIES = ['__Host-nordla_sourcing_csrf'];
  const csrf = () => { for (const part of String(document.cookie).split(';')) { const i = part.indexOf('='); if (i > 0 && CSRF_COOKIES.includes(part.slice(0, i).trim())) return part.slice(i + 1).trim(); } return ''; };
  const app = document.getElementById('app');
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : String(v)); } for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
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
    SCOPE_MISSING: 'Une permission de lecture n’a pas été accordée : recommencez et acceptez-les toutes.', PROVIDER_UNAVAILABLE: 'Le fournisseur ne répond pas pour le moment : réessayez plus tard.', PROVIDER_UNSUPPORTED: 'Ce fournisseur n’est pas encore connectable.', CALLBACK_FAILED: 'La connexion n’a pas abouti : recommencez.',
  };
  const errText = (r) => ERR[r.json?.error?.code ?? r.json?.oauth] ?? `Action refusée (${r.status}).`;
  let data = null; let flash = null; let pick = null;

  async function load() {
    const r = await api('/api/connections');
    if (r.status === 401 || (r.status === 403 && r.json?.error?.code !== 'FORBIDDEN_ROLE')) return signIn();
    if (!r.ok) return app.replaceChildren(h('div', { class: 'cx-wrap' }, h('h1', { text: 'Connexions' }), h('p', { class: 'cx-msg err', text: 'Cette page est indisponible pour le moment.' })));
    data = r.json;
    const q = new URLSearchParams(location.search); const ref = q.get('connect'); const err = q.get('connect_error');
    if (err) flash = { tone: 'err', text: ERR[err] ?? 'La connexion n’a pas abouti.' };
    if (ref && data.canManage) { const t = await api(`/api/connections/targets?session=${encodeURIComponent(ref)}`); if (t.ok) pick = { ref, provider: q.get('provider'), targets: t.json.targets }; else flash = { tone: 'err', text: errText(t) }; }
    if (ref || err) history.replaceState(null, '', '/settings/connections');
    render();
  }
  function signIn() { app.replaceChildren(h('div', { class: 'cx-wrap' }, h('h1', { text: 'Connexions' }), h('p', { class: 'cx-sub', text: 'Connectez-vous avec votre compte Nordla.' }), h('a', { class: 'cx-btn', href: '/', text: 'Ouvrir Nordla' }))); }
  const setFlash = (tone, text) => { flash = { tone, text }; render(); };

  async function startOAuth(path, body) { const r = await api(path, body); if (r.ok && r.json.authorizationUrl) { location.assign(r.json.authorizationUrl); return; } setFlash('err', errText(r)); }
  async function runAction(connectionId, action) {
    if (action === 'reconnect') return startOAuth(`/api/connections/${connectionId}/reconnect`, {});
    if (action === 'disconnect' && !window.confirm('Déconnecter ce compte ? Les jetons enregistrés seront détruits ; rien ne change chez le fournisseur.')) return;
    const r = await api(`/api/connections/${connectionId}/${action}`, {});
    if (r.ok) { data = r.json; setFlash('ok', action === 'verify' ? 'État revérifié auprès du fournisseur.' : 'Compte déconnecté.'); } else setFlash('err', errText(r));
  }
  async function choose(target) {
    const r = await api('/api/connections/select', { session_ref: pick.ref, external_id: target.externalId });
    if (r.ok) { data = r.json; pick = null; setFlash('ok', r.json.state === 'CONFIGURED' ? `Compte ${target.displayName ?? target.externalId} connecté et vérifié (lecture seule).` : 'Compte lié ; la vérification n’est pas concluante : voir l’état ci-dessous.'); } else setFlash('err', errText(r));
  }

  const chips = (items, cls) => h('ul', { class: 'cx-chips' }, items.map((c) => h('li', { class: cls, text: c.label ?? c })));
  const steps = (list) => list.length ? h('ol', { class: 'cx-steps' }, list.map((s) => h('li', { class: s.done ? 'done' : '' }, h('span', { class: 'cx-who', text: { owner: 'Vous', provider: 'Fournisseur', nordla: 'Nordla' }[s.owner] ?? '' }), ` ${s.label}`))) : null;

  function connection(c, provider) {
    const btn = (action, label, cls = 'ghost') => h('button', { class: `cx-btn ${cls}`, type: 'button', text: label, on: { click: () => runAction(c.id, action) } });
    const labels = { verify: 'Revérifier', reconnect: 'Reconnecter', disconnect: 'Déconnecter' };
    return h('div', { class: 'cx-conn' },
      h('div', { class: 'cx-conn-head' }, h('strong', { text: c.account }), h('span', { class: 'cx-state', 'data-tone': c.tone, text: c.stateLabel })),
      c.accountType ? h('p', { class: 'cx-meta', text: `Type de compte : ${c.accountType}` }) : null,
      c.sync ? h('p', { class: 'cx-meta', text: `${c.sync.label}${c.sync.at ? ` — ${when(c.sync.at)}` : ''}` }) : null,
      c.verifiedAt ? h('p', { class: 'cx-meta', text: `Dernière vérification : ${when(c.verifiedAt)}` }) : null,
      c.scopes.length ? h('p', { class: 'cx-meta', text: c.readOnly ? 'Permissions : lecture seule.' : 'Permissions : attention, ce compte a une permission d’écriture.' }) : null,
      c.needs.includes('REAUTH_REQUIRED') ? h('p', { class: 'cx-meta warn', text: 'Le fournisseur demande de nouveau votre accord.' }) : null,
      c.actions.length ? h('div', { class: 'cx-actions' }, c.actions.map((a) => btn(a, labels[a], a === 'disconnect' ? 'warn' : 'ghost'))) : null);
  }

  function providerCard(p) {
    const msg = h('p', { class: 'cx-msg', 'aria-live': 'polite' });
    const actions = [];
    if (p.setup.canConnect && p.status === 'AVAILABLE' && p.setup.state === 'READY') actions.push(h('button', { class: 'cx-btn', type: 'button', text: p.connections.length ? `Ajouter un autre compte ${p.label}` : `Connecter ${p.label} (lecture seule)`, on: { click: () => startOAuth('/api/connections/connect', { provider: p.id }) } }));
    if (p.setup.state === 'APP_MISSING') actions.push(h('button', { class: 'cx-btn', type: 'button', disabled: true, text: `Connecter ${p.label}` }));
    return h('section', { class: 'cx-card', 'data-provider': p.id, 'data-status': p.status },
      h('div', { class: 'cx-head' }, h('h3', { text: p.label }), h('span', { class: 'cx-status', 'data-status': p.status, text: p.status === 'AVAILABLE' && p.setup.state === 'APP_MISSING' ? p.setup.label : p.statusLabel })),
      h('p', { class: 'cx-desc', text: p.description }),
      h('p', { class: 'cx-meta', text: `${p.accessLabel}${p.multiAccount ? ' · plusieurs comptes possibles' : ''}${p.multiCapability && p.category === 'commerce_gestion' ? ' · une seule connexion, plusieurs capacités' : ''}` }),
      chips(p.capabilities, 'cap'),
      p.connections.length ? h('div', { class: 'cx-conns' }, p.connections.map((c) => connection(c, p))) : (p.status === 'AVAILABLE' && p.setup.state !== 'APP_MISSING' ? h('p', { class: 'cx-meta', text: p.source === 'shopify' ? 'Aucune boutique liée.' : 'Aucun compte connecté.' }) : null),
      p.setup.state === 'APP_MISSING' || p.setup.state === 'WAITING' ? h('div', { class: 'cx-todo' }, h('p', { class: 'cx-todo-title', text: p.setup.state === 'WAITING' ? 'Ce qu’il reste à faire' : p.setup.label }), p.setup.detail ? h('p', { class: 'cx-meta', text: p.setup.detail }) : null, steps(p.setup.steps)) : null,
      p.bank ? h('details', { class: 'cx-banks' }, h('summary', { text: `Banques belges proposées par ${p.bank.provider ? p.bank.provider.label : 'le fournisseur prévu'} (${p.bank.banks.length}) — à confirmer à la première lecture réelle` }), h('ul', {}, p.bank.banks.map((b) => h('li', {}, h('strong', { text: b.label }), b.key === p.bank.pilot ? ' · banque du pilote' : '', b.aliasOf ? ' · même banque que Crelan' : '')))) : null,
      actions.length ? h('div', { class: 'cx-actions' }, actions) : null, msg);
  }

  function picker() {
    if (!pick) return null;
    return h('section', { class: 'cx-card cx-pick' }, h('h3', { text: 'Choisissez le compte à connecter' }),
      h('p', { class: 'cx-desc', text: 'Nordla ne choisit jamais un compte à votre place. Seul un compte professionnel peut être relié.' }),
      pick.targets.length ? pick.targets.map((t) => h('div', { class: 'cx-conn' }, h('strong', { text: t.displayName ?? t.externalId }), h('span', { class: 'cx-meta', text: ` ${t.accountType ?? ''}${t.locationName ? ` · ${t.locationName}` : ''}` }),
        t.eligible ? h('button', { class: 'cx-btn', type: 'button', text: 'Relier ce compte', on: { click: () => choose(t) } }) : h('span', { class: 'cx-meta warn', text: ' Non éligible : compte professionnel requis.' })))
        : h('p', { class: 'cx-meta', text: 'Aucun compte autorisé n’a été trouvé.' }),
      h('button', { class: 'cx-btn ghost', type: 'button', text: 'Annuler', on: { click: () => { pick = null; render(); } } }));
  }

  function render() {
    app.replaceChildren(h('div', { class: 'cx-wrap' },
      h('p', { class: 'cx-crumb' }, h('a', { class: 'cx-link', href: '/', text: 'Nordla' }), ' › Paramètres › ', h('strong', { text: 'Connexions' })),
      h('h1', { text: 'Connexions' }), h('p', { class: 'cx-sub', text: 'Les comptes et services reliés à votre boutique, avec leur état réel.' }),
      h('div', { class: 'cx-banner' }, h('strong', { text: 'Lecture seule. ' }), 'Nordla ne publie, ne modifie et ne paie rien depuis ces connexions. ', data.canManage ? '' : 'Votre rôle permet de consulter, pas de modifier.'),
      flash ? h('p', { class: `cx-flash ${flash.tone}`, role: 'status', text: flash.text }) : null,
      picker(),
      data.categories.map((c) => h('section', { class: 'cx-cat', 'data-category': c.id }, h('h2', { text: c.label }), h('div', { class: 'cx-list' }, c.providers.map(providerCard))))));
  }
  load();
})();
