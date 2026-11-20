// PILOT wiring for the Finance start-up (createRuntime). Off by default: FINANCE_RUNTIME_DB unset or "service" keeps the existing
// service-role store unchanged. FINANCE_RUNTIME_DB=narrow-pilot routes getDocument and issueDocument through the least-privilege
// PostgreSQL role. In that mode any failure stops the start-up: there is no fallback to the service client.
//
// Configuration (outside the repository, never printed):
//   FINANCE_RUNTIME_DB=narrow-pilot
//   FINANCE_PILOT_DATABASE_URL   postgres URL of a pilot login (<login>.<project_ref> on the shared pooler)
//   FINANCE_PILOT_CA_FILE        path to the PEM of the verified CA (never the Windows trust store)
//   FINANCE_PILOT_SERVER_NAME    optional: DNS name to verify when the URL carries an IP literal
// Local tests only: FINANCE_PILOT_LOCAL_TEST=1 accepts a loopback plaintext URL (refused otherwise).

import { readFile as readFileDefault } from 'node:fs/promises';
import { createNarrowIssuePath } from './narrow-issue-path.js';
import { createPilotPool, verifyPilotConnection, PilotConnectionError } from './pg-connection.js';

export const RUNTIME_DB_MODES = Object.freeze(['service', 'narrow-pilot']);

export class FinanceRuntimeConfigError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

/**
 * Returns null in service mode, or { path, pool, identity } after a successful start-up identity check.
 * Throws FinanceRuntimeConfigError / PilotConnectionError on any problem: the caller must stop, never switch mode.
 */
export async function createNarrowIssuePathFromEnv({ env = process.env, merchantId, readFile = readFileDefault, log = () => {} } = {}) {
  const mode = env.FINANCE_RUNTIME_DB ?? 'service';
  if (!RUNTIME_DB_MODES.includes(mode)) throw new FinanceRuntimeConfigError('FINANCE_RUNTIME_DB_UNKNOWN', `FINANCE_RUNTIME_DB must be one of: ${RUNTIME_DB_MODES.join(', ')}`);
  if (mode === 'service') return null;

  const url = env.FINANCE_PILOT_DATABASE_URL;
  if (!url) throw new FinanceRuntimeConfigError('FINANCE_PILOT_DATABASE_URL_MISSING', 'narrow-pilot mode needs FINANCE_PILOT_DATABASE_URL');
  const caFile = env.FINANCE_PILOT_CA_FILE;
  if (!caFile) throw new FinanceRuntimeConfigError('FINANCE_PILOT_CA_FILE_MISSING', 'narrow-pilot mode needs FINANCE_PILOT_CA_FILE');
  let ca;
  try { ca = await readFile(caFile, 'utf8'); }
  catch { throw new FinanceRuntimeConfigError('FINANCE_PILOT_CA_FILE_UNREADABLE', 'the CA file cannot be read'); }
  if (!/-----BEGIN CERTIFICATE-----/.test(ca)) throw new FinanceRuntimeConfigError('FINANCE_PILOT_CA_FILE_INVALID', 'the CA file is not a PEM certificate');

  const pool = createPilotPool({
    connectionString: url,
    ca,
    serverName: env.FINANCE_PILOT_SERVER_NAME || null,
    allowLoopbackPlaintext: env.FINANCE_PILOT_LOCAL_TEST === '1',
    applicationName: 'nordla-finance-narrow',
  });
  try {
    const identity = await verifyPilotConnection(pool, merchantId);
    log(`Finance runtime database: narrow-pilot (session user ${identity.sessionUser}, bound merchant verified, TLS verified)`);
    return { path: createNarrowIssuePath({ pool, merchantId }), pool, identity };
  } catch (err) {
    await pool.end().catch(() => {});
    if (err instanceof PilotConnectionError) throw err;
    throw new FinanceRuntimeConfigError('FINANCE_PILOT_START_REFUSED', 'the narrow-pilot identity check failed; the service does not start');
  }
}
