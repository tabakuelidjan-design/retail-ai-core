import { deepFreeze, deriveId } from '../creative-brain/validation.js';
import { GATE_REASON, GATE_STATUS, PRODUCTION_STATUS, SCHEMA } from './constants.js';

// THE PROVIDER GATE. Nothing is sent to a provider unless every condition holds, and even then this module never calls a provider. It is the single
// place that says whether a layered production may be sent, and it fails closed (NOT_READY; READY_PENDING_OWNER_GO when only the owner's go is missing; OPEN_BY_OWNER only when the owner said go):
//   the product identity is VERIFIED, every scene is SPECIFIED, the budget holds, the whole Creative pipeline is READY for the exact code hash (planning, Brain, campaign, production), and the owner has said go.
// The layered compositor is a tested library; until it is wired to the runtime the gate also says so.

/**
 * @param {object} input { production (the result of the production planner), readiness (the verdict of the combined Creative readiness gate), ownerGo, compositorWired }
 */
export function evaluateProviderGate({
  production, readiness, ownerGo = false, compositorWired = false,
}) {
  const reasons = [];
  if (!production?.production) reasons.push(GATE_REASON.PRODUCTION_NOT_SPECIFIED);
  else {
    if (production.product_identity?.status !== 'VERIFIED') reasons.push(GATE_REASON.PRODUCT_IDENTITY_NOT_VERIFIED);
    if (production.status !== PRODUCTION_STATUS.SPECIFIED || production.scenes.some((s) => s.status !== PRODUCTION_STATUS.SPECIFIED)) reasons.push(GATE_REASON.PRODUCTION_NOT_SPECIFIED);
    if (production.production.budget.within_ceiling !== true) reasons.push(GATE_REASON.BUDGET_BLOCKED);
  }
  if (!readiness || readiness.ready !== true || readiness.status !== 'CREATIVE_PIPELINE_READY') reasons.push(GATE_REASON.PIPELINE_NOT_READY);
  if (!compositorWired) reasons.push(GATE_REASON.COMPOSITOR_NOT_WIRED_TO_THE_RUNTIME);
  if (!ownerGo) reasons.push(GATE_REASON.OWNER_GO_PENDING);
  const blocking = reasons.filter((r) => r !== GATE_REASON.OWNER_GO_PENDING);
  let status = GATE_STATUS.NOT_READY;
  if (blocking.length === 0) status = ownerGo ? GATE_STATUS.OPEN_BY_OWNER : GATE_STATUS.READY_PENDING_OWNER_GO;
  const body = {
    schema: SCHEMA.gate, status, reasons: [...new Set(reasons)], production_id: production?.production?.production_id ?? null, provider_calls: 0,
  };
  return deepFreeze({ gate_id: deriveId('gat', body), ...body });
}
