import { deepFreeze, deriveId } from '../creative-brain/validation.js';
import { describeLayeredRuntime } from '../creative-runtime/layered-runtime.js';
import { GATE_REASON, GATE_STATUS, PRODUCTION_STATUS, READINESS_LEVEL, SCHEMA } from './constants.js';

// THE PROVIDER GATE. Nothing is sent to a provider unless every condition holds, and even then this module never calls a provider. It is the single
// place that says whether a layered production may be sent, and it fails closed (NOT_READY; READY_PENDING_OWNER_GO when only the owner's go is missing; OPEN_BY_OWNER only when the owner said go):
//   the product identity is VERIFIED, every scene is SPECIFIED, the budget holds, the whole Creative pipeline is READY for the exact code hash (planning, Brain, campaign, production), and the owner has said go.
// The layered production must be REACHABLE from the creative runtime: the gate reads what the runtime really calls (`describeLayeredRuntime`), so a stage that is not wired cannot be reported as wired.

/**
 * @param {object} input { production (the result of the production planner), readiness (the verdict of the combined Creative readiness gate), ownerGo, runtime (what the layered runtime is made of; by default the real one) }
 */
export function evaluateProviderGate({
  production, readiness, ownerGo = false, runtime = describeLayeredRuntime(),
}) {
  const reasons = [];
  if (!production?.production) reasons.push(GATE_REASON.PRODUCTION_NOT_SPECIFIED);
  else {
    if (production.product_identity?.status !== 'VERIFIED') reasons.push(GATE_REASON.PRODUCT_IDENTITY_NOT_VERIFIED);
    if (production.status !== PRODUCTION_STATUS.SPECIFIED || production.scenes.some((s) => s.status !== PRODUCTION_STATUS.SPECIFIED)) reasons.push(GATE_REASON.PRODUCTION_NOT_SPECIFIED);
    if (production.production.budget.within_ceiling !== true) reasons.push(GATE_REASON.BUDGET_BLOCKED);
  }
  if (!readiness || readiness.ready !== true || readiness.status !== 'CREATIVE_PIPELINE_READY') reasons.push(GATE_REASON.PIPELINE_NOT_READY);
  if (runtime?.wired !== true) reasons.push(GATE_REASON.COMPOSITOR_NOT_WIRED_TO_THE_RUNTIME);
  if (!ownerGo) reasons.push(GATE_REASON.OWNER_GO_PENDING);
  const blocking = reasons.filter((r) => r !== GATE_REASON.OWNER_GO_PENDING);
  let status = GATE_STATUS.NOT_READY;
  if (blocking.length === 0) status = ownerGo ? GATE_STATUS.OPEN_BY_OWNER : GATE_STATUS.READY_PENDING_OWNER_GO;
  const body = {
    schema: SCHEMA.gate, status, reasons: [...new Set(reasons)], production_id: production?.production?.production_id ?? null, provider_calls: 0,
  };
  return deepFreeze({ gate_id: deriveId('gat', body), ...body });
}

/**
 * The three honest levels of the layered production, and the first one NOT reached:
 *   CONTRACT_READY        the specification and its rules hold (the production parity audit passes)
 *   IMPLEMENTATION_READY  every stage exists as tested code (compositor, matte, text integrity, budget)
 *   RUNTIME_EXECUTABLE    the creative runtime can run a scene end to end through them (the runtime entry exists and calls every stage)
 * @param {object} input { parityOk, runtime (default: the real layered runtime) }
 */
export function productionReadinessLevel({ parityOk, runtime = describeLayeredRuntime() }) {
  const stages = Object.values(runtime?.stages ?? {});
  const implemented = stages.length > 0 && stages.every(Boolean);
  const executable = implemented && runtime?.wired === true && runtime?.entry === 'runLayeredCreative' && runtime?.single_image_fallback === false;
  let level = READINESS_LEVEL.NOT_READY;
  if (parityOk === true) level = READINESS_LEVEL.CONTRACT_READY;
  if (parityOk === true && implemented) level = READINESS_LEVEL.IMPLEMENTATION_READY;
  if (parityOk === true && executable) level = READINESS_LEVEL.RUNTIME_EXECUTABLE;
  return Object.freeze({ level, contract_ready: parityOk === true, implementation_ready: parityOk === true && implemented, runtime_executable: parityOk === true && executable });
}
