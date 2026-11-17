// Paramètres › Sécurité: four rubrics (list on the left, detail on the right; on a phone the list, then the detail with "Retour").
// Everything shown comes from GET /api/security* : each state is the server's answer, each button exists only when the server says the action is available. Server text uses textContent only.
(() => {
  'use strict';
  const { h, api, shell, guard, app } = window.NordlaShell;
  const RUBRICS = [
    { id: 'sign_in', slug: 'connexion', label: 'Connexion et récupération', scope: 'PERSONAL' },
    { id: 'sessions', slug: 'sessions', label: 'Sessions et appareils', scope: 'PERSONAL' },
    { id: 'activity', slug: 'activite', label: 'Activité de sécurité', scope: 'PERSONAL' },
    { id: 'team', slug: 'equipe', label: 'Protection de l’équipe', scope: 'TEAM' },
  ];
  const BY_SLUG = Object.fromEntries(RUBRICS.map((r) => [r.slug, r.id]));
  const wide = () => window.matchMedia('(min-width: 900px)').matches;
  const fmt = (iso) => { try { return new Intl.DateTimeFormat('fr-BE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Brussels' }).format(new Date(iso)); } catch { return '—'; } };
  const ERR = { FORBIDDEN_ROLE: 'Votre rôle ne permet pas cette action.', BAD_CURRENT_PASSWORD: 'Le mot de passe actuel est incorrect.', RATE_LIMITED: 'Trop de tentatives. Réessayez dans quelques minutes.', UNAVAILABLE: 'Le service d’authentification ne répond pas : rien n’a été changé.', VALIDATION: 'Mot de passe refusé.', FEATURE_UNAVAILABLE: 'Cette action n’est pas disponible.', PROVIDER_REFUSED: 'Le fournisseur a refusé ce mot de passe. Rien n’a été changé.', CURRENT_SESSION_UNKNOWN: 'Session actuelle introuvable : rien n’a été fait.' };
  const errText = (r) => r.json?.error?.message ?? ERR[r.json?.error?.code] ?? `Action refusée (${r.status}).`;
  let ov = null; let current = null; let flash = null;
  const detail = h('section', { class: 'cx-detail', id: 'sc-detail' }); const listBox = h('div', { class: 'cx-list' });

  const badge = (r) => h('p', { class: 'sc-scope', 'data-scope': r.scope, text: r.scope === 'TEAM' ? `Équipe du commerce actif${ov.shell?.merchant?.name ? ` : ${ov.shell.merchant.name}` : ''}` : 'Compte personnel : ne concerne que vous' });
  const head = (r, sub) => h('div', { class: 'gn-head' }, h('h2', { text: r.label }), badge(r), sub ? h('p', { text: sub }) : null);
  const state = (text, tone) => h('span', { class: 'gn-state', 'data-tone': tone, text });
  const row = (label, ...value) => h('div', { class: 'gn-field' }, h('span', { class: 'gn-label', text: label }), h('div', { class: 'gn-control' }, ...value));
  const unavailable = (what, reason) => h('div', {}, state('Indisponible', 'lock'), ' ', h('strong', { text: what }), h('p', { class: 'gn-help', text: reason }));
  const msg = (m) => h('div', { class: `gn-msg ${m.tone}`, role: m.tone === 'err' ? 'alert' : 'status', text: m.text });
  const confirmBox = (title, lines, onYes, yesText) => {
    const box = h('div', { class: 'gn-note sc-confirm', role: 'alertdialog', 'aria-label': title }, h('strong', { text: title }), lines.map((l) => h('p', { text: l })),
      h('div', { class: 'gn-subbar' }, h('button', { class: 'cx-btn', type: 'button', text: yesText, on: { click: async (e) => { e.currentTarget.disabled = true; await onYes(); } } }), h('button', { class: 'cx-btn ghost', type: 'button', text: 'Annuler', on: { click: () => box.remove() } })));
    return box;
  };

  // ---------------------------------------------------------------- rubric 1
  function passwordForm() {
    const cur = h('input', { class: 'gn-input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Mot de passe actuel', maxlength: 1024 });
    const nxt = h('input', { class: 'gn-input', type: 'password', autocomplete: 'new-password', 'aria-label': 'Nouveau mot de passe', maxlength: 200 });
    const out = h('div'); const btn = h('button', { class: 'cx-btn gn-btn-save', type: 'button', text: 'Changer le mot de passe' });
    btn.addEventListener('click', async () => {
      out.replaceChildren(); btn.disabled = true; btn.textContent = 'Changement…';
      const r = await api('/api/security/password', { current: cur.value, next: nxt.value });
      btn.disabled = false; btn.textContent = 'Changer le mot de passe'; if (guard(r)) return;
      if (r.ok) { cur.value = ''; nxt.value = ''; out.replaceChildren(msg({ tone: 'ok', text: `Mot de passe changé. ${r.json.otherSessionsClosed} autre(s) session(s) déconnectée(s).` })); } else out.replaceChildren(msg({ tone: 'err', text: errText(r) }));
    });
    return h('form', { class: 'gn-form', novalidate: true, on: { submit: (e) => e.preventDefault() } }, h('p', { class: 'gn-help', text: `12 caractères au moins. Toutes vos autres sessions (tous modules et commerces) seront déconnectées ; celle-ci reste ouverte.` }), cur, h('div', { class: 'gn-mt' }), nxt, h('div', { class: 'gn-mt' }), btn, out);
  }
  function signIn(r) {
    const a = ov.account; const pw = h('div');
    pw.replaceChildren(a.password.available ? h('button', { class: 'cx-btn', type: 'button', text: 'Changer le mot de passe…', on: { click: () => pw.replaceChildren(passwordForm()) } }) : unavailable('Changer le mot de passe', a.password.reason));
    return [head(r, 'Comment votre compte se connecte à Nordla.'), h('hr', { class: 'gn-rule' }),
      row('Méthode de connexion', h('strong', { text: a.signInMethod.label }), a.email ? h('p', { class: 'gn-help', text: `Compte : ${a.email}` }) : null, a.lastSignInAt ? h('p', { class: 'gn-help', text: `Dernière connexion chez le fournisseur : ${fmt(a.lastSignInAt)}` }) : null),
      row('Double authentification', state('Non demandée', 'todo'), h('p', { class: 'gn-help', text: `${a.mfa.label}.${a.mfa.enrolledFactors != null ? ` Facteurs enregistrés chez le fournisseur : ${a.mfa.enrolledFactors}.` : ''}` }), unavailable('Activer la double authentification', a.mfa.enrollment.reason)),
      row('Mot de passe', pw), row('Récupérer mon compte', unavailable('Récupération par e-mail', a.recovery.reason)), row('Clés d’accès (passkeys)', unavailable('Clés d’accès', a.passkeys.reason))];
  }

  // ---------------------------------------------------------------- rubric 2
  async function sessions(r) {
    const res = await api('/api/security/sessions'); if (guard(res)) return null;
    if (!res.ok) return [head(r), h('p', { class: 'cx-msg err', text: 'Les sessions sont indisponibles pour le moment.' })];
    const s = res.json; const list = h('ul', { class: 'sc-sessions' }); const slot = h('div');
    for (const x of s.sessions) list.append(h('li', { class: 'sc-session', 'data-current': x.current ? 'true' : null },
      h('div', {}, h('strong', { text: `${x.moduleLabel}${x.merchantName ? ` · ${x.merchantName}` : ''}` }), ' ', x.current ? state('Cette session', 'ok') : null, !x.sameMerchant ? state('Autre commerce', 'wait') : null),
      h('small', { text: `Ouverte ${fmt(x.createdAt)} · dernière activité ${fmt(x.lastSeenAt)} · expire ${fmt(x.expiresAt)}` })));
    if (!s.sessions.length) list.append(h('li', { text: 'Aucune session active.' }));
    const reload = async (m) => { flash = m; await open('sessions', true); };
    const so = s.scopeOfOthers;
    const bCur = h('button', { class: 'cx-btn ghost', type: 'button', text: 'Déconnecter cette session', on: { click: () => slot.replaceChildren(confirmBox('Déconnecter cette session ?', ['Vous serez déconnecté de ce navigateur, pour le module et le commerce actuels seulement. Vos autres sessions restent ouvertes.'], async () => { await api('/api/security/sessions/revoke-current', {}); await api('/api/auth/logout', {}); location.assign('/'); }, 'Déconnecter')) } });
    const bOth = h('button', { class: 'cx-btn', type: 'button', text: 'Déconnecter les autres sessions', disabled: so.count === 0 || !s.currentFound, on: { click: () => slot.replaceChildren(confirmBox(`Déconnecter ${so.count} autre(s) session(s) ?`, [`Modules concernés : ${so.modules.join(', ') || '—'}.`, so.otherMerchants ? `Cette action touche aussi d’autres commerces : ${so.merchants.join(', ')}.` : 'Elles appartiennent toutes à ce commerce.', 'Votre session actuelle reste ouverte.'], async () => { const x = await api('/api/security/sessions/revoke-others', {}); if (guard(x)) return; await reload(x.ok ? { tone: 'ok', text: `${x.json.revoked} session(s) déconnectée(s).` } : { tone: 'err', text: errText(x) }); }, 'Déconnecter les autres')) } });
    return [head(r, 'Vos sessions actives dans tous les modules et commerces de votre compte.'), h('hr', { class: 'gn-rule' }), flash ? msg(flash) : null, list,
      h('p', { class: 'gn-help', text: s.deviceInfo.reason }), !s.currentFound ? h('p', { class: 'gn-help', text: 'La session actuelle n’a pas pu être identifiée : « Déconnecter les autres sessions » est désactivé.' }) : null, h('div', { class: 'gn-subbar gn-mt' }, bCur, bOth), slot];
  }

  // ---------------------------------------------------------------- rubric 3
  async function activity(r) {
    const res = await api('/api/security/activity'); if (guard(res)) return null;
    if (!res.ok) return [head(r), h('p', { class: 'cx-msg err', text: 'L’activité est indisponible pour le moment.' })];
    const ul = h('ul', { class: 'sc-sessions' }, res.json.events.map((e) => h('li', { class: 'sc-session' }, h('div', {}, h('strong', { text: e.label }), ' ', state(e.outcome === 'SUCCESS' ? 'Réussi' : e.outcome === 'DENIED' ? 'Refusé' : 'Échec', e.outcome === 'SUCCESS' ? 'ok' : 'wait'), e.detail?.count != null ? ` · ${e.detail.count} session(s)` : null), h('small', { text: `${fmt(e.at)} · ${e.module}` }))));
    if (!res.json.events.length) ul.append(h('li', { text: 'Aucun événement enregistré pour le moment.' }));
    return [head(r, res.json.note), h('hr', { class: 'gn-rule' }), ul];
  }

  // ---------------------------------------------------------------- rubric 4
  async function team(r) {
    const res = await api('/api/security/team'); if (guard(res)) return null;
    const t = res.json;
    return [head(r, 'Les règles de connexion réellement appliquées à ce commerce.'), h('hr', { class: 'gn-rule' }),
      h('p', { class: 'gn-note', text: t.canManage ? 'Votre rôle peut gérer ces règles, mais aucune n’est encore modifiable depuis cette page.' : 'Lecture seule : la gestion de ces règles est réservée au propriétaire et aux administrateurs.' }),
      ...t.applied.map((a) => row(a.label, h('strong', { text: a.value }), ' ', state('Appliquée', 'ok'), a.note ? h('p', { class: 'gn-help', text: a.note }) : null)),
      row('Exiger la double authentification pour les rôles sensibles', unavailable('Exiger la double authentification', t.requireMfa.reason)),
      row('Délai d’inactivité par rôle', unavailable('Délai par rôle', 'Prévu pour une étape suivante. Le délai est aujourd’hui le même pour tous.'))];
  }

  // ---------------------------------------------------------------- page
  const BUILD = { sign_in: async (r) => signIn(r), sessions, activity, team };
  function renderList() { listBox.replaceChildren(...RUBRICS.map((r) => h('a', { class: 'cx-row', href: `/settings/security/${r.slug}`, 'aria-current': current === r.id ? 'true' : null, on: { click: (e) => { e.preventDefault(); go(r.id); } } }, h('span', { class: 'cx-row-name', text: r.label }), state(r.scope === 'TEAM' ? 'Équipe' : 'Personnel', r.scope === 'TEAM' ? 'wait' : 'todo')))); }
  async function open(id, replace = false) {
    const r = RUBRICS.find((x) => x.id === id); const nodes = await BUILD[id](r); if (!nodes) return;
    current = id; detail.replaceChildren(...[!wide() ? h('button', { class: 'cx-back', type: 'button', text: '‹ Retour', on: { click: () => go(null) } }) : null, ...nodes].filter(Boolean)); flash = null; renderList(); layout(); document.title = `Nordla AI · Paramètres · Sécurité · ${r.label}`;
    if (!replace) history.pushState(null, '', `/settings/security/${r.slug}`);
  }
  function layout() { const hideList = !wide() && !!current; listBox.hidden = hideList; detail.hidden = !wide() && !current; }
  async function go(id) { if (id === null) { current = null; history.pushState(null, '', '/settings/security'); renderList(); layout(); window.scrollTo(0, 0); return; } await open(id); window.scrollTo(0, 0); }
  window.addEventListener('popstate', () => { const id = BY_SLUG[location.pathname.split('/')[3]]; if (id) open(id, true); else { current = null; renderList(); layout(); } });
  window.matchMedia('(min-width: 900px)').addEventListener('change', () => { if (wide() && !current) open('sign_in', true); else layout(); });

  async function start() {
    const r = await api('/api/security'); if (guard(r)) return;
    if (!r.ok) return app.replaceChildren(h('div', { class: 'cx-wrap' }, h('h1', { text: 'Sécurité' }), h('p', { class: 'cx-msg err', text: 'Cette page est indisponible pour le moment.' })));
    ov = r.json; const sd = ov.shell ?? { nav: [{ id: 'settings', label: 'Paramètres', href: '/settings', icon: 'settings' }], merchant: null, environment: null };
    app.replaceChildren(shell(sd, 'settings', [h('p', { class: 'cx-crumb' }, h('a', { class: 'cx-link', href: '/settings', text: 'Paramètres' }), ' / ', h('strong', { text: 'Sécurité' })), h('h1', { text: 'Sécurité' }), h('div', { class: 'cx-split', id: 'sc-split' }, h('div', {}, listBox), detail)]));
    renderList(); const wanted = BY_SLUG[location.pathname.split('/')[3]] ?? null;
    const first = wanted ?? (wide() ? 'sign_in' : null); if (first) await open(first, true); else layout();
  }
  start();
})();
