'use strict';
// HOSTED ONLY (served and loaded by hosted.js / createGrowthApp({ hosted: true }); the local preview server never has it).
// 1. Sign-in: the Core identity (e-mail + password of the Nordla account). The page carries the HttpOnly session cookie; every change carries the CSRF token.
// 2. Server-side follow-up: at sign-in the merchant's entries are loaded from /api/growth/follow-up; the screens read and write them through growthStorage
//    (persist.js). A write updates the screen at once and is sent to the server; a refusal (version conflict, role, network) is said at the top of the page, never hidden.
// 3. History already stored in THIS browser (before the server store existed) is never deleted or overwritten: the merchant is told how many entries are not on the server
//    yet and sends them with one button; entries the server already has are kept as they are.
// Nothing here sends a message, publishes, or changes the shop.

var growthHosted = (() => {
  const CSRF_COOKIES = ['__Host-nordla_growth_csrf'];
  const csrf = () => { for (const part of String(document.cookie).split(';')) { const i = part.indexOf('='); if (i > 0 && CSRF_COOKIES.includes(part.slice(0, i).trim())) return part.slice(i + 1).trim(); } return ''; };
  const state = { home: null, role: null, scope: null, bar: null, message: null, importable: [], done: null, route: null, loginError: '', busy: false };

  // The texts of the browser-only screens say "this browser": hosted, the follow-up is on the server (per language, applied once at start).
  const SERVER_TEXT = {
    fr: { 'gr.follow.prereq.local': 'La confirmation est enregistrée sur le serveur Nordla.', 'gr.follow.prereq.localConfirmed': 'Vérifications confirmées et enregistrées. Le classement calculé par le serveur ne voit pas cette confirmation : l’ordre affiché n’est pas modifié.', 'gr.pipe.storage': 'Historique enregistré sur le serveur Nordla, pour votre boutique (aucun CRM connecté) : il est retrouvé depuis un autre navigateur après connexion.', 'gr.guide.f.pipeline.need': 'Historique enregistré sur le serveur ; un CRM reste à connecter.', 'gr.follow.history': 'Historique enregistré', 'gr.follow.storageError': 'Impossible de lire ou d’enregistrer le suivi.', 'gr.follow.local': 'Historique enregistré sur le serveur Nordla.' },
    nl: { 'gr.follow.prereq.local': 'De bevestiging wordt op de Nordla-server opgeslagen.', 'gr.follow.prereq.localConfirmed': 'Controles bevestigd en opgeslagen. De door de server berekende rangschikking ziet deze bevestiging niet: de getoonde volgorde verandert niet.', 'gr.pipe.storage': 'Historiek opgeslagen op de Nordla-server, voor uw winkel (geen CRM verbonden): na aanmelding ook beschikbaar in een andere browser.', 'gr.guide.f.pipeline.need': 'Historiek op de server opgeslagen; een CRM moet nog worden verbonden.', 'gr.follow.history': 'Opgeslagen geschiedenis', 'gr.follow.storageError': 'De opvolging kon niet worden gelezen of opgeslagen.', 'gr.follow.local': 'De geschiedenis wordt op de Nordla-server opgeslagen.' },
    en: { 'gr.follow.prereq.local': 'The confirmation is stored on the Nordla server.', 'gr.follow.prereq.localConfirmed': 'Checks confirmed and saved. The ranking computed by the server does not see this confirmation: the displayed order is not changed.', 'gr.pipe.storage': 'History saved on the Nordla server, for your shop (no CRM connected): it is found again from another browser after signing in.', 'gr.guide.f.pipeline.need': 'History saved on the server; a CRM is still to be connected.', 'gr.follow.history': 'Saved history', 'gr.follow.storageError': 'Follow-up could not be read or saved.', 'gr.follow.local': 'History is saved on the Nordla server.' },
  };
  const applyServerText = () => { const d = window.NORDLA_DICTS || {}; for (const lang of Object.keys(SERVER_TEXT)) if (d[lang]) Object.assign(d[lang], SERVER_TEXT[lang]); };

  async function api(path, init = {}) {
    const method = init.method ?? 'GET';
    const headers = { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' && csrf() ? { 'x-nordla-csrf': csrf() } : {}) };
    const r = await fetch(path, { credentials: 'same-origin', ...init, headers });
    let body = null; try { body = await r.json(); } catch { body = null; }
    return { ok: r.ok, status: r.status, body };
  }

  // ---- the bar above the page: who, saved / not saved, history of this browser ----
  const barEl = () => {
    if (state.bar) return state.bar;
    state.bar = h('div', { class: 'gr-session-bar', role: 'status' });
    const app = document.getElementById('app');
    if (app && app.parentNode && typeof app.parentNode.insertBefore === 'function') app.parentNode.insertBefore(state.bar, app);
    return state.bar;
  };
  function renderBar() {
    const bar = barEl(); const kids = [];
    if (state.home) kids.push(h('p', { class: 'gr-session-home' }, h('a', { class: 'gv-link gr-session-home-link', href: state.home }, t('gr.session.home'))));
    if (state.message) kids.push(h('p', { class: 'gr-session-msg', role: 'alert' }, state.message, ' ', h('button', { type: 'button', class: 'gv-link', on: { click: () => { window.location.reload(); } } }, t('gr.session.reload'))));
    if (state.role && !GROWTH_WRITE_ROLES.includes(state.role)) kids.push(h('p', { class: 'gr-session-msg' }, t('gr.session.readOnly')));
    if (state.importable.length) kids.push(h('p', { class: 'gr-session-msg' }, t('gr.session.importTitle', String(state.importable.length)), ' ', h('button', { type: 'button', class: 'gv-link gr-session-import', on: { click: importLocal } }, t('gr.session.importGo'))));
    if (state.done != null) kids.push(h('p', { class: 'gr-session-msg' }, t('gr.session.importDone', String(state.done))));
    kids.push(h('p', { class: 'gr-session-who gr-muted' }, state.role ? t('gr.session.role', state.role) : '', ' ', h('button', { type: 'button', class: 'gv-link gr-session-logout', on: { click: logout } }, t('gr.session.logout'))));
    bar.replaceChildren(...kids);
  }
  const GROWTH_WRITE_ROLES = ['OWNER', 'ADMIN', 'COLLABORATOR'];

  // ---- the server-side entries, per key, one write at a time per key ----
  const store = { entries: new Map(), chain: new Map(), write: null };
  store.write = (key, raw) => {
    const prev = store.entries.get(key); const before = prev ? { ...prev } : null;
    store.entries.set(key, { raw, version: prev?.version ?? 0 }); // the screen sees it at once
    const run = (store.chain.get(key) ?? Promise.resolve()).then(async () => {
      let value; try { value = JSON.parse(raw); } catch { return; }
      const cur = store.entries.get(key);
      const r = await api('/api/growth/follow-up', { method: 'PUT', body: JSON.stringify({ key, value, expected_version: before?.version ?? 0 }) }).catch(() => ({ ok: false, status: 0, body: null }));
      if (r.ok) { const e = store.entries.get(key); if (e) e.version = r.body.version; renderBar(); return; }
      // refused: the screen must not pretend it is saved
      if (r.status === 409) { state.message = t('gr.session.conflict'); await hydrate(); }
      else if (r.status === 401) { state.message = t('gr.session.expired'); }
      else { if (before) store.entries.set(key, before); else store.entries.delete(key); state.message = t('gr.session.saveError', r.body?.error?.code ?? (r.status ? String(r.status) : 'NETWORK')); }
      renderBar();
    });
    store.chain.set(key, run.catch(() => {}));
  };

  async function hydrate() {
    const r = await api('/api/growth/follow-up');
    if (!r.ok) throw Object.assign(new Error('follow-up'), { status: r.status });
    state.scope = r.body.merchant_scope;
    store.entries = new Map(r.body.entries.map((e) => [e.key, { raw: JSON.stringify(e.value), version: e.version }]));
    growthPersist.server = { entries: store.entries, write: store.write };
    findImportable();
  }

  /** Browser-stored entries of this merchant's scope that the server does not have. Never touches the browser copies. */
  function findImportable() {
    state.importable = [];
    if (!state.scope) return;
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !(key.startsWith(`nordla.growth.follow-up.v1:${state.scope}:`) || key === `nordla.growth.pipeline.v1:${state.scope}`)) continue;
        if (!store.entries.has(key)) state.importable.push(key);
      }
    } catch { /* no browser storage: nothing to import */ }
  }
  async function importLocal() {
    let ok = 0;
    for (const key of [...state.importable]) {
      let value; try { value = JSON.parse(localStorage.getItem(key)); } catch { continue; }
      const r = await api('/api/growth/follow-up', { method: 'PUT', body: JSON.stringify({ key, value, expected_version: 0 }) }).catch(() => ({ ok: false }));
      if (r.ok) { store.entries.set(key, { raw: JSON.stringify(value), version: r.body.version }); ok += 1; }
    }
    state.done = ok; findImportable(); renderBar();
    if (state.route) state.route();
  }

  // ---- sign-in ----
  async function signIn() {
    const email = (document.getElementById('gr-login-email') || {}).value ?? ''; const password = (document.getElementById('gr-login-password') || {}).value ?? '';
    if (!email.trim() || !password) { state.loginError = t('gr.session.missing'); return showLogin(); }
    state.busy = true; state.loginError = ''; showLogin();
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: email.trim(), password }) });
      if (r.ok && r.body && r.body.ok) { state.busy = false; return boot(state.route); }
      state.loginError = (r.body && r.body.message) || t('gr.session.failed');
    } catch { state.loginError = t('gr.session.network'); }
    state.busy = false; showLogin();
  }
  function showLogin() {
    growthPersist.server = null;
    const app = document.getElementById('app');
    app.replaceChildren(h('div', { class: 'gr-login-wrap' }, h('section', { class: 'ex-card gr-login' },
      h('h1', { class: 'ex-title' }, t('gr.session.title')), h('p', { class: 'ex-sub' }, t('gr.session.intro')),
      state.loginError ? h('p', { class: 'gr-login-error', role: 'alert' }, state.loginError) : null,
      h('label', { for: 'gr-login-email' }, t('gr.session.email')), h('input', { id: 'gr-login-email', class: 'gr-login-input', type: 'email', autocomplete: 'username' }),
      h('label', { for: 'gr-login-password' }, t('gr.session.password')), h('input', { id: 'gr-login-password', class: 'gr-login-input', type: 'password', autocomplete: 'current-password' }),
      h('button', { id: 'gr-login-go', type: 'button', class: 'btn-primary-sm', disabled: state.busy ? 'disabled' : null, on: { click: signIn } }, state.busy ? t('gr.session.busy') : t('gr.session.submit')))));
    if (state.bar) state.bar.replaceChildren();
  }
  /** The screen does not open: say why, offer a retry when it can help, and the way out. */
  function showBlocked(key, canRetry) {
    growthPersist.server = null;
    document.getElementById('app').replaceChildren(h('div', { class: 'gr-login-wrap' }, h('section', { class: 'ex-card gr-login' }, h('h1', { class: 'ex-title' }, t('gr.session.title')), h('p', { class: 'gr-login-error', role: 'alert' }, t(key)),
      canRetry ? h('button', { type: 'button', class: 'btn-primary-sm', on: { click: () => boot(state.route) } }, t('gr.session.retry')) : null, h('button', { type: 'button', class: 'gv-link gr-session-logout', on: { click: logout } }, t('gr.session.logout')))));
    if (state.bar) state.bar.replaceChildren();
  }
  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* the cookies are cleared server-side; the page goes to the sign-in anyway */ }
    state.role = null; state.message = null; state.importable = []; state.done = null; showLogin();
  }

  /** Called by app.js instead of route(): sign in if needed, load the merchant's follow-up, then show the screen. */
  async function boot(route) {
    state.route = route; applyServerText();
    let s = null; try { s = (await api('/api/auth/session')).body; } catch { s = null; }
    if (!s || s.mode !== 'session') { state.loginError = t('gr.session.network'); return showLogin(); }
    if (!s.authenticated) return showLogin();
    state.role = s.role ?? null;
    try { const hm = (await api('/api/growth/home')).body; state.home = hm && typeof hm.url === 'string' && /^https:\/\//.test(hm.url) ? hm.url : null; } catch { state.home = null; } // a missing link never blocks the screen
    try { await hydrate(); } catch (e) { if (e.status === 401) return showLogin(); return showBlocked(e.status === 403 ? 'gr.session.denied' : 'gr.session.unavailable', e.status !== 403); } // never open the screen on a follow-up that failed to load: a later save would hide what the server holds
    renderBar(); route();
  }
  /** A data request answered 401 (the session ended): back to the sign-in, nothing else is lost. */
  function expired() { state.loginError = t('gr.session.expired'); state.role = null; showLogin(); }

  return { boot, expired, state, store };
})();
