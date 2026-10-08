import {
  DISTINCTIVE_ASSET_TYPE,
  CLAIM_KIND,
  EVIDENCE_COMPLETENESS,
  EVIDENCE_PROVENANCE,
  FACT_SUPPORTING_PROVENANCE,
  GOVERNED_DOCUMENT_STATUS,
  SNAPSHOT_REFRESH_TRIGGER,
  SNAPSHOT_SOURCE_KIND,
  SNAPSHOT_STATUS,
} from './constants.js';
import {
  approval,
  assertObject,
  brandIdValue,
  enumValue,
  integerVersion,
  isoDate,
  jsonValue,
  merchantIdValue,
  objectList,
  optionalString,
  requiredString,
  stringList,
  uniqueIds,
  validationResult,
} from './validation.js';

const governedStatuses = Object.values(GOVERNED_DOCUMENT_STATUS);

export function commonDocument(input, kind, allowedStatuses) {
  assertObject(input, kind);
  const status = requiredString(input.status, `${kind}.status`);
  if (!allowedStatuses.includes(status)) {
    throw new TypeError(`unsupported ${kind}.status: ${status}`);
  }
  const merchantId = merchantIdValue(input.merchant_id, `${kind}.merchant_id`);
  const brandId = brandIdValue(input.brand_id, `${kind}.brand_id`);
  if (brandId === merchantId) throw new TypeError(`${kind}.brand_id must be distinct from ${kind}.merchant_id`);
  return {
    id: requiredString(input.id, `${kind}.id`),
    merchant_id: merchantId,
    brand_id: brandId,
    version: integerVersion(input.version, `${kind}.version`),
    status,
    created_at: isoDate(input.created_at, `${kind}.created_at`),
    supersedes_id: optionalString(input.supersedes_id, `${kind}.supersedes_id`),
  };
}

export function normalizeEvidence(input, field = 'evidence') {
  assertObject(input, field);
  const source = input.source ?? {};
  assertObject(source, `${field}.source`);

  return Object.freeze({
    id: requiredString(input.id, `${field}.id`),
    provenance: enumValue(input.provenance, EVIDENCE_PROVENANCE, `${field}.provenance`),
    statement: requiredString(input.statement, `${field}.statement`),
    source: Object.freeze({
      system: requiredString(source.system, `${field}.source.system`),
      ref: optionalString(source.ref, `${field}.source.ref`),
      observed_at: isoDate(source.observed_at, `${field}.source.observed_at`),
      kind: source.kind == null
        ? null
        : enumValue(source.kind, SNAPSHOT_SOURCE_KIND, `${field}.source.kind`),
      subject_ref: optionalString(source.subject_ref, `${field}.source.subject_ref`),
    }),
    completeness: enumValue(
      input.completeness ?? EVIDENCE_COMPLETENESS.PARTIAL,
      EVIDENCE_COMPLETENESS,
      `${field}.completeness`,
    ),
    limitations: stringList(input.limitations, `${field}.limitations`),
  });
}

function normalizeFinding(input, field) {
  assertObject(input, field);
  return Object.freeze({
    id: requiredString(input.id, `${field}.id`),
    statement: requiredString(input.statement, `${field}.statement`),
    claim_kind: enumValue(input.claim_kind, CLAIM_KIND, `${field}.claim_kind`),
    evidence_refs: stringList(input.evidence_refs, `${field}.evidence_refs`),
  });
}

function normalizeRefreshTrigger(input, field) {
  assertObject(input, field);
  return Object.freeze({
    type: enumValue(input.type, SNAPSHOT_REFRESH_TRIGGER, `${field}.type`),
    occurred_at: isoDate(input.occurred_at, `${field}.occurred_at`),
    source_ref: optionalString(input.source_ref, `${field}.source_ref`),
  });
}

export function normalizeBrandSnapshot(input) {
  const base = commonDocument(input, 'snapshot', Object.values(SNAPSHOT_STATUS));
  const evidence = objectList(input.evidence, 'snapshot.evidence', normalizeEvidence);
  uniqueIds(evidence, 'snapshot.evidence');

  const groups = {};
  for (const key of [
    'positioning',
    'messages',
    'category',
    'competitors',
    'customer_expectations',
    'visible_assets',
    'contradictions',
    'evidence_gaps',
  ]) {
    groups[key] = objectList(input[key], `snapshot.${key}`, normalizeFinding);
    uniqueIds(groups[key], `snapshot.${key}`);
  }

  return Object.freeze({
    ...base,
    observed_at: isoDate(input.observed_at, 'snapshot.observed_at'),
    evidence,
    ...groups,
    refresh_triggers: objectList(
      input.refresh_triggers,
      'snapshot.refresh_triggers',
      normalizeRefreshTrigger,
    ),
  });
}

export function validateSnapshotReadiness(snapshot) {
  const reasons = [];
  if (snapshot.status === SNAPSHOT_STATUS.READY && snapshot.evidence.length === 0) {
    reasons.push('SNAPSHOT_READY_WITHOUT_EVIDENCE');
  }

  const evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]));
  for (const group of [
    snapshot.positioning,
    snapshot.messages,
    snapshot.category,
    snapshot.competitors,
    snapshot.customer_expectations,
    snapshot.visible_assets,
    snapshot.contradictions,
  ]) {
    for (const finding of group) {
      for (const ref of finding.evidence_refs) {
        if (!evidenceById.has(ref)) reasons.push('FINDING_REFERENCES_UNKNOWN_EVIDENCE');
      }
      if (finding.claim_kind === CLAIM_KIND.FACT) {
        const supported = finding.evidence_refs.some((ref) => (
          FACT_SUPPORTING_PROVENANCE.includes(evidenceById.get(ref)?.provenance)
        ));
        if (!supported) reasons.push('FACT_REQUIRES_OBSERVED_EVIDENCE');
      }
    }
  }
  return validationResult(reasons);
}

function normalizeDistinctiveAsset(input, field) {
  assertObject(input, field);
  return Object.freeze({
    id: requiredString(input.id, `${field}.id`),
    type: enumValue(input.type, DISTINCTIVE_ASSET_TYPE, `${field}.type`),
    description: requiredString(input.description, `${field}.description`),
    asset_ref: optionalString(input.asset_ref, `${field}.asset_ref`),
  });
}

export function normalizeBrandCore(input) {
  const base = commonDocument(input, 'core', governedStatuses);
  const distinctiveAssets = objectList(
    input.distinctive_assets,
    'core.distinctive_assets',
    normalizeDistinctiveAsset,
  );
  uniqueIds(distinctiveAssets, 'core.distinctive_assets');
  if (distinctiveAssets.length > 3) {
    throw new RangeError('core.distinctive_assets must contain at most 3 priority assets');
  }

  let snapshotRef = null;
  if (input.snapshot_ref != null) {
    assertObject(input.snapshot_ref, 'core.snapshot_ref');
    snapshotRef = Object.freeze({
      id: requiredString(input.snapshot_ref.id, 'core.snapshot_ref.id'),
      version: integerVersion(input.snapshot_ref.version, 'core.snapshot_ref.version'),
    });
  }

  return Object.freeze({
    ...base,
    snapshot_ref: snapshotRef,
    category: optionalString(input.category, 'core.category'),
    buying_contexts: stringList(input.buying_contexts, 'core.buying_contexts'),
    value_proposition: optionalString(input.value_proposition, 'core.value_proposition'),
    positioning: optionalString(input.positioning, 'core.positioning'),
    core_promise: optionalString(input.core_promise, 'core.core_promise'),
    reasons_to_believe: stringList(input.reasons_to_believe, 'core.reasons_to_believe'),
    personality: stringList(input.personality, 'core.personality'),
    voice: Object.freeze({
      traits: stringList(input.voice?.traits, 'core.voice.traits'),
      do: stringList(input.voice?.do, 'core.voice.do'),
      dont: stringList(input.voice?.dont, 'core.voice.dont'),
    }),
    exclusions: stringList(input.exclusions, 'core.exclusions'),
    distinctive_assets: distinctiveAssets,
    evidence_refs: stringList(input.evidence_refs, 'core.evidence_refs'),
    approval: approval(input.approval, 'core.approval'),
  });
}

export function validateCoreForApproval(core) {
  const reasons = [];
  if (!core.category) reasons.push('CATEGORY_REQUIRED');
  if (core.buying_contexts.length === 0) reasons.push('BUYING_CONTEXT_REQUIRED');
  if (!core.value_proposition) reasons.push('VALUE_PROPOSITION_REQUIRED');
  if (!core.positioning) reasons.push('POSITIONING_REQUIRED');
  if (!core.core_promise) reasons.push('CORE_PROMISE_REQUIRED');
  if (core.reasons_to_believe.length === 0) reasons.push('REASON_TO_BELIEVE_REQUIRED');
  if (core.exclusions.length === 0) reasons.push('CONCRETE_EXCLUSION_REQUIRED');
  if (core.status === GOVERNED_DOCUMENT_STATUS.APPROVED && !core.approval) {
    reasons.push('APPROVAL_RECORD_REQUIRED');
  }
  return validationResult(reasons);
}
