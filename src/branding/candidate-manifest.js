import { CONTENT_KIND } from './constants.js';
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
  optionalString,
  requiredString,
} from './validation.js';

// Candidate manifest = the facts about a candidate asset (a post, an image, a document...) that
// Brand Guardian evaluates hard rules against. It is the CONTRACT between future adapters and the
// Guardian: adapters (OCR, color extraction, font detection, creative-fidelity...) fill it, the
// Guardian never inspects raw media. Evaluating rules against it is Guardian V1's job; this module
// only fixes and validates the shape.

const KEYS = [
  'content_kind', 'asset_refs', 'detected_colors', 'typography',
  'text_content', 'claim_refs', 'external_gate_results',
];

const list = (value, field, item) => {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((entry, index) => item(entry, `${field}[${index}]`));
};

export function normalizeCandidateManifest(input) {
  assertObject(input, 'manifest');
  for (const key of Object.keys(input)) {
    if (!KEYS.includes(key)) throw new TypeError(`manifest.${key} is not part of the candidate manifest`);
  }
  return deepFreeze({
    content_kind: enumValue(input.content_kind, CONTENT_KIND, 'manifest.content_kind'),
    asset_refs: list(input.asset_refs, 'manifest.asset_refs', opaqueRef),
    detected_colors: list(input.detected_colors, 'manifest.detected_colors', normalizeHexColor),
    typography: list(input.typography, 'manifest.typography', (entry, field) => {
      assertObject(entry, field);
      return { family: requiredString(entry.family, `${field}.family`) };
    }),
    text_content: optionalString(input.text_content, 'manifest.text_content'),
    claim_refs: list(input.claim_refs, 'manifest.claim_refs', claimRef),
    external_gate_results: list(input.external_gate_results, 'manifest.external_gate_results', (entry, field) => {
      assertObject(entry, field);
      const gate = requiredString(entry.gate, `${field}.gate`);
      if (!EXTERNAL_GATES[gate]) throw new TypeError(`${field}.gate is not a known external gate: ${gate}`);
      const status = requiredString(entry.status, `${field}.status`);
      if (!EXTERNAL_GATES[gate].statuses.includes(status)) {
        throw new TypeError(`${field}.status is unknown to gate ${gate}: ${status}`);
      }
      return { gate, status };
    }),
  });
}
