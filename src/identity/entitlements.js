// Nordla entitlements, read per call (no cache): which modules are ACTIVE for ONE merchant.
// A failure to read is never turned into "active": the caller receives an error and refuses (default deny).

import { isModuleCode } from './modules.js';

export const ENTITLEMENTS_TABLE = 'module_entitlements';

/**
 * @param {{ supabase: { select: Function }, merchantId: string }} input
 * @returns {Promise<Set<string>>} the registered module codes ACTIVE for this merchant (nothing else)
 */
export async function activeEntitlementsOf({ supabase, merchantId }) {
  const merchant = String(merchantId ?? '').toLowerCase();
  if (!merchant) throw new TypeError('activeEntitlementsOf: merchantId is required');
  const rows = await supabase.select(ENTITLEMENTS_TABLE, { select: 'merchant_id,module_code,status', merchant_id: `eq.${merchant}`, status: 'eq.ACTIVE' });
  const active = new Set();
  for (const r of rows ?? []) {
    // the query already filters by merchant and status; the row is checked again so another merchant's row can never count
    if (String(r.merchant_id ?? '').toLowerCase() !== merchant || r.status !== 'ACTIVE') continue;
    if (isModuleCode(r.module_code)) active.add(r.module_code);
  }
  return active;
}
