import { CORE_CATEGORY as C } from './taxonomy.js';

// NORDLA CORE RESILIENCE: THE RECOVERY POLICY. A module never decides a recovery by itself: the Core policy says, per category, which actions are AUTHORIZED, in which order they are tried, and under which
// precondition; a module policy may only choose inside that authorization (or, for DOMAIN_RULE_VIOLATION, declare its own list). Every recovery is BOUNDED by a budget; a bounded failure ends in a classified terminal
// state. The engine is deterministic code outside any model (NDR-009): no language model chooses a recovery.

export const RECOVERY_ACTION = Object.freeze({
  NORMALIZE: 'NORMALIZE', // a deterministic, meaning-preserving repair
  REASK_PROVIDER: 'REASK_PROVIDER', // one bounded protocol re-ask of the SAME provider with the SAME request
  RETRY_SAFE_OPERATION: 'RETRY_SAFE_OPERATION', // re-run an idempotent operation after a declared transient failure
  REPLAN: 'REPLAN', // go back to an earlier stage and plan again, keeping valid upstream state
  SWITCH_CAPABILITY: 'SWITCH_CAPABILITY', // use a DECLARED, AUTHORIZED, equivalent capability (never a dynamic route: NDR-D01, NDR-P16)
  ASK_USER: 'ASK_USER', // stop and ask one precise question
  GRACEFUL_BLOCK: 'GRACEFUL_BLOCK', // stop cleanly with a classified reason, keeping everything valid
  ROLLBACK: 'ROLLBACK', // return to the last committed checkpoint
  FATAL_STOP: 'FATAL_STOP', // nothing safe can be done
});
const A = RECOVERY_ACTION;

export const TERMINAL_ACTIONS = Object.freeze([A.ASK_USER, A.GRACEFUL_BLOCK, A.ROLLBACK, A.FATAL_STOP]);

export const TERMINAL_STATE = Object.freeze({
  COMPLETED: 'COMPLETED',
  NEEDS_USER: 'NEEDS_USER',
  BLOCKED_GRACEFULLY: 'BLOCKED_GRACEFULLY',
  ROLLED_BACK: 'ROLLED_BACK',
  FATAL: 'FATAL',
  RECOVERY_EXHAUSTED: 'RECOVERY_EXHAUSTED', // a bounded recovery ran out of budget and the run was blocked
});

/** The Core policy: the authorized actions of each category, in the order they are tried. */
export const CORE_POLICY = Object.freeze({
  [C.PROTOCOL_ERROR]: [A.NORMALIZE, A.REASK_PROVIDER, A.GRACEFUL_BLOCK],
  [C.INPUT_INVALID]: [A.NORMALIZE, A.ASK_USER, A.GRACEFUL_BLOCK],
  [C.MISSING_INFORMATION]: [A.NORMALIZE, A.ASK_USER, A.GRACEFUL_BLOCK], // NORMALIZE = apply a DECLARED safe default, only when one exists
  [C.USER_CONTRADICTION]: [A.NORMALIZE, A.ASK_USER, A.GRACEFUL_BLOCK], // NORMALIZE = an explicit user-priority rule resolves it
  [C.RECOVERABLE_EXECUTION_ERROR]: [A.RETRY_SAFE_OPERATION, A.REPLAN, A.ROLLBACK, A.GRACEFUL_BLOCK],
  [C.TOOL_CAPABILITY_LIMIT]: [A.REPLAN, A.SWITCH_CAPABILITY, A.ASK_USER, A.GRACEFUL_BLOCK],
  [C.PROVIDER_FAILURE]: [A.RETRY_SAFE_OPERATION, A.SWITCH_CAPABILITY, A.ASK_USER, A.GRACEFUL_BLOCK], // ASK_USER only when the sole alternatives would DEGRADE the requested outcome
  [C.DOMAIN_RULE_VIOLATION]: [A.ASK_USER, A.GRACEFUL_BLOCK], // the module policy may declare more, never fewer safeguards
  [C.SAFETY_OR_FIDELITY_BLOCK]: [A.GRACEFUL_BLOCK, A.ASK_USER, A.FATAL_STOP],
  [C.STATE_INTEGRITY_ERROR]: [A.ROLLBACK, A.FATAL_STOP],
  [C.FATAL_SYSTEM_ERROR]: [A.FATAL_STOP],
});

/** Actions NO module policy may ever add to a category: a safety or integrity failure is never normalized, retried, re-asked or switched around. */
export const FORBIDDEN = Object.freeze({
  [C.SAFETY_OR_FIDELITY_BLOCK]: [A.NORMALIZE, A.REASK_PROVIDER, A.RETRY_SAFE_OPERATION, A.SWITCH_CAPABILITY, A.ROLLBACK],
  [C.STATE_INTEGRITY_ERROR]: [A.NORMALIZE, A.REASK_PROVIDER, A.RETRY_SAFE_OPERATION, A.REPLAN, A.SWITCH_CAPABILITY, A.ASK_USER],
  [C.FATAL_SYSTEM_ERROR]: [A.NORMALIZE, A.REASK_PROVIDER, A.RETRY_SAFE_OPERATION, A.REPLAN, A.SWITCH_CAPABILITY, A.ASK_USER, A.ROLLBACK],
});

/**
 * Domain actions keep their meaning; each is mapped onto Core semantics: { core: Core action, scope: where }. Creative: RECONCEPT -> REPLAN at the concept stage; RECOMPOSE -> REPLAN at the composition stage;
 * REFINE -> REPLAN at the production stage.
 */
export function createDomainActionMap(module, map) {
  const frozen = {};
  for (const [name, entry] of Object.entries(map)) {
    if (!Object.values(A).includes(entry.core)) throw new TypeError(`${module}.${name}: ${entry.core} is not a Core action`);
    frozen[name] = Object.freeze({ domain_action: name, module, core: entry.core, scope: entry.scope ?? null });
  }
  return Object.freeze(frozen);
}

const COUNTER = Object.freeze({
  [A.REASK_PROVIDER]: 'provider_repairs', [A.RETRY_SAFE_OPERATION]: 'safe_retries', [A.REPLAN]: 'replans', [A.SWITCH_CAPABILITY]: 'capability_switches',
});
export const DEFAULT_LIMITS = Object.freeze({ provider_repairs: 1, safe_retries: 2, replans: 1, capability_switches: 1, depth: 4, cost_eur: Infinity, elapsed_ms: Infinity });

/** The bounds of one run's recovery. Every executed recovery is recorded; nothing is unbounded. */
export function createRecoveryBudget(limits = {}, { clock = () => Date.now() } = {}) {
  const max = { ...DEFAULT_LIMITS, ...limits };
  for (const [k, v] of Object.entries(max)) if (!(v === Infinity || (Number.isFinite(v) && v >= 0))) throw new RangeError(`recovery limit ${k}`);
  const used = { provider_repairs: 0, safe_retries: 0, replans: 0, capability_switches: 0, depth: 0, cost_eur: 0 };
  const started = clock();
  const budget = {
    max, used,
    elapsed: () => clock() - started,
    /** null when the action fits, otherwise the reason it does not. */
    refusal(action, costDelta = 0, { ignoreTime = false } = {}) {
      const counter = COUNTER[action];
      if (counter && used[counter] >= max[counter]) return `${counter.toUpperCase()}_EXHAUSTED`;
      if (!TERMINAL_ACTIONS.includes(action) && used.depth >= max.depth) return 'RECOVERY_DEPTH_EXHAUSTED';
      if (!TERMINAL_ACTIONS.includes(action) && used.cost_eur + costDelta > max.cost_eur) return 'RECOVERY_COST_EXHAUSTED';
      if (!ignoreTime && !TERMINAL_ACTIONS.includes(action) && budget.elapsed() > max.elapsed_ms) return 'RECOVERY_TIME_EXHAUSTED';
      return null;
    },
    spend(action, costDelta = 0) {
      // the decision already checked the clock; recording must not depend on it again (a second reading could differ)
      const why = budget.refusal(action, costDelta, { ignoreTime: true });
      if (why) throw Object.assign(new Error(`recovery budget refused ${action}: ${why}`), { code: 'CORE_RECOVERY_BUDGET_REFUSED', reason: why });
      const counter = COUNTER[action];
      if (counter) used[counter] += 1;
      if (!TERMINAL_ACTIONS.includes(action)) used.depth += 1;
      used.cost_eur += costDelta;
    },
    snapshot: () => ({ ...used, elapsed_ms: budget.elapsed(), max: { ...max } }),
  };
  return budget;
}

export class UnauthorizedRecoveryError extends Error {
  constructor(category, action, reason) {
    super(`recovery ${action} is not authorized for ${category}: ${reason}`);
    this.name = 'UnauthorizedRecoveryError';
    this.code = 'CORE_UNAUTHORIZED_RECOVERY';
    this.category = category;
    this.action = action;
  }
}

/**
 * The authorized actions of a category for a module. The module policy: `{ allow: { DOMAIN_RULE_VIOLATION: [..] }, extend: { CATEGORY: [..] }, forbid: { CATEGORY: [..] } }`.
 * `allow` replaces the list of DOMAIN_RULE_VIOLATION only; `extend` appends to any category except where FORBIDDEN; `forbid` removes (a module may always be stricter); `prefer` puts actions first.
 */
export function authorizedActions(category, modulePolicy = null) {
  let list = [...(CORE_POLICY[category] ?? [])];
  if (category === C.DOMAIN_RULE_VIOLATION && modulePolicy?.allow?.[category]) list = [...modulePolicy.allow[category]];
  for (const extra of modulePolicy?.extend?.[category] ?? []) if (!list.includes(extra)) list.push(extra);
  const never = FORBIDDEN[category] ?? [];
  const stricter = modulePolicy?.forbid?.[category] ?? [];
  list = list.filter((a) => !never.includes(a) && !stricter.includes(a) && Object.values(A).includes(a));
  // a module may put actions first (for example Finance asks the user before anything else)
  const first = modulePolicy?.prefer?.[category] ?? [];
  list.sort((x, y) => (first.includes(x) ? first.indexOf(x) : 99) - (first.includes(y) ? first.indexOf(y) : 99));
  // a terminal exit always exists: a category never ends up with nothing to do
  if (!list.some((a) => TERMINAL_ACTIONS.includes(a))) list.push(category === C.FATAL_SYSTEM_ERROR ? A.FATAL_STOP : A.GRACEFUL_BLOCK);
  return list;
}

export function assertAuthorized(error, action, modulePolicy = null) {
  const allowed = authorizedActions(error.category, modulePolicy);
  if (!allowed.includes(action)) throw new UnauthorizedRecoveryError(error.category, action, `authorized: ${allowed.join(', ')}`);
  return true;
}

/**
 * Preconditions of each action, from the context the stage declares. Returns null when the action may be tried, otherwise why not.
 *   reaskable (the stage allows ONE protocol re-ask), normalizable (a deterministic meaning-preserving repair exists), idempotent + transient (a safe retry), replannable, alternates (declared equivalent capabilities),
 *   safeDefault (a declared default), priorityRule (an explicit user-priority rule), canAskUser.
 */
function precondition(action, error, ctx) {
  if (ctx.failedActions?.has(action)) return 'RECOVERY_ACTION_ALREADY_FAILED';
  switch (action) {
    case A.NORMALIZE: return ctx.normalizable ? null : 'NO_MEANING_PRESERVING_REPAIR';
    case A.REASK_PROVIDER: return ctx.reaskable ? null : 'STAGE_DOES_NOT_ALLOW_A_REASK';
    case A.RETRY_SAFE_OPERATION: return ctx.idempotent && (error.category !== C.PROVIDER_FAILURE || ctx.transient) ? null : 'NOT_A_DECLARED_TRANSIENT_FAILURE_OF_AN_IDEMPOTENT_OPERATION';
    case A.REPLAN: return ctx.replannable ? null : 'NOTHING_TO_REPLAN';
    case A.SWITCH_CAPABILITY: return (ctx.alternates?.length ?? 0) > 0 ? null : 'NO_DECLARED_AUTHORIZED_EQUIVALENT_CAPABILITY';
    case A.ASK_USER:
      if (ctx.canAskUser === false) return 'NO_USER_TO_ASK';
      if (error.category === C.PROVIDER_FAILURE && (ctx.degradingAlternates?.length ?? 0) === 0) return 'NOTHING_TO_DECIDE_FOR_THE_USER';
      return null;
    default: return null;
  }
}

/**
 * The deterministic decision: the first authorized action whose precondition holds and whose budget remains. If a non-terminal action was skipped only because the budget ran out, the outcome is flagged `exhausted`.
 * Returns { action, terminal, skipped: [{action, why}], exhausted, terminal_state }.
 */
export function decideRecovery({ error, budget, modulePolicy = null, ctx = {} }) {
  const skipped = [];
  let exhausted = false;
  for (const action of authorizedActions(error.category, modulePolicy)) {
    const why = precondition(action, error, ctx) ?? budget.refusal(action, ctx.costDelta ?? 0);
    if (why) { skipped.push({ action, why }); if (/_EXHAUSTED$/.test(why)) exhausted = true; continue; }
    const terminal = TERMINAL_ACTIONS.includes(action);
    return { action, terminal, skipped, exhausted, terminal_state: terminal ? terminalStateOf(action, exhausted) : null };
  }
  // nothing fits: the safest authorized terminal exit
  const exit = error.category === C.FATAL_SYSTEM_ERROR || error.category === C.STATE_INTEGRITY_ERROR ? A.FATAL_STOP : A.GRACEFUL_BLOCK;
  return { action: exit, terminal: true, skipped, exhausted, terminal_state: terminalStateOf(exit, exhausted) };
}

export function terminalStateOf(action, exhausted = false) {
  switch (action) {
    case A.ASK_USER: return TERMINAL_STATE.NEEDS_USER;
    case A.ROLLBACK: return TERMINAL_STATE.ROLLED_BACK;
    case A.FATAL_STOP: return TERMINAL_STATE.FATAL;
    default: return exhausted ? TERMINAL_STATE.RECOVERY_EXHAUSTED : TERMINAL_STATE.BLOCKED_GRACEFULLY;
  }
}
