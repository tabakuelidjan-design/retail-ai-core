import { createHash } from 'node:crypto';
import { DECISION_EVENT_TYPE } from './constants.js';
import {
  assertObject,
  enumValue,
  integerVersion,
  isoDate,
  optionalString,
  requiredString,
} from './validation.js';

// Minimal decision event, shaped so it can later be mapped 1:1 onto the Socle Decision Ledger
// (NDR-001/010). This module only BUILDS the event: persisting it is the Socle's job, and
// no second approval system lives in Branding.

const stable = (value) => {
  if (value == null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
};

export function buildBrandDecisionEvent({
  type,
  merchantId,
  actor,
  subject,
  decidedAt,
  note = null,
  supersedes = null,
} = {}) {
  assertObject(actor, 'actor');
  assertObject(subject, 'subject');
  const body = {
    type: enumValue(type, DECISION_EVENT_TYPE, 'type'),
    merchant_id: requiredString(merchantId, 'merchantId'),
    actor: {
      user_id: requiredString(actor.user_id, 'actor.user_id'),
      role: requiredString(actor.role, 'actor.role'),
    },
    subject: {
      kind: requiredString(subject.kind, 'subject.kind'),
      id: requiredString(subject.id, 'subject.id'),
      version: integerVersion(subject.version, 'subject.version'),
    },
    decided_at: isoDate(decidedAt, 'decidedAt'),
    note: optionalString(note, 'note'),
    supersedes: supersedes == null ? null : {
      kind: requiredString(supersedes.kind, 'supersedes.kind'),
      id: requiredString(supersedes.id, 'supersedes.id'),
      version: integerVersion(supersedes.version, 'supersedes.version'),
    },
  };
  // Deterministic id: replaying the same decision yields the same event (idempotent persistence).
  const id = `bde_${createHash('sha256').update(stable(body)).digest('hex').slice(0, 32)}`;
  return Object.freeze({ id, ...body });
}
