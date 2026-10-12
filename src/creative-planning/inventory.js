import { deepFreeze, deriveId } from '../creative-brain/validation.js';
import {
  COPY_MODE, SCHEMA, SOURCE_KIND, TEXT_ROLE,
} from './constants.js';
import { CARRIER } from './request.js';
import { measure } from './text-units.js';

// THE CONTENT INVENTORY (CONTENT_ANALYSIS). A deterministic reading of what is to be said and what is known: every text with its copy mode and its measured size, every fact with its status,
// the inputs that were understood. It decides nothing about the format; it makes the next stage's decision possible. Counts are MEASURED here (code, not a model).

/**
 * @param {object} input { request (normalized), observations (normalized) }
 */
export function buildInventory({ request, observations }) {
  const units = [];
  for (const item of request.copy) {
    const size = item.text ? measure(item.text, request.locale) : { chars: 0, words: 0, sentences: 0, paragraphs: 0 };
    units.push({
      unit_ref: item.copy_ref, origin: 'REQUEST', mode: item.mode, role: item.role, carrier: item.carrier, text: item.text, purpose: item.purpose, fact_refs: item.fact_refs, ...size,
    });
  }
  // a TEXT source nobody gave a policy to is LOCKED: the safe reading of text one has been given is that it is not to be rewritten
  const known = new Set(units.map((u) => u.unit_ref));
  for (const o of observations) {
    if (o.source_kind !== SOURCE_KIND.TEXT || !o.text || known.has(o.provenance.ref)) continue;
    const size = measure(o.text, request.locale);
    units.push({
      unit_ref: o.provenance.ref, origin: 'OBSERVATION', mode: COPY_MODE.COPY_LOCKED, role: TEXT_ROLE.BODY, carrier: CARRIER.APPROVED_COPY, text: o.text, purpose: null, fact_refs: [], ...size,
    });
  }
  const facts = new Map(request.facts.map((f) => [f.fact_ref, f]));
  for (const o of observations) for (const f of o.facts) if (!facts.has(f.fact_ref)) facts.set(f.fact_ref, f);
  const product = observations.find((o) => o.source_kind === SOURCE_KIND.PRODUCT_IMAGE);
  const body = {
    schema: SCHEMA.inventory,
    locale: request.locale,
    objective: request.objective,
    audience: request.audience,
    units,
    facts: [...facts.values()],
    observation_refs: observations.map((o) => o.observation_id),
    product_image: product ? { observation_id: product.observation_id, width_px: product.measured.width_px, height_px: product.measured.height_px, analysis: product.analysis.status } : null,
    reference_roles: [...new Set(observations.filter((o) => o.source_kind === SOURCE_KIND.REFERENCE_IMAGE).map((o) => o.role))].sort(),
    totals: {
      units: units.length,
      text_units: units.filter((u) => u.text).length,
      chars: units.reduce((n, u) => n + u.chars, 0),
      words: units.reduce((n, u) => n + u.words, 0),
      generatable: units.filter((u) => u.mode === COPY_MODE.COPY_GENERATABLE).length,
    },
  };
  return deepFreeze({ inventory_id: deriveId('cin', body), ...body });
}
