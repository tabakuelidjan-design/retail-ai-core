// PILOT: real connection factory for the narrow runtime path. No fallback: this module never builds an administrative
// connection and never reads environment variables. The entrypoint passes the values; secrets never live in the repository.
//
// Rules:
//  - TLS is mandatory and verified (rejectUnauthorized true, with the CA the entrypoint provides). A plaintext connection
//    is accepted only to a loopback host, and only when the caller sets allowLoopbackPlaintext (local tests).
//  - The login must be a pilot login: its name must start with `nordla_fin_pilot_`, and it must not be an administrative
//    or platform role (postgres, supabase_admin, service_role, authenticator, anon, authenticated).
//  - The pool is small and bounded (max connections, idle and connect timeouts, statement timeout).
//  - At start-up, `verifyPilotConnection` runs the identity check (nordla_runtime.fin_pilot_assert) through the narrow path
//    and refuses to continue on any failure. The caller must stop, not switch to a service client.

import pg from 'pg';
import { createNarrowIssuePath } from './narrow-issue-path.js';

const FORBIDDEN_LOGINS = new Set(['postgres', 'supabase_admin', 'service_role', 'authenticator', 'anon', 'authenticated', 'dashboard_user']);
const PILOT_PREFIX = 'nordla_fin_pilot_';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class PilotConnectionError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

/** Validates the configuration without connecting. Throws PilotConnectionError on any refusal. */
export function checkPilotConfig({ connectionString, ca = null, allowLoopbackPlaintext = false } = {}) {
  let u;
  try { u = new URL(connectionString); }
  catch { throw new PilotConnectionError('PILOT_CONNECTION_INVALID', 'connection string is not a URL'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw new PilotConnectionError('PILOT_CONNECTION_INVALID', 'not a PostgreSQL URL');
  const login = decodeURIComponent(u.username);
  if (!login || !login.startsWith(PILOT_PREFIX) || FORBIDDEN_LOGINS.has(login)) {
    throw new PilotConnectionError('PILOT_LOGIN_REFUSED', 'the login is not a pilot login');
  }
  // Every TLS parameter of the URL is refused, except sslmode=verify-full, which is redundant with the enforced
  // configuration. sslcert, sslkey, sslrootcert, sslcrl, sslpassword, sslnegotiation... could replace or extend the
  // verified CA or add a client identity: they are never accepted, whatever their value.
  for (const key of u.searchParams.keys()) {
    if (!key.toLowerCase().startsWith('ssl')) continue;
    if (key.toLowerCase() === 'sslmode' && u.searchParams.getAll(key).every((v) => v === 'verify-full')) continue;
    throw new PilotConnectionError('PILOT_TLS_PARAM_REFUSED', `TLS parameter "${key}" is not accepted in the pilot connection string`);
  }
  const loopback = LOOPBACK.has(u.hostname);
  if (!loopback) {
    if (!ca) throw new PilotConnectionError('PILOT_TLS_CA_REQUIRED', 'a CA certificate is required to verify the server');
  } else if (!allowLoopbackPlaintext) {
    throw new PilotConnectionError('PILOT_TLS_REQUIRED', 'loopback without the local-test flag is refused');
  }
  return { login, loopback };
}

/** Builds the pool (no connection is opened yet). */
export function createPilotPool({ connectionString, ca = null, allowLoopbackPlaintext = false, max = 3, statementTimeoutMs = 15000, applicationName = 'nordla-finance-pilot' } = {}) {
  const { loopback } = checkPilotConfig({ connectionString, ca, allowLoopbackPlaintext });
  const u = new URL(connectionString);
  // TLS is configured only through the `ssl` option below; the URL carries no TLS parameter (checked above)
  for (const key of [...u.searchParams.keys()]) if (key.toLowerCase().startsWith('ssl')) u.searchParams.delete(key);
  const ssl = loopback ? false : { ca, rejectUnauthorized: true, servername: u.hostname };
  return new pg.Pool({
    connectionString: u.toString(),
    ssl,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    application_name: applicationName,
    statement_timeout: statementTimeoutMs,
  });
}

/**
 * Start-up check: the pool's login must be bound to `merchantId`, unprivileged, and a pilot member. Throws on failure.
 * Returns the identity that the database reports (session_user), for the start-up log.
 */
export async function verifyPilotConnection(pool, merchantId) {
  const path = createNarrowIssuePath({ pool, merchantId });
  try {
    await path.verify();
  } catch (cause) {
    const e = new PilotConnectionError('PILOT_IDENTITY_REFUSED', `identity check failed: ${cause.message}`);
    e.cause = cause;
    throw e;
  }
  const r = await pool.query('select session_user::text as su, current_user::text as cu');
  return { sessionUser: r.rows[0].su, currentUser: r.rows[0].cu };
}
