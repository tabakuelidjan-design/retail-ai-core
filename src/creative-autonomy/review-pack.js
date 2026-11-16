// C4 (2026-11-06): the MANUAL ARTISTIC REVIEW PACK. Nothing here ranks, scores or accepts a proposal: it puts the right pieces in front of the owner, in the right order, and names the step to redo for each defect.
//   Order of judgement: (1) WITHOUT the title: the idea and the hierarchy; (2) at FULL SIZE: the support, the light, the outlines (crop at 100 % and at 300 %); (3) WITH the title: is the promise backed by the facts?
//   Two facts are kept apart, never merged: the ANCHORING of the case on the planned line (measured on the product, always known) and the CONTACT with the decor (measured on the decor without the product, may stay
//   "À vérifier par le propriétaire"). A request that describes a ledge proves nothing; a block drawn afterwards is never used to confirm it.
//   The verdicts are MANUAL and SEPARATE: visual impact, and the publication decision. This module only leaves them empty for the owner.
// Optional module: a failure here must never stop a run (the caller catches it and records REVIEW_PACK_NOT_BUILT).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measureSupportContact, contactReviewCrop, CONTACT_STATUS, OWNER_REVIEW_LABEL } from './support-contact.js';
import { encodePng } from '../creative-intelligence/png-encode.js';
import { decodePng } from '../creative-intelligence/png-pixels.js';

export const REVIEW_STEPS = Object.freeze([
  { id: 'SANS_TITRE', title: '1. Sans titre : l\'idée et la hiérarchie', piece: 'composite sans titre', questions: ['Que raconte la scène sur CE produit ?', 'Où va le regard à taille de téléphone ?', 'La scène est-elle générique ou vide ?'] },
  { id: 'TAILLE_REELLE', title: '2. À taille réelle : l\'appui, la lumière, les contours', piece: 'composite sans titre à 100 % + recadrage du point d\'appui à 100 % et 300 %', questions: ['Le boîtier est-il posé : contact, ombre, câble visible ?', 'La lumière vient-elle du même côté que celle du produit, au même niveau ?', 'Les contours sont-ils nets, sans halo ni frange ?', 'Une teinte interdite ou un objet parasite apparaît-il ?'] },
  { id: 'AVEC_TITRE', title: '3. Avec le titre : la promesse est-elle étayée ?', piece: 'image finale', questions: ['Le titre dit-il quelque chose que les faits du produit prouvent ?', 'L\'image renforce-t-elle la promesse, ou la contredit-elle ?', 'Le texte touche-t-il le produit ?'] },
]);

/** Defect -> the step to redo. The order of the rows is the order of the steps in the pipeline. */
export const DEFECT_STEPS = Object.freeze([
  { defect: 'Idée générique, scène vide, hiérarchie illisible', redo: 'Concept / ART_DIRECT (le détail porteur), puis STAGE (position, lumière)', step: 'SANS_TITRE' },
  { defect: 'Support absent ou incohérent', redo: 'STAGE (support_surface) ou nouvelle génération', step: 'TAILLE_REELLE' },
  { defect: 'Produit flottant, base sans appui', redo: 'Contact (ancrage sur le corps) ou compositing ; si le contact est « À vérifier », voir l\'action proposée', step: 'TAILLE_REELLE' },
  { defect: 'Lumière ou ombre incohérentes', redo: 'STAGE (côté de la lumière principale), puis nouvelle génération', step: 'TAILLE_REELLE' },
  { defect: 'Halo ou contour', redo: 'Compositing (masque de découpe)', step: 'TAILLE_REELLE' },
  { defect: 'Contour du produit qui se fond dans le décor (lisibilité)', redo: 'STAGE (décor, valeur ou teinte du fond, lumière de bord) ; jamais un fond imposé', step: 'TAILLE_REELLE' },
  { defect: 'Teinte interdite ou objet parasite hors emprise', redo: 'Génération (termes négatifs, autre variante)', step: 'TAILLE_REELLE' },
  { defect: 'Texte sur le produit', redo: 'Mise en page (zone de titre) ou déplacement du produit', step: 'AVEC_TITRE' },
  { defect: 'Promesse non étayée', redo: 'Titre et faits (jamais l\'image)', step: 'AVEC_TITRE' },
]);

/**
 * READABILITY OF THE PRODUCT OUTLINE (lot A, 2026-11-07). The measure comes from scripts/creative-autonomy/readability.py (CIELAB difference between the product's inner edge and the decor just outside it).
 * It replaces any rule on the colour or value of the background: a bright or colourful decor is open, what is flagged is a stretch of outline whose value AND hue are those of its surroundings.
 * It FLAGS for the owner ("À vérifier par le propriétaire"), it never rejects and never scores. Thresholds are PROVISIONAL (two real renders, a rough reference mask, synthetic scenes).
 */
export const READABILITY_ALERT = Object.freeze({ share_below: 0.5, median_below: 13, weak_above: 0.25, clear_dE: 15, weak_dE: 8 });
export function readabilityFlag(measure) {
  const g = measure?.['ensemble hors base'];
  if (!g) return { status: 'Non mesurée', flagged: false, rejects: false, reasons: ['la lisibilité du contour n\'est pas mesurée pour ce rendu'] };
  const reasons = [];
  if (g.share_dE_ge_15 < READABILITY_ALERT.share_below) reasons.push(`seulement ${Math.round(g.share_dE_ge_15 * 100)} % du contour (hors base) se détache nettement du décor (seuil de signalement : ${Math.round(READABILITY_ALERT.share_below * 100)} %)`);
  if (g.median_dE < READABILITY_ALERT.median_below) reasons.push(`écart médian ${g.median_dE} (seuil de signalement : ${READABILITY_ALERT.median_below})`);
  if (g.share_dE_lt_8 > READABILITY_ALERT.weak_above) reasons.push(`${Math.round(g.share_dE_lt_8 * 100)} % du contour est presque invisible (seuil : ${Math.round(READABILITY_ALERT.weak_above * 100)} %)`);
  const flagged = reasons.length > 0;
  return { status: flagged ? OWNER_REVIEW_LABEL : 'Contour lisible (signal automatique)', flagged, rejects: false, reasons, sections: measure, action: flagged ? 'Regardez où le contour se fond dans le décor (la section « haut » de la mesure dit si c\'est le sommet) : reprenez STAGE (décor, valeur ou teinte du fond, lumière de bord) ; une lumière ou une couleur de fond peut convenir, ce qui compte est que le produit se détache.' : null };
}

/** SUPPORT DRAWN BY THE DECOR (support_check.py): COMPATIBLE passes silently, INCOMPATIBLE is shown loudly (a pack should not reach the owner with it: the engine refuses the variant), UNCERTAIN goes to the owner's review. */
export function supportDrawnFlag(check) {
  if (!check) return { status: 'Non mesuré', flagged: true, outcome: 'NOT_MEASURED', reasons: ["la surface dessinée sous le point d'appui n'est pas mesurée pour ce rendu"], action: "Regardez à l'œil si le pied du boîtier repose sur le dessus de la surface, pas devant sa face." };
  const flagged = check.outcome !== 'COMPATIBLE';
  const status = check.outcome === 'COMPATIBLE' ? 'Appui dessiné compatible (mesure automatique)' : check.outcome === 'INCOMPATIBLE' ? 'APPUI INCOMPATIBLE : le produit serait posé devant la face, pas sur le dessus' : OWNER_REVIEW_LABEL;
  return { status, flagged, outcome: check.outcome, reason: check.reason, reasons: check.detail ? [check.detail] : [], gap_px: check.gap_px ?? null,
    action: flagged ? "Regardez le recadrage de l'appui : le bas du boîtier repose-t-il sur le dessus de la surface dessinée ? Sinon, reprenez STAGE (hauteur de la surface) et régénérez le décor." : null };
}

/** What the owner can DO when the contact with the decor stays ambiguous (one line per missing code, in the order of usefulness). */
const OWNER_ACTIONS = Object.freeze({
  NO_SUPPORT_EDGE_AT_CONTACT: 'Regardez le recadrage à 300 % : si le pied du boîtier repose visiblement sur un rebord ou un plan, vous pouvez valider l\'appui. Sinon, demandez un nouveau rendu avec un rebord franc à la ligne de contact (étape à reprendre : STAGE, support), ou choisissez une autre variante.',
  HANGING_PART_ON_A_PLANE: 'Vérifiez que la pointe du câble retombe devant une face visible du support et qu\'elle ne flotte pas dans le vide ; sinon, reprenez STAGE (le support doit descendre sous le câble).',
  NO_FLOOR_PLANE_FOUND: 'Aucune ligne mur/sol n\'est trouvée : vérifiez à l\'œil que le boîtier est posé sur un sol continu ; sinon reprenez STAGE (support).',
  LIGHT_NOT_COMPARED: 'La lumière du décor n\'est pas mesurée automatiquement : comparez à l\'œil le côté de l\'ombre et de la lumière avec ceux du produit.',
});
const MISSING_FR = Object.freeze({
  NO_SUPPORT_EDGE_AT_CONTACT: "Aucun rebord net n'est dessiné là où le pied du boîtier repose : le support demandé n'est pas vérifié dans l'image.",
  HANGING_PART_ON_A_PLANE: 'Une partie (le câble) pend sous la ligne de contact : sur un sol uni, sa pointe flotte ou traverse le sol, et cette relation ne se mesure pas.',
  NO_FLOOR_PLANE_FOUND: "Aucune ligne mur/sol n'est trouvée au-dessus de la ligne de contact : le sol continu n'est pas vérifié.",
});
const codesOf = (missing) => (missing ?? []).map((m) => /^[A-Z_]+/.exec(String(m))?.[0]).filter(Boolean);
export function ownerActionsForContact(contact) {
  if (contact.status === CONTACT_STATUS.CONFIRMED) return [];
  const actions = codesOf(contact.missing).map((c) => OWNER_ACTIONS[c]).filter(Boolean);
  actions.push(OWNER_ACTIONS.LIGHT_NOT_COMPARED);
  return [...new Set(actions)];
}

/**
 * @param {{ outDir: string, finalPath: string, noTitlePath: string, decorPath: string, plate: object, box: number[], canvas: number[], stage: object, concept?: object, facts?: object }} input
 *   plate = the decor's meta (contact_front, body_anchor, bottom_front), box = [x0, y0, w, h] from the compositor report.
 */
export function buildReviewPack({ outDir, finalPath, noTitlePath, decorPath, plate, box, canvas, stage, concept = null, facts = null, readability = null, supportCheck = null }) {
  mkdirSync(outDir, { recursive: true });
  const [bx, by, bw, bh] = box; const boxObj = { x0: bx, y0: by, w: bw, h: bh }; const [W, H] = canvas;
  // the whole body_anchor travels with the point (anchored, drop_px, source): without it a hanging cable would be ignored and a floor contact falsely CONFIRMED
  const contactPoint = plate.contact_front ? { ...(plate.body_anchor ?? {}), x: plate.contact_front[0], y: plate.contact_front[1], base_w_px: plate.body_anchor?.base_w_px ?? bw } : null;
  const decorPng = readFileSync(decorPath);
  const contact = contactPoint ? measureSupportContact({ decorPng, contact: contactPoint, supportSurface: stage.support_surface ?? 'FLOOR' }) : null;
  const notitle = readFileSync(noTitlePath);
  // the pieces
  copyFileSync(noTitlePath, join(outDir, '1-sans-titre.png'));
  copyFileSync(finalPath, join(outDir, '4-avec-titre.png'));
  let crop100 = null; let crop300 = null;
  if (contactPoint) {
    crop100 = contactReviewCrop({ compositePng: notitle, contact: contactPoint, box: boxObj, scale: 1 });
    crop300 = contactReviewCrop({ compositePng: notitle, contact: contactPoint, box: boxObj, scale: 3 });
    writeFileSync(join(outDir, '2-appui-100.png'), crop100.png); writeFileSync(join(outDir, '3-appui-300.png'), crop300.png);
  }
  const lowerEdge = by + bh; const hangPx = plate.body_anchor?.drop_px ?? 0;
  const anchoring = contactPoint ? {
    FACT: 'ANCRAGE DU BOÎTIER SUR LA LIGNE PRÉVUE (mesuré sur le produit)',
    status: plate.body_anchor?.anchored ? 'BOITIER_POSE_SUR_LA_LIGNE_PREVUE' : 'PRODUIT_SANS_PARTIE_PENDANTE_PLACE_PAR_SA_BOITE',
    contact_line_y: contactPoint.y, detected_on: plate.body_anchor?.source ?? null, base_width_px: contactPoint.base_w_px,
    hanging_part_px: hangPx, cable_visible: lowerEdge <= H - 4, hanging_tip_y: lowerEdge,
    note: 'La base du boîtier est placée sur la ligne de contact décidée par STAGE ; ce fait ne dit rien du décor.',
  } : { FACT: 'ANCRAGE DU BOÎTIER SUR LA LIGNE PRÉVUE', status: 'NON_MESURE', note: 'Ce rendu n\'a pas de géométrie d\'ancrage (rendu antérieur à C2).' };
  const contactBlock = contact ? {
    FACT: 'CONTACT CONFIRMÉ AVEC LE DÉCOR (mesuré sur le décor, sans le produit)',
    status: contact.status, label: contact.status === CONTACT_STATUS.CONFIRMED ? 'Contact confirmé' : OWNER_REVIEW_LABEL, support_requested: stage.support_surface ?? 'FLOOR',
    measurements: contact.measurements, missing: contact.missing ?? [], missing_fr: codesOf(contact.missing).map((c) => MISSING_FR[c]).filter(Boolean), verified_in_image: contact.verified_in_image ?? false,
    owner_actions: ownerActionsForContact(contact), crop_rect: crop300?.rect ?? null,
    note: 'Décrit n\'est pas vérifié : un support demandé dans le texte n\'est pas un support dessiné. Aucun bloc n\'est ajouté après coup pour le confirmer.',
  } : { FACT: 'CONTACT CONFIRMÉ AVEC LE DÉCOR', status: 'NON_MESURE', label: OWNER_REVIEW_LABEL, owner_actions: [OWNER_ACTIONS.LIGHT_NOT_COMPARED] };
  const pack = {
    kind: 'REVIEW_PACK_C4', automatic_ranking: false, canvas: [W, H],
    pieces: { sans_titre: '1-sans-titre.png', appui_100: crop100 ? '2-appui-100.png' : null, appui_300: crop300 ? '3-appui-300.png' : null, avec_titre: '4-avec-titre.png' },
    steps: REVIEW_STEPS, ancrage_boitier: anchoring, contact_decor: contactBlock, lisibilite_contour: readabilityFlag(readability), support_dessine: supportDrawnFlag(supportCheck), defect_to_step: DEFECT_STEPS,
    promise: { headline: stage.headline ?? null, facts_lines: facts?.facts_lines ?? null, central_idea: concept?.central_idea ?? null },
    // two SEPARATE manual verdicts, left empty: nothing in the pipeline fills them
    verdicts: { impact_visuel: { jugement: null, par: null, le: null, defauts: [] }, decision_publication: { decision: null, par: null, le: null }, rule: 'jugement manuel ; l\'impact visuel et la décision de publication sont deux décisions séparées' },
  };
  writeFileSync(join(outDir, 'revue.json'), JSON.stringify(pack, null, 1));
  writeFileSync(join(outDir, 'revue.html'), renderReviewHtml(pack));
  return pack;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export function renderReviewHtml(p) {
  const a = p.ancrage_boitier; const c = p.contact_decor; const ok = c.status === CONTACT_STATUS.CONFIRMED;
  const step = (i) => p.steps[i];
  const li = (arr) => `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const img = (src, alt, cls = '') => (src ? `<figure class="${cls}"><img src="${esc(src)}" alt="${esc(alt)}"><figcaption>${esc(alt)}</figcaption></figure>` : '<p class="muted">Pièce non disponible pour ce rendu.</p>');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revue artistique</title>
<style>:root{--bg:#f7f6f3;--ink:#1b2430;--mut:#5d6672;--line:#d9d6cf;--card:#fff;--warn:#8a5a00;--warnbg:#fff4dc;--ok:#1f6a45;--okbg:#e4f3ea}
@media (prefers-color-scheme:dark){:root{--bg:#12161c;--ink:#eceff3;--mut:#a3acb8;--line:#2c3440;--card:#1a2029;--warn:#f0c36a;--warnbg:#3a2f14;--ok:#7fd1a5;--okbg:#17302400}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,Segoe UI,Arial,sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.1rem;margin:0 0 8px}p{margin:.3em 0}.muted{color:var(--mut)}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}.row{display:flex;gap:16px;flex-wrap:wrap}figure{margin:0}figure img{max-width:100%;height:auto;border:1px solid var(--line);display:block}
figcaption{font-size:.85rem;color:var(--mut);margin-top:4px}.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.fact{border:1px solid var(--line);border-radius:8px;padding:12px}.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600;font-size:.9rem}
.ok{background:var(--okbg);color:var(--ok)}.warn{background:var(--warnbg);color:var(--warn)}table{border-collapse:collapse;width:100%}td,th{border-top:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{font-size:.85rem;color:var(--mut)}
.verdict{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.box{border:1px dashed var(--line);border-radius:8px;padding:12px;min-height:90px}.crop{max-width:100%;overflow:auto}</style></head><body><main>
<h1>Revue artistique manuelle</h1><p class="muted">Aucun classement automatique. Jugez dans l'ordre : sans titre, à taille réelle, puis avec le titre. Les deux verdicts sont distincts et ne sont jamais remplis par Nordla.</p>
<section><h2>Deux faits à ne pas confondre</h2><div class="pair">
<div class="fact"><span class="badge ok">${a.status === 'BOITIER_POSE_SUR_LA_LIGNE_PREVUE' ? 'Boîtier posé sur la ligne prévue' : esc(a.status)}</span><h2 style="margin-top:8px">Ancrage du boîtier</h2><p class="muted">${esc(a.FACT)}</p>
${a.contact_line_y ? `<p>Ligne de contact : <b>y = ${a.contact_line_y} px</b> · largeur du pied : ${a.base_width_px} px · mesuré sur : ${esc(a.detected_on)}</p><p>Câble pendant : ${a.hanging_part_px} px, <b>${a.cable_visible ? 'visible, dans le cadre' : 'COUPÉ par le cadre'}</b> (pointe à y = ${a.hanging_tip_y} px)</p>` : ''}<p class="muted">${esc(a.note)}</p></div>
<div class="fact"><span class="badge ${ok ? 'ok' : 'warn'}">${esc(c.label)}</span><h2 style="margin-top:8px">Contact avec le décor</h2><p class="muted">${esc(c.FACT)}</p>
${c.support_requested ? `<p>Support demandé : <b>${esc(c.support_requested)}</b> · vérifié dans l'image : <b>${c.verified_in_image ? 'oui' : 'non'}</b></p>` : ''}${(c.missing_fr ?? []).length ? li(c.missing_fr) : ''}<p class="muted">${esc(c.note ?? '')}</p></div></div>
${ok ? '' : `<p style="margin-top:12px"><b>Ce que vous pouvez faire :</b></p>${li(c.owner_actions)}`}</section>
${p.support_dessine ? `<section><h2>Appui dessiné par le décor</h2><p><span class="badge ${p.support_dessine.flagged ? 'warn' : 'ok'}">${esc(p.support_dessine.status)}</span></p>${(p.support_dessine.reasons ?? []).length ? li(p.support_dessine.reasons) : ''}${p.support_dessine.action ? `<p>${esc(p.support_dessine.action)}</p>` : ''}<p class="muted">Mesure automatique sur le décor seul (profils de luminance) ; une mesure incertaine se juge à l'œil.</p></section>` : ''}
${p.lisibilite_contour ? `<section><h2>Lisibilité du contour du produit</h2><p><span class="badge ${p.lisibilite_contour.flagged ? 'warn' : 'ok'}">${esc(p.lisibilite_contour.status)}</span></p>${(p.lisibilite_contour.reasons ?? []).length ? li(p.lisibilite_contour.reasons) : ''}${p.lisibilite_contour.action ? `<p>${esc(p.lisibilite_contour.action)}</p>` : ''}<p class="muted">Signal automatique provisoire : il ne rejette jamais, le jugement est le vôtre.</p></section>` : ''}
<section><h2>${esc(step(0).title)}</h2>${li(step(0).questions)}<div class="row">${img(p.pieces.sans_titre, 'Composite sans titre (produit authentique, décor, ombre ; aucun texte)')}</div></section>
<section><h2>${esc(step(1).title)}</h2>${li(step(1).questions)}<div class="pair">${img(p.pieces.appui_100, 'Point d\'appui et câble, taille réelle (100 %) ; trait cyan = ligne de contact prévue', 'crop')}${img(p.pieces.appui_300, 'Même zone à 300 % (pixels durs) ; trait cyan = ligne de contact prévue', 'crop')}</div><p class="muted">La lumière et les contours se jugent aussi sur la pièce 1 affichée à 100 %.</p></section>
<section><h2>${esc(step(2).title)}</h2>${li(step(2).questions)}<p>Promesse : <b>${esc(p.promise.headline)}</b>${p.promise.facts_lines ? ` — faits : ${esc(p.promise.facts_lines.join(' · '))}` : ''}</p><div class="row">${img(p.pieces.avec_titre, 'Image finale avec titre')}</div></section>
<section><h2>Pour chaque défaut, l'étape à reprendre</h2><table><tr><th>Défaut constaté</th><th>Étape à reprendre</th><th>Où le voir</th></tr>${p.defect_to_step.map((d) => `<tr><td>${esc(d.defect)}</td><td>${esc(d.redo)}</td><td>${esc(p.steps.find((s) => s.id === d.step).title.replace(/ :.*/, ''))}</td></tr>`).join('')}</table></section>
<section><h2>Verdicts (manuels, séparés)</h2><div class="verdict"><div class="box"><b>Impact visuel</b><p class="muted">À remplir par le propriétaire : jugement et défauts relevés (avec l'étape à reprendre).</p></div><div class="box"><b>Décision de publication</b><p class="muted">À remplir par le propriétaire. Indépendante de l'impact visuel ; rien n'est publié sans elle.</p></div></div></section>
</main></body></html>`;
}
