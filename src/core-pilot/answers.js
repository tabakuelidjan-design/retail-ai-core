// Text answers built ONLY from the readers' facts (Finance, Analytics). Formatting only: no figure is computed here except putting a
// number in words. Facts and hypotheses are kept apart; every answer names its source, its period and its freshness.
const frDate = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : 'date inconnue');
const cents = (c, cur = 'EUR') => (Number.isFinite(c) ? `${(c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, ' ')} ${cur === 'EUR' ? '€' : cur}` : 'montant inconnu');
const major = (v, unit) => (Number.isFinite(v) ? (unit === 'count' ? String(v) : `${v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, ' ')} ${unit === 'EUR' ? '€' : unit}`) : 'inconnu');
const pct = (r) => (Number.isFinite(r) ? `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %` : 'n.d.');

export function payablesAnswer(p) {
  const head = `Factures fournisseurs à payer — Finance (${p.source}), au ${frDate(p.asOf)} :`;
  const sources = [{ kind: 'finance', ref: 'factures fournisseurs (Finance)', source: p.source, asOf: p.asOf }];
  const limits = ['Nordla n’effectue aucun paiement ni virement.'];
  if (p.notYetValidated) limits.push(`${p.notYetValidated} facture(s) reçue(s) pas encore validée(s) dans Finance : non comptée(s).`);
  if (!p.items.length) return { status: 'ANSWERED', answer: `${head}\nAucune facture validée ne reste à payer.`, sources, limits };
  const total = Object.entries(p.totals).map(([c, v]) => cents(v, c)).join(' + ');
  const line = (i) => {
    const when = i.calendar === 'OVERDUE' ? `EN RETARD de ${-i.daysRemaining} j` : i.calendar === 'DUE_TODAY' ? 'ÉCHÉANCE AUJOURD’HUI' : i.calendar === 'NO_DUE_DATE' ? 'sans échéance connue' : `dans ${i.daysRemaining} j`;
    return `• ${when} — ${i.supplier ?? 'fournisseur ?'}${i.invoiceNumber ? `, facture ${i.invoiceNumber}` : ''} : reste ${cents(i.remainingCents, i.currency)}${i.dueDate ? ` (échéance ${frDate(i.dueDate)})` : ''}${i.settlement === 'PARTIALLY_PAID' ? ', déjà payée en partie' : ''}`;
  };
  return { status: 'ANSWERED', answer: [`${head} ${p.items.length} facture(s), reste total ${total} ; ${p.overdue} en retard, ${p.dueSoon} à échéance sous 7 jours.`, ...p.items.slice(0, 12).map(line), ...(p.items.length > 12 ? [`… et ${p.items.length - 12} autre(s) dans Finance.`] : [])].join('\n'), sources, limits };
}

export function treasuryAnswer(t) {
  const lines = [`Trésorerie — Finance (${t.source}), au ${frDate(t.asOf)} :`]; const limits = ['Projection du moteur de trésorerie Finance : ce n’est pas un solde garanti.'];
  for (const [cur, pos] of Object.entries(t.position ?? {})) {
    const h = t.forecast?.[cur]?.horizons?.[String(t.horizonDays)];
    lines.push(`• ${cur} : position ${cents(pos.calculated?.totalCents ?? pos.observed?.totalCents, cur)} (fraîcheur : ${pos.freshness ?? 'inconnue'})${h ? ` ; à ${t.horizonDays} j : sorties engagées ${cents(h.payments?.committedCents, cur)}, entrées engagées ${cents(h.receipts?.committedCents, cur)}, dont fournisseurs en retard ${cents(h.overduePayablesCents, cur)}` : ''}`);
    for (const w of pos.warnings ?? []) limits.push(`Avertissement Finance : ${w.code}`);
  }
  if (lines.length === 1) lines.push('Aucune position bancaire ni de caisse enregistrée dans Finance.');
  if (t.undated) limits.push(`${t.undated} élément(s) sans date ne sont pas dans la projection.`);
  return { status: 'ANSWERED', answer: lines.join('\n'), sources: [{ kind: 'finance', ref: 'moteur de trésorerie (Finance)', source: t.source, asOf: t.asOf }], limits };
}

export function purchasesAnswer(p) {
  const r = p.report;
  const lines = [`Achats (factures fournisseurs) du ${frDate(r.from)} au ${frDate(r.to)} — Finance (${p.source}) : ${r.documentsCount} document(s), total ${r.total} €.`, ...r.bySupplier.slice(0, 5).map((s) => `• ${s.name ?? 'fournisseur ?'} : ${s.gross} € (${s.count})`)];
  const limits = [r.note]; if (r.excludedForeign) limits.push(`${r.excludedForeign} document(s) en devise étrangère sans montant EUR : non comptés.`);
  return { status: 'ANSWERED', answer: lines.join('\n'), sources: [{ kind: 'finance', ref: 'analyse des achats (Finance)', source: p.source, asOf: p.asOf, period: { from: r.from, to: r.to } }], limits };
}

export function salesAnswer(e) {
  if (!e.ok) return { status: 'DATA_UNAVAILABLE', answer: `Analytics ne peut pas répondre (${e.error}) : aucun chiffre n’est donné.`, sources: [], limits: [e.error] };
  const v = Object.fromEntries(e.values.map((x) => [x.key, x])); const rows = Object.fromEntries((e.comparison?.rows ?? []).map((r) => [r.key, r]));
  const ref = e.comparison?.reference;
  const cmp = (k) => (rows[k] ? ` (${pct(rows[k].delta_pct)} vs ${major(rows[k].previous, rows[k].unit)})` : '');
  const lines = [
    `Ventes du ${frDate(e.period.from)} au ${frDate(e.period.to)} (${e.period.days} j${e.period.includesToday ? ', jour en cours inclus' : ''}) — Analytics (${e.source})${ref ? `, comparées au ${frDate(ref.from)}–${frDate(ref.to)}` : ''} :`,
    `• Chiffre d’affaires net HT : ${major(v.net_sales_ex_tax?.value, v.net_sales_ex_tax?.unit)}${cmp('net_sales_ex_tax')}`,
    `• Commandes : ${major(v.order_count?.value, 'count')}${cmp('order_count')} ; panier moyen HT : ${major(v.aov_ex_tax?.value, v.aov_ex_tax?.unit)}${cmp('aov_ex_tax')}`,
  ];
  const mover = (it) => { const d = it.values?.find((x) => x.key === 'delta_abs'); const dp = it.values?.find((x) => x.key === 'delta_pct'); return `${it.label} (${major(d?.value, d?.unit)}, ${pct(dp?.value)})`; };
  if (e.movers.growth.length) lines.push(`Faits — en hausse : ${e.movers.growth.map(mover).join(' ; ')}`);
  if (e.movers.decline.length) lines.push(`Faits — en baisse : ${e.movers.decline.map(mover).join(' ; ')}`);
  lines.push(`Pourquoi : les données montrent QUI a bougé, pas la cause. Analytics ne voit pas ${e.unknownCauses.map((g) => ({ traffic: 'le trafic', ad_spend: 'les dépenses publicitaires', inventory: 'les ruptures de stock' })[g] ?? g).join(', ')} : toute cause serait une hypothèse à vérifier.`);
  const limits = [];
  if (e.freshness?.stale) limits.push(`Données ANCIENNES : calculées le ${e.freshness.dataAsOf} (il y a ${e.freshness.ageMinutes} min) — à rafraîchir avant de décider.`);
  else if (e.freshness?.dataAsOf) limits.push(`Données calculées le ${String(e.freshness.dataAsOf).replace('T', ' ').slice(0, 16)} UTC.`);
  for (const r of e.completeness?.reasons ?? []) limits.push(`Incomplet : ${r.code}${r.affects ? ` (${r.affects.join(', ')})` : ''}`);
  if (!e.comparison?.coverage?.sufficient && e.comparison) limits.push('Historique insuffisant pour une comparaison complète.');
  return { status: 'ANSWERED', answer: lines.join('\n'), sources: [{ kind: 'analytics', ref: 'moteurs Analytics (ventes, produits, canaux)', source: e.source, asOf: e.freshness?.dataAsOf ?? null, period: { from: e.period.from, to: e.period.to } }], limits };
}
