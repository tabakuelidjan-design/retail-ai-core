import {
  EVIDENCE_KIND,
  SNAPSHOT_CONTRADICTION_KIND,
  SNAPSHOT_COVERAGE_STATUS,
  SNAPSHOT_RESEARCH_QUESTION,
  SNAPSHOT_REFRESH_TRIGGER,
  SNAPSHOT_SOURCE_KIND,
  SNAPSHOT_STATUS,
  SNAPSHOT_TOPIC,
} from './constants.js';
import {
  normalizeBrandSnapshot,
  normalizeEvidence,
  validateSnapshotReadiness,
} from './contracts.js';
import {
  assertObject,
  enumValue,
  isoDate,
  jsonValue,
  objectList,
  optionalString,
  requiredString,
  stringList,
  uniqueIds,
} from './validation.js';

export const MAX_DIRECT_COMPETITORS_V1 = 3;

export const DEFAULT_SNAPSHOT_RESEARCH_QUESTIONS = Object.freeze([
  SNAPSHOT_RESEARCH_QUESTION.WHO_COMPETES,
  SNAPSHOT_RESEARCH_QUESTION.HOW_COMPETITORS_POSITION,
  SNAPSHOT_RESEARCH_QUESTION.WHAT_CUSTOMERS_VALUE_OR_REJECT,
  SNAPSHOT_RESEARCH_QUESTION.WHAT_CHALLENGES_CURRENT_BRAND,
]);

export const DEFAULT_SNAPSHOT_SOURCE_KINDS = Object.freeze([
  SNAPSHOT_SOURCE_KIND.MERCHANT_PROVIDED,
  SNAPSHOT_SOURCE_KIND.OWNED_SURFACE,
  SNAPSHOT_SOURCE_KIND.INTERNAL_FACT,
  SNAPSHOT_SOURCE_KIND.CUSTOMER_REVIEW,
  SNAPSHOT_SOURCE_KIND.DIRECT_COMPETITOR,
  SNAPSHOT_SOURCE_KIND.PUBLIC_REFERENCE,
]);

const QUESTION_TOPICS = Object.freeze({
  [SNAPSHOT_RESEARCH_QUESTION.WHO_COMPETES]: [
    SNAPSHOT_TOPIC.COMPETITOR,
  ],
  [SNAPSHOT_RESEARCH_QUESTION.HOW_COMPETITORS_POSITION]: [
    SNAPSHOT_TOPIC.COMPETITOR_POSITIONING,
  ],
  [SNAPSHOT_RESEARCH_QUESTION.WHAT_CUSTOMERS_VALUE_OR_REJECT]: [
    SNAPSHOT_TOPIC.CUSTOMER_EXPECTATION,
  ],
  [SNAPSHOT_RESEARCH_QUESTION.WHAT_CHALLENGES_CURRENT_BRAND]: [
    SNAPSHOT_TOPIC.CORE_CHALLENGE,
  ],
});

const TOPIC_TO_GROUP = Object.freeze({
  [SNAPSHOT_TOPIC.CATEGORY]: 'category',
  [SNAPSHOT_TOPIC.POSITIONING]: 'positioning',
  [SNAPSHOT_TOPIC.MESSAGE]: 'messages',
  [SNAPSHOT_TOPIC.COMPETITOR]: 'competitors',
  [SNAPSHOT_TOPIC.COMPETITOR_POSITIONING]: 'competitors',
  [SNAPSHOT_TOPIC.CUSTOMER_EXPECTATION]: 'customer_expectations',
  [SNAPSHOT_TOPIC.VISIBLE_ASSET]: 'visible_assets',
  [SNAPSHOT_TOPIC.CORE_CHALLENGE]: 'contradictions',
});

function normalizeCompetitor(input, field) {
  if (typeof input === 'string') {
    return Object.freeze({ id: requiredString(input, field), label: null });
  }
  assertObject(input, field);
  return Object.freeze({
    id: requiredString(input.id, `${field}.id`),
    label: optionalString(input.label, `${field}.label`),
  });
}

export function buildSnapshotResearchPlan({
  merchantId,
  directCompetitors = [],
  questions = DEFAULT_SNAPSHOT_RESEARCH_QUESTIONS,
  sourceKinds = DEFAULT_SNAPSHOT_SOURCE_KINDS,
} = {}) {
  const competitors = objectList(
    directCompetitors,
    'directCompetitors',
    normalizeCompetitor,
  );
  uniqueIds(competitors, 'directCompetitors');
  if (competitors.length > MAX_DIRECT_COMPETITORS_V1) {
    throw new RangeError(
      `Brand Snapshot V1 supports at most ${MAX_DIRECT_COMPETITORS_V1} direct competitors`,
    );
  }

  const normalizedQuestions = [...new Set(
    questions.map((value) => enumValue(
      value,
      SNAPSHOT_RESEARCH_QUESTION,
      'research question',
    )),
  )];
  const normalizedSources = [...new Set(
    sourceKinds.map((value) => enumValue(
      value,
      SNAPSHOT_SOURCE_KIND,
      'source kind',
    )),
  )];

  return Object.freeze({
    merchant_id: requiredString(merchantId, 'merchantId'),
    max_direct_competitors: MAX_DIRECT_COMPETITORS_V1,
    direct_competitors: Object.freeze(competitors),
    questions: Object.freeze(normalizedQuestions),
    allowed_source_kinds: Object.freeze(normalizedSources),
    continuous_crawling: false,
    purpose: 'DECISION_RELEVANT_BRAND_OBSERVATION_ONLY',
  });
}

export function normalizeSnapshotClaim(input, field = 'claim') {
  assertObject(input, field);
  return Object.freeze({
    id: requiredString(input.id, `${field}.id`),
    topic: enumValue(input.topic, SNAPSHOT_TOPIC, `${field}.topic`),
    subject: requiredString(input.subject, `${field}.subject`),
    attribute: requiredString(input.attribute, `${field}.attribute`),
    value: jsonValue(input.value, `${field}.value`),
    statement: requiredString(input.statement, `${field}.statement`),
    evidence_kind: enumValue(
      input.evidence_kind,
      EVIDENCE_KIND,
      `${field}.evidence_kind`,
    ),
    evidence_refs: stringList(input.evidence_refs, `${field}.evidence_refs`),
  });
}

function normalizeSnapshotEvidence(input, field) {
  const evidence = normalizeEvidence(input, field);
  if (!evidence.source.kind) {
    throw new Error(`${field}.source.kind is required for Brand Snapshot V1`);
  }
  return evidence;
}

export function validateEvidenceAgainstResearchPlan(evidence, plan) {
  const reasons = [];
  const allowedKinds = new Set(plan.allowed_source_kinds);
  const competitors = new Set(plan.direct_competitors.map((item) => item.id));

  for (const item of evidence) {
    if (!allowedKinds.has(item.source.kind)) {
      reasons.push('SOURCE_KIND_OUTSIDE_RESEARCH_PLAN');
    }
    if (item.source.kind === SNAPSHOT_SOURCE_KIND.DIRECT_COMPETITOR) {
      if (!item.source.subject_ref) {
        reasons.push('DIRECT_COMPETITOR_SOURCE_MISSING_SUBJECT_REF');
      } else if (!competitors.has(item.source.subject_ref)) {
        reasons.push('DIRECT_COMPETITOR_OUTSIDE_RESEARCH_PLAN');
      }
    }
  }

  return Object.freeze({
    ok: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableValue(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function detectSnapshotContradictions(claims = []) {
  const grouped = new Map();

  for (const raw of claims) {
    const claim = normalizeSnapshotClaim(raw);
    if (claim.evidence_kind === EVIDENCE_KIND.HYPOTHESIS) continue;
    const key = `${claim.topic}\u0000${claim.subject}\u0000${claim.attribute}`;
    const list = grouped.get(key) ?? [];
    list.push(claim);
    grouped.set(key, list);
  }

  const out = [];
  for (const [key, group] of grouped.entries()) {
    const values = new Map();
    for (const claim of group) {
      const canonical = stableValue(claim.value);
      if (!values.has(canonical)) values.set(canonical, []);
      values.get(canonical).push(claim);
    }
    if (values.size < 2) continue;

    const kinds = new Set(group.map((claim) => claim.evidence_kind));
    let contradictionKind = SNAPSHOT_CONTRADICTION_KIND.INFERENCE_INFERENCE;
    if (
      kinds.has(EVIDENCE_KIND.FACT)
      && group.filter((claim) => claim.evidence_kind === EVIDENCE_KIND.FACT)
        .map((claim) => stableValue(claim.value))
        .filter((value, index, all) => all.indexOf(value) === index)
        .length > 1
    ) {
      contradictionKind = SNAPSHOT_CONTRADICTION_KIND.FACT_FACT;
    } else if (kinds.has(EVIDENCE_KIND.FACT)) {
      contradictionKind = SNAPSHOT_CONTRADICTION_KIND.FACT_INFERENCE;
    }

    out.push(Object.freeze({
      id: `contradiction-${out.length + 1}`,
      key,
      kind: contradictionKind,
      claim_ids: Object.freeze(group.map((claim) => claim.id)),
      evidence_refs: Object.freeze([
        ...new Set(group.flatMap((claim) => claim.evidence_refs)),
      ]),
      statement: `Conflicting observed brand claims for ${group[0].subject} / ${group[0].attribute}`,
    }));
  }

  return Object.freeze(out);
}

export function assessSnapshotCoverage(plan, claims = [], contradictions = []) {
  const normalizedClaims = claims.map((claim) => normalizeSnapshotClaim(claim));
  const answered = [];
  const missing = [];

  for (const question of plan.questions) {
    const topics = QUESTION_TOPICS[question] ?? [];
    const hasClaim = normalizedClaims.some(
      (claim) => topics.includes(claim.topic)
        && claim.evidence_kind !== EVIDENCE_KIND.HYPOTHESIS,
    );
    const hasDetectedChallenge = (
      question === SNAPSHOT_RESEARCH_QUESTION.WHAT_CHALLENGES_CURRENT_BRAND
      && contradictions.length > 0
    );

    if (hasClaim || hasDetectedChallenge) answered.push(question);
    else missing.push(question);
  }

  const status = answered.length === 0
    ? SNAPSHOT_COVERAGE_STATUS.UNAVAILABLE
    : missing.length
      ? SNAPSHOT_COVERAGE_STATUS.PARTIAL
      : SNAPSHOT_COVERAGE_STATUS.COMPLETE;

  return Object.freeze({
    status,
    answered_questions: Object.freeze(answered),
    missing_questions: Object.freeze(missing),
  });
}

function findingFromClaim(claim) {
  return Object.freeze({
    id: claim.id,
    statement: claim.statement,
    evidence_kind: claim.evidence_kind,
    evidence_refs: claim.evidence_refs,
  });
}

export function buildBrandSnapshotV1({
  id,
  merchantId,
  version = 1,
  status = SNAPSHOT_STATUS.READY,
  createdAt,
  observedAt,
  researchPlan,
  evidence = [],
  claims = [],
  refreshTriggers = [],
  supersedesId = null,
} = {}) {
  if (!researchPlan) throw new TypeError('researchPlan is required');
  if (researchPlan.merchant_id !== merchantId) {
    throw new Error('SNAPSHOT_RESEARCH_PLAN_MERCHANT_MISMATCH');
  }

  const normalizedEvidence = objectList(
    evidence,
    'snapshot.evidence',
    normalizeSnapshotEvidence,
  );
  uniqueIds(normalizedEvidence, 'snapshot.evidence');

  const planValidation = validateEvidenceAgainstResearchPlan(
    normalizedEvidence,
    researchPlan,
  );
  if (!planValidation.ok) {
    throw new Error(planValidation.reasons.join(', '));
  }

  const normalizedClaims = objectList(
    claims,
    'snapshot.claims',
    normalizeSnapshotClaim,
  );
  uniqueIds(normalizedClaims, 'snapshot.claims');

  const evidenceIds = new Set(normalizedEvidence.map((item) => item.id));
  for (const claim of normalizedClaims) {
    if (claim.evidence_kind === EVIDENCE_KIND.FACT && claim.evidence_refs.length === 0) {
      throw new Error('FACT_WITHOUT_EVIDENCE_REFERENCE');
    }
    for (const ref of claim.evidence_refs) {
      if (!evidenceIds.has(ref)) throw new Error('CLAIM_REFERENCES_UNKNOWN_EVIDENCE');
    }
  }

  const contradictions = detectSnapshotContradictions(normalizedClaims);
  const coverage = assessSnapshotCoverage(
    researchPlan,
    normalizedClaims,
    contradictions,
  );

  const groups = {
    positioning: [],
    messages: [],
    category: [],
    competitors: [],
    customer_expectations: [],
    visible_assets: [],
    contradictions: [],
    evidence_gaps: [],
  };

  for (const claim of normalizedClaims) {
    const group = TOPIC_TO_GROUP[claim.topic];
    if (group) groups[group].push(findingFromClaim(claim));
  }

  for (const contradiction of contradictions) {
    groups.contradictions.push({
      id: contradiction.id,
      statement: contradiction.statement,
      evidence_kind: EVIDENCE_KIND.INFERENCE,
      evidence_refs: contradiction.evidence_refs,
    });
  }

  coverage.missing_questions.forEach((question, index) => {
    groups.evidence_gaps.push({
      id: `evidence-gap-${index + 1}`,
      statement: `Insufficient evidence for research question: ${question}`,
      evidence_kind: EVIDENCE_KIND.HYPOTHESIS,
      evidence_refs: [],
    });
  });

  const snapshot = normalizeBrandSnapshot({
    id,
    merchant_id: merchantId,
    version,
    status,
    created_at: createdAt,
    observed_at: observedAt,
    supersedes_id: supersedesId,
    evidence: normalizedEvidence,
    ...groups,
    refresh_triggers: refreshTriggers,
  });

  const readiness = validateSnapshotReadiness(snapshot);

  return Object.freeze({
    snapshot,
    research: Object.freeze({
      plan: researchPlan,
      coverage,
      contradictions,
      readiness,
    }),
  });
}

export function evaluateSnapshotRefresh({ snapshot, events = [] } = {}) {
  if (!snapshot) throw new TypeError('snapshot is required');
  const observedAt = new Date(snapshot.observed_at).getTime();

  const material = objectList(events, 'events', (input, field) => {
    assertObject(input, field);
    return Object.freeze({
      type: enumValue(input.type, SNAPSHOT_REFRESH_TRIGGER, `${field}.type`),
      occurred_at: isoDate(input.occurred_at, `${field}.occurred_at`),
      source_ref: optionalString(input.source_ref, `${field}.source_ref`),
    });
  }).filter((event) => new Date(event.occurred_at).getTime() > observedAt);

  return Object.freeze({
    refresh_required: material.length > 0,
    next_snapshot_status: material.length > 0
      ? SNAPSHOT_STATUS.STALE
      : snapshot.status,
    triggers: Object.freeze(material),
    core_update: null,
    policy_note: 'SNAPSHOT_REFRESH_NEVER_REWRITES_BRAND_CORE_AUTOMATICALLY',
  });
}
