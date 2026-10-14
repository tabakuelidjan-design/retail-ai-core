import { CONFIDENCE, FACT_QUALITY, SUBJECT_KIND, SUBJECT_STATUS } from './constants.js';
import { SocleError, clone, deepFreeze, hashId, isNum, nonEmpty, oneOf, toIso } from './util.js';

function normalizeFacts(facts) {
  if (!Array.isArray(facts)) throw new SocleError('INVALID_FIELD', 'facts must be an array');
  return facts.map((f) => ({
    key: nonEmpty(f.key, 'fact.key'),
    value: f.value === undefined ? null : f.value,
    unit: f.unit ?? null,
    quality: f.quality ? oneOf(f.quality, FACT_QUALITY, 'fact.quality') : FACT_QUALITY.OK,
    source_ref: f.source_ref ?? null,
  }));
}

function normalizeMissing(list) {
  if (!Array.isArray(list)) throw new SocleError('INVALID_FIELD', 'missing_data must be an array');
  return list.map((m) => ({ field: nonEmpty(m.field, 'missing_data.field'), reason: m.reason ?? '', blocking: m.blocking === true }));
}

// A Subject is "something that may deserve a decision". Immutable value object.
export function createSubject(input) {
  const merchant_id = nonEmpty(input.merchant_id, 'merchant_id');
  const type = nonEmpty(input.type, 'type');
  const key = input.key ? nonEmpty(input.key, 'key') : type;
  if (!isNum(input.materiality) || input.materiality < 0) {
    throw new SocleError('INVALID_FIELD', 'materiality must be a finite number >= 0 (amount at stake)');
  }
  const currency = nonEmpty(input.currency, 'currency');
  if (!/^[A-Z]{3}$/.test(currency)) throw new SocleError('INVALID_FIELD', 'currency must be an ISO 4217 code');
  const detected_at = toIso(input.detected_at, 'detected_at');
  const subject = {
    id: input.id ? nonEmpty(input.id, 'id') : hashId('subj', merchant_id, key, detected_at),
    merchant_id,
    type,
    key, // stable identity across re-detections (used by cooldown)
    kind: oneOf(input.kind, SUBJECT_KIND, 'kind'),
    title: nonEmpty(input.title, 'title'),
    summary: input.summary ?? '',
    status: input.status ? oneOf(input.status, SUBJECT_STATUS, 'status') : SUBJECT_STATUS.TO_VERIFY,
    materiality: input.materiality,
    currency,
    confidence: input.confidence ? oneOf(input.confidence, CONFIDENCE, 'confidence') : CONFIDENCE.MEDIUM,
    detected_at,
    review_at: input.review_at ? toIso(input.review_at, 'review_at') : null,
    facts: normalizeFacts(input.facts ?? []),
    missing_data: normalizeMissing(input.missing_data ?? []),
    source_refs: Array.isArray(input.source_refs) ? input.source_refs.map(String) : [],
    triage: null,
    dismissal: null,
  };
  return deepFreeze(subject);
}

export const getFact = (subject, key) => subject.facts.find((f) => f.key === key) ?? null;
export const factNumber = (subject, key) => {
  const f = getFact(subject, key);
  return f && isNum(f.value) ? f.value : null;
};

const TRANSITIONS = {
  [SUBJECT_STATUS.TO_VERIFY]: [SUBJECT_STATUS.TO_DECIDE, SUBJECT_STATUS.DISMISSED],
  [SUBJECT_STATUS.TO_DECIDE]: [SUBJECT_STATUS.TO_VERIFY, SUBJECT_STATUS.IN_PROGRESS, SUBJECT_STATUS.DISMISSED],
  [SUBJECT_STATUS.IN_PROGRESS]: [SUBJECT_STATUS.RESULT],
  [SUBJECT_STATUS.RESULT]: [],
  [SUBJECT_STATUS.DISMISSED]: [],
};

export function transitionSubject(subject, next, extra = {}) {
  if (!TRANSITIONS[subject.status].includes(next)) {
    throw new SocleError('INVALID_TRANSITION', `${subject.status} -> ${next} is not allowed`);
  }
  return deepFreeze({ ...clone(subject), status: next, ...extra });
}

// Data Quality First: a suspect fact or a blocking gap sends the Subject to
// TO_VERIFY. It only becomes TO_DECIDE when the data can support a decision.
export function triageSubject(subject) {
  if (![SUBJECT_STATUS.TO_VERIFY, SUBJECT_STATUS.TO_DECIDE].includes(subject.status)) return subject;
  const reasons = [
    ...subject.facts.filter((f) => f.quality === FACT_QUALITY.SUSPECT).map((f) => `SUSPECT_FACT:${f.key}`),
    ...subject.missing_data.filter((m) => m.blocking).map((m) => `BLOCKING_MISSING_DATA:${m.field}`),
  ];
  const status = reasons.length > 0 ? SUBJECT_STATUS.TO_VERIFY : SUBJECT_STATUS.TO_DECIDE;
  return deepFreeze({ ...clone(subject), status, triage: { reasons } });
}
