// Stock / Achats / Fournisseurs (Chantier C). One factory wires the write side (commands), the read side (queries) and the assistant contract over ONE store.
// The store is injected: createMemoryProcurementStore() for tests and rehearsal; a Supabase-backed store is a separate, not yet written adapter (see docs).
import { createProcurementService } from './service.js';
import { createProcurementQueries } from './queries.js';
import { createProcurementAssistantTools } from './assistant.js';

export { createMemoryProcurementStore } from './memory-store.js';
export { createPgProcurementStore, mapPgError } from './pg-store.js';
export { openFileProcurementStore } from './file-store.js';
export { importSourcingCase, draftOrderFromCase, caseToCapture } from './sourcing-bridge.js';
export { ProcurementError, StoreError } from './errors.js';
export { PO_STATUSES, PO_TRANSITIONS, ROLES, INCOTERMS, DEFAULT_POLICY, resolveTierPrice } from './service.js';
export { LOCATION_TYPES, MOVEMENT_KINDS } from './stock.js';

export function createProcurement({ store, merchantId, now, audit, analyze, retryDelayMs, policy }) {
  const commands = createProcurementService({ store, merchantId, now, audit, ...(retryDelayMs !== undefined ? { retryDelayMs } : {}), ...(policy ? { policy } : {}) });
  const queries = createProcurementQueries({ store, merchantId, now, ...(analyze ? { analyze } : {}) });
  const assistant = createProcurementAssistantTools({ queries });
  return Object.freeze({ commands, queries, assistant });
}
