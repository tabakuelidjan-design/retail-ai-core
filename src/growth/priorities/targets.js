// Where a prepared action points to, expressed with Growth's own stable identifiers (no platform URL: Growth is independent of the commerce platform).
// Pure: it reads the payloads of the engines and returns a descriptor the opportunity sheet turns into a link or into manual steps.
//   product     -> the Produits Potentiels sheet of the product (id = Growth product id), with the proposed variant when one was chosen and still exists;
//   segment     -> the Audience sheet of the segment (id = segment key);
//   storeWeekday-> the recommended day, the location only when the data identifies it; Growth validated no product for this action (the merchant chooses it).
// `available: false` = the target cannot be opened in Growth (not in the engine's current list): the UI then shows the manual steps and what is left to fill in.

export function targetOf(item, { productRow = null, audience = null, store = null } = {}) {
  const a = item?.preparedAction;
  if (!a) return null;
  if (item.kind === 'product') {
    const variantId = a.variant?.id ?? null;
    return { type: 'product', page: 'potential', id: a.target?.id ?? null, title: a.target?.title ?? null, available: !!productRow,
      variantId: variantId && (productRow?.variants ?? []).some((v) => v.id === variantId) ? variantId : null };
  }
  if (item.kind === 'segment') {
    return { type: 'segment', page: 'audience', id: a.segment ?? null, available: (audience?.segments ?? []).some((s) => s.key === a.segment) };
  }
  if (item.kind === 'storeWeekday') {
    const known = (store?.locations ?? []).filter((l) => l.known && l.name);
    const location = known.length === 1 ? { mode: 'single', name: known[0].name } : known.length > 1 ? { mode: 'several', count: known.length } : null;
    return { type: 'storeWeekday', page: 'storeGrowth', day: a.day, location, productValidated: false, available: true };
  }
  return null;
}
