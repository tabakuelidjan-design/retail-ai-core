// Small, bounded security signal. No request body, token, path, identity or upstream error is logged.
// At most one line per code per minute; sensitive audit records remain in their existing merchant journals.
const CODES = new Set(['MFA_POLICY_UNAVAILABLE', 'ATTACHMENT_TENANT_MISMATCH']);
const MODULES = new Set(['security', 'finance', 'analytics', 'sourcing']);
export function createSecurityMonitor({ module, write = (entry) => console.warn(JSON.stringify(entry)), now = Date.now } = {}) {
  if (!MODULES.has(module)) throw new TypeError('Unknown security monitor module');
  const recent = new Map();
  return (code) => {
    if (!CODES.has(code)) return;
    const at = now(); const previous = recent.get(code);
    if (previous !== undefined && at - previous < 60000) return;
    recent.set(code, at);
    try { write({ event: 'security_denied', module, code }); } catch { /* telemetry cannot turn a refusal into access */ }
  };
}
