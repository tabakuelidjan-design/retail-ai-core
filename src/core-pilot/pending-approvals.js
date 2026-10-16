// Parle à Nordla: "what is waiting for my approval?" across the modules that hold something: the Core decision journal and Stock / Achats purchase orders in PENDING_APPROVAL.
// READ ONLY. It lists; it approves nothing. Each module that is not connected is said so instead of being skipped silently.
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const NL = String.fromCharCode(10);
const ASKS = /(en attente|attend|a valider|a approuver|a faire valider).*(approbation|validation|proposition|approuv)|(proposition|approbation|validation).*(en attente|attend)|(ce que|que) je dois (approuver|valider)|ma validation/;
export const isApprovalsQuestion = (text) => ASKS.test(norm(text));

/** @param {{ runtime: object|null, procurement: object|null }} deps */
export async function pendingApprovalsAnswer({ runtime, procurement }) {
  const lines = []; const sources = []; const limits = [];
  if (runtime) {
    const o = await runtime.overview(); const list = o.decisions.filter((v) => !v.entry.human_decision && v.entry.recommendation);
    lines.push(list.length ? `Nordla Core — ${list.length} décision(s) d’achat à valider :` : 'Nordla Core — aucune décision d’achat n’attend votre validation.');
    for (const v of list) { lines.push(`• ${v.subject?.title ?? v.entry.subject.title} : recommandé « ${v.entry.recommendation.label} »`); sources.push({ kind: 'core_journal', ref: v.entry.id, case: v.source?.case_id ?? null, at: v.entry.created_at }); }
  } else { lines.push('Nordla Core — non configuré sur ce serveur : aucune décision lue.'); limits.push('CORE_NOT_CONFIGURED'); }
  if (procurement) {
    const r = await procurement.call('open_purchase_orders', {}); const pend = (r.orders ?? []).filter((x) => x.status === 'PENDING_APPROVAL');
    lines.push(pend.length ? `Stock / Achats — ${pend.length} commande(s) d’achat à approuver :` : 'Stock / Achats — aucune commande d’achat n’attend d’approbation.');
    for (const x of pend) lines.push(`• ${x.number} — ${Number.isInteger(x.totalMinor) ? `${(x.totalMinor / 100).toFixed(2).replace('.', ',')} ${x.currency ?? ''}`.trim() : 'montant inconnu'}${x.expectedDate ? `, attendue le ${x.expectedDate}` : ''}`);
    sources.push({ kind: 'procurement', ref: 'open_purchase_orders', as_of: new Date().toISOString() });
  } else { lines.push('Stock / Achats — non raccordé : aucune commande d’achat lue.'); limits.push('Stock / Achats n’est pas relié à ce serveur : ses approbations en attente ne sont pas visibles ici.'); }
  lines.push('Nordla n’approuve rien : la validation se fait par vous (Valider / Rejeter dans le Core ; approbation nominative dans Achats).');
  return { status: 'ANSWERED', answer: lines.join(NL), sources, limits };
}
