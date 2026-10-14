// Economic-operator role of the merchant for THIS product. Deterministic and evidence-based: the rules below mirror the CONSOLIDATED texts read on 2026-10-03.
//   own name or trademark                       -> MANUFACTURER (GPSR Art. 13(1); LVD Art. 10, EMC Art. 11, RED Art. 14, PPE Art. 12, Toys Directive Art. 8, RoHS manufacturer definition,
//                                                  Batteries Regulation: importer / distributor treated as manufacturer)
//   modification that affects compliance        -> MANUFACTURER (sector acts: "modifies ... in such a way that compliance may be affected"; GPSR Art. 13(2)-(3): substantial modification
//                                                  = a change not foreseen in the initial risk assessment that affects safety)
//   repackaging / relabelling under its own name -> MANUFACTURER (Blue Guide 2022 section 3.1: whoever packs, processes or labels ready-made products and places them under its name)
//   unchanged import under the maker's brand     -> IMPORTER (not a manufacturer)
// When a fact that decides the role is UNKNOWN the status is UNRESOLVED and a question is asked: Nordla never defaults to "merely a distributor / importer".
const BASIS = {
  own: ['GPSR Art. 13(1): own name or trademark = manufacturer, Art. 9 duties', 'LVD Art. 10 / EMC Art. 11 / RED Art. 14 / PPE Art. 12 / Toys Directive Art. 8 / RoHS / Batteries Regulation: own name or trade mark = manufacturer'],
  modification: ['sector acts (LVD, EMC, RED, PPE, Toys, Batteries): modifying the product in such a way that compliance may be affected = manufacturer', 'GPSR Art. 13(2)-(3): substantial modification (not foreseen in the initial risk assessment, new or higher hazard) = manufacturer for the affected part or the whole product'],
  repack: ['Blue Guide 2022 section 3.1: whoever assembles, packs, processes or labels ready-made products and places them on the market under its name is the manufacturer'],
};

export function economicOperator(placing = {}) {
  const t = (k) => (placing[k] === undefined ? null : placing[k]);
  const own = t('underOwnNameOrBrand'); const euMaker = t('manufacturerEstablishedInEU'); const euRep = t('euAuthorisedRepresentative');
  const legacy = t('substantialModification') === true; // earlier single flag: treated as a modification that affects compliance
  const modified = t('modifiedProduct') === true || legacy; const modAffects = legacy ? true : t('modificationAffectsCompliance');
  const repack = t('repackaged') === true; const repackOwn = t('repackagedUnderOwnName');
  const labelChange = t('changedInstructionsOrLabels') === true; const safetyChange = t('changedSafetyInformation');
  const roles = []; const warnings = []; const reasons = []; const unresolved = []; const basis = [];

  let manufacturer = false;
  if (own === true) { manufacturer = true; reasons.push('placed under own name or brand'); basis.push(...BASIS.own); warnings.push({ code: 'OWN_BRAND_MANUFACTURER_DUTIES', severity: 'HIGH', message: 'The product would be sold under your own name, trademark or label: you are treated as its MANUFACTURER (technical documentation, conformity assessment, EU declaration of conformity, CE marking where applicable, traceability, risk assessment). Do not assume you are only a reseller.' }); }
  if (modified && modAffects === true) { manufacturer = true; reasons.push('modification that affects compliance'); basis.push(...BASIS.modification); warnings.push({ code: legacy ? 'SUBSTANTIAL_MODIFICATION' : 'MODIFICATION_AFFECTS_COMPLIANCE', severity: 'HIGH', message: 'You modify the product in a way that can affect its compliance or safety: you are treated as its MANUFACTURER for the affected product.' }); }
  if (modified && modAffects === null) unresolved.push({ code: 'MODIFICATION_EFFECT_UNKNOWN', question: 'You modify the product: can the modification affect its safety or its compliance (design, materials, firmware, battery, accessories)? Describe the change.' });
  if (repack && repackOwn === true) { manufacturer = true; reasons.push('repackaged / relabelled under own name'); basis.push(...BASIS.repack); warnings.push({ code: 'REPACKAGED_UNDER_OWN_NAME', severity: 'HIGH', message: 'You repack or relabel the product under your own name: you are treated as its MANUFACTURER.' }); }
  if (repack && repackOwn === null) unresolved.push({ code: 'REPACKAGE_NAME_UNKNOWN', question: 'You repack the product: does the new packaging or label carry YOUR name or trademark?' });
  if (labelChange && safetyChange === true) unresolved.push({ code: 'SAFETY_INFORMATION_CHANGED', question: 'You change the instructions, warnings or safety information: this can make you responsible for them; an expert must confirm the effect.' });
  if (labelChange && safetyChange === null) unresolved.push({ code: 'LABEL_CHANGE_SCOPE_UNKNOWN', question: 'You change the instructions or labels: is it only a translation / importer identification, or do the safety information or warnings change?' });
  if (own === null) unresolved.push({ code: 'OWN_BRAND_UNKNOWN', question: 'Will this product be sold under YOUR name, brand or label (private label)?' });

  if (manufacturer) roles.push('MANUFACTURER_OBLIGATIONS_MAY_APPLY');
  if (euMaker === false && euRep !== true) { roles.push('IMPORTER'); reasons.push('the manufacturer is established outside the EU and no EU authorised representative is named: the first EU party placing it on the market is the importer'); }
  else if (euMaker === true || euRep === true) { roles.push('DISTRIBUTOR'); reasons.push(euMaker ? 'bought from an EU-established manufacturer' : 'an EU authorised representative is named'); }
  if (euMaker === null && euRep === null) unresolved.push({ code: 'EU_PARTY_UNKNOWN', question: 'Is the legal manufacturer established in the EU, or does the supplier name an EU authorised representative / importer?' });

  // ownBrand = "the merchant carries manufacturer obligations": true when a deterministic reason exists, null while a deciding fact is unknown, false only when every deciding fact is known and none applies
  const roleUnknown = unresolved.filter((u) => u.code !== 'EU_PARTY_UNKNOWN').length > 0;
  const ownBrand = manufacturer ? true : roleUnknown ? null : own === false ? false : null;
  return {
    role: roles.length ? roles.join(' + ') : 'UNRESOLVED', roles, ownBrand, status: unresolved.length ? 'UNRESOLVED' : 'DETERMINATE', resolved: unresolved.length === 0, reasons, warnings, unresolved, basis: [...new Set(basis)],
    note: 'Nordla does not decide your legal role. It tells you what your answers imply, with the legal basis; the authorities and an expert decide.',
    sources: [{ title: 'GPSR (EU) 2023/988 Art. 11-13 (consolidated 2026-05-29)', url: 'http://publications.europa.eu/resource/celex/02023R0988-20260529', verification: 'OPENED_OFFICIAL', checkedAt: '2026-10-03' }, { title: 'Commission Blue Guide on EU product rules 2022, section 3.1', url: 'http://publications.europa.eu/resource/celex/52022XC0629(04)', verification: 'OPENED_OFFICIAL', checkedAt: '2026-10-03' }],
  };
}
