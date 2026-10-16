// Parle à Nordla -> Stock / Achats: "retrouve le fournisseur X" (search by NAME). READ ONLY, through the assistant's find_supplier / supplier_reliability tools.
// Access control, two layers: (1) the assistant is bound to the caller's company (another company's suppliers do not exist for it) and returns identity + default terms only - no contacts,
// no bank details, no documents; (2) what is SHOWN depends on the person's role: everyone who may use Parle à Nordla sees the name and country; only OWNER and ADMIN see the commercial terms
// and the reliability facts. A name that matches several suppliers is asked back, never guessed.
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const NL = String.fromCharCode(10);
const SRC = (tool, extra = {}) => ({ kind: 'procurement', ref: tool, as_of: new Date().toISOString(), ...extra });
const CAN_SEE_TERMS = new Set(['OWNER', 'ADMIN']);
const LOOKUP = /\b(retrouve|retrouver|cherche|chercher|trouve|trouver|recherche|rechercher|fiche|infos?|informations?|montre|affiche|donne|qui est)\b.*\b(fournisseur|supplier)\s+(?:nomme |appele |called |named )?([a-z0-9][a-z0-9 .&'-]{1,60})/;
const STOP = new Set(['ce', 'cet', 'cette', 'mon', 'ma', 'mes', 'le', 'la', 'les', 'du', 'de', 'des', 'un', 'une', 'principal', 'meilleur', 'moins', 'actuel', 'ouvert', 'dossier', 'produit', 'article', 'precedent', 'suivant']);
const FINANCE = /(factur|paiement|payer|tresorerie|echeance|virement|rib|iban)/;

/** @returns {Promise<object|null>} an answer in the shape of ask.js, or null when the sentence is not a supplier lookup by name. */
export async function procurementSupplierAnswer(text, assistant, actor = {}) {
  const t = norm(text);
  if (FINANCE.test(t)) return null; // invoices and payments are Finance's
  const m = LOOKUP.exec(t); if (!m) return null;
  const name = m[3].replace(/[?!.]+$/, '').trim();
  if (!name || STOP.has(name.split(' ')[0])) return null; // "ce fournisseur", "le meilleur fournisseur": no name was given
  const r = await assistant.call('find_supplier', { text: name });
  if (r.status === 'NOT_FOUND') return { status: 'ANSWERED', answer: `Je ne trouve aucun fournisseur « ${name} » dans Stock / Achats.`, sources: [SRC('find_supplier')], limits: ['Seuls les fournisseurs enregistrés dans Stock / Achats pour cette entreprise sont cherchés ; un fournisseur qui n’y est pas enregistré (par exemple seulement dans un dossier China Sourcing) n’apparaît pas.'] };
  if (r.status === 'AMBIGUOUS') return { status: 'ASK', answer: `Plusieurs fournisseurs correspondent à « ${name} » : ${r.candidates.map((c) => `${c.name}${c.country ? ` (${String(c.country).toUpperCase()})` : ''}`).join(' ; ')}. Lequel ?`, sources: [SRC('find_supplier')], limits: [] };
  if (r.status !== 'OK') return { status: 'ASK', answer: String(r.question ?? 'Quel fournisseur (nom) ?'), sources: [SRC('find_supplier')], limits: [] };
  const s = r.candidates[0]; const lines = [`Fournisseur : ${s.name}${s.country ? ` (${String(s.country).toUpperCase()})` : ''}.`]; const sources = [SRC('find_supplier')]; const limits = [];
  if (CAN_SEE_TERMS.has(actor?.role)) {
    lines.push(`Conditions par défaut : devise ${s.currency ?? 'inconnue'}, Incoterm ${s.incotermDefault ?? 'inconnu'}, délai ${s.leadTimeDays ?? '?'} j.`);
    const rel = await assistant.call('supplier_reliability', { supplierId: s.supplierId });
    if (rel.status === 'OK') {
      const f = (k) => (rel.metrics[k]?.status === 'NOT_MEASURABLE' ? `non mesurable (échantillon < ${rel.metrics[k].minSample})` : `${rel.metrics[k].numerator}/${rel.metrics[k].denominator}`);
      lines.push(`Fiabilité (faits tracés, pas de note) : réceptions à l’heure ${f('onTimeReceipts')} ; défauts ${f('defectRateUnits')} ; incidents ${rel.metrics.incidents?.total ?? 0}.`); sources.push(SRC('supplier_reliability', { supplierId: s.supplierId }));
    }
  } else limits.push('Les conditions commerciales et la fiabilité ne sont montrées qu’aux rôles Propriétaire et Administrateur.');
  return { status: 'ANSWERED', answer: lines.join(NL), sources, limits };
}
