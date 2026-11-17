// What a creative brief may take from Paramètres > Général (the module-facing context of the `creative` reader). READ ONLY, allowlisted, never invented.
// It is CONTEXT: the explicit objective of a brief always stays first, and this adds no price, stock, delay or claim (those come from verified product facts).
// Left out on purpose: the budget amount (an internal figure), every legal / billing field, the private contact details of a place that is not public.
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));

/** @param {object|null} ctx result of generalService.contextFor({ module: 'creative' }) @returns {object|null} null when there is nothing to add */
export function commerceContextForBrief(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const o = ctx.objectives ?? {}; const c = o.constraints ?? {};
  const out = clean({
    commerce: text(ctx.profile?.name, 80), site: text(ctx.profile?.website, 200), description: text(ctx.profile?.description, 280),
    activite_principale: text(ctx.activity?.main?.label ?? ctx.activity?.main?.value, 80),
    priorite_du_moment: text(o.priority?.label ?? o.priority?.value, 120), precision_priorite: text(o.priority?.note, 200), resultat_attendu: text(o.expected_result, 200), echeance: text(o.deadline, 10),
    offres_a_mettre_en_avant: (o.featured_offers ?? []).map((x) => text(x?.label, 80)).filter(Boolean).slice(0, 10),
    contraintes: clean({ temps: text(c.time?.note, 200), stock: text(c.stock?.note, 200), production: text(c.production?.note, 200) }),
    lieux_publics: (ctx.places ?? []).map((p) => clean({ nom: text(p.name, 80), adresse: [p.address?.street, p.address?.postal_code, p.address?.city].filter(Boolean).join(' ') || null, telephone: text(p.phone, 30), email: text(p.email, 120) })).filter((p) => Object.keys(p).length),
  });
  if (out.contraintes && !Object.keys(out.contraintes).length) delete out.contraintes;
  return Object.keys(out).length ? out : null;
}
