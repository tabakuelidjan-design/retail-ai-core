// Manual Observation producer (M1.5): lets a small shop or workshop feed UNDERSTAND with a TRACED human observation
// ("customers often ask for a kind of product", "people look at a zone and leave", "a question keeps coming up at the counter").
//
// It is qualitative evidence (MANUAL_OBSERVATION), never statistical proof - the M1 envelope attaches
// MANUAL_OBSERVATION_IS_NOT_STATISTICAL_PROOF automatically. It stores NO profile and NO prose.
//
// Privacy by construction (the schema is closed; there is no free text field):
//   - no customer_name, e-mail, phone, address, note, comment or transcript key exists: such keys are refused;
//   - subject_refs / source_ref / evidence_refs are opaque tokens (no space, '@', '?', '&');
//   - limitations and provenance.limitations are stable UPPER_SNAKE codes, not sentences;
//   - provenance.source_system is an opaque reference, and provenance carries nothing else free-form
//     (no filters, no attribution_model, no source_fields): a name or a remark cannot ride along.
// The detailed human description belongs to a future server-side record that evidence_refs points to - not to the signal.

import { SIGNAL_CLASS } from './understand-constants.js';
import { PRODUCER_ERROR as P, produceMarketSignal, requireField } from './signal-producer.js';
import {
  closedObject, enumValue, fail, opaqueRef, tokenList, upperToken,
} from './understand-validation.js';

const MANUAL_PREFIX = 'MANUAL_';
// signal_type is capped at 64 characters by the MarketSignal envelope.
const MAX_OBSERVATION_TYPE = 64 - MANUAL_PREFIX.length;
const PROVENANCE_KEYS = ['source_system', 'completeness', 'evidence_kind', 'limitations'];
const COMPLETENESS = Object.freeze({ COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', UNAVAILABLE: 'UNAVAILABLE' });
const EVIDENCE_KIND = Object.freeze({ observed: 'observed', attributed: 'attributed', inferred: 'inferred', derived: 'derived', unavailable: 'unavailable' });

function manualProvenance(input) {
  closedObject(input, PROVENANCE_KEYS, 'manualObservation.provenance');
  return {
    source_system: opaqueRef(input.source_system, 'manualObservation.provenance.source_system', { max: 120 }),
    completeness: enumValue(input.completeness, COMPLETENESS, 'manualObservation.provenance.completeness'),
    evidence_kind: enumValue(input.evidence_kind, EVIDENCE_KIND, 'manualObservation.provenance.evidence_kind'),
    limitations: tokenList(input.limitations, 'manualObservation.provenance.limitations', { max: 50 }),
  };
}

/**
 * Input (closed): observation_type (UPPER_SNAKE, e.g. PRODUCT_REQUEST), subject_refs[>=1], source_ref, evidence_refs[>=1],
 * observed_at (required, <= detected_at), detected_at, expires_at, effective_window?, locale?, market?,
 * limitations[] (UPPER_SNAKE codes), provenance {source_system, completeness, evidence_kind, limitations?}.
 * Produces signal_type MANUAL_<observation_type>.
 */
export function produceManualObservationSignal({ tenant, brand = null, ...input } = {}) {
  return produceMarketSignal({
    tenant,
    brand,
    input,
    label: 'manualObservation',
    extraKeys: ['observation_type'],
    signalClass: SIGNAL_CLASS.MANUAL_OBSERVATION,
    resolve(i) {
      if (i.observation_type == null || (typeof i.observation_type === 'string' && !i.observation_type.trim())) {
        fail(P.MANUAL_OBSERVATION_TYPE_REQUIRED, 'manualObservation.observation_type is required');
      }
      let type;
      try {
        type = upperToken(i.observation_type, 'manualObservation.observation_type', { max: MAX_OBSERVATION_TYPE });
      } catch {
        fail(P.MANUAL_OBSERVATION_INVALID_TYPE, 'manualObservation.observation_type must be UPPER_SNAKE_CASE');
      }
      if (type.startsWith(MANUAL_PREFIX)) fail(P.MANUAL_OBSERVATION_INVALID_TYPE, 'manualObservation.observation_type must not repeat the MANUAL_ prefix');
      requireField(i.subject_refs, P.MANUAL_OBSERVATION_SUBJECT_REQUIRED, 'a manual observation needs at least one subject_ref');
      requireField(i.evidence_refs, P.MANUAL_OBSERVATION_EVIDENCE_REQUIRED, 'a manual observation needs at least one evidence_ref');
      if (i.observed_at == null) fail(P.MANUAL_OBSERVATION_OBSERVED_AT_REQUIRED, 'a manual observation needs observed_at');
      return {
        signalType: `${MANUAL_PREFIX}${type}`,
        fields: {
          limitations: tokenList(i.limitations, 'manualObservation.limitations', { max: 50 }),
          provenance: manualProvenance(i.provenance),
        },
      };
    },
  });
}
