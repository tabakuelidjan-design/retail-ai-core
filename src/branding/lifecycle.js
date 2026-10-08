import {
  GOVERNED_DOCUMENT_STATUS,
  SNAPSHOT_STATUS,
} from './constants.js';

const SNAPSHOT_TRANSITIONS = Object.freeze({
  [SNAPSHOT_STATUS.DRAFT]: new Set([SNAPSHOT_STATUS.READY]),
  [SNAPSHOT_STATUS.READY]: new Set([SNAPSHOT_STATUS.STALE, SNAPSHOT_STATUS.SUPERSEDED]),
  [SNAPSHOT_STATUS.STALE]: new Set([SNAPSHOT_STATUS.SUPERSEDED]),
  [SNAPSHOT_STATUS.SUPERSEDED]: new Set(),
});

const GOVERNED_TRANSITIONS = Object.freeze({
  [GOVERNED_DOCUMENT_STATUS.DRAFT]: new Set([GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED]),
  [GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED]: new Set([
    GOVERNED_DOCUMENT_STATUS.DRAFT,
    GOVERNED_DOCUMENT_STATUS.APPROVED,
  ]),
  [GOVERNED_DOCUMENT_STATUS.APPROVED]: new Set([GOVERNED_DOCUMENT_STATUS.SUPERSEDED]),
  [GOVERNED_DOCUMENT_STATUS.SUPERSEDED]: new Set(),
});

export function allowedBrandStatusTransition(kind, from, to) {
  const transitions = kind === 'SNAPSHOT' ? SNAPSHOT_TRANSITIONS : GOVERNED_TRANSITIONS;
  return transitions[from]?.has(to) === true;
}

export function assertBrandStatusTransition(kind, from, to) {
  if (!allowedBrandStatusTransition(kind, from, to)) {
    throw new Error(`invalid ${kind} status transition: ${from} -> ${to}`);
  }
  return true;
}
