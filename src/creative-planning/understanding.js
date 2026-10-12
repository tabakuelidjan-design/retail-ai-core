import { safeCause } from '../creative-brain/model-port.js';
import {
  BRAIN_ERROR, closed, deepFreeze, deriveId, enumOf, fail, listOf, oneLine,
} from '../creative-brain/validation.js';
import {
  ANALYSIS_STATUS, REFERENCE_ROLE, SCHEMA, SOURCE_KIND,
} from './constants.js';
import { longText, normalizeFact, wholeNumber } from './request.js';
import { measure } from './text-units.js';

// INPUT UNDERSTANDING. The planner never reads pixels, files or provider output. It reads NORMALIZED OBSERVATIONS: one closed contract for every kind of input (text, product image, uploaded file,
// reference image, structured facts), whoever produced it. A deterministic reading always exists (text is measured, an image's stated dimensions are kept, a fact list is validated). A connected
// UNDERSTANDING PORT may enrich an observation (what an image shows, what a file says); nothing about the planner changes when one is connected, and a port that fails never stops the plan: the
// observation is simply NOT_ANALYZED, with the safe diagnostics of the failure.
//
//   port = { understand({ source, bytes }) -> Promise<{ text?, facts?, descriptors?, measured? }> }      one port per source kind, optional
//
// What a port returns is untrusted data: it is validated here like any other input, and its descriptors are advisory words (what was seen), never a fact of the merchant.

const OBSERVATION_KEYS = ['observation_id', 'schema', 'source_kind', 'role', 'provenance', 'analysis', 'text', 'facts', 'measured', 'descriptors'];
const MEASURED_KEYS = ['width_px', 'height_px', 'bytes_length', 'chars', 'words'];

/** A stored or port-made observation, re-validated: closed, measured figures whole and bounded, and the id must follow from the content. */
export function normalizeObservation(observation) {
  closed(observation, OBSERVATION_KEYS, 'observation');
  const { observation_id: id, ...body } = observation;
  if (body.schema !== SCHEMA.observation) fail(BRAIN_ERROR.RULE_VIOLATION, 'observation.schema is not known', 'observation.schema');
  enumOf(body.source_kind, SOURCE_KIND, 'observation.source_kind');
  enumOf(body.role, REFERENCE_ROLE, 'observation.role');
  closed(body.provenance, ['ref', 'origin', 'sha256'], 'observation.provenance');
  closed(body.analysis, ['status', 'analyzer', 'failure_code'], 'observation.analysis');
  enumOf(body.analysis.status, ANALYSIS_STATUS, 'observation.analysis.status');
  if (body.analysis.failure_code !== null) oneLine(body.analysis.failure_code, 'observation.analysis.failure_code', { max: 100 });
  closed(body.measured, MEASURED_KEYS, 'observation.measured');
  for (const key of MEASURED_KEYS) if (body.measured[key] !== null) wholeNumber(body.measured[key], `observation.measured.${key}`, { min: 0, max: 2_000_000_000 });
  if (body.text !== null) longText(body.text, 'observation.text');
  listOf(body.facts, 'observation.facts', { max: 100 }, (f, w) => normalizeFact(f, w));
  listOf(body.descriptors, 'observation.descriptors', { max: 12 }, (d, w) => oneLine(d, w, { max: 200 }));
  if (id !== deriveId('obs', body)) fail(BRAIN_ERROR.RULE_VIOLATION, 'observation_id does not follow from the content', 'observation.observation_id');
  return deepFreeze(structuredClone(observation));
}

function baseObservation(source, locale) {
  const measuredText = source.text ? measure(source.text, locale) : null;
  const measured = {
    width_px: source.width_px, height_px: source.height_px, bytes_length: source.bytes_length, chars: measuredText ? measuredText.chars : null, words: measuredText ? measuredText.words : null,
  };
  const hasMeasure = Object.values(measured).some((v) => v !== null);
  const status = source.source_kind === SOURCE_KIND.TEXT || source.source_kind === SOURCE_KIND.STRUCTURED_FACTS ? ANALYSIS_STATUS.ANALYZED : (hasMeasure ? ANALYSIS_STATUS.METADATA_ONLY : ANALYSIS_STATUS.NOT_ANALYZED);
  return {
    schema: SCHEMA.observation,
    source_kind: source.source_kind,
    role: source.role,
    provenance: { ref: source.ref, origin: source.origin, sha256: source.sha256 },
    analysis: { status, analyzer: 'DETERMINISTIC', failure_code: null },
    text: source.text,
    facts: source.facts,
    measured,
    descriptors: [],
  };
}

const seal = (body) => normalizeObservation({ observation_id: deriveId('obs', body), ...body });

/**
 * One observation per source, in the order of the sources. A port enriches the deterministic reading; a failing or invalid port leaves the observation NOT_ANALYZED with the safe diagnostics.
 * @param {object} input { sources (normalized), bytes: Map<ref, bytes>, ports: { [source_kind]: { understand } }, locale }
 */
export async function understandInputs({ sources, bytes = new Map(), ports = {}, locale = 'en' }) {
  const out = [];
  for (const source of sources) {
    const body = baseObservation(source, locale);
    const port = ports[source.source_kind];
    if (port && typeof port.understand === 'function') {
      let failure;
      try {
        const answer = await port.understand({ source, bytes: bytes.get(source.ref) ?? null });
        const extra = answer && typeof answer === 'object' ? answer : {};
        const enriched = {
          ...body,
          text: extra.text != null ? longText(extra.text, 'port.text') : body.text,
          facts: [...body.facts, ...listOf(extra.facts ?? [], 'port.facts', { max: 100 }, (f, w) => normalizeFact(f, w))],
          descriptors: listOf(extra.descriptors ?? [], 'port.descriptors', { max: 12 }, (d, w) => oneLine(d, w, { max: 200 })),
          measured: { ...body.measured, ...Object.fromEntries(Object.entries(extra.measured ?? {}).filter(([k]) => MEASURED_KEYS.includes(k))) },
          analysis: { status: ANALYSIS_STATUS.ANALYZED, analyzer: 'PORT', failure_code: null },
        };
        out.push(seal(enriched));
        continue;
      } catch (cause) {
        failure = safeCause(cause).code ?? 'PORT_FAILED';
      }
      out.push(seal({ ...body, analysis: { status: ANALYSIS_STATUS.NOT_ANALYZED, analyzer: 'PORT', failure_code: failure } }));
    } else out.push(seal(body));
  }
  return out;
}
