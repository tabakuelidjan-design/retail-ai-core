// The hub: the ONLY way one module's capability is invoked from another (requirement 19: contracts and orchestration, no physical merge).
// Every call is (1) availability-checked (MODULE_NOT_AVAILABLE, never a crash), (2) authorized by the one approval policy, (3) written to the trace ledger.
import { MODULE, ERR, IntegrationError } from './constants.js';
import { authorize, ACTION_POLICY } from './approval.js';

/**
 * @param {{ ledger, adapters: Record<string, { available?: ()=>boolean, commands: Record<string, Function> }> }} deps
 * An adapter is the module's integration face; a module with no adapter is NOT_AVAILABLE.
 */
export function createHub({ ledger, adapters = {} }) {
  const has = (module) => Boolean(adapters[module]) && (adapters[module].available?.() ?? true);

  async function call(module, command, args = {}, ctx = {}) {
    const { workflow_id, from = MODULE.CORE, initiated_by = null, approvals = [], subject_ref = null, entity_refs = [] } = ctx;
    const action = `${module}.${command}`;
    const log = (outcome, extra = {}) => ledger.append({ workflow_id, initiated_by, source_module: from, destination_module: module, action, entity_refs, outcome, ...extra });

    if (!has(module)) {
      log('MODULE_NOT_AVAILABLE', { error: { code: ERR.MODULE_NOT_AVAILABLE, module } });
      return { ok: false, status: 'MODULE_NOT_AVAILABLE', code: ERR.MODULE_NOT_AVAILABLE, module };
    }
    const fn = adapters[module].commands?.[command];
    const noCommand = () => { log('ERROR', { error: { code: ERR.COMMAND_NOT_AVAILABLE, command } }); return { ok: false, status: 'COMMAND_NOT_AVAILABLE', code: ERR.COMMAND_NOT_AVAILABLE, module, command }; };
    if (typeof fn !== 'function' && !(action in ACTION_POLICY)) return noCommand();
    const auth = authorize(action, { approvals, subject_ref });
    if (auth.decision === 'BLOCK') { log('BLOCKED', { decision: auth, error: { code: auth.code } }); return { ok: false, status: 'BLOCKED', code: auth.code, reason: auth.reason }; }
    if (auth.decision === 'APPROVAL_REQUIRED') { log('APPROVAL_REQUIRED', { decision: auth, error: { code: auth.code } }); return { ok: false, status: 'APPROVAL_REQUIRED', code: auth.code, reason: auth.reason }; }
    if (typeof fn !== 'function') return noCommand(); // policy allows it (or an approval exists) but this phase implements no such command
    try {
      const result = await fn(args, ctx);
      const review = auth.decision === 'REVIEW_REQUIRED';
      log(review ? 'REVIEW_REQUIRED' : 'OK', { decision: auth, approval: approvals.find((a) => a?.action === action) ?? null, result: summarize(result) });
      return { ok: true, status: review ? 'REVIEW_REQUIRED' : 'OK', result, level: auth.level };
    } catch (e) {
      const code = e instanceof IntegrationError ? e.code : 'MODULE_ERROR';
      log(code === ERR.CURRENCY_CONFLICT || e instanceof IntegrationError ? 'BLOCKED' : 'ERROR', { decision: auth, error: { code, message: String(e.message).slice(0, 300), detail: e.detail ?? null } });
      return { ok: false, status: e instanceof IntegrationError ? 'BLOCKED' : 'ERROR', code, reason: e.message, detail: e.detail };
    }
  }
  return Object.freeze({ call, has, modules: () => Object.keys(adapters).filter(has) });
}

/** What goes into the ledger of a result: ids, statuses and counts; never raw bodies. */
function summarize(r) {
  if (r === null || r === undefined || typeof r !== 'object') return r ?? null;
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    else if (Array.isArray(v)) out[k] = `[${v.length}]`;
    else out[k] = '{...}';
  }
  return out;
}
