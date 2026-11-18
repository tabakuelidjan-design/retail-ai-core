// Finance single sign-on configuration.
// The key that verifies Core tickets is its OWN variable, FINANCE_SSO_KEY: a canonical base64url value of 32 random bytes
// (43 characters, see identity/sso-keys.js). It is never the dashboard token (FINANCE_DASHBOARD_TOKEN), and there is no fallback:
// a missing, malformed, too-short, or reused key turns Core single sign-on OFF (/sso does not exist). The dashboard keeps its own login.
// Core (sourcing server) signs with the same value, in its FINANCE_SSO_SECRET variable (a Railway reference to this one).

import { createAccessChecker } from '../identity/sso-contract.js';
import { parseSsoKey, ssoKeyReuseOf } from '../identity/sso-keys.js';

export const FINANCE_SSO_KEY_VARIABLE = 'FINANCE_SSO_KEY';

/**
 * The dedicated Finance SSO key, or null with the reason (for logs). Never returns the dashboard token.
 * @returns {{ key: string, error: null } | { key: null, error: string }}
 */
export function financeSsoKeyOf(env, dashboardToken) {
  const raw = env?.[FINANCE_SSO_KEY_VARIABLE];
  const parsed = parseSsoKey(raw);
  if (!parsed.ok) return { key: null, error: `${FINANCE_SSO_KEY_VARIABLE}: ${parsed.code}` };
  if (ssoKeyReuseOf(raw, { dashboardToken })) return { key: null, error: `${FINANCE_SSO_KEY_VARIABLE}: DASHBOARD_TOKEN_REUSED` };
  return { key: raw, error: null };
}

/**
 * The `sso` option of the Finance app: null (no /sso) unless Finance is hosted, SSO is enabled, and the dedicated key is valid.
 */
export function financeSsoOptions({ hosted, enabled, env, dashboardToken, supabase, merchantId }) {
  if (!hosted || enabled !== true) return null;
  const { key } = financeSsoKeyOf(env, dashboardToken);
  if (!key) return null;
  return { secret: key, requirePerson: true, checkAccess: createAccessChecker({ supabase, merchantId }) };
}
