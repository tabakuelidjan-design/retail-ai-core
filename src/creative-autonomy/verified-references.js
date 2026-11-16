// The product's VERIFIED REFERENCES: the figures that the product itself carries and the verified facts state (model number, verified characteristics). Derived from the verified text, never invented.
// They are the only digits a PRODUCT_VISIBLE art direction may carry, and only in `rationale` (contract.js, allowFigures); they are shown to the art director in product_facts.verified_references.
import { figureSpansOf, figureKey } from '../creative-brain/contract.js';

/** [{ display, key }] for every figure reference found in the verified text, once each, in order of appearance. */
export function verifiedReferencesOf(verifiedText) {
  const seen = new Map();
  for (const span of figureSpansOf(verifiedText)) { const key = figureKey(span); if (key && !seen.has(key)) seen.set(key, { display: span.replace(/[\u00a0\u202f]/g, ' ').trim(), key }); }
  return [...seen.values()];
}
