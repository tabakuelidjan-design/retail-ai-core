import { DIMENSIONS, OUTCOME } from './dimensions.js';

// The owner's review is EVIDENCE, never an input of the critic and never a template: this module is not imported by the critic or the loop, and it is used only AFTER a critique
// exists, to record where the critic and the owner agree or disagree. The owner's status is set only by an owner-recorded record (recorded_by: 'owner'); no function of Nordla can
// produce OWNER_APPROVED / SHIPPABLE.

export const OWNER_STATUS = Object.freeze({ OWNER_REJECTED: 'OWNER_REJECTED', OWNER_APPROVED: 'OWNER_APPROVED', PENDING: 'PENDING' });
export const AGREEMENT = Object.freeze({ AGREE: 'AGREE', DISAGREE: 'DISAGREE', PARTIAL: 'PARTIAL', NOT_COMPARED: 'NOT_COMPARED' });
const OWNER_VIEWS = new Set(['FAIL', 'PASS', 'NOT_STATED']);

/** @param {object} record { kind: 'OWNER_REVIEW', candidate_sha256, status, recorded_by: 'owner', dimensions: [{ dimension, owner_view, note }] } */
export function assertOwnerReview(record) {
  if (record?.kind !== 'OWNER_REVIEW' || record.recorded_by !== 'owner') throw new TypeError('an owner review is a record made by the owner');
  if (!Object.values(OWNER_STATUS).includes(record.status)) throw new TypeError('unknown owner status');
  if (!/^[0-9a-f]{64}$/.test(record.candidate_sha256 ?? '')) throw new TypeError('an owner review is about one candidate (sha256)');
  const seen = new Set();
  for (const d of record.dimensions ?? []) {
    if (!DIMENSIONS.includes(d.dimension) || seen.has(d.dimension) || !OWNER_VIEWS.has(d.owner_view)) throw new TypeError('invalid owner dimension entry');
    seen.add(d.dimension);
  }
  return record;
}

/** Per-dimension comparison of the critic with the owner. Only dimensions the owner stated are compared. */
export function compareWithOwner({ critique, ownerReview }) {
  assertOwnerReview(ownerReview);
  if (ownerReview.candidate_sha256 !== critique.candidate_sha256) throw new Error('the owner review and the critique are not about the same candidate');
  const stated = new Map((ownerReview.dimensions ?? []).map((d) => [d.dimension, d]));
  const rows = critique.dimensions.map((c) => {
    const o = stated.get(c.dimension);
    if (!o || o.owner_view === 'NOT_STATED') return { dimension: c.dimension, critic: c.outcome, owner: 'NOT_STATED', agreement: AGREEMENT.NOT_COMPARED };
    let agreement;
    if (c.outcome === OUTCOME.NOT_MEASURABLE) agreement = AGREEMENT.NOT_COMPARED;
    else if (c.outcome === o.owner_view) agreement = AGREEMENT.AGREE;
    else if (c.outcome === OUTCOME.REVIEW_REQUIRED) agreement = AGREEMENT.PARTIAL;
    else agreement = AGREEMENT.DISAGREE;
    return { dimension: c.dimension, critic: c.outcome, owner: o.owner_view, agreement };
  });
  const count = (a) => rows.filter((r) => r.agreement === a).length;
  return Object.freeze({
    rows: Object.freeze(rows),
    agree: count(AGREEMENT.AGREE), partial: count(AGREEMENT.PARTIAL), disagree: count(AGREEMENT.DISAGREE), not_compared: count(AGREEMENT.NOT_COMPARED),
    owner_status: ownerReview.status, // copied from the owner's own record, never derived
  });
}
