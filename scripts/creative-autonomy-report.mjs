// The owner's report after an ideation trial, built ONLY from what the run recorded: Nordla's words are quoted as they came out of the model, nothing is
// rewritten, completed or invented. Sections: 1 concepts, 2 Nordla's own judgment (originality / commercial relevance), 3 art direction and staging,
// 4 what the scene grammar could not express, 5 calls and money. An independent review, if any, is written separately and labelled as such.
//   node scripts/creative-autonomy-report.mjs <trial outDir> <productKey> [planId]   ->  <outDir>/<productKey>/RAPPORT.md
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, productKey, planIdArg] = process.argv.slice(2);
const work = join(outDir, productKey);
const trace = JSON.parse(readFileSync(join(work, 'trace.json'), 'utf8'));
const planId = planIdArg ?? readdirSync(outDir).find((f) => f.endsWith('.plan.json'))?.replace('.plan.json', '');
const plan = planId && existsSync(join(outDir, `${planId}.plan.json`)) ? JSON.parse(readFileSync(join(outDir, `${planId}.plan.json`), 'utf8')) : null;
const result = planId && existsSync(join(outDir, `${planId}.result.json`)) ? JSON.parse(readFileSync(join(outDir, `${planId}.result.json`), 'utf8')) : null;
const journalPath = planId ? join(outDir, `${planId}.calls.jsonl`) : null;
const journal = journalPath && existsSync(journalPath) ? readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const L = [];
const q = (t) => String(t ?? '').replace(/\n/g, ' ');
L.push(`# Rapport d'essai Nordla : ${trace.mode === 'IDEATION_ONLY' ? 'IDÉATION SEULE (texte, aucune image, pas une production visuelle)' : trace.mode}`);
L.push('', `- Plan : \`${planId ?? 'inconnu'}\` · statut : **${trace.status}** · moteur texte : ${trace.engines.text} · images envoyées : 0`);
if (plan) L.push(`- Objectif donné à Nordla : « ${plan.objective} »`, `- Modèle : ${plan.model}, périmètre ${plan.scope}, ${plan.region}`);
L.push('- Tout le texte entre guillemets ou en citation vient du modèle, tel quel. Rien n\'a été réécrit.');
if (trace.error) L.push('', `> Arrêt : ${trace.error.code ?? ''} ${q(trace.error.message)}`);

L.push('', '## 1. Les trois concepts imaginés par Nordla');
for (const [i, c] of (trace.concepts ?? []).entries()) {
  L.push('', `### Concept ${i + 1} · \`${c.concept_id}\``,
    `- Idée centrale : « ${q(c.central_idea)} »`, `- Métaphore visuelle : « ${q(c.visual_metaphor)} »`, `- Histoire : « ${q(c.story)} »`,
    `- Émotion visée : « ${q(c.emotional_intent)} » · rôle du produit : ${c.product_role} · message : ${c.message_role}`,
    `- Ce qui doit rester en mémoire : « ${q(c.memory_hook)} »`, `- Pourquoi il serait distinctif (selon Nordla) : « ${q(c.distinctiveness_reason)} »`,
    `- Risques qu'il se reconnaît : ${(c.risks ?? []).map((r) => `« ${q(r)} »`).join(' ; ')}`);
}

L.push('', '## 2. Le jugement de Nordla sur ses propres concepts');
L.push('Les critères sont jugés en mots, sans note : MEETS / PARTIAL / FAILS. L\'originalité correspond à DISTINCTIVENESS et GENERIC_RISK ; la pertinence commerciale à RELEVANCE_TO_BRIEF et COMMERCIAL_CLARITY.');
L.push('> Limite : c\'est le même modèle qui a imaginé puis jugé ces concepts, ce n\'est donc pas un regard indépendant.');
const KEY = ['DISTINCTIVENESS', 'GENERIC_RISK', 'RELEVANCE_TO_BRIEF', 'COMMERCIAL_CLARITY', 'BRAND_COMPATIBILITY', 'CONCEPT_STRENGTH'];
for (const e of trace.selection?.evaluations ?? []) {
  L.push('', `### \`${e.concept_id}\``);
  for (const k of KEY) { const cr = (e.criteria ?? []).find((x) => x.criterion === k); if (cr) L.push(`- **${k}** : ${cr.outcome} · « ${q(cr.evidence)} »${cr.refinement ? ` · à renforcer : « ${q(cr.refinement)} »` : ''}`); }
}
if (trace.selection?.selection) L.push('', `Décision dérivée par les règles fixes de Nordla : **${trace.selection.selection.outcome ?? JSON.stringify(trace.selection.selection)}**`);

L.push('', '## 3. Direction artistique et mise en scène choisies par Nordla');
for (const p of trace.proposals ?? []) {
  const a = p.art_direction; const s = p.stage;
  L.push('', `### \`${p.concept.concept_id}\``,
    `- Atmosphère : « ${q(a.atmosphere)} »`, `- Lumière voulue : « ${q(a.lighting_intent)} »`, `- Matières : « ${q(a.material_language)} »`,
    `- Profondeur : ${a.depth_model} · rythme : ${a.visual_rhythm} · réalisme : ${a.realism} · température : ${a.emotional_temperature} · tension : ${a.visual_tension}`,
    `- Éléments narratifs : ${(a.narrative_elements ?? []).map((n) => `« ${q(n.element)} » (${n.zone})`).join(' ; ')}`,
    `- Mise en scène traduite : fond ${s.backdrop} ${s.backdrop_tone}, sol ${s.floor_finish} ; lumière principale ${s.key_light.kind} ${s.key_light.side} ${s.key_light.intensity} ${s.key_light.temperature}${s.accent_lights.length ? ` + ${s.accent_lights.map((l) => `${l.kind} ${l.side}`).join(', ')}` : ''} ; caméra ${s.camera.height} / ${s.camera.framing} / ${s.camera.product_position}`,
    `- Accessoires : ${s.props.length ? s.props.map((x) => `${x.shape}${x.word ? ` « ${x.word} »` : ''} ${x.material} ${x.placement} (« ${q(x.reason)} »)`).join(' ; ') : 'aucun'}`,
    `- Titre proposé (soumis à ta validation) : « ${q(s.headline)} » · texte ${s.text_placement} · prix affiché : ${s.show_price}`,
    `- Justification : « ${q(s.rationale)} »`);
}

L.push('', '## 4. Ce que Nordla voulait faire et que la grammaire actuelle ne permet pas');
let gaps = 0;
for (const p of trace.proposals ?? []) {
  const w = p.grammar_gap?.wanted_but_not_available ?? []; gaps += w.length;
  L.push(`- \`${p.concept.concept_id}\` : ${w.length ? w.map((x) => `« ${q(x)} »`).join(' ; ') : 'rien de déclaré'}`);
}
L.push('', gaps ? `Total : ${gaps} manque(s) déclaré(s) par le modèle lui-même. C'est la preuve à utiliser pour décider du prochain développement.` : 'Le modèle n\'a déclaré aucun manque. Ce constat est enregistré tel quel, il ne prouve pas que la grammaire suffit.');

L.push('', '## 5. Appels réels et coût');
L.push('| # | Étape | Type | Fournisseur | Modèle | Issue | Durée |', '|---|---|---|---|---|---|---|');
for (const t of trace.trace) L.push(`| ${t.n} | ${t.step}${t.concept_id ? ` ${t.concept_id}` : ''} | ${t.kind} | ${t.provider} | ${t.model ?? '-'} | ${t.outcome} | ${t.ms} ms |`);
const ok = journal.filter((e) => e.event === 'SUCCEEDED');
L.push('', `- Appels réussis d'après le journal : ${ok.length} · échecs : ${journal.filter((e) => e.event === 'FAILED').length} · request ids : ${ok.map((e) => e.request_id).filter(Boolean).join(', ') || 'aucun'}`);
if (result?.money) {
  const m = result.money;
  L.push(`- Coût **estimé** avant l'essai : ${m.ESTIMATE_expected_eur} €`,
    `- **Plafond** de l'application : ${m.CEILING_application_eur} €. Montant comptabilisé dans le registre de sécurité, volontairement surestimé : ${m.CEILING_ledger?.settled_eur ?? '?'} €, plus ${m.CEILING_ledger?.reserved_eur ?? 0} € réservés`,
    `- **Usage déclaré par Alibaba** : ${m.USAGE_reported_by_alibaba?.prompt_tokens} jetons en entrée et ${m.USAGE_reported_by_alibaba?.completion_tokens} en sortie, soit ≈ ${m.USAGE_reported_by_alibaba?.eur_at_list_price} € au prix catalogue`,
    `- **Facturation réelle** : uniquement dans la console Alibaba (Facturation), à relever à la main.`);
}
L.push('', `Requêtes et réponses brutes de chaque étape du Brain : \`${productKey}/brain-calls/\`.`);
writeFileSync(join(work, 'RAPPORT.md'), L.join('\n'));
console.log(join(work, 'RAPPORT.md'));
