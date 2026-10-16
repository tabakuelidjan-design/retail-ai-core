// Validates a campaign handoff against a catalogue snapshot and renders a readable review sheet.
// usage: node tools/habb-editorial-check.mjs <plan.json> <catalogue-snapshot.json> [out.md]
import { readFileSync, writeFileSync } from 'node:fs';
import { checkEditorialPlan } from '../src/asset-library/index.js';

const [planPath, cataloguePath, outPath] = process.argv.slice(2);
if (!planPath || !cataloguePath) { console.error('usage: node tools/habb-editorial-check.mjs <plan.json> <catalogue.json> [out.md]'); process.exit(2); }
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const snap = JSON.parse(readFileSync(cataloguePath, 'utf8'));
const catalogue = new Map(Object.entries(snap.products));
// chantier E blocks every price except the coque's (owner-confirmed 2026-08-05): same rule here
const result = checkEditorialPlan(plan, { catalogue, priceConfirmedFor: new Set([...catalogue.keys()].filter((k) => /coque/.test(k))) });
console.log(JSON.stringify({ ok: result.ok, counts: result.counts, problems: result.problems }, null, 1));

if (outPath) {
  const kindLabel = { POST: 'Publication', STORY: 'Story', REEL: 'Reel' };
  const lines = [`# ${plan.campaign_id}`, '', `Fenêtre : ${plan.window.start} → ${plan.window.end} · statut : **${plan.status}** · exécution : ${plan.execution}`,
    `Catalogue lu le ${snap.fetched_at} (${snap.source}).`, '',
    `Contrôle automatique des faits et des règles : ${result.ok ? 'OK' : 'REFUSÉ'} · ${result.counts.posts} publications, ${result.counts.stories} stories, ${result.counts.reels} reels.`, `**Assets prêts : ${plan.items.filter((i) => i.asset_status === 'READY').length} sur ${plan.items.length} · brouillons : ${plan.items.filter((i) => i.asset_status === 'DRAFT').length} · manquants : ${plan.items.filter((i) => i.asset_status === 'MISSING').length}.** « OK » ne veut pas dire « prêt à publier ».`, ''];
  for (const it of plan.items) {
    const p = catalogue.get(it.product_ref);
    lines.push(`## J${it.day} · ${it.item_id} · ${kindLabel[it.kind]} (${it.channel})`, '',
      `- Produit réel : ${p ? `${p.title} (${p.price_eur.toFixed(2).replace('.', ',')} €)` : it.product_ref}`, `- Objectif : ${it.objective}`, `- Concept visuel : ${it.concept}`,
      `- Accroche : ${it.hook}`, `- Légende : ${(it.caption ?? '').replaceAll('\n', ' ⏎ ')}`, `- Assets : ${it.asset_status} (${it.asset_refs.length})`,
      `- Validation : ${it.validation_status}`, `- À faire avant validation : ${it.blockers.join(' · ') || '—'}`, '');
  }
  writeFileSync(outPath, `${lines.join('\n')}\n`);
}
process.exit(result.ok ? 0 : 1);
