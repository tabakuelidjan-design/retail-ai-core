// One approval policy for every cross-module action (requirement 5). Default deny: an action not in the table is BLOCKED.
// The policy lives outside any agent or model (NDR-009); an approval is a record by a HUMAN naming the action and the subject it covers.
import { LEVEL, MODULE as M, ERR, fail, deepFreeze } from './constants.js';
import { PROCUREMENT_ACTIONS } from './procurement-policy.js';

const L = LEVEL;
/** `<MODULE>.<action>` -> level. Read the table as the whole list of what Nordla may do across modules before China. */
export const ACTION_POLICY = deepFreeze({
  ...PROCUREMENT_ACTIONS, // Stock / Achats assistant tools (reads + proposals only), see procurement-policy.js
  // reading and searching
  [`${M.FINANCE}.search_invoices`]: L.READ_ONLY, [`${M.FINANCE}.supplier_overview`]: L.READ_ONLY,
  [`${M.STOCK_SALES}.read_availability`]: L.READ_ONLY, [`${M.ANALYTICS}.read`]: L.READ_ONLY, [`${M.ANALYTICS}.explain_change`]: L.READ_ONLY,
  [`${M.CHINA_SOURCING}.summarize_case`]: L.READ_ONLY, [`${M.PARLE_A_NORDLA}.route`]: L.READ_ONLY,
  // deterministic calculation and preparation (nothing leaves the building, nothing is committed)
  [`${M.FINANCE}.analyze_purchase`]: L.AUTO_SAFE, [`${M.FINANCE}.compare_scenarios`]: L.AUTO_SAFE, [`${M.CHINA_SOURCING}.compare`]: L.AUTO_SAFE, [`${M.CHINA_SOURCING}.assess`]: L.AUTO_SAFE,
  [`${M.BUYING}.prepare_handoff`]: L.AUTO_SAFE, [`${M.MARKETING}.build_campaign_contract`]: L.AUTO_SAFE, 
  [`${M.ANALYTICS}.define_tracking`]: L.AUTO_SAFE, [`${M.STOCK_SALES}.expect_incoming`]: L.AUTO_SAFE, [`${M.BRANDING}.check_claims`]: L.AUTO_SAFE,
  // a human looks at it before it is used
  [`${M.BUYING}.create_purchase_plan`]: L.OWNER_REVIEW, [`${M.CREATIVE}.produce_draft`]: L.OWNER_REVIEW, [`${M.CREATIVE}.final_asset`]: L.OWNER_REVIEW, [`${M.MARKETING}.approve_campaign_for_creative`]: L.OWNER_REVIEW,
  // a human must approve, by name, before it happens
  [`${M.CHINA_SOURCING}.mark_buy_candidate`]: L.OWNER_APPROVAL_REQUIRED, [`${M.BUYING}.approve_purchase_plan`]: L.OWNER_APPROVAL_REQUIRED, [`${M.BUYING}.place_order`]: L.OWNER_APPROVAL_REQUIRED,
  [`${M.FINANCE}.pay_supplier`]: L.OWNER_APPROVAL_REQUIRED, [`${M.MARKETING}.publish`]: L.OWNER_APPROVAL_REQUIRED,
  [`${M.STOCK_SALES}.receive_goods`]: L.OWNER_APPROVAL_REQUIRED, [`${M.STOCK_SALES}.adjust_on_hand`]: L.OWNER_APPROVAL_REQUIRED,
  [`${M.BRANDING}.approve_claim`]: L.OWNER_APPROVAL_REQUIRED,
  // not in this phase, whoever asks
  [`${M.CREATIVE}.call_live_provider`]: L.BLOCKED, [`${M.STOCK_SALES}.write_shopify`]: L.BLOCKED, [`${M.MARKETING}.spend`]: L.BLOCKED,
});

const MACHINE = new Set(['system', 'engine', 'llm', 'ai', 'auto', 'bot', 'nordla', 'agent', 'model']);

/** An approval: { action, subject_ref, approver: { kind: 'HUMAN', id, role }, approved_at }. */
export function validateApproval(a) {
  if (!a || typeof a !== 'object') return { ok: false, code: ERR.APPROVAL_REQUIRED, reason: 'no approval record' };
  const ap = a.approver ?? {};
  if (ap.kind !== 'HUMAN' || typeof ap.id !== 'string' || !ap.id || MACHINE.has(ap.id.toLowerCase())) return { ok: false, code: ERR.APPROVER_NOT_HUMAN, reason: 'the approver must be a named human' };
  if (typeof a.action !== 'string' || typeof a.subject_ref !== 'string' || !a.subject_ref || !a.approved_at) return { ok: false, code: ERR.APPROVAL_REQUIRED, reason: 'an approval names the action, the subject and the time' };
  if (ap.role !== undefined && ap.role !== 'OWNER' && ap.role !== 'AUTHORIZED_REVIEWER') return { ok: false, code: ERR.APPROVER_NOT_HUMAN, reason: 'only an owner or an authorized reviewer approves' };
  return { ok: true };
}

/**
 * @returns {{ decision: 'ALLOW'|'REVIEW_REQUIRED'|'APPROVAL_REQUIRED'|'BLOCK', level, code?, reason }}
 * OWNER_REVIEW: allowed to proceed as a DRAFT; the result is marked pending review (the caller must carry that status).
 */
export function authorize(action, { approvals = [], subject_ref = null } = {}) {
  const level = ACTION_POLICY[action];
  if (!level) return { decision: 'BLOCK', level: L.BLOCKED, code: ERR.ACTION_UNKNOWN, reason: `${action} is not in the policy: default deny` };
  if (level === L.BLOCKED) return { decision: 'BLOCK', level, code: ERR.ACTION_BLOCKED, reason: `${action} is blocked in this phase` };
  if (level === L.READ_ONLY || level === L.AUTO_SAFE) return { decision: 'ALLOW', level, reason: 'no approval needed' };
  if (level === L.OWNER_REVIEW) return { decision: 'REVIEW_REQUIRED', level, reason: 'allowed as a draft; the owner reviews before it is used' };
  const matching = approvals.filter((a) => a?.action === action && (!subject_ref || a.subject_ref === subject_ref));
  if (!matching.length) return { decision: 'APPROVAL_REQUIRED', level, code: ERR.APPROVAL_REQUIRED, reason: `${action} needs a named human approval${subject_ref ? ` for ${subject_ref}` : ''}` };
  const checked = matching.map(validateApproval);
  const good = checked.find((c) => c.ok);
  if (!good) return { decision: 'APPROVAL_REQUIRED', level, code: checked[0].code, reason: checked[0].reason };
  return { decision: 'ALLOW', level, reason: 'approved by a named human' };
}

export function assertAllowed(action, ctx) {
  const r = authorize(action, ctx);
  if (r.decision === 'BLOCK' || r.decision === 'APPROVAL_REQUIRED') fail(r.code, r.reason, { action, level: r.level });
  return r;
}
