// Public invitation page (/invitation/<token>): no session. The token comes from the address, goes back in a POST body (never in an API URL), and the page only shows
// what the server tells it: the commerce, the invited address (fixed), the role and its rights. The person chooses a name and a password (or proves an existing account).
(() => {
  'use strict';
  const app = document.getElementById('app');
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : String(v)); } for (const k of kids.flat(Infinity)) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
  const token = decodeURIComponent(location.pathname.split('/')[2] ?? '');
  const post = async (path, body) => { try { const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { /* none */ } return { ok: r.ok, status: r.status, json: j }; } catch { return { ok: false, status: 0, json: null }; } };
  const LEVEL = { none: 'Aucun accès', view: 'Consulter', edit: 'Modifier' };
  const SENS = { yes: 'Oui', limited: 'Limité', no: 'Non' };
  const card = (...kids) => app.replaceChildren(h('main', { class: 'iv-wrap' }, h('p', { class: 'iv-brand', text: 'Nordla AI' }), ...kids));
  const dead = (title, text) => card(h('h1', { text: title }), h('p', { class: 'tm-note', text }));
  const STATE = { INVALID: ['Lien invalide', 'Ce lien d’invitation n’est pas valide. Demandez-en un nouveau à la personne qui vous a invité.'], ACCEPTED: ['Invitation déjà utilisée', 'Cette invitation a déjà été acceptée. Connectez-vous avec votre compte.'], EXPIRED: ['Invitation expirée', 'Ce lien a expiré. Demandez à la personne qui vous a invité de vous en envoyer un nouveau.'], CANCELLED: ['Invitation annulée', 'Cette invitation a été annulée.'] };

  async function start() {
    const r = await post('/api/invitations/info', { token });
    if (r.status === 429) return dead('Trop de tentatives', 'Réessayez dans quelques minutes.');
    if (!r.ok || !r.json) return dead('Indisponible', 'Cette page est indisponible pour le moment. Réessayez plus tard.');
    const i = r.json; if (i.state !== 'PENDING') { const [t, x] = STATE[i.state] ?? STATE.INVALID; return dead(t, x); }
    const name = h('input', { class: 'tm-input', type: 'text', autocomplete: 'name', maxlength: 80, 'aria-label': 'Votre nom' });
    const pass = h('input', { class: 'tm-input', type: 'password', autocomplete: i.accountExists ? 'current-password' : 'new-password', 'aria-label': 'Mot de passe' });
    const out = h('div', { class: 'tm-slot' });
    const go = h('button', { class: 'cx-btn', type: 'button', text: i.accountExists ? 'Accepter l’invitation' : 'Créer mon accès', on: { click: async () => {
      out.replaceChildren(); go.disabled = true; const x = await post('/api/invitations/accept', { token, password: pass.value, name: name.value }); go.disabled = false;
      if (x.ok) return card(h('h1', { text: 'Invitation acceptée' }), h('p', { class: 'tm-note', text: `Vous avez maintenant accès à ${i.merchantName ?? 'ce commerce'} (${i.roleLabel}).` }), h('a', { class: 'cx-btn', href: '/', text: 'Ouvrir Nordla' }));
      const m = x.json?.error?.message ?? (x.status === 0 ? 'Le serveur ne répond pas.' : 'Impossible d’accepter cette invitation.'); out.replaceChildren(h('div', { class: 'tm-msg err', role: 'alert', text: m })); } } });
    card(h('h1', { text: 'Invitation' }), h('p', { class: 'iv-lead' }, 'Vous êtes invité(e) à rejoindre ', h('strong', { text: i.merchantName ?? 'un commerce' }), ' avec le rôle ', h('strong', { text: i.roleLabel }), '.'),
      h('label', { class: 'tm-label', text: 'Adresse e-mail (fixée par l’invitation)' }), h('input', { class: 'tm-input', type: 'email', value: i.email, readonly: true, 'aria-label': 'Adresse e-mail invitée' }),
      i.accountExists ? h('p', { class: 'tm-note', text: 'Un compte Nordla existe déjà pour cette adresse : saisissez son mot de passe pour accepter.' }) : [h('label', { class: 'tm-label', text: 'Votre nom (facultatif)' }), name, h('p', { class: 'tm-help', text: `Choisissez un mot de passe d’au moins ${i.minPassword} caractères.` })],
      h('label', { class: 'tm-label', text: i.accountExists ? 'Mot de passe du compte' : 'Mot de passe' }), pass,
      h('h2', { class: 'iv-h2', text: 'Ce que ce rôle permet' }), h('ul', { class: 'tm-rl' }, i.rights.modules.map((m) => h('li', {}, h('span', { text: m.label }), h('span', { class: 'tm-lvl', 'data-level': m.level, text: LEVEL[m.level] })))),
      h('p', { class: 'tm-help', text: 'Actions sensibles : ' + i.rights.sensitive.map((a) => `${a.label} (${SENS[a.value].toLowerCase()})`).join(' · ') }),
      h('div', { class: 'tm-actions' }, go), out);
  }
  start();
})();
