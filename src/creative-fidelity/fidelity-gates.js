import {
  FIDELITY_CHECK,
  FIDELITY_GATE_OUTCOME,
  QUALITY_RATING,
} from './constants.js';

const knownChecks = new Set(Object.values(FIDELITY_CHECK));
const knownOutcomes = new Set(Object.values(FIDELITY_GATE_OUTCOME));

export function requiredChecksFromInvariants(invariants = []) {
  const checks = new Set([FIDELITY_CHECK.PRODUCT_IDENTITY]);
  const mapping = {
    PRESERVE_PRODUCT_GEOMETRY: FIDELITY_CHECK.PRODUCT_GEOMETRY,
    PRESERVE_PIECE_COUNT: FIDELITY_CHECK.PIECE_COUNT,
    PRESERVE_PRODUCT_COLOR: FIDELITY_CHECK.PRODUCT_COLOR,
    PRESERVE_LOGO_EXACTLY: FIDELITY_CHECK.LOGO,
    PRESERVE_TEXT_EXACTLY: FIDELITY_CHECK.TEXT,
    PRESERVE_FACE_PIXELS_EXACTLY: FIDELITY_CHECK.FACE,
  };

  for (const invariant of invariants) {
    if (mapping[invariant]) checks.add(mapping[invariant]);
  }
  return Object.freeze([...checks]);
}

export function evaluateHardFidelityGate({
  observations = [],
  requiredChecks = [],
} = {}) {
  if (!Array.isArray(observations)) {
    throw new TypeError('observations must be an array');
  }
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    return Object.freeze({
      outcome: FIDELITY_GATE_OUTCOME.NOT_MEASURABLE,
      failures: Object.freeze([]),
      missing: Object.freeze(['REQUIRED_CHECKS_NOT_DECLARED']),
    });
  }

  const required = [...new Set(requiredChecks)];
  for (const code of required) {
    if (!knownChecks.has(code)) {
      throw new Error(`unknown required fidelity check: ${code}`);
    }
  }

  const byCode = new Map();
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') {
      throw new TypeError('each observation must be an object');
    }
    if (!knownChecks.has(observation.code)) {
      throw new Error(
        `unknown fidelity observation code: ${observation.code}`,
      );
    }
    if (!knownOutcomes.has(observation.outcome)) {
      throw new Error(
        `unknown fidelity observation outcome: ${observation.outcome}`,
      );
    }
    if (byCode.has(observation.code)) {
      throw new Error(
        `duplicate fidelity observation: ${observation.code}`,
      );
    }

    byCode.set(observation.code, Object.freeze({
      code: observation.code,
      outcome: observation.outcome,
      evidence: observation.evidence ?? null,
      source: observation.source ?? null,
    }));
  }

  const missing = required.filter((code) => !byCode.has(code));
  const failures = required
    .map((code) => byCode.get(code))
    .filter(
      (observation) => observation?.outcome === FIDELITY_GATE_OUTCOME.FAIL,
    );
  const unmeasurable = required
    .map((code) => byCode.get(code))
    .filter(
      (observation) => (
        observation?.outcome === FIDELITY_GATE_OUTCOME.NOT_MEASURABLE
      ),
    );

  if (failures.length) {
    return Object.freeze({
      outcome: FIDELITY_GATE_OUTCOME.FAIL,
      failures: Object.freeze(failures),
      missing: Object.freeze(missing),
    });
  }
  if (missing.length || unmeasurable.length) {
    return Object.freeze({
      outcome: FIDELITY_GATE_OUTCOME.NOT_MEASURABLE,
      failures: Object.freeze([]),
      missing: Object.freeze(missing),
    });
  }
  return Object.freeze({
    outcome: FIDELITY_GATE_OUTCOME.PASS,
    failures: Object.freeze([]),
    missing: Object.freeze([]),
  });
}

export function normalizeQualityAxes(input = {}) {
  const axes = [
    'shape_fidelity',
    'proportion_fidelity',
    'material_fidelity',
    'color_fidelity',
    'texture_fidelity',
    'realism',
    'ai_look',
    'creative_quality',
  ];
  const allowed = new Set(Object.values(QUALITY_RATING));
  const out = {};

  for (const axis of axes) {
    const value = input[axis] ?? null;
    if (value != null && !allowed.has(value)) {
      throw new TypeError(
        `${axis} must be null or a QUALITY_RATING value`,
      );
    }
    out[axis] = value;
  }
  return Object.freeze(out);
}
