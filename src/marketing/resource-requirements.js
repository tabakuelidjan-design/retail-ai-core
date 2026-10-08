// ResourceRequirements, estimated lead time and valid execution window.
//
// Marketing DECLARES what a Push would consume; it never concludes that the resource is available. It computes no cash
// available, no acceptable CAC, no maximum spend, no profit (Finance), no stock or capacity verdict (Inventory / Operations).
// A material number needs a basis (closed list, no model guess) and, when the basis points at a source, an evidence ref.

import { MKT_ERROR as E } from './understand-constants.js';
import {
  LEAD_TIME_FIT, LEAD_TIME_MS, LEAD_TIME_UNIT, M2_ERROR as X,
} from './m2-constants.js';
import { nonNegativeNumber, numberBasis } from './m2-validation.js';
import {
  asOfValue, closedObject, deepFreeze, enumValue, fail, isoTimestamp, pattern, refList, toMs,
} from './understand-validation.js';

const RESOURCE_KEYS = [
  'cash', 'human_time', 'operational_capacity_refs', 'inventory_requirement_refs', 'creative_capacity_refs',
  'contact_capacity_refs', 'other_resource_refs',
];
const CASH_KEYS = ['currency', 'min', 'max', 'basis', 'evidence_refs'];
const HUMAN_TIME_KEYS = ['min_minutes', 'max_minutes', 'basis', 'evidence_refs'];
const LEAD_TIME_KEYS = ['value', 'unit', 'basis', 'evidence_refs'];
const WINDOW_KEYS = ['start', 'end'];
const CURRENCY = /^[A-Z]{3}$/;
const MAX_LEAD_TIME = 100_000;

function cash(input, field) {
  closedObject(input, CASH_KEYS, field);
  const min = nonNegativeNumber(input.min, `${field}.min`, { rangeCode: X.RESOURCE_INVALID_RANGE });
  const max = nonNegativeNumber(input.max, `${field}.max`, { rangeCode: X.RESOURCE_INVALID_RANGE });
  if (min > max) fail(X.RESOURCE_INVALID_RANGE, `${field}.min cannot exceed ${field}.max`, { field });
  return {
    currency: pattern(input.currency, `${field}.currency`, CURRENCY, { max: 3 }),
    min,
    max,
    ...numberBasis(input, field, X.RESOURCE_EVIDENCE_REQUIRED),
  };
}

function humanTime(input, field) {
  closedObject(input, HUMAN_TIME_KEYS, field);
  const min = nonNegativeNumber(input.min_minutes, `${field}.min_minutes`, { rangeCode: X.RESOURCE_INVALID_RANGE });
  const max = nonNegativeNumber(input.max_minutes, `${field}.max_minutes`, { rangeCode: X.RESOURCE_INVALID_RANGE });
  if (min > max) fail(X.RESOURCE_INVALID_RANGE, `${field}.min_minutes cannot exceed ${field}.max_minutes`, { field });
  return { min_minutes: min, max_minutes: max, ...numberBasis(input, field, X.RESOURCE_EVIDENCE_REQUIRED) };
}

/** An empty object is valid: a Push may declare nothing it consumes. Needs are opaque refs, never availability. */
export function buildResourceRequirements(input = {}) {
  closedObject(input, RESOURCE_KEYS, 'resource_requirements');
  return deepFreeze({
    cash: input.cash == null ? null : cash(input.cash, 'resource_requirements.cash'),
    human_time: input.human_time == null ? null : humanTime(input.human_time, 'resource_requirements.human_time'),
    operational_capacity_refs: refList(input.operational_capacity_refs, 'resource_requirements.operational_capacity_refs'),
    inventory_requirement_refs: refList(input.inventory_requirement_refs, 'resource_requirements.inventory_requirement_refs'),
    creative_capacity_refs: refList(input.creative_capacity_refs, 'resource_requirements.creative_capacity_refs'),
    contact_capacity_refs: refList(input.contact_capacity_refs, 'resource_requirements.contact_capacity_refs'),
    other_resource_refs: refList(input.other_resource_refs, 'resource_requirements.other_resource_refs'),
  });
}

export function buildEstimatedLeadTime(input) {
  closedObject(input, LEAD_TIME_KEYS, 'estimated_lead_time');
  return deepFreeze({
    value: nonNegativeNumber(input.value, 'estimated_lead_time.value', { max: MAX_LEAD_TIME, rangeCode: X.LEAD_TIME_INVALID_VALUE }),
    unit: enumValue(input.unit, LEAD_TIME_UNIT, 'estimated_lead_time.unit', X.LEAD_TIME_INVALID_UNIT),
    ...numberBasis(input, 'estimated_lead_time', X.RESOURCE_EVIDENCE_REQUIRED),
  });
}

export function buildExecutionWindow(input) {
  closedObject(input, WINDOW_KEYS, 'valid_execution_window');
  const start = isoTimestamp(input.start, 'valid_execution_window.start', X.EXECUTION_WINDOW_INVALID);
  const end = isoTimestamp(input.end, 'valid_execution_window.end', X.EXECUTION_WINDOW_INVALID);
  if (toMs(end) <= toMs(start)) fail(X.EXECUTION_WINDOW_INVALID, 'valid_execution_window.end must be after start');
  return deepFreeze({ start, end });
}

/**
 * Deterministic lead-time fit, with the clock passed explicitly:
 *   candidate_start = max(asOf, window.start)
 *   completion      = candidate_start + lead_time          (DAYS = 24 hours exactly; no business days)
 *   completion <= window.end  -> FIT,  otherwise NOT_FIT
 * The fractional millisecond of a fractional lead time is rounded UP so a completion is never optimistic.
 */
export function evaluateLeadTimeFit(leadTime, window, asOf) {
  const lead = buildEstimatedLeadTime(leadTime);
  const win = buildExecutionWindow(window);
  const asOfIso = asOfValue(asOf);
  const startMs = Math.max(toMs(asOfIso), toMs(win.start));
  const completionMs = startMs + Math.ceil(lead.value * LEAD_TIME_MS[lead.unit]);
  if (!Number.isFinite(completionMs) || Number.isNaN(new Date(completionMs).getTime())) fail(E.INVALID_FIELD, 'the completion date is out of range', { field: 'estimated_lead_time' });
  return deepFreeze({
    status: completionMs <= toMs(win.end) ? LEAD_TIME_FIT.FIT : LEAD_TIME_FIT.NOT_FIT,
    as_of: asOfIso,
    candidate_start: new Date(startMs).toISOString(),
    completion: new Date(completionMs).toISOString(),
  });
}
