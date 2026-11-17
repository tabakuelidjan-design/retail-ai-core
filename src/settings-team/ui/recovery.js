// Public recovery page (/recuperation/<token>): no session. The token comes from the address and goes back in a POST body only. The person chooses a new password;
// every Nordla session of the account is closed by the server when the link is used.
(() => {
  'use strict';
  const app = document.getElementById('app');
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : String(v)); } for (const k of kids.flat(Infinity)) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
  const token = decodeURIComponent(location.pathname.split('/')[2] ?? '');
  const post = async (path, body) => { try { const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { /* none */ } return { ok: r.ok, status: r.status, json: j }; } catch { return { ok: false, status: 0, json: null }; } };
  const card = (...kids) => app.replaceChildren(h('main', { class: 'iv-wrap' }, h('p', { class: 'iv-brand', text: 'Nordla AI' }), ...kids));
  const dead = (title, text) => card(h('h1', { text: title }), h('p', { class: 'tm-note', text }));
  const STATE = { INVALID: ['Lien invalide', 'Ce lien n’est pas valide. Demandez-en un nouveau à un propriétaire ou administrateur de votre commerce.'], USED: ['Lien déjà utilisé', 'Ce lien a déjà servi. Connectez-vous avec votre nouveau mot de passe, ou demandez un nouveau lien.'], EXPIRED: ['Lien expiré', 'Ce lien a expiré (il est valable 60 minutes). Demandez-en un nouveau.'], CANCELLED: ['Lien remplacé', 'Un lien plus récent a été créé : utilisez-le, ou demandez-en un nouveau.'] };
  async function start() {
    const r = await post('/api/recovery/info', { token });
    if (r.status === 429) return dead('Trop de tentatives', 'Réessayez dans quelques minutes.');
    if (!r.ok || !r.json) return dead('Indisponible', 'Cette page est indisponible pour le moment. Réessayez plus tard.');
    const i = r.json; if (i.state !== 'PENDING') { const [t, x] = STATE[i.state] ?? STATE.INVALID; return dead(t, x); }
    const p1 = h('input', { class: 'tm-input', type: 'password', autocomplete: 'new-password', 'aria-label': 'Nouveau mot de passe' });
    const p2 = h('input', { class: 'tm-input', type: 'password', autocomplete: 'new-password', 'aria-label': 'Confirmer le mot de passe' });
    const out = h('div', { class: 'tm-slot' });
    const err = (m) => out.replaceChildren(h('div', { class: 'tm-msg err', role: 'alert', text: m }));
    const go = h('button', { class: 'cx-btn', type: 'button', text: 'Changer le mot de passe', on: { click: async () => {
      out.replaceChildren(); if (p1.value.length < i.minPassword) return err(`Au moins ${i.minPassword} caractères.`); if (p1.value !== p2.value) return err('Les deux mots de passe ne sont pas identiques.');
      go.disabled = true; const x = await post('/api/recovery/apply', { token, password: p1.value }); go.disabled = false;
      if (x.ok) return card(h('h1', { text: 'Mot de passe changé' }), h('p', { class: 'tm-note', text: 'Toutes les sessions de votre compte ont été fermées. Connectez-vous avec votre nouveau mot de passe.' }), h('a', { class: 'cx-btn', href: '/', text: 'Ouvrir Nordla' }));
      err(x.json?.error?.message ?? (x.status === 0 ? 'Le serveur ne répond pas.' : 'Impossible de changer le mot de passe.')); } } });
    card(h('h1', { text: 'Réinitialiser votre mot de passe' }), h('p', { class: 'iv-lead' }, 'Accès à ', h('strong', { text: i.merchantName ?? 'ce commerce' }), '. Choisissez un nouveau mot de passe.'),
      h('label', { class: 'tm-label', text: 'Nouveau mot de passe' }), p1, h('p', { class: 'tm-help', text: `Au moins ${i.minPassword} caractères.` }), h('label', { class: 'tm-label', text: 'Confirmer' }), p2,
      h('p', { class: 'tm-note', text: 'En validant, toutes les sessions Nordla de ce compte sont fermées.' }), h('div', { class: 'tm-actions' }, go), out);
  }
  start();
})();
