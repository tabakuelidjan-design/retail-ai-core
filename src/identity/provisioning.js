// Nordla identity - INTERNAL module provisioning (ADR 0004, Core C3). Enables or suspends a module for a merchant.
//
// This is a Nordla operation (provisioning, later billing), never a customer action: it takes no actor, is not reachable from any
// merchant role (an OWNER or ADMIN can never enable a paid module) and is not wired to any route. It is meant for an operator
// script or the future billing process only. The change and its MODULE_ENABLED / MODULE_SUSPENDED journal entry are written by the
// database function identity_module_set in one transaction.

import { randomUUID } from 'node:crypto';
import { isModuleCode } from './modules.js';

export const MODULE_SET_FN = 'identity_module_set';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE = /^[a-z][a-z0-9_]{1,31}:[a-z0-9_-]{1,64}$/; // e.g. provisioning:manual, billing:invoice-2026-001

export class ProvisioningError extends Error {
  constructor(code, message) { super(message); this.name = 'ProvisioningError'; this.code = code; }
}

/**
 * @param {{ supabase: { rpc: Function }, now?: () => Date, newId?: () => string }} deps
 */
export function createModuleProvisioning({ supabase, now = () => new Date(), newId = randomUUID } = {}) {
  if (!supabase || typeof supabase.rpc !== 'function') throw new TypeError('createModuleProvisioning needs a Supabase client with rpc()');
  const set = (status) => async ({ merchantId, moduleCode, source, correlationId } = {}) => {
    if (typeof merchantId !== 'string' || !UUID.test(merchantId)) throw new ProvisioningError('INVALID_ARGUMENT', 'merchantId is invalid.');
    if (!isModuleCode(moduleCode)) return Object.freeze({ ok: false, code: 'MODULE_UNKNOWN' });
    if (typeof source !== 'string' || !SOURCE.test(source)) throw new ProvisioningError('INVALID_ARGUMENT', 'source must look like "provisioning:manual".');
    const corr = correlationId === undefined || correlationId === null ? newId() : (UUID.test(String(correlationId)) ? correlationId : null);
    if (!corr) throw new ProvisioningError('INVALID_ARGUMENT', 'correlationId is invalid.');
    let out;
    try {
      out = await supabase.rpc(MODULE_SET_FN, { p_merchant: merchantId.toLowerCase(), p_module: moduleCode, p_status: status, p_source: source, p_now: now().toISOString(), p_correlation: corr });
    } catch { throw new ProvisioningError('PROVISIONING_STORE_FAILED', 'The module change could not be recorded; nothing was changed.'); }
    if (!out || typeof out.ok !== 'boolean') throw new ProvisioningError('PROVISIONING_STORE_FAILED', 'Unexpected answer from the entitlement store.');
    return Object.freeze({ ok: out.ok, code: out.code });
  };
  return Object.freeze({ enableModule: set('ACTIVE'), suspendModule: set('SUSPENDED') });
}
