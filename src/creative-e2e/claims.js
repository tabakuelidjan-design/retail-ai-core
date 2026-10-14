// THE DISPOSITION OF EVERY APPROVED CLAIM. A claim of the brief (a verified price, a promise) is never silently dropped and never forced onto the visual: each one ends with a stated disposition and the reason.
//   VISUAL_COPY    the exact wording is drawn on an asset of the campaign (which one is recorded)
//   CAPTION        the exact wording is in the caption of the plan
//   METADATA_ONLY  the operator declared it is carried as data only (e.g. the price of the listing), never drawn
//   NOT_USED       it is in no text of the plan; with the reason
// The operator may DECLARE the intended disposition with `claim_policy` ({ [ref]: disposition }). A declared VISUAL_COPY or CAPTION that the plan does not contain is a stop (CLAIM_NOT_PLACED), a claim whose number or
// price appears in the text in ANOTHER form is a stop (CLAIM_ALTERED): the exact approved formatting is the only form of a price. Nothing here rewrites a word.

export const DISPOSITION = Object.freeze({
  VISUAL_COPY: 'VISUAL_COPY', CAPTION: 'CAPTION', METADATA_ONLY: 'METADATA_ONLY', NOT_USED: 'NOT_USED',
});

const squash = (text) => String(text ?? '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
// a price or a number with its unit: "25,00 €", "25 €", "20 000 mAh" (compared as the written form)
const AMOUNT = /\d[\d .,]*\d?\s?(?:€|eur|euros?|mah|%)/gi;
const amountsOf = (text) => [...squash(text).matchAll(AMOUNT)].map((m) => squash(m[0]).toLowerCase());
// the numeric value of a written amount ("25,00 €" and "25 €" are both 25): the same value written another way is an ALTERED price, not the approved one
const unitOf = (amount) => amount.replace(/[\d\s.,]/g, '');
const valueOf = (amount) => {
  const n = amount.replace(/[^\d.,]/g, '');
  const last = Math.max(n.lastIndexOf(','), n.lastIndexOf('.'));
  const norm = last >= 0 && n.length - last <= 3 ? `${n.slice(0, last).replace(/[.,]/g, '')}.${n.slice(last + 1)}` : n.replace(/[.,]/g, '');
  return Number.parseFloat(norm);
};

const captionTexts = (caption) => {
  if (!caption) return [];
  if (typeof caption === 'string') return [caption];
  if (Array.isArray(caption)) return caption.map((p) => p?.text ?? '').filter(Boolean);
  return caption.text ? [caption.text] : [];
};

/** The approved claims of a brief, as { ref, kind, role, wording }. */
export function claimsOfBrief(brief) {
  return [
    ...(brief?.claims ?? []).map((c) => ({ ref: c.ref, kind: 'CLAIM', role: c.role ?? null, wording: c.wording })),
    ...(brief?.approved_copy ?? []).map((c) => ({ ref: c.ref, kind: 'APPROVED_COPY', role: c.role ?? null, wording: c.content })),
  ].filter((c) => c.ref && typeof c.wording === 'string');
}

/**
 * @param {object} input { brief, contentPlans (the content plans of the campaign), policy ({ [ref]: DISPOSITION }) }
 * @returns {{ dispositions: object[], blocks: object[] }} dispositions: one per claim; blocks: what stops the run (an empty list means every claim has a traceable, coherent disposition)
 */
export function dispositionOfClaims({ brief, contentPlans = [], policy = {} }) {
  const onAssets = [];
  for (const plan of contentPlans) for (const asset of plan?.assets ?? []) for (const slot of asset.slots ?? []) onAssets.push({ index: asset.index, asset_role: asset.asset_role, slot_role: slot.role, text: squash(slot.text) });
  const captions = contentPlans.flatMap((p) => captionTexts(p?.caption)).map(squash);
  const dispositions = []; const blocks = [];
  for (const claim of claimsOfBrief(brief)) {
    const wording = squash(claim.wording); const declared = policy[claim.ref] ?? null;
    if (declared && !Object.values(DISPOSITION).includes(declared)) { blocks.push({ code: 'CLAIM_POLICY_INVALID', ref: claim.ref, declared }); continue; }
    const placed = onAssets.filter((a) => a.text.includes(wording)).map((a) => ({ asset_index: a.index, slot_role: a.slot_role }));
    const inCaption = captions.some((c) => c.includes(wording));
    // the same amount written another way in a text of the plan (25 € for 25,00 €): the approved form is not the written form
    const wanted = amountsOf(wording);
    const altered = wanted.length > 0 && placed.length === 0 && !inCaption && [...onAssets.map((a) => a.text), ...captions].some((t) => amountsOf(t).some((a) => !wanted.includes(a) && wanted.some((w) => valueOf(w) === valueOf(a) && unitOf(w) === unitOf(a))));
    let disposition; let reason;
    if (altered) { disposition = declared ?? DISPOSITION.NOT_USED; reason = 'THE_AMOUNT_APPEARS_IN_ANOTHER_FORM_THAN_THE_APPROVED_WORDING'; blocks.push({ code: 'CLAIM_ALTERED', ref: claim.ref, wording }); }
    else if (placed.length) { disposition = DISPOSITION.VISUAL_COPY; reason = 'THE_EXACT_WORDING_IS_ON_AN_ASSET'; }
    else if (inCaption) { disposition = DISPOSITION.CAPTION; reason = 'THE_EXACT_WORDING_IS_IN_THE_CAPTION'; }
    else if (declared === DISPOSITION.METADATA_ONLY) { disposition = DISPOSITION.METADATA_ONLY; reason = 'DECLARED_BY_THE_OPERATOR_CARRIED_AS_DATA_ONLY'; }
    else if (declared === DISPOSITION.VISUAL_COPY || declared === DISPOSITION.CAPTION) { disposition = DISPOSITION.NOT_USED; reason = `DECLARED_${declared}_BUT_THE_WORDING_IS_NOT_IN_THE_PLAN`; blocks.push({ code: 'CLAIM_NOT_PLACED', ref: claim.ref, declared, wording }); }
    else { disposition = DISPOSITION.NOT_USED; reason = declared === DISPOSITION.NOT_USED ? 'DECLARED_NOT_USED_BY_THE_OPERATOR' : 'NOT_IN_THE_REQUEST_COPY_AND_NOT_FORCED_ONTO_THE_VISUAL'; }
    dispositions.push({
      ref: claim.ref, kind: claim.kind, role: claim.role, wording, disposition, reason, declared, placed_on: placed, exact: disposition === DISPOSITION.VISUAL_COPY || disposition === DISPOSITION.CAPTION ? true : null,
    });
  }
  return { dispositions, blocks };
}
