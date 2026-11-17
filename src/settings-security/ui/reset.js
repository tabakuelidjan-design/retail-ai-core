// Mot de passe oublié / réinitialisation. Three states, decided by the URL:
//   no fragment            -> ask for the e-mail address (always the same answer afterwards)
//   #access_token=...      -> the link from the e-mail: choose a new password (and the second-factor code when the account has one)
//   #error=... / expired   -> the link is expired or already used: ask for a new one
// The token is read from the fragment, removed from the address bar at once, sent ONLY to this server (POST /api/auth/reset), never stored.
(() => {
  'use strict';
  const app = document.getElementById('app');
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : String(v)); } for (const k of kids.flat(Infinity)) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
  const frag = new URLSearchParams(location.hash.replace(/^#/, ''));
  const token = frag.get('type') === 'recovery' || frag.get('access_token') ? frag.get('access_token') : null;
  const linkError = frag.get('error') || frag.get('error_code');
  if (location.hash) history.replaceState(null, '', location.pathname); // the token leaves the address bar before anything else
  const post = async (path, body) => { const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { /* none */ } return { ok: r.ok, status: r.status, json: j }; };
  const msg = (tone, text) => h('div', { class: `gn-msg ${tone}`, role: tone === 'err' ? 'alert' : 'status', text });
  const wrap = (...kids) => app.replaceChildren(h('div', { class: 'cx-wrap sc-reset-box' }, h('a', { class: 'cx-brand', href: '/', text: 'Nordla AI' }), ...kids));
  const field = (label, input) => h('div', { class: 'gn-field sc-reset-field' }, h('label', { class: 'gn-label', text: label }), h('div', { class: 'gn-control' }, input));

  function requestForm(note) {
    const email = h('input', { class: 'gn-input', type: 'email', autocomplete: 'username', inputmode: 'email', maxlength: 254, 'aria-label': 'Adresse e-mail' }); const out = h('div'); const btn = h('button', { class: 'cx-btn gn-btn-save', type: 'button', text: 'Envoyer le lien' });
    btn.addEventListener('click', async () => { btn.disabled = true; out.replaceChildren(); const r = await post('/api/auth/forgot', { email: email.value.trim() }); btn.disabled = false; out.replaceChildren(r.ok ? msg('ok', 'Si un compte existe pour cette adresse, un e-mail avec un lien de réinitialisation vient d’être envoyé. Le lien est valable peu de temps et ne sert qu’une fois.') : msg('err', r.status === 409 ? 'La récupération du compte n’est pas disponible.' : 'Le serveur ne répond pas. Réessayez plus tard.')); });
    wrap(h('h1', { text: 'Mot de passe oublié' }), note ? msg('err', note) : null, h('p', { class: 'cx-sub', text: 'Indiquez l’adresse e-mail de votre compte Nordla : nous vous envoyons un lien pour choisir un nouveau mot de passe.' }), field('Adresse e-mail', email), btn, out, h('p', {}, h('a', { class: 'cx-link', href: '/', text: 'Retour à la connexion' })));
  }

  function resetForm() {
    const pw = h('input', { class: 'gn-input', type: 'password', autocomplete: 'new-password', maxlength: 200, 'aria-label': 'Nouveau mot de passe' }); const pw2 = h('input', { class: 'gn-input', type: 'password', autocomplete: 'new-password', maxlength: 200, 'aria-label': 'Confirmer le nouveau mot de passe' });
    const code = h('input', { class: 'gn-input', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 20, 'aria-label': 'Code de l’application ou de récupération' }); const codeBox = h('div', { hidden: true }, field('Code de l’application d’authentification (ou code de récupération)', code));
    const out = h('div'); const btn = h('button', { class: 'cx-btn gn-btn-save', type: 'button', text: 'Changer le mot de passe' });
    btn.addEventListener('click', async () => {
      out.replaceChildren(); if (pw.value.length < 12) { out.replaceChildren(msg('err', 'Le mot de passe doit faire au moins 12 caractères.')); return; } if (pw.value !== pw2.value) { out.replaceChildren(msg('err', 'Les deux mots de passe ne sont pas identiques.')); return; }
      btn.disabled = true; const r = await post('/api/auth/reset', { token, password: pw.value, ...(code.value.trim() ? { code: code.value.trim() } : {}) }); btn.disabled = false;
      const c = r.json?.error?.code;
      if (r.ok) { wrap(h('h1', { text: 'Mot de passe changé' }), msg('ok', 'Votre mot de passe est changé. Toutes vos anciennes sessions ont été déconnectées.'), h('a', { class: 'cx-btn', href: '/', text: 'Se connecter' })); return; }
      if (c === 'LINK_INVALID') { requestForm('Ce lien est expiré ou a déjà été utilisé. Demandez un nouveau lien.'); return; }
      if (c === 'MFA_REQUIRED') { codeBox.hidden = false; code.focus(); out.replaceChildren(msg('err', r.json.error.message)); return; }
      out.replaceChildren(msg('err', r.json?.error?.message ?? 'Action refusée.'));
    });
    wrap(h('h1', { text: 'Nouveau mot de passe' }), h('p', { class: 'cx-sub', text: '12 caractères au moins. Vos sessions actuelles seront toutes déconnectées.' }), field('Nouveau mot de passe', pw), field('Confirmer', pw2), codeBox, btn, out);
  }

  if (token) resetForm(); else requestForm(linkError ? 'Ce lien est expiré ou a déjà été utilisé. Demandez un nouveau lien.' : null);
})();
