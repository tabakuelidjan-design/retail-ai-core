import {
  DECISION_EVENT_TYPE,
  GOVERNED_DOCUMENT_STATUS,
  BRAND_REVIEW_SIGNAL,
  SNAPSHOT_STATUS,
} from './constants.js';
import {
  normalizeBrandCore,
  validateCoreForApproval,
} from './contracts.js';
import { buildBrandDecisionEvent } from './decision-event.js';
import {
  assertObject,
  assertResolvedActor,
  isoDate,
  optionalString,
  tenantMerchantId,
} from './validation.js';

const CORE_SUBJECT = 'brand_core';

// A READY snapshot is the normal base. A STALE one is still usable but raises a review
// signal for the human reviewer: staleness informs the decision, it does not auto-block it.
const USABLE_SNAPSHOT_STATUSES = new Set([SNAPSHOT_STATUS.READY, SNAPSHOT_STATUS.STALE]);

function assertSnapshotUsable(snapshot, merchantId) {
  if (!snapshot) throw new TypeError('snapshot is required');
  if (snapshot.merchant_id !== merchantId) {
    throw new Error('CORE_SNAPSHOT_MERCHANT_MISMATCH');
  }
  if (!USABLE_SNAPSHOT_STATUSES.has(snapshot.status)) {
    throw new Error('CORE_REQUIRES_READY_SNAPSHOT');
  }
  return snapshot;
}

// Approval is stricter than preparation: the reference Snapshot must be READY.
function assertSnapshotReadyForApproval(snapshot, merchantId) {
  assertSnapshotUsable(snapshot, merchantId);
  if (snapshot.status !== SNAPSHOT_STATUS.READY) {
    throw new Error('CORE_APPROVAL_REQUIRES_READY_SNAPSHOT');
  }
  return snapshot;
}

const snapshotSignals = (snapshot) => (
  snapshot.status === SNAPSHOT_STATUS.STALE ? [BRAND_REVIEW_SIGNAL.SNAPSHOT_STALE] : []
);

export function validateCoreEvidenceAgainstSnapshot(core, snapshot) {
  const reasons = [];
  if (!snapshot) return Object.freeze({ ok: false, reasons: Object.freeze(['SNAPSHOT_REQUIRED']) });

  if (core.merchant_id !== snapshot.merchant_id) {
    reasons.push('CORE_SNAPSHOT_MERCHANT_MISMATCH');
  }
  if (!core.snapshot_ref) {
    reasons.push('CORE_SNAPSHOT_REFERENCE_REQUIRED');
  } else if (
    core.snapshot_ref.id !== snapshot.id
    || core.snapshot_ref.version !== snapshot.version
  ) {
    reasons.push('CORE_SNAPSHOT_REFERENCE_MISMATCH');
  }

  const evidenceIds = new Set(snapshot.evidence.map((item) => item.id));
  for (const ref of core.evidence_refs) {
    if (!evidenceIds.has(ref)) reasons.push('CORE_REFERENCES_UNKNOWN_EVIDENCE');
  }

  return Object.freeze({
    ok: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

export function buildBrandCoreProposal({
  id,
  tenant,
  version = 1,
  createdAt,
  snapshot,
  decisions = {},
  supersedesId = null,
} = {}) {
  const merchantId = tenantMerchantId(tenant);
  assertSnapshotUsable(snapshot, merchantId);
  assertObject(decisions, 'decisions');

  const core = normalizeBrandCore({
    id,
    merchant_id: merchantId,
    version,
    status: GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED,
    created_at: createdAt,
    supersedes_id: supersedesId,
    snapshot_ref: { id: snapshot.id, version: snapshot.version },
    category: decisions.category ?? null,
    buying_contexts: decisions.buying_contexts ?? [],
    value_proposition: decisions.value_proposition ?? null,
    positioning: decisions.positioning ?? null,
    core_promise: decisions.core_promise ?? null,
    reasons_to_believe: decisions.reasons_to_believe ?? [],
    personality: decisions.personality ?? [],
    voice: decisions.voice ?? {},
    exclusions: decisions.exclusions ?? [],
    distinctive_assets: decisions.distinctive_assets ?? [],
    evidence_refs: decisions.evidence_refs ?? [],
    approval: null,
  });

  const evidenceValidation = validateCoreEvidenceAgainstSnapshot(core, snapshot);
  if (!evidenceValidation.ok) {
    throw new Error(evidenceValidation.reasons.join(', '));
  }

  return Object.freeze({
    core,
    approval_readiness: validateCoreForApproval(core),
    source_snapshot_status: snapshot.status,
    review_signals: Object.freeze(snapshotSignals(snapshot)),
    auto_approved: false,
  });
}

/**
 * Human approval of a Core proposal.
 * - `resolvedActor` comes from the trusted server/Socle context, never from a client payload.
 *   Branding only checks it is present, same tenant and an authorized role - it authenticates nobody;
 * - `activeCore` is the tenant's currently APPROVED Core (or null). A new version MUST
 *   supersede it, so two APPROVED Cores can never coexist for one tenant;
 * - returns the approved Core, the superseded previous Core (if any) and a decision event
 *   ready to be handed to the Socle Decision Ledger. Nothing is persisted here.
 */
export function approveBrandCore({
  proposal,
  snapshot,
  tenant,
  resolvedActor,
  activeCore = null,
  approvedAt,
  note = null,
} = {}) {
  if (!proposal) throw new TypeError('proposal is required');
  const merchantId = tenantMerchantId(tenant);
  if (proposal.merchant_id !== merchantId) throw new Error('CORE_TENANT_MISMATCH');
  const actor = assertResolvedActor(resolvedActor, tenant);

  if (proposal.status !== GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED) {
    throw new Error('CORE_MUST_BE_REVIEW_REQUIRED_BEFORE_APPROVAL');
  }

  assertSnapshotReadyForApproval(snapshot, merchantId);

  const evidenceValidation = validateCoreEvidenceAgainstSnapshot(proposal, snapshot);
  if (!evidenceValidation.ok) {
    throw new Error(evidenceValidation.reasons.join(', '));
  }

  const readiness = validateCoreForApproval(proposal);
  if (!readiness.ok) {
    throw new Error(`CORE_NOT_READY_FOR_APPROVAL: ${readiness.reasons.join(', ')}`);
  }

  let superseded = null;
  if (activeCore) {
    if (activeCore.merchant_id !== merchantId) throw new Error('CORE_ACTIVE_CORE_TENANT_MISMATCH');
    if (activeCore.status !== GOVERNED_DOCUMENT_STATUS.APPROVED) {
      throw new Error('CORE_ACTIVE_CORE_NOT_APPROVED');
    }
    if (proposal.supersedes_id !== activeCore.id || proposal.version !== activeCore.version + 1) {
      throw new Error('CORE_ACTIVE_CORE_MUST_BE_SUPERSEDED');
    }
    superseded = normalizeBrandCore({
      ...activeCore,
      status: GOVERNED_DOCUMENT_STATUS.SUPERSEDED,
    });
  } else if (proposal.supersedes_id) {
    throw new Error('CORE_SUPERSEDES_UNKNOWN_ACTIVE_CORE');
  }

  const decidedAt = isoDate(approvedAt, 'approvedAt');
  const decisionEvent = buildBrandDecisionEvent({
    type: DECISION_EVENT_TYPE.BRAND_CORE_APPROVED,
    merchantId,
    actor,
    subject: { kind: CORE_SUBJECT, id: proposal.id, version: proposal.version },
    decidedAt,
    note: optionalString(note, 'note'),
    supersedes: superseded
      ? { kind: CORE_SUBJECT, id: superseded.id, version: superseded.version }
      : null,
  });

  const core = normalizeBrandCore({
    ...proposal,
    status: GOVERNED_DOCUMENT_STATUS.APPROVED,
    approval: {
      decision_event_id: decisionEvent.id,
      approved_by: actor.user_id,
      approver_role: actor.role,
      approved_at: decidedAt,
      note: optionalString(note, 'note'),
    },
  });

  return Object.freeze({
    core,
    superseded,
    decision_event: decisionEvent,
    review_signals: Object.freeze(snapshotSignals(snapshot)),
  });
}

// Guard for stores/callers: a tenant has at most one APPROVED Core.
export function selectActiveBrandCore(cores = [], tenant) {
  const merchantId = tenantMerchantId(tenant);
  const active = cores.filter((core) => (
    core.merchant_id === merchantId && core.status === GOVERNED_DOCUMENT_STATUS.APPROVED
  ));
  if (active.length > 1) throw new Error('MULTIPLE_APPROVED_BRAND_CORES');
  return active[0] ?? null;
}

export function proposeBrandCoreRevision({
  approvedCore,
  snapshot,
  tenant,
  id,
  createdAt,
  changes = {},
} = {}) {
  if (!approvedCore) throw new TypeError('approvedCore is required');
  if (approvedCore.status !== GOVERNED_DOCUMENT_STATUS.APPROVED) {
    throw new Error('CORE_REVISION_REQUIRES_APPROVED_CORE');
  }
  assertObject(changes, 'changes');

  const next = {
    category: changes.category ?? approvedCore.category,
    buying_contexts: changes.buying_contexts ?? approvedCore.buying_contexts,
    value_proposition: changes.value_proposition ?? approvedCore.value_proposition,
    positioning: changes.positioning ?? approvedCore.positioning,
    core_promise: changes.core_promise ?? approvedCore.core_promise,
    reasons_to_believe: changes.reasons_to_believe ?? approvedCore.reasons_to_believe,
    personality: changes.personality ?? approvedCore.personality,
    voice: changes.voice ?? approvedCore.voice,
    exclusions: changes.exclusions ?? approvedCore.exclusions,
    distinctive_assets: changes.distinctive_assets ?? approvedCore.distinctive_assets,
    evidence_refs: changes.evidence_refs ?? approvedCore.evidence_refs,
  };

  return buildBrandCoreProposal({
    id,
    tenant,
    version: approvedCore.version + 1,
    createdAt,
    snapshot,
    decisions: next,
    supersedesId: approvedCore.id,
  });
}

export function buildCoreDecisionPacket({ proposal, snapshot } = {}) {
  if (!proposal) throw new TypeError('proposal is required');
  if (!snapshot) throw new TypeError('snapshot is required');

  const evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]));
  return Object.freeze({
    core_ref: Object.freeze({ id: proposal.id, version: proposal.version }),
    snapshot_ref: proposal.snapshot_ref,
    status: proposal.status,
    review_signals: Object.freeze(snapshotSignals(snapshot)),
    decisions: Object.freeze({
      category: proposal.category,
      buying_contexts: proposal.buying_contexts,
      value_proposition: proposal.value_proposition,
      positioning: proposal.positioning,
      core_promise: proposal.core_promise,
      reasons_to_believe: proposal.reasons_to_believe,
      personality: proposal.personality,
      voice: proposal.voice,
      exclusions: proposal.exclusions,
      distinctive_assets: proposal.distinctive_assets,
    }),
    evidence: Object.freeze(
      proposal.evidence_refs
        .map((ref) => evidenceById.get(ref))
        .filter(Boolean),
    ),
    approval_required: true,
    approval_authority: 'HUMAN_OWNER_OR_AUTHORIZED_REVIEWER',
    auto_apply: false,
  });
}
