import {
  CONTENT_KIND,
  OBSERVATION_COVERAGE,
} from './constants.js';
import {
  claimRef,
  EXTERNAL_GATES,
  normalizeHexColor,
  opaqueRef,
} from './hard-rules.js';
import {
  assertObject,
  deepFreeze,
  enumValue,
  requiredString,
} from './validation.js';
import { FIDELITY_GATE_OUTCOME } from '../creative-fidelity/constants.js';

// Candidate manifest = structured FACTS about a candidate (a post, an image, a document...),
// produced by upstream adapters (OCR, color extraction, font detection, asset resolver,
// creative-fidelity...). Brand Guardian evaluates hard rules against it and never inspects raw
// media, so a manifest holds no raw media: only refs, colors, names, text fragments and statuses.
//
// Trust: a manifest must be produced by trusted adapters / server context and never be built straight from
// an untrusted client payload; this module validates its shape only and authenticates nothing.
//
// Every observation is SUBJECT-AWARE and carries a COVERAGE, so that Nordla can tell
//   "nothing found after a complete measurement"  (COMPLETE, values = [])
// from
//   "the detector did not (fully) run"            (PARTIAL / UNAVAILABLE / no entry at all).
// A rule is matched with `observation.subject === rule.subject` - exact, no fuzzy matching. An adapter
// that cannot classify a subject must not guess: it reports PARTIAL or UNAVAILABLE.

const KEYS = ['content_kind', 'assets', 'colors', 'typography', 'text', 'claims', 'external_gates'];
const OBSERVATION_KEYS = ['subject', 'coverage', 'values', 'evidence_refs'];
const GATE_KEYS = ['subject', 'coverage', 'status', 'evidence_refs'];

const MAX_OBSERVATIONS = 100;
const MAX_VALUES = 200;
const MAX_FRAGMENT = 5000;
const MAX_SUBJECT = 120;
const MAX_FAMILY = 100;

function exactKeys(input, allowed, field) {
  assertObject(input, field);
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new TypeError(`${field}.${key} is not part of the candidate manifest`);
  }
}

// A manifest carries controlled Nordla references (asset://, evidence://, ...), never a location or inline media: no data/blob/file
// URI, no http(s)/ftp/ws URL (raw provider or signed URL, credentials) and no filesystem path. Manifest-specific on purpose: the
// global opaqueRef() is shared by other Branding contracts and is left untouched.
const FORBIDDEN_LOCATION = /^(?:https?|ftps?|wss?|file|data|blob):|^[a-z]:\\|^[\\/]/i;

function candidateRef(value, field) {
  const ref = opaqueRef(value, field);
  if (FORBIDDEN_LOCATION.test(ref)) {
    throw new TypeError(`${field} must be a controlled Nordla reference, not inline media, a URL or a file location`);
  }
  return ref;
}

function evidenceRefs(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const out = value.map((ref, index) => candidateRef(ref, `${field}[${index}]`));
  if (new Set(out).size !== out.length) throw new TypeError(`${field} contains duplicates`);
  return out;
}

function subjectOf(value, field) {
  const subject = requiredString(value, field);
  if (subject.length > MAX_SUBJECT) throw new RangeError(`${field} is too long`);
  return subject;
}

function channel(value, field, normalizeEntry) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  if (value.length > MAX_OBSERVATIONS) throw new RangeError(`${field} must contain at most ${MAX_OBSERVATIONS} observations`);
  const entries = value.map((entry, index) => normalizeEntry(entry, `${field}[${index}]`));
  // one subject appears once per channel: several values go in values[]
  const subjects = entries.map((entry) => entry.subject);
  if (new Set(subjects).size !== subjects.length) throw new TypeError(`${field} lists the same subject twice`);
  return entries;
}

function valuesObservation(item, { unique = true } = {}) {
  return (entry, field) => {
    exactKeys(entry, OBSERVATION_KEYS, field);
    const coverage = enumValue(entry.coverage, OBSERVATION_COVERAGE, `${field}.coverage`);
    if (entry.values != null && !Array.isArray(entry.values)) throw new TypeError(`${field}.values must be an array`);
    const raw = entry.values ?? [];
    if (raw.length > MAX_VALUES) throw new RangeError(`${field}.values must contain at most ${MAX_VALUES} items`);
    const values = raw.map((value, index) => item(value, `${field}.values[${index}]`));
    if (unique && new Set(values).size !== values.length) throw new TypeError(`${field}.values contains duplicates`);
    // UNAVAILABLE means "no reliable measurement": it cannot carry measured values.
    if (coverage === OBSERVATION_COVERAGE.UNAVAILABLE && values.length > 0) {
      throw new TypeError(`${field}: an UNAVAILABLE observation cannot carry values`);
    }
    return {
      subject: subjectOf(entry.subject, `${field}.subject`),
      coverage,
      values,
      evidence_refs: evidenceRefs(entry.evidence_refs, `${field}.evidence_refs`),
    };
  };
}

const family = (value, field) => {
  const text = requiredString(value, field);
  if (text.length > MAX_FAMILY) throw new RangeError(`${field} is too long`);
  return text;
};

const fragment = (value, field) => {
  const text = requiredString(value, field);
  if (text.length > MAX_FRAGMENT) throw new RangeError(`${field} is too long`);
  return text;
};

function gateObservation(entry, field) {
  exactKeys(entry, GATE_KEYS, field);
  const subject = subjectOf(entry.subject, `${field}.subject`);
  const gate = EXTERNAL_GATES[subject];
  if (!gate) throw new TypeError(`${field}.subject is not a known external gate: ${subject}`);
  const coverage = enumValue(entry.coverage, OBSERVATION_COVERAGE, `${field}.coverage`);
  const status = entry.status == null ? null : requiredString(entry.status, `${field}.status`);
  if (status !== null && !gate.observable_statuses.includes(status)) {
    throw new TypeError(`${field}.status is unknown to gate ${subject}: ${status}`);
  }
  if (coverage === OBSERVATION_COVERAGE.UNAVAILABLE && status !== null) {
    throw new TypeError(`${field}: an UNAVAILABLE gate cannot carry a status`);
  }
  if (coverage === OBSERVATION_COVERAGE.COMPLETE && status === null) {
    throw new TypeError(`${field}: a COMPLETE gate result needs a status`);
  }
  return { subject, coverage, status, evidence_refs: evidenceRefs(entry.evidence_refs, `${field}.evidence_refs`) };
}

export function normalizeCandidateManifest(input) {
  exactKeys(input, KEYS, 'manifest');
  return deepFreeze({
    content_kind: enumValue(input.content_kind, CONTENT_KIND, 'manifest.content_kind'),
    assets: channel(input.assets, 'manifest.assets', valuesObservation(candidateRef)),
    colors: channel(input.colors, 'manifest.colors', valuesObservation(normalizeHexColor)),
    typography: channel(input.typography, 'manifest.typography', valuesObservation(family)),
    text: channel(input.text, 'manifest.text', valuesObservation(fragment, { unique: false })),
    claims: channel(input.claims, 'manifest.claims', valuesObservation(claimRef)),
    external_gates: channel(input.external_gates, 'manifest.external_gates', gateObservation),
  });
}

/**
 * Adapter: creative-fidelity's `evaluateHardFidelityGate` result -> `product_fidelity` gate observation.
 * Guardian never recomputes product fidelity; it only consumes this status.
 *   PASS            -> COMPLETE + PASS      (every required check passed)
 *   FAIL, no gaps   -> COMPLETE + FAIL
 *   FAIL + missing  -> PARTIAL  + FAIL      (a violation is proven, compliance is not)
 *   NOT_MEASURABLE  -> UNAVAILABLE, no status
 */
export function fidelityGateObservation({ gate, evidenceRefs: refs = [] } = {}) {
  assertObject(gate, 'gate');
  const missing = gate.missing ?? [];
  let coverage;
  let status;
  switch (gate.outcome) {
    case FIDELITY_GATE_OUTCOME.PASS:
      coverage = OBSERVATION_COVERAGE.COMPLETE;
      status = FIDELITY_GATE_OUTCOME.PASS;
      break;
    case FIDELITY_GATE_OUTCOME.FAIL:
      coverage = missing.length ? OBSERVATION_COVERAGE.PARTIAL : OBSERVATION_COVERAGE.COMPLETE;
      status = FIDELITY_GATE_OUTCOME.FAIL;
      break;
    case FIDELITY_GATE_OUTCOME.NOT_MEASURABLE:
      coverage = OBSERVATION_COVERAGE.UNAVAILABLE;
      status = null;
      break;
    default:
      throw new TypeError(`unsupported fidelity gate outcome: ${gate.outcome}`);
  }
  return gateObservation({ subject: 'product_fidelity', coverage, status, evidence_refs: refs }, 'gate');
}

// Single normalization shared by rules and observed text: Unicode NFC, case-folded with the
// locale-independent toLowerCase, whitespace collapsed. Deterministic; NOT fuzzy matching.
export const normalizeMatchText = (text) => String(text).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
