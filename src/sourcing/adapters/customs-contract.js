// CONTRACT of the future OFFICIAL customs lookup adapter (TARIC / EBTI). No adapter is integrated in V0: the duty rate is typed in by the owner or taken from a broker,
// and a code stays an "HS/CN CANDIDATE" until a binding tariff information or the customs authority supports it. Any adapter MUST return a result that passes
// validateLookupResult(); the decision engine feeds `measures` into the landed-cost duty line only as an ESTIMATE labelled with its source, origin and validity date.
export const CUSTOMS_LOOKUP_CONTRACT = Object.freeze({
  source: 'EU TARIC / EBTI (official)',
  officialReferences: ['https://ec.europa.eu/taxation_customs/dds2/taric/taric_consultation.jsp', 'https://taxation-customs.ec.europa.eu/online-services/online-services-and-databases-customs/european-binding-tariff-information-ebti_en'],
  input: ['goodsCode or description', 'origin (ISO country, here CN)', 'date of import', 'optional: destination Member State'],
  output: ['source', 'retrievedAt', 'origin', 'goodsCode', 'validFrom', 'measures[] {type, ratePct, validFrom, additionalCode|null, geographicalArea?}', 'candidates[] {code, description, confidence}'],
  mustNot: ['select a code because its duty is lower', 'return a single "confirmed" code for a free-text description', 'drop anti-dumping, countervailing, safeguard, quota or surveillance measures', 'ignore origin, measure validity dates or additional codes'],
  states: ['LOOKUP_OK (candidates with measures)', 'LOOKUP_UNAVAILABLE (offline / error: the duty stays UNKNOWN)', 'BTI_PROVIDED (binding tariff information number and validity: the only way to the binding status)'],
});
const NEED = ['source', 'retrievedAt', 'origin', 'goodsCode', 'validFrom'];
export function validateLookupResult(r) {
  const errors = [];
  for (const k of NEED) if (r?.[k] === undefined || r?.[k] === null || r?.[k] === '') errors.push(`missing ${k}`);
  if (!Array.isArray(r?.measures)) errors.push('measures must be a list');
  else r.measures.forEach((m, i) => { for (const k of ['type', 'ratePct', 'validFrom']) if (m?.[k] === undefined) errors.push(`measure ${i} lacks ${k}`); if (!('additionalCode' in (m ?? {}))) errors.push(`measure ${i} lacks additionalCode (null when none)`); });
  if (!Array.isArray(r?.candidates) || r.candidates.length === 0) errors.push('at least one candidate is required');
  if (r?.chosenCode && Array.isArray(r.candidates) && r.candidates.length > 1) errors.push('a lookup cannot choose between several candidates: only the owner, a broker or a binding tariff information can');
  return { ok: errors.length === 0, errors };
}
