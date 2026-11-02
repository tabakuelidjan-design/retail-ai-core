// The owner's report after an ideation trial, built ONLY from what the run recorded: Nordla's words are quoted as they came out of the model, nothing is
// rewritten, completed or invented. Sections: 1 concepts, 2 Nordla's own judgment (originality / commercial relevance), 3 art direction and staging,
// 4 what the scene grammar could not express, 5 calls and money. An independent review, if any, is written separately and labelled as such.
//   node scripts/creative-autonomy-report.mjs <trial outDir> <productKey> [planId]   ->  <outDir>/<productKey>/RAPPORT.md
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hasForbidden as __hasForbidden } from '../src/creative-autonomy/stage-contract.js';
import { inventedCapabilities } from '../src/creative-autonomy/brand-guard.js';
import { loadMerchantCreativeBrand as __loadBrand, resolveBrandProfile as __resolveProfile, artDirectionHintFor as __hintFor } from '../src/creative-autonomy/brand-profile.js';
const HABB_BRAND = __loadBrand('habb'); // HABB is tenant configuration (config/merchants/habb/creative-brand.json)
const HABB = __resolveProfile(HABB_BRAND);
const hasForbidden = (s) => __hasForbidden(s, HABB.forbidden_decor); // HABB's rules = its tenant profile

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
const sceneRun = plan?.limits?.mode === 'SCENE_AROUND_PRODUCT';
const imageEdits = journal.filter((e) => e.operation === 'IMAGE_EDIT');
L.push(`# Rapport d'essai Nordla : ${trace.mode === 'IDEATION_ONLY' ? 'IDÉATION SEULE (texte, aucune image, pas une production visuelle)' : sceneRun ? 'SCÈNE AUTOUR DU VRAI PRODUIT (concept sélectionné par Nordla)' : trace.mode}`);
L.push('', `- Plan : \`${planId ?? 'inconnu'}\` · statut : **${trace.status}** · moteur texte : ${trace.engines.text} · images envoyées : ${sceneRun ? `${imageEdits.filter((e) => e.event === 'RESERVED').length} plaque (le produit détouré de la photo, sur fond gris), à ${plan.limits.image.model}, périmètre ${plan.limits.image.scope}` : 0}`);
if (plan) L.push(`- Objectif donné à Nordla : « ${plan.objective} »`, `- Modèle : ${plan.model}, périmètre ${plan.scope}, ${plan.region}`);
L.push('- Tout le texte entre guillemets ou en citation vient du modèle, tel quel. Rien n\'a été réécrit.');
if (trace.error) L.push('', `> Arrêt : **${trace.status}** à l'étape ${trace.stopped_at?.step ?? '?'}${trace.stopped_at?.concept_id ? ` (\`${trace.stopped_at.concept_id}\`)` : ''} : ${trace.error.code ?? ''}${trace.error.field ? ` sur \`${trace.error.field}\`` : ''}. ${q(trace.error.message)}`, '> Les sections ci-dessous présentent ce qui a réellement été obtenu avant l\'arrêt, rien d\'autre.');

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
  const warn = (x) => { const d = hasForbidden(x); const c = inventedCapabilities(x, ''); return d || c.length ? ` ⚠ contraire aux règles HABB (${[d, ...c].filter(Boolean).join(', ')})` : ''; };
  for (const k of KEY) { const cr = (e.criteria ?? []).find((x) => x.criterion === k); if (cr) L.push(`- **${k}** : ${cr.outcome} · « ${q(cr.evidence)} »${cr.refinement ? ` · à renforcer : « ${q(cr.refinement)} »${warn(cr.refinement)}` : ''}`); }
}
if (trace.selection?.selection) L.push('', `Décision dérivée par les règles fixes de Nordla : **${trace.selection.selection.outcome ?? JSON.stringify(trace.selection.selection)}**`);

L.push('', '## 3. Direction artistique et mise en scène choisies par Nordla');
// built from what the run REALLY obtained: accepted art directions and stages, and every attempted stage with its exact refusal (even after STOPPED_ERROR)
const conceptIds = (trace.concepts ?? []).map((c) => c.concept_id);
const artOf = (cid) => trace.art_directions?.[cid] ?? (trace.proposals ?? []).find((p) => p.concept.concept_id === cid)?.art_direction ?? null;
const stageOf = (cid) => trace.stages?.[cid] ?? (trace.proposals ?? []).find((p) => p.concept.concept_id === cid)?.stage ?? null;
const callsDir = join(work, 'brain-calls');
const callFiles = existsSync(callsDir) ? readdirSync(callsDir).sort() : [];
const recorded = (stepName, cid) => callFiles.filter((f) => f.endsWith('.response.txt') && f.includes(`-${stepName}-${cid}`)).map((f) => {
  const merged = f.replace('.response.txt', '.merged.txt');
  let raw = null; try { raw = JSON.parse(readFileSync(join(callsDir, f), 'utf8')); } catch { /* not JSON: shown as such */ }
  return { file: f, raw, merged: callFiles.includes(merged) };
});
const stageLine = (s) => `fond ${s.backdrop} ${s.backdrop_tone}, sol ${s.floor_finish} ; lumière principale ${s.key_light?.kind} ${s.key_light?.side} ${s.key_light?.intensity} ${s.key_light?.temperature}${(s.accent_lights ?? []).length ? ` + ${s.accent_lights.map((l) => `${l.kind} ${l.side}`).join(', ')}` : ''} ; caméra ${s.camera?.height} / ${s.camera?.framing} / ${s.camera?.product_position}`;
const propsLine = (s) => ((s.props ?? []).length ? s.props.map((x) => `${x.shape}${x.word ? ` « ${x.word} »` : ''} ${x.material} ${x.placement}${x.reason ? ` (« ${q(x.reason)} »)` : ''}`).join(' ; ') : 'aucun');
for (const cid of conceptIds) {
  L.push('', `### \`${cid}\``);
  const a = artOf(cid);
  if (a) {
    L.push(`- Direction artistique ACCEPTÉE. Atmosphère : « ${q(a.atmosphere)} » ; lumière : « ${q(a.lighting_intent)} » ; matières : « ${q(a.material_language)} »`,
      `- Profondeur : ${a.depth_model} · rythme : ${a.visual_rhythm} · réalisme : ${a.realism} · température : ${a.emotional_temperature} · tension : ${a.visual_tension}`,
      `- Éléments narratifs : ${(a.narrative_elements ?? []).map((n) => `« ${q(n.element)} » (${n.zone})`).join(' ; ')}`);
  } else L.push('- Direction artistique : non obtenue (arrêt avant ou pendant cette étape).');
  // every ART_DIRECT / STAGE attempt for this concept, in order, with its outcome from the trace
  for (const t of trace.trace.filter((x) => x.concept_id === cid && /^(ART_DIRECT|STAGE)/.test(x.step))) {
    const isStage = t.step.startsWith('STAGE');
    const rec = recorded(t.step, cid)[0];
    const attempt = t.outcome === 'ERROR' ? `REFUSÉE : ${t.detail?.code ?? ''} sur \`${t.detail?.field ?? '?'}\` (« ${q(t.detail?.message)} »)` : 'ACCEPTÉE';
    L.push(`- Tentative ${t.step}${t.repair_scope ? ` (réparation limitée à \`${t.repair_scope}\`)` : ''} : ${attempt}`);
    if (t.repair_merge?.applied && t.repair_merge.discarded_outside_scope?.length) L.push(`  - Changements du modèle HORS du champ réparé, écartés : ${t.repair_merge.discarded_outside_scope.map((d) => `\`${d}\``).join(', ')}`);
    if (isStage && rec?.raw && t.outcome === 'ERROR') L.push(`  - Mise en scène tentée (réponse brute) : ${stageLine(rec.raw)} ; accessoires : ${propsLine(rec.raw)} ; titre : « ${q(rec.raw.headline)} » ; justification : ${String(rec.raw.rationale ?? '').length} caractères`);
  }
  const s = stageOf(cid);
  if (s) L.push(`- Mise en scène ACCEPTÉE : ${stageLine(s)}`, `- Accessoires : ${propsLine(s)}`, `- Titre proposé (soumis à ta validation) : « ${q(s.headline)} » · texte ${s.text_placement} · prix affiché : ${s.show_price}`, `- Justification : « ${q(s.rationale)} »`);
  else L.push('- Mise en scène : aucune acceptée.');
}

L.push('', '## 4. Ce que Nordla voulait faire et que la grammaire actuelle ne permet pas');
let gaps = 0;
const flag = (x) => { const d = hasForbidden(x); const c = inventedCapabilities(x, ''); return d || c.length ? ` ⚠ contraire aux règles HABB (${[d, ...c].filter(Boolean).join(', ')}) : ne sera jamais produit` : ''; };
for (const cid of conceptIds) {
  const accepted = stageOf(cid)?.wanted_but_not_available ?? null;
  const attempted = recorded('STAGE', cid).concat(recorded('STAGE_REPAIR', cid)).flatMap((r) => r.raw?.wanted_but_not_available ?? []);
  const w = accepted ?? attempted; gaps += w.length;
  L.push(`- \`${cid}\` : ${w.length ? w.map((x) => `« ${q(x)} »${flag(x)}`).join(' ; ') : 'rien de déclaré'}${!accepted && attempted.length ? ' (déclaré dans une mise en scène tentée, puis refusée)' : ''}`);
}
L.push('', gaps ? `Total : ${gaps} manque(s) déclaré(s) par le modèle lui-même. C'est la preuve à utiliser pour décider du prochain développement.` : 'Le modèle n\'a déclaré aucun manque. Ce constat est enregistré tel quel, il ne prouve pas que la grammaire suffit.');

if (sceneRun) {
  L.push('', '## 4 bis. La scène générée autour du vrai produit');
  const produced = trace.trace.find((t) => t.step === 'PRODUCE');
  if (produced) L.push(`- Concept produit : \`${produced.detail.concept_id ?? 'aucun'}\` (choix de Nordla à l'étape SELECT : ${produced.detail.selection_outcome}). Concepts non produits : ${produced.detail.not_produced.map((c) => `\`${c}\``).join(', ') || 'aucun'}.`);
  for (const r of trace.trace.filter((t) => t.step === 'RENDER')) {
    const d = r.detail ?? {};
    if (r.outcome === 'ERROR') {
      L.push(`- Rendu **refusé** : ${d.code} · ${q(d.message)}`);
      for (const v of d.evidence?.variants ?? []) L.push(`  - variante ${v.variant} : ${v.pass ? 'acceptée' : `refusée (${v.rejections.join(', ')})`}${v.warnings?.length ? ` · avertissements : ${v.warnings.join(', ')}` : ''}`);
      continue;
    }
    L.push(`- Rendu ${d.reused_scene ? '(scène réutilisée, aucun nouvel appel)' : `${d.model} · requête ${d.request_id ?? '?'} · variante choisie : ${d.chosen_variant}`}`);
    if (!d.reused_scene) for (const v of d.variants ?? []) L.push(`  - variante ${v.variant} : ${v.pass ? 'acceptée' : `refusée (${v.rejections.join(', ')})`}${v.warnings?.length ? ` · avertissements : ${v.warnings.join(', ')}` : ''}`);
  }
  const prop = (() => { try { return JSON.parse(readFileSync(join(work, 'propositions.json'), 'utf8'))[0]; } catch { return null; } })();
  const chosen = prop?.scene?.variants?.find((v) => v.variant === prop.scene.chosen_variant);
  if (chosen) {
    L.push(`- Mesures de la variante retenue : produit retrouvé à (${chosen.alignment.dx}, ${chosen.alignment.dy}) px, échelle ${chosen.alignment.scale}, corrélation des contours ${chosen.alignment.edge_ncc} · bordure fantôme ${chosen.ghost?.share ?? '?'} · ombre de contact ${chosen.contact_shadow?.present ? 'mesurée' : 'NON mesurée'} · reflet ${chosen.reflection?.present ? 'mesuré' : 'non mesuré'}${chosen.reflection?.expected ? ' (attendu : sol miroir)' : ''} · côté de la lumière ${chosen.light?.consistent === false ? 'DIFFÉRENT de la photo' : 'cohérent'}`);
    L.push(`- Image finale : \`${prop.image}\` · fidélité du produit : ${prop.technical_quality.product_fidelity.pass ? 'pixels de la photo restaurés (preuve)' : 'ÉCHEC'} · défauts techniques : ${prop.technical_quality.defects.join(', ') || 'aucun'}`);
  }
  L.push('> Restaurer les pixels authentiques ne prouve pas que l\'image est réaliste : ombre, reflet et lumière sont des mesures indicatives. Le jugement final est celui du propriétaire, à l\'œil, en taille réelle.');
}

L.push('', '## 5. Appels réels et coût');
L.push('| # | Étape | Type | Fournisseur | Modèle | Issue | Durée |', '|---|---|---|---|---|---|---|');
for (const t of trace.trace) L.push(`| ${t.n} | ${t.step}${t.concept_id ? ` ${t.concept_id}` : ''} | ${t.kind} | ${t.provider} | ${t.model ?? '-'} | ${t.outcome} | ${t.ms} ms |`);
const ok = journal.filter((e) => e.event === 'SUCCEEDED');
L.push('', `- Réparations : ${trace.repairs?.used ?? 0} utilisée(s) sur ${trace.repairs?.allowed ?? 0} autorisée(s)${plan?.limits ? ` · plafond d'appels texte : ${plan.limits.max_text_calls_per_product} · plafond de dépense : ${plan.limits.max_spend_eur} €` : ''}`);
L.push(`- Appels réussis d'après le journal : ${ok.length} · échecs : ${journal.filter((e) => e.event === 'FAILED').length} · request ids : ${ok.map((e) => e.request_id).filter(Boolean).join(', ') || 'aucun'}`);
if (result?.money) {
  const m = result.money;
  L.push(`- Coût **estimé** avant l'essai : ${plan?.money?.ESTIMATE_expected_eur ?? m.ESTIMATE_expected_eur} €${sceneRun ? ` (dont l'appel d'image : ${plan.money.ESTIMATE_parts?.image_call_usd} USD au prix catalogue de Francfort)` : ''}`,
    `- **Plafond** de l'application : ${m.CEILING_application_eur} €. Montant comptabilisé dans le registre de sécurité, volontairement surestimé : ${m.CEILING_ledger?.settled_eur ?? '?'} €, plus ${m.CEILING_ledger?.reserved_eur ?? 0} € réservés`,
    `- **Usage déclaré par Alibaba** : ${m.USAGE_reported_by_alibaba?.prompt_tokens} jetons en entrée et ${m.USAGE_reported_by_alibaba?.completion_tokens} en sortie, soit ≈ ${m.USAGE_reported_by_alibaba?.eur_at_list_price} € au prix catalogue`,
    `- **Facturation réelle** : uniquement dans la console Alibaba (Facturation), à relever à la main.`);
}
L.push('', `Requêtes et réponses brutes de chaque étape du Brain : \`${productKey}/brain-calls/\`.`);
writeFileSync(join(work, 'RAPPORT.md'), L.join('\n'));
console.log(join(work, 'RAPPORT.md'));
