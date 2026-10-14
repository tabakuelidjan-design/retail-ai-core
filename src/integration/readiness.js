// Honest global readiness (requirement 20). Module-local readiness never implies global readiness: each global flag is computed from EVIDENCE the caller
// passes in (test results, CI result, workflow outcomes) and from the module map; a missing piece of evidence is NO, never assumed YES.
import { MODULE_MAP, NOT_MERGED } from './module-map.js';
import { KNOWN_DUPLICATIONS } from './ownership.js';
import { MODULE as M } from './constants.js';

const yes = (b) => (b ? 'YES' : 'NO');

/**
 * @param {{ contracts?: Record<string, boolean>, workflows?: { china_to_store?: boolean, product_campaign?: boolean, supplier_finance?: boolean },
 *           ledger_verified?: boolean, full_suite?: { ran: boolean, failed_unexplained: number }, ci?: { green: boolean|null } , owner_decisions_open?: string[] }} evidence
 */
export function evaluateIntegrationReadiness(evidence = {}) {
  const c = evidence.contracts ?? {};
  const w = evidence.workflows ?? {};
  const modulesPresent = Object.entries(MODULE_MAP).filter(([, v]) => v.implemented).map(([k]) => k);
  const modulesNotImplemented = Object.entries(MODULE_MAP).filter(([, v]) => !v.implemented).map(([k]) => k);

  const module_flags = {
    CORE_READY: yes(c.core), FINANCE_READY: yes(c.finance), SOURCING_READY: yes(c.sourcing), BMC_READY: yes(c.bmc), STOCK_READY: yes(c.stock), ANALYTICS_READY: yes(c.analytics),
  };
  const NORDLA_MODULES_CONNECTED = yes(Object.values(c).length > 0 && ['sourcing_buying', 'buying_finance', 'buying_stock', 'stock_marketing', 'bmc', 'analytics', 'router'].every((k) => c[k] === true) && evidence.ledger_verified === true);
  const NORDLA_CROSS_MODULE_WORKFLOWS_READY = yes(w.china_to_store === true && w.product_campaign === true && w.supplier_finance === true);

  const blockers = [];
  if (!evidence.full_suite?.ran) blockers.push('full suite not run');
  else if (evidence.full_suite.failed_unexplained > 0) blockers.push(`${evidence.full_suite.failed_unexplained} unexplained suite failure(s)`);
  if (evidence.ci?.green !== true) blockers.push(evidence.ci?.green === false ? 'CI red' : 'CI not confirmed green');
  if (NORDLA_MODULES_CONNECTED !== 'YES') blockers.push('modules not all connected');
  if (NORDLA_CROSS_MODULE_WORKFLOWS_READY !== 'YES') blockers.push('a cross-module workflow is not passing');
  const high = KNOWN_DUPLICATIONS.filter((d) => d.severity === 'HIGH').map((d) => d.id);
  const open = evidence.owner_decisions_open ?? [];
  // PRE_CHINA_READY is a conjunction; open owner decisions and unmerged branches are reported next to it, not hidden behind it.
  const NORDLA_PRE_CHINA_READY = yes(blockers.length === 0 && NORDLA_MODULES_CONNECTED === 'YES' && NORDLA_CROSS_MODULE_WORKFLOWS_READY === 'YES');
  return Object.freeze({
    ...module_flags, NORDLA_MODULES_CONNECTED, NORDLA_CROSS_MODULE_WORKFLOWS_READY, NORDLA_PRE_CHINA_READY,
    blockers, modules_present: modulesPresent, modules_not_implemented: modulesNotImplemented,
    not_merged: NOT_MERGED.map((n) => n.branch), high_severity_duplications: high, owner_decisions_open: open,
    persistence: 'NOT_PERSISTED: BUY_CANDIDATE, PurchasePlan, IncomingExpectation, CampaignContract, TrackingDefinition and the trace ledger are in memory',
    voice: modulesNotImplemented.includes(M.PARLE_A_NORDLA) ? 'Parle à Nordla: text router only, no voice/ASR' : 'voice present',
  });
}
