// Small shared helpers for the M2 contracts (the generic ones live in understand-validation.js, reused as-is).

import { MKT_ERROR as E } from './understand-constants.js';
import { NUMBER_BASIS, SOURCED_BASES, M2_ERROR } from './m2-constants.js';
import { enumValue, fail, refList } from './understand-validation.js';

const MAX_AMOUNT = 1e12;

/** A finite, non-negative number (never a numeric string). rangeCode is the stable code for a negative or out-of-range value. */
export function nonNegativeNumber(value, field, { max = MAX_AMOUNT, rangeCode }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(E.INVALID_FIELD, `${field} must be a finite number`, { field });
  if (value < 0 || value > max) fail(rangeCode, `${field} is out of range`, { field });
  return value;
}

/**
 * A material number must say where it comes from. The basis is a closed list without any model-guess value, and a basis
 * that points at a source (domain fact, calculation, quote) needs at least one evidence ref.
 */
export function numberBasis(input, field, evidenceCode) {
  const basis = enumValue(input.basis, NUMBER_BASIS, `${field}.basis`, M2_ERROR.INVALID_BASIS);
  const evidenceRefs = refList(input.evidence_refs, `${field}.evidence_refs`);
  if (SOURCED_BASES.includes(basis) && !evidenceRefs.length) {
    fail(evidenceCode, `${field} uses ${basis} and needs at least one evidence_ref`, { field });
  }
  return { basis, evidence_refs: evidenceRefs };
}

// Key-sorted JSON, so two equal contracts compare equal whatever the key order they were stored with.
export const canonical = (value) => {
  if (value == null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
};
