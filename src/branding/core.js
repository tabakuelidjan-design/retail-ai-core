import {
  GOVERNED_DOCUMENT_STATUS,
  SNAPSHOT_STATUS,
} from './constants.js';
import {
  normalizeBrandCore,
  validateCoreForApproval,
} from './contracts.js';
import {
  assertObject,
  isoDate,
  optionalString,
  requiredString,
  stringList,
} from './validation.js';

function assertSnapshotReady(snapshot, merchantId) {
  if (!snapshot) throw new TypeError('snapshot is required');
  if (snapshot.merchant_id !== merchantId) {
    throw new Error('CORE_SNAPSHOT_MERCHANT_MISMATCH');
  }
  if (snapshot.status !== SNAPSHOT_STATUS.READY) {
    throw new Error('CORE_REQUIRES_READY_SNAPSHOT');
  }
  return snapshot;
}

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
  merchantId,
  version = 1,
  createdAt,
  snapshot,
  decisions = {},
  supersedesId = null,
} = {}) {
  assertSnapshotReady(snapshot, merchantId);
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
    auto_approved: false,
  });
}

export function approveBrandCore({
  proposal,
  snapshot,
  approvedBy,
  approvedAt,
  note = null,
} = {}) {
  if (!proposal) throw new TypeError('proposal is required');
  if (proposal.status !== GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED) {
    throw new Error('CORE_MUST_BE_REVIEW_REQUIRED_BEFORE_APPROVAL');
  }

  assertSnapshotReady(snapshot, proposal.merchant_id);

  const evidenceValidation = validateCoreEvidenceAgainstSnapshot(proposal, snapshot);
  if (!evidenceValidation.ok) {
    throw new Error(evidenceValidation.reasons.join(', '));
  }

  const readiness = validateCoreForApproval(proposal);
  if (!readiness.ok) {
    throw new Error(`CORE_NOT_READY_FOR_APPROVAL: ${readiness.reasons.join(', ')}`);
  }

  return normalizeBrandCore({
    ...proposal,
    status: GOVERNED_DOCUMENT_STATUS.APPROVED,
    approval: {
      approved_by: requiredString(approvedBy, 'approvedBy'),
      approved_at: isoDate(approvedAt, 'approvedAt'),
      note: optionalString(note, 'note'),
    },
  });
}

export function proposeBrandCoreRevision({
  approvedCore,
  snapshot,
  id,
  createdAt,
  changes = {},
} = {}) {
  if (!approvedCore) throw new TypeError('approvedCore is required');
  if (approvedCore.status !== GOVERNED_DOCUMENT_STATUS.APPROVED) {
    throw new Error('CORE_REVISION_REQUIRES_APPROVED_CORE');
  }
  assertSnapshotReady(snapshot, approvedCore.merchant_id);
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
    merchantId: approvedCore.merchant_id,
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
