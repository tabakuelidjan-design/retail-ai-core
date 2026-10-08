import {
  BRAND_RULE_TYPE,
  DISTINCTIVE_ASSET_TYPE,
  CLAIM_KIND,
  EVIDENCE_COMPLETENESS,
  EVIDENCE_PROVENANCE,
  FACT_SUPPORTING_PROVENANCE,
  GOVERNED_DOCUMENT_STATUS,
  RULE_ENFORCEMENT,
  RULE_OPERATOR,
  RULE_SEVERITY,
  SNAPSHOT_REFRESH_TRIGGER,
  SNAPSHOT_SOURCE_KIND,
  SNAPSHOT_STATUS,
} from './constants.js';
import {
  approval,
  assertObject,
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

function commonDocument(input, kind, allowedStatuses) {
  assertObject(input, kind);
  const status = requiredString(input.status, `${kind}.status`);
  if (!allowedStatuses.includes(status)) {
    throw new TypeError(`unsupported ${kind}.status: ${status}`);
  }
  return {
    id: requiredString(input.id, `${kind}.id`),
    merchant_id: merchantIdValue(input.merchant_id, `${kind}.merchant_id`),
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

function normalizeHardRule(input, field) {
  assertObject(input, field);
  const constraint = input.constraint ?? {};
  assertObject(constraint, `${field}.constraint`);

  return Object.freeze({
    id: requiredString(input.id, `${field}.id`),
    rule_type: enumValue(input.rule_type, BRAND_RULE_TYPE, `${field}.rule_type`),
    subject: requiredString(input.subject, `${field}.subject`),
    enforcement: enumValue(input.enforcement, RULE_ENFORCEMENT, `${field}.enforcement`),
    severity: enumValue(input.severity, RULE_SEVERITY, `${field}.severity`),
    constraint: Object.freeze({
      operator: enumValue(constraint.operator, RULE_OPERATOR, `${field}.constraint.operator`),
      value: jsonValue(constraint.value, `${field}.constraint.value`),
    }),
    scope: optionalString(input.scope, `${field}.scope`) ?? 'GLOBAL',
    source_ref: optionalString(input.source_ref, `${field}.source_ref`),
  });
}

export function normalizeBrandMemory(input) {
  const base = commonDocument(input, 'memory', governedStatuses);
  assertObject(input.core_ref, 'memory.core_ref');
  const hardRules = objectList(input.hard_rules, 'memory.hard_rules', normalizeHardRule);
  uniqueIds(hardRules, 'memory.hard_rules');

  return Object.freeze({
    ...base,
    core_ref: Object.freeze({
      id: requiredString(input.core_ref.id, 'memory.core_ref.id'),
      version: integerVersion(input.core_ref.version, 'memory.core_ref.version'),
    }),
    hard_rules: hardRules,
    design_tokens: Object.freeze(jsonValue(input.design_tokens ?? {}, 'memory.design_tokens')),
    semantic_context: Object.freeze(jsonValue(input.semantic_context ?? {}, 'memory.semantic_context')),
    asset_refs: stringList(input.asset_refs, 'memory.asset_refs'),
    production_asset_refs: stringList(
      input.production_asset_refs,
      'memory.production_asset_refs',
    ),
    approval: approval(input.approval, 'memory.approval'),
  });
}

const hasOwnKeys = (value) => value && typeof value === 'object' && Object.keys(value).length > 0;

export function validateMemoryForApproval(memory, { core = null } = {}) {
  const reasons = [];

  if (memory.status === GOVERNED_DOCUMENT_STATUS.APPROVED && !memory.approval) {
    reasons.push('APPROVAL_RECORD_REQUIRED');
  }

  const hasContent = (
    memory.hard_rules.length > 0
    || memory.asset_refs.length > 0
    || memory.production_asset_refs.length > 0
    || hasOwnKeys(memory.design_tokens)
    || hasOwnKeys(memory.semantic_context)
  );
  if (!hasContent) reasons.push('BRAND_MEMORY_EMPTY');

  if (!core) {
    reasons.push('APPROVED_CORE_REQUIRED');
  } else {
    if (core.status !== GOVERNED_DOCUMENT_STATUS.APPROVED) {
      reasons.push('CORE_NOT_APPROVED');
    }
    if (core.merchant_id !== memory.merchant_id) {
      reasons.push('CORE_MEMORY_MERCHANT_MISMATCH');
    }
    if (memory.core_ref.id !== core.id || memory.core_ref.version !== core.version) {
      reasons.push('CORE_REFERENCE_MISMATCH');
    }
  }

  return validationResult(reasons);
}
