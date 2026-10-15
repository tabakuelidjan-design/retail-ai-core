// Sign-in on a HOSTED server (Core identity): the server says so on GET /api/auth/session ({ mode: 'session' }). There, the phone never
// sends a development token: the browser carries the HttpOnly session cookie, and every change carries the CSRF token (read from the
// __Host-nordla_sourcing_csrf cookie) in x-nordla-csrf. A server that answers anything else is the local / PC server: the token path stays.
// The password is sent once to the same origin and never stored on the phone. Nothing local (cases, photos) is touched by sign-in or sign-out.
import { esc } from './dom.js';
import { ls } from './storage.js';

const CSRF_COOKIE = '__Host-nordla_sourcing_csrf';

export function csrfToken() {
  for (const part of String(globalThis.document?.cookie ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === CSRF_COOKIE) return part.slice(i + 1).trim(); }
  return '';
}

/** Asks the server which sign-in it uses; sets S.authMode ('session' | 'token') and, in session mode, S.token to a non-secret marker when signed in. */
export async function detectAuth(S) {
  try {
    const r = await fetch('/api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const b = r.ok ? await r.json() : null;
    if (b?.mode === 'session') { S.authMode = 'session'; S.token = b.authenticated ? 'session' : ''; S.role = b.role ?? null; ls.set('nordla.sourcing.authMode', 'session'); ls.set('nordla.sourcing.signedIn', !!b.authenticated); return S.authMode; }
    if (b?.mode === 'token') { S.authMode = 'token'; ls.set('nordla.sourcing.authMode', 'token'); return S.authMode; }
  } catch { /* offline: keep what the phone knew */ }
  // no answer (offline, server down): what the phone knew last time. A phone that was signed in keeps working on its own cases; the server
  // re-checks the session as soon as it answers (a refused session shows the sign-in again, nothing local is touched).
  S.authMode = ls.get('nordla.sourcing.authMode', 'token') === 'session' ? 'session' : 'token';
  if (S.authMode === 'session') S.token = ls.get('nordla.sourcing.signedIn', false) ? 'session' : '';
  return S.authMode;
}

export function loginScreen(S) {
  return `<div class="card"><h2>Connexion</h2><p class="small muted">Connectez-vous avec votre compte Nordla. Vos dossiers et photos déjà sur ce téléphone restent ici, connectés ou non.</p>
  ${S.loginError ? `<p class="warn">${esc(S.loginError)}</p>` : ''}
  <label>Adresse e-mail<input id="login-email" type="email" autocomplete="username" inputmode="email"></label>
  <label>Mot de passe<input id="login-password" type="password" autocomplete="current-password"></label>
  <button class="btn" data-act="login-go" style="margin-top:10px" ${S.loginBusy ? 'disabled' : ''}>${S.loginBusy ? 'Connexion…' : 'Se connecter'}</button>
  <button class="btn sec" data-act="gate-offline" style="margin-top:8px">Travailler sur ce téléphone seulement (hors ligne)</button></div>`;
}

/** Wires the sign-in button. `after` re-renders and checks the server once signed in. */
export function installSignIn({ S, after }) {
  if (typeof document === 'undefined') return;
  document.addEventListener('click', async (ev) => {
    if (!ev.target.closest?.('[data-act="login-go"]')) return;
    const email = document.getElementById('login-email')?.value.trim() ?? ''; const password = document.getElementById('login-password')?.value ?? '';
    if (!email || !password) { S.loginError = 'Indiquez votre adresse e-mail et votre mot de passe.'; return after(); }
    S.loginBusy = true; S.loginError = ''; after();
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const b = await r.json().catch(() => ({}));
      if (r.ok && b.ok) { S.token = 'session'; S.authFailed = false; S.role = b.role ?? null; ls.set('nordla.sourcing.signedIn', true); }
      else S.loginError = b.message ?? 'Connexion impossible.';
    } catch { S.loginError = 'Le serveur ne répond pas. Vos dossiers restent utilisables sur ce téléphone.'; }
    S.loginBusy = false; after();
  });
}
