import {
  BRAND_RULE_TYPE as T,
  RULE_OPERATOR as O,
  RULE_SCOPE,
  RULE_SEVERITY,
} from './constants.js';
import {
  assertObject,
  enumValue,
  requiredString,
} from './validation.js';
import { FIDELITY_GATE_OUTCOME } from '../creative-fidelity/constants.js';

// Pattern matching (regex) is deliberately NOT part of V1: no real need yet, and a safe mechanism
// does not exist. It can be reintroduced later if a concrete business case requires it.
// Hard rule = a rule a machine can check without judgment. Qualitative expectations
// ("elegant", "premium", "balanced", "must not look AI") are NOT hard rules: they belong to
// Brand Memory's semantic_context or to Creative Quality.

// The only type x operator combinations V1 accepts.
export const HARD_RULE_MATRIX = Object.freeze({
  [T.ASSET_REF]: Object.freeze([O.EQUALS, O.ONE_OF, O.REQUIRED]),
  [T.COLOR]: Object.freeze([O.EQUALS, O.ONE_OF, O.REQUIRED]),
  [T.TYPOGRAPHY]: Object.freeze([O.EQUALS, O.ONE_OF, O.REQUIRED]),
  [T.TEXT]: Object.freeze([O.CONTAINS, O.NOT_CONTAINS, O.REQUIRED]),
  [T.CLAIM_REF]: Object.freeze([O.EQUALS, O.ONE_OF, O.REQUIRED]),
  [T.EXTERNAL_GATE]: Object.freeze([O.STATUS_IN, O.REQUIRED]),
});

// Canonical external gates a rule may consume. The gate is computed elsewhere (never by Branding).
//   observable_statuses    what the gate can REPORT (the vocabulary a candidate manifest may carry)
//   allowed_rule_statuses  what a rule's STATUS_IN may declare as COMPLIANT
// They differ on purpose: FAIL and NOT_MEASURABLE are valid things for a gate to report, but they can
// never be configured as a conforming state. First (and only) V1 gate: creative-fidelity.
export const EXTERNAL_GATES = Object.freeze({
  product_fidelity: Object.freeze({
    source: 'creative-fidelity',
    observable_statuses: Object.freeze(Object.values(FIDELITY_GATE_OUTCOME)),
    allowed_rule_statuses: Object.freeze([FIDELITY_GATE_OUTCOME.PASS]),
  }),
});

// Provenance: every rule must say why it exists.
export const SOURCE_REF_PATTERN = /^(brand-core|decision|approved-asset|claim|external-policy):\/\/\S+$/;
export const CLAIM_REF_PATTERN = /^claim:\/\/\S+$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const OPAQUE_REF = /^\S+$/;

const MAX_ONE_OF = 50;
const MAX_TEXT_VALUE = 500;

export function normalizeHexColor(value, field) {
  const text = requiredString(value, field);
  if (!HEX_COLOR.test(text)) throw new TypeError(`${field} must be a #RRGGBB hex color`);
  return text.toUpperCase();
}

export function opaqueRef(value, field) {
  const text = requiredString(value, field);
  if (!OPAQUE_REF.test(text)) throw new TypeError(`${field} must be an opaque reference without whitespace`);
  return text;
}

export function claimRef(value, field) {
  const text = requiredString(value, field);
  if (!CLAIM_REF_PATTERN.test(text)) throw new TypeError(`${field} must be a claim:// reference`);
  return text;
}

function oneOf(value, field, item) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty array`);
  }
  if (value.length > MAX_ONE_OF) throw new RangeError(`${field} must contain at most ${MAX_ONE_OF} items`);
  const out = value.map((entry, index) => item(entry, `${field}[${index}]`));
  if (new Set(out).size !== out.length) throw new TypeError(`${field} contains duplicates`);
  return Object.freeze(out);
}

function textValue(value, field) {
  const text = requiredString(value, field);
  if (text.length > MAX_TEXT_VALUE) throw new RangeError(`${field} is too long`);
  return text;
}

function requiredFlag(value, field) {
  if (value !== true) throw new TypeError(`${field} must be true for a REQUIRED rule`);
  return true;
}

// Value shape per type, for the operators that carry a value.
const SCALAR = Object.freeze({
  [T.ASSET_REF]: opaqueRef,
  [T.COLOR]: normalizeHexColor,
  [T.TYPOGRAPHY]: (value, field) => textValue(value, field),
  [T.CLAIM_REF]: claimRef,
});

function normalizeValue(rule, value, field, gate) {
  switch (rule.operator) {
    case O.REQUIRED: return requiredFlag(value, field);
    case O.EQUALS: return SCALAR[rule.rule_type](value, field);
    case O.ONE_OF: return oneOf(value, field, SCALAR[rule.rule_type]);
    case O.CONTAINS:
    case O.NOT_CONTAINS: return textValue(value, field);
    case O.STATUS_IN: {
      const statuses = oneOf(value, field, (entry, f) => requiredString(entry, f));
      for (const status of statuses) {
        if (!gate.observable_statuses.includes(status)) {
          throw new TypeError(`${field} contains a status unknown to gate ${rule.subject}: ${status}`);
        }
        if (!gate.allowed_rule_statuses.includes(status)) {
          throw new TypeError(`${field}: ${status} cannot be configured as a compliant status of gate ${rule.subject}`);
        }
      }
      return statuses;
    }
    default: throw new TypeError(`unsupported operator: ${rule.operator}`);
  }
}

export function normalizeHardRule(input, field = 'hard_rule') {
  assertObject(input, field);
  const allowedKeys = ['id', 'rule_type', 'subject', 'operator', 'value', 'severity', 'scope', 'source_ref'];
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new TypeError(`${field}.${key} is not part of the hard rule contract`);
  }

  const rule = {
    id: requiredString(input.id, `${field}.id`),
    rule_type: enumValue(input.rule_type, T, `${field}.rule_type`),
    subject: requiredString(input.subject, `${field}.subject`),
    operator: enumValue(input.operator, O, `${field}.operator`),
  };
  if (!HARD_RULE_MATRIX[rule.rule_type].includes(rule.operator)) {
    throw new TypeError(`operator ${rule.operator} is not allowed for rule type ${rule.rule_type}`);
  }

  let gate = null;
  if (rule.rule_type === T.EXTERNAL_GATE) {
    gate = EXTERNAL_GATES[rule.subject];
    if (!gate) throw new TypeError(`${field}.subject is not a known external gate: ${rule.subject}`);
  }

  const sourceRef = input.source_ref == null ? null : requiredString(input.source_ref, `${field}.source_ref`);
  if (sourceRef == null) throw new TypeError(`${field}.source_ref is required: HARD_RULE_SOURCE_REF_REQUIRED`);
  if (!SOURCE_REF_PATTERN.test(sourceRef)) {
    throw new TypeError(`${field}.source_ref must use a known provenance scheme`);
  }

  return Object.freeze({
    ...rule,
    value: normalizeValue(rule, input.value, `${field}.value`, gate),
    severity: enumValue(input.severity, RULE_SEVERITY, `${field}.severity`),
    scope: enumValue(input.scope ?? RULE_SCOPE.GLOBAL, RULE_SCOPE, `${field}.scope`),
    source_ref: sourceRef,
  });
}
