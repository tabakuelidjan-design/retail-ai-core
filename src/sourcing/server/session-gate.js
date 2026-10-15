// HOSTED China Sourcing behind the Core identity (ADR 0004 identity, Core C4 HTTP security). The development token is NOT accepted here:
// on a public address a person signs in with the e-mail / password of their Supabase Auth account, must be an ACTIVE member of THIS
// merchant (the server's NORDLA_MERCHANT_ID, never a request value) with the 'sourcing' module ACTIVE, and gets a Nordla session:
//   __Host-nordla_sourcing_sid   HttpOnly; Secure; SameSite=Lax; Path=/   (opaque token, only its hash is stored)
//   __Host-nordla_sourcing_csrf  Secure; SameSite=Lax; Path=/             (read by the page, sent back as x-nordla-csrf on every change)
// Every /api route then needs that session, re-checked on each call (membership and module re-read: a suspended person is out at once);
// every change (PUT / POST / DELETE) also needs the exact same-origin Origin and the CSRF pair. Login answers are the identity layer's
// public ones (one LOGIN_FAILED for every refusal, RATE_LIMITED, UNAVAILABLE), with a minimum duration so timing does not tell them apart.
//
//   POST /api/auth/login    { email, password }       -> 200 { ok: true, role } + cookies | 401 / 429 / 503 public refusal
//   GET  /api/auth/session                             -> 200 { mode: 'session', authenticated, role? } (never an error: the page needs it)
//   POST /api/auth/logout                              -> 200 { ok: true } ; the session is revoked server-side, both cookies cleared
//   authorize(req) for every other /api route          -> { ok: true, access } | { ok: false, status, body }

const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
const SAFE = ['GET', 'HEAD'];

export function createSessionGate({ identity, security }) {
  if (!identity || typeof identity.authenticateAndOpenSession !== 'function' || typeof identity.resolveAccessSession !== 'function') throw new TypeError('createSessionGate needs the identity service of this server (createIdentityService)');
  if (!security || typeof security.guardMutation !== 'function') throw new TypeError('createSessionGate needs the HTTP security of this server (createHttpSecurity)');
  if (identity.context?.module !== 'sourcing' || security.module !== 'sourcing') throw new TypeError('the identity and the HTTP security must both be built for the "sourcing" module');
  const refusal = (r) => ({ ok: false, status: r.response?.status ?? 403, body: r.response ?? { error: 'FORBIDDEN' } });
  const cookiesFor = (token) => [security.cookies.sessionCookie(token), security.cookies.csrfCookie(security.csrfTokenFor(token))];
  const cleared = () => [security.cookies.clearSessionCookie(), security.cookies.clearCsrfCookie()];

  /** The /api/auth/* routes. Returns true when the request was one of them (and answered). */
  async function handle(req, res, pathname) {
    if (pathname === '/api/auth/session') {
      const g = security.guardRead(req); if (!g.ok) { json(res, g.response.status, g.response); return true; }
      const token = security.cookies.read(req.headers.cookie).session;
      const a = token ? await identity.resolveAccessSession(token) : null;
      json(res, 200, a?.ok ? { mode: 'session', authenticated: true, role: a.role } : { mode: 'session', authenticated: false });
      return true;
    }
    if (pathname === '/api/auth/login') {
      const g = security.guardLogin(req); if (!g.ok) { json(res, g.response.status, g.response); return true; }
      let body; try { body = await security.readLoginBody(req); } catch (e) { const p = security.publicError(e, { requestId: g.ctx.requestId }); json(res, p.status, p); return true; }
      const r = await security.normalizeLogin(() => identity.authenticateAndOpenSession({ email: body.email, password: body.password, ipAddress: g.ctx.clientIp }));
      if (!r || r.ok !== true) { const p = r ?? { error: 'UNAVAILABLE', status: 503 }; json(res, p.status ?? 401, { error: p.error, message: p.message }); return true; }
      json(res, 200, { ok: true, role: r.session?.role ?? null }, { 'set-cookie': cookiesFor(r.token) });
      return true;
    }
    if (pathname === '/api/auth/logout') {
      const g = await security.guardMutation(req, identity.resolveAccessSession);
      if (g.ok) await identity.logoutSession?.(g.sessionToken);
      json(res, 200, { ok: true }, { 'set-cookie': cleared() }); // cookies cleared even for a stale session: nothing to keep on the phone
      return true;
    }
    return false;
  }

  /** Every other /api route: a valid session; for a change also the same-origin and CSRF checks. */
  async function authorize(req) {
    const method = String(req.method ?? '').toUpperCase();
    if (SAFE.includes(method)) {
      const g = security.guardRead(req); if (!g.ok) return refusal(g);
      const token = security.cookies.read(req.headers.cookie).session;
      const a = token ? await identity.resolveAccessSession(token) : null;
      return a?.ok ? { ok: true, access: a } : { ok: false, status: 401, body: { error: 'SESSION_INVALID', message: 'Votre session n\'est plus valide. Reconnectez-vous.' } };
    }
    const g = await security.guardMutation(req, identity.resolveAccessSession);
    if (!g.ok) return g.code === 'SESSION_INVALID' || g.code === 'CSRF_NO_SESSION' ? { ok: false, status: 401, body: { error: 'SESSION_INVALID', message: 'Votre session n\'est plus valide. Reconnectez-vous.' } } : refusal(g);
    return { ok: true, access: g.access };
  }

  return Object.freeze({ mode: 'session', handle, authorize });
}
