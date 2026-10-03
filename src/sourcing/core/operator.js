// Economic-operator role of the merchant for THIS product. The critical rule: selling under the merchant's own name or brand can make the merchant the
// MANUFACTURER for legal purposes (GPSR Art. 13 / NLF acts). This is a HIGH-visibility warning, never silently assumed away. Nordla does not decide the legal role:
// it states what the facts given imply and what to confirm.
export function economicOperator(placing = {}) {
  const own = placing.underOwnNameOrBrand ?? null; const euMaker = placing.manufacturerEstablishedInEU ?? null; const euRep = placing.euAuthorisedRepresentative ?? null; const modifies = placing.substantialModification ?? null;
  const reasons = []; const warnings = []; const roles = [];
  if (own === true) {
    roles.push('MANUFACTURER_OBLIGATIONS_MAY_APPLY');
    warnings.push({ code: 'OWN_BRAND_MANUFACTURER_DUTIES', severity: 'HIGH', message: 'The product would be sold under your own name, trademark or label: you may be treated as its MANUFACTURER (technical documentation, conformity assessment, EU declaration of conformity, CE marking where applicable, traceability, risk assessment). Do not assume you are only a reseller.' });
    reasons.push('placed under own name or brand');
  }
  if (modifies === true) { if (!roles.includes('MANUFACTURER_OBLIGATIONS_MAY_APPLY')) roles.push('MANUFACTURER_OBLIGATIONS_MAY_APPLY'); warnings.push({ code: 'SUBSTANTIAL_MODIFICATION', severity: 'HIGH', message: 'A substantial modification of the product can also make you the manufacturer.' }); reasons.push('substantial modification'); }
  if (euMaker === false && euRep !== true) { roles.push('IMPORTER'); reasons.push('the manufacturer is established outside the EU and no EU authorised representative is named: the first EU party placing it on the market is the importer'); }
  else if (euMaker === true || euRep === true) { roles.push('DISTRIBUTOR'); reasons.push(euMaker ? 'bought from an EU-established manufacturer' : 'an EU authorised representative is named'); }
  const unresolved = [];
  if (own === null) unresolved.push({ code: 'OWN_BRAND_UNKNOWN', question: 'Will this product be sold under YOUR name, brand or label (private label)?' });
  if (euMaker === null && euRep === null) unresolved.push({ code: 'EU_PARTY_UNKNOWN', question: 'Is the legal manufacturer established in the EU, or does the supplier name an EU authorised representative / importer?' });
  const resolved = own !== null && (euMaker !== null || euRep !== null);
  return {
    role: roles.length ? roles.join(' + ') : 'UNRESOLVED', roles, ownBrand: own === true || modifies === true ? true : own, resolved, reasons, warnings, unresolved,
    note: 'Nordla does not decide your legal role. It tells you what your answers imply; the authorities and an expert decide.',
    sources: [{ title: 'GPSR (EU) 2023/988 Art. 11-13: importer, distributor, treated as manufacturer', url: 'https://eur-lex.europa.eu/eli/reg/2023/988/oj', verification: 'NOT_OPENED_ELI', checkedAt: '2026-10-03' }, { title: 'Commission Blue Guide on EU product rules', url: 'https://single-market-economy.ec.europa.eu/single-market/goods/building-blocks/blue-guide_en', verification: 'PENDING_RESEARCH', checkedAt: '2026-10-03' }],
  };
}
