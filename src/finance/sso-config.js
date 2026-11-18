// Finance single sign-on configuration (phase 2 correction).
// The key that verifies Core tickets is its OWN variable, FINANCE_SSO_KEY. It is never the dashboard token (FINANCE_DASHBOARD_TOKEN),
// and there is no fallback to that token: a missing, short or dashboard-token-equal key turns Core single sign-on OFF (/sso does not exist).
// Core (sourcing server) must sign with the same value, in its FINANCE_SSO_SECRET variable (a Railway reference to this one).

import { createAccessChecker } from '../identity/sso-contract.js';

export const FINANCE_SSO_KEY_VARIABLE = 'FINANCE_SSO_KEY';
export const FINANCE_SSO_MIN_KEY_LENGTH = 24;

/** The dedicated SSO key from the environment, or null when it is missing, too short, or equal to the dashboard token. */
export function financeSsoKeyOf(env, dashboardToken) {
  const key = String(env?.[FINANCE_SSO_KEY_VARIABLE] ?? '');
  if (key.length < FINANCE_SSO_MIN_KEY_LENGTH) return null;
  if (typeof dashboardToken === 'string' && dashboardToken.length > 0 && key === dashboardToken) return null;
  return key;
}

/**
 * The `sso` option of the Finance app: null (no /sso) unless Finance is hosted, SSO is enabled, and the dedicated key is valid.
 * The dashboard token is never used as the SSO key.
 */
export function financeSsoOptions({ hosted, enabled, env, dashboardToken, supabase, merchantId }) {
  if (!hosted || enabled !== true) return null;
  const secret = financeSsoKeyOf(env, dashboardToken);
  if (!secret) return null;
  return { secret, requirePerson: true, checkAccess: createAccessChecker({ supabase, merchantId }) };
}
