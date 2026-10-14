// SALON VIEWS: pure HTML builders for the field loop (capture -> review -> compare -> ask -> negotiate -> update -> what changed). They take view models computed by the core (core/field/*) and return strings:
// no state, no events, nothing computed here. French text for the owner; English sentences of the core are shown where the SUPPLIER will read them. Built for a 390 px phone held in one hand:
// cards instead of tables, wrapping text, targets of at least 44 px, no horizontal scroll.
import { esc } from '../dom.js';
import { labelOf, describeFact } from '/core/candidate-view.js';
import { priceOfQuote } from '/core/price-display.js';
const moneyText = (amount, currency) => priceOfQuote(amount, currency).text; // "12 USD", or "12 — devise à confirmer": a missing currency is never replaced by a guess
import { fr, frList, BLOCK_CODE_FR, DOC_NAME_FR, DOC_STATE_FR } from './salon-fr.js';

export const REC_FR = { BUY_CANDIDATE: "Candidat à l'achat", INVESTIGATE: 'À creuser', PASS: 'Passer' };
export const EV_FR = { STRONG_EVIDENCE: 'Preuves solides', MEDIUM_EVIDENCE: 'Preuves moyennes', WEAK_EVIDENCE: 'Preuves faibles', INSUFFICIENT_EVIDENCE: 'Preuves insuffisantes' };
export const ROLE_FR = { PREFERRED: 'Préféré', VIABLE: 'Viable', INVESTIGATE: 'À creuser', BLOCKED: 'Bloqué' };
export const MARK = { VERIFIED: '✓', SUPPLIER_CLAIM: '◐', ESTIMATED: '≈', UNKNOWN: '?', CONFLICT: '!', USER_PROVIDED: '◐' };
export const STATUS_FR = { VERIFIED: 'vérifié', SUPPLIER_CLAIM: 'dit par le fournisseur', ESTIMATED: 'estimé', UNKNOWN: 'inconnu', CONFLICT: 'contradiction', USER_PROVIDED: 'corrigé par vous' };
export const LEVEL_FR = { LOW: 'faible', MEDIUM: 'moyen', HIGH: 'élevé', UNKNOWN: 'inconnu' };
export const RISK_FR = { compliance: 'Conformité', commercial: 'Commercial', documentation: 'Documents', quality: 'Qualité', delivery: 'Délai', consistency: 'Cohérence' };
export const FIT_FR = { HIGH: 'Fit élevé', MEDIUM: 'Fit moyen', LOW: 'Fit faible', INSUFFICIENT_EVIDENCE: 'Fit : preuves insuffisantes' };
export const FITSTATE_FR = { SUPPORTED: 'oui', PARTIAL: 'en partie', UNKNOWN: 'inconnu', NOT_APPLICABLE: 'sans objet' };
export const REVIEW_FR = { PENDING: 'à relire', CONFIRMED: 'confirmé', CORRECTED: 'corrigé', REJECTED: 'rejeté', CONFLICT: 'contradiction' };
const SECTION_FR = { identity: 'Identité', price: 'Prix', logistics: 'Livraison', samples: 'Échantillon', specs: 'Produit', packaging: 'Emballage', claims: 'Documents annoncés', payment: 'Paiement', customization: 'Personnalisation', other: 'Autre' };
const DIR_FR = { BETTER: 'mieux', WORSE: 'moins bien', NEUTRAL: '', UNKNOWN: '' };
const cls = (x) => String(x ?? '').replace(/[^A-Za-z0-9_]/g, '');
export const pill = (text, kind = '') => `<span class="sl-pill ${cls(kind)}">${esc(text)}</span>`;
export const btn = (label, act, key = '', extra = '', kind = '') => `<button type="button" class="sl-btn ${kind}" data-act="${esc(act)}"${key !== '' ? ` data-key="${esc(key)}"` : ''}${extra}>${esc(label)}</button>`;
export const val = (v) => ` data-val='${esc(JSON.stringify(v))}'`;
const eur = (m) => (m === null || m === undefined ? '?' : `${(m / 100).toFixed(2)} €`);
export const section = (id, title, body, open = true, badge = '') => `<details class="sl-sec" data-sec="${esc(id)}"${open ? ' open' : ''}><summary><span>${esc(title)}</span>${badge}</summary><div class="sl-secbody">${body}</div></details>`;

// ---- home ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function homeHtml({ overview, comparisons, selected, resume, online, ws }) {
  const sel = new Set(selected);
  const cards = overview.length ? overview.map((o) => `<article class="sl-card${sel.has(o.caseId) ? ' sel' : ''}" data-case="${esc(o.caseId)}">
    <button type="button" class="sl-cardmain" data-act="sl-open-case" data-key="${esc(o.caseId)}" aria-label="Ouvrir ${esc(o.supplier ?? o.title)}">
      <span class="sl-t">${esc(o.supplier ?? 'Fournisseur sans nom')}</span><span class="sl-s">${esc(o.title)}</span>
      <span class="sl-row">${pill(ROLE_FR[o.role] ?? o.role, `role-${o.role}`)}${pill(EV_FR[o.evidence] ?? o.evidence, `ev-${o.evidence}`)}</span>
      <span class="sl-row sl-nums"><span>${o.price ? esc(o.price) : '<em>prix inconnu</em>'}</span><span>${o.landed ? `rendu ${esc(o.landed)}` : '<em>coût rendu inconnu</em>'}</span></span>
      ${o.conflicts || o.pending ? `<span class="sl-row">${o.conflicts ? pill(`${o.conflicts} contradiction${o.conflicts > 1 ? 's' : ''}`, 'bad') : ''}${o.pending ? pill(`${o.pending} à relire`, 'warn') : ''}</span>` : ''}
    </button>
    <button type="button" class="sl-pick" data-act="sl-sel" data-key="${esc(o.caseId)}" aria-pressed="${sel.has(o.caseId)}" aria-label="Comparer ${esc(o.supplier ?? o.title)}">${sel.has(o.caseId) ? '✓' : '+'}</button></article>`).join('')
    : '<p class="sl-empty">Aucun fournisseur pour l\'instant. Appuyez sur « Capturer » dès que vous avez un devis, une photo ou une note.</p>';
  const saved = comparisons.length ? `<h2 class="sl-h">Comparaisons enregistrées</h2>${comparisons.map((c) => `<div class="sl-saved"><button type="button" class="sl-cardmain" data-act="sl-compare" data-key="${esc(c.id)}"><span class="sl-t">${esc(c.name ?? `${c.caseIds.length} fournisseurs`)}</span><span class="sl-s">${esc(c.summary?.headline ?? '')} · ${esc(c.updatedAt.slice(0, 16).replace('T', ' '))}</span></button><button type="button" class="sl-x" data-act="sl-del-cmp" data-key="${esc(c.id)}" aria-label="Supprimer la comparaison">×</button></div>`).join('')}` : '';
  const back = resume ? `<div class="sl-resume"><span>Reprendre : ${esc(resume.label)}</span>${btn('Reprendre', 'sl-resume', '', '', 'pri')}</div>` : '';
  return `<div class="sl"><header class="sl-hd"><div><h1>Salon</h1><p class="sl-sub">${overview.length} fournisseur${overview.length > 1 ? 's' : ''} · ${online ? 'en ligne' : 'hors ligne : tout reste utilisable'}</p></div><div class="sl-hdr">${btn('⋯', 'sl-menu', '', ' aria-label="Réglages et modes"', 'ghost')}${btn('+ Capturer', 'sl-nav', 'capture', '', 'pri')}</div></header>${back}<section>${cards}</section>${saved}
    ${selected.length >= 2 ? `<div class="sl-bar"><span>${selected.length} choisis</span>${btn(`Comparer (${selected.length})`, 'sl-compare', '', '', 'pri')}</div>` : selected.length === 1 ? '<p class="sl-hint">Choisissez au moins un autre fournisseur (+) pour comparer.</p>' : (overview.length >= 2 ? '<p class="sl-hint">Appuyez sur + pour choisir 2 à 5 fournisseurs à comparer.</p>' : '')}</div>`;
}

// ---- capture -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function captureHtml({ caseInfo = null, mode = 'quote', flash = '', online = false }) {
  const upd = caseInfo ? `<p class="sl-ctx">Mise à jour de l'offre de <b>${esc(caseInfo.supplier ?? caseInfo.title)}</b> : le nouveau devis s'ajoute, l'ancien reste.</p>` : '';
  const tab = (k, l) => `<button type="button" class="sl-seg" data-act="sl-cap-mode" data-key="${k}" aria-pressed="${mode === k}">${l}</button>`;
  const text = `<label>Coller ce que dit le fournisseur<textarea name="text" rows="6" inputmode="text" placeholder="${mode === 'chat' ? 'Collez la conversation (WeChat, e-mail, WhatsApp)…' : 'Collez le devis tel quel : prix, MOQ, délai, matière…'}" data-draft="sl"></textarea></label>
    <label class="sl-file">Ou un PDF avec texte<input type="file" accept="application/pdf,.pdf,text/plain,.txt" data-act="sl-pdf"></label>${online ? '' : '<p class="sl-hint">Hors ligne : la lecture d\'un PDF n\'est pas disponible. Collez le texte, ou saisissez à la main.</p>'}`;
  const manual = `<div class="sl-grid"><label>Prix unitaire<input name="m_unitPrice" inputmode="decimal" placeholder="3.20"></label><label>Devise<select name="m_currency"><option value="">?</option><option>USD</option><option>CNY</option><option>EUR</option></select></label>
    <label>MOQ<input name="m_moq" inputmode="numeric" placeholder="500"></label><label>Délai (jours)<input name="m_leadTimeDays" inputmode="numeric"></label>
    <label>Incoterm<select name="m_incoterm"><option value="">?</option>${['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'DAP', 'DDP'].map((x) => `<option>${x}</option>`).join('')}</select></label><label>Port<input name="m_port" placeholder="Ningbo"></label>
    <label>Matière<input name="m_material" placeholder="inox 304"></label><label>Acompte %<input name="m_depositPct" inputmode="numeric"></label></div>`;
  return `<div class="sl"><header class="sl-hd"><h1>${caseInfo ? "Mettre à jour l'offre" : 'Capturer'}</h1>${btn('Fermer', 'sl-nav', 'home', '', 'ghost')}</header>${upd}${flash ? `<p class="sl-flash">${esc(flash)}</p>` : ''}
    <form data-form="sl-capture" class="sl-form" autocomplete="off"><input type="hidden" name="mode" value="${esc(mode)}"><input type="hidden" name="caseId" value="${esc(caseInfo?.caseId ?? '')}">
      ${caseInfo ? '' : `<label>Fournisseur<input name="supplier" placeholder="Nom, stand ou contact" autocapitalize="words"></label><label>Produit / modèle<input name="product" placeholder="Gourde inox 500 ml, TB-500"></label>`}
      <div class="sl-segs" role="group" aria-label="Type de saisie">${tab('quote', 'Devis')}${tab('chat', 'Chat')}${tab('manual', 'Saisie')}</div>
      ${mode === 'manual' ? manual : text}
      <div class="sl-grid"><label>Quantité envisagée<input name="qty" inputmode="numeric" placeholder="1000"></label><label class="sl-file">Photo (référence)<input type="file" accept="image/*" capture="environment" data-act="sl-photo"></label></div>
      <label>Note<textarea name="note" rows="2" placeholder="Stand B12, contact Mme Li…"></textarea></label>
      <p class="sl-hint">Rien n'est obligatoire. Ce qui manque reste <b>inconnu</b>, jamais inventé.</p>
      <button type="submit" class="sl-btn pri big">${caseInfo ? "Importer cette nouvelle offre" : 'Créer et importer'}</button></form></div>`;
}

// ---- review of an imported offer ---------------------------------------------------------------------------------------------------------------------------------------------------
const valueText = (f) => { try { return describeFact({ key: f.key, value: f.value, context: f.context, needsCorrection: f.needsCorrection, rawText: f.rawText }, 'fr').valueText; } catch { return String(f.value); } };
export function reviewHtml({ draft, caseInfo, groupableIds, conflicts, unknownNames, correcting, flash = '' }) {
  const rows = (fields) => fields.filter((f) => f.review.state !== 'REJECTED' || true).map((f) => {
    const st = f.review.state; const label = labelOf(f.key, f.context, 'fr'); const open = correcting === f.id;
    return `<li class="sl-fact ${cls(st)}"><div class="sl-fh"><b>${esc(label)}</b>${pill(REVIEW_FR[st] ?? st, `rv-${st}`)}</div>
      <div class="sl-fv">${f.needsCorrection && f.value === null ? `<em>à corriger : « ${esc(f.rawText)} »</em>` : esc(valueText(f))}${st === 'CORRECTED' ? ` <small>(le fournisseur disait : ${esc(valueText({ ...f, value: f.originalValue }))})</small>` : ''}</div>
      <div class="sl-fs">« ${esc(f.rawText)} » · ${esc(f.status === 'USER_PROVIDED' ? 'corrigé par vous' : 'dit par le fournisseur')}${f.reverted ? ' · correction annulée' : ''}</div>
      ${f.historical ? `<p class="sl-hist"><b>Archive de cette offre.</b> Valeur actuelle du dossier : <b>${esc(factValueText(f.current))}</b> (${esc(SOURCE_FR[f.current.source_type] ?? f.current.source_type)}). ${btn('Voir et corriger le fait actuel', 'sl-open-fact', f.current.fact_type, '', 'ghost')}</p>` : ''}
      ${st === 'PENDING' ? `<div class="sl-acts">${f.needsCorrection ? '' : btn('Confirmer', 'sl-confirm', f.id, '', 'pri')}${btn('Corriger', 'sl-correct-open', f.id)}${btn('Rejeter', 'sl-reject', f.id, '', 'ghost')}</div>` : ''}
      ${open ? `<form data-form="sl-correct" data-id="${esc(f.id)}" class="sl-inline"><input type="hidden" name="id" value="${esc(f.id)}"><input name="value" inputmode="${/price|moq|Pct|Qty/i.test(f.key) ? 'decimal' : 'text'}" placeholder="Valeur exacte" autofocus><button class="sl-btn pri" type="submit">OK</button></form>` : ''}</li>`;
  }).join('');
  const secs = Object.entries(draft.sections).map(([k, list]) => `<h3 class="sl-h3">${esc(SECTION_FR[k] ?? k)}</h3><ul class="sl-facts">${rows(list)}</ul>`).join('');
  const unk = draft.unknown.length ? `<h3 class="sl-h3">Pas dans cette offre : inconnu</h3><ul class="sl-unk">${draft.unknown.map((u) => `<li>? ${esc(labelOf(u.key, 'product', 'fr'))}</li>`).join('')}</ul>` : '';
  const conf = conflicts.map((c) => `<div class="sl-conf"><b>Contradiction</b><p>${esc(c.title)}</p><div class="sl-acts">${c.choices.map((ch) => btn(ch.label, 'sl-resolve', c.id, val(ch.choice))).join('')}</div></div>`).join('');
  const attr = unknownNames.length ? `<div class="sl-conf"><b>Qui a écrit quoi ?</b><p>Nordla ne devine pas qui est le fournisseur.</p>${unknownNames.map((n) => `<div class="sl-who"><span>${esc(n)}</span>${btn('Fournisseur', 'sl-attr', n, val('supplier'))}${btn('Moi', 'sl-attr', n, val('me'))}</div>`).join('')}</div>` : '';
  const c = draft.counts;
  return `<div class="sl"><header class="sl-hd"><h1>Relire l'offre</h1>${btn('Terminé', 'sl-open-case', caseInfo.caseId, '', 'pri')}</header>${flash ? `<p class="sl-flash">${esc(flash)}</p>` : ''}
    <p class="sl-ctx"><b>${esc(caseInfo.supplier ?? caseInfo.title)}</b> · offre ${draft.seq}${draft.kind === 'REVISION' ? ' (mise à jour)' : ''} · ${c.total} fait${c.total > 1 ? 's' : ''} : ${c.pending} à relire, ${c.confirmed + c.corrected} validés, ${c.rejected} rejetés</p>
    ${draft.isLatest ? '' : `<p class="sl-flash">Ancienne offre (n°${draft.seq}) : lecture d'archive. Le dossier s'appuie aujourd'hui sur l'offre la plus récente ; l'onglet « Faits » montre les valeurs actuelles.</p>`}
    <p class="sl-note">Tout ce que dit le fournisseur reste une <b>déclaration</b> : rien ici n'est vérifié.</p>${draft.speakerAssumed ? '<p class="sl-flash">Le chat n\'indique pas qui écrit : on suppose que c\'est le fournisseur. Vérifiez.</p>' : ''}${attr}${conf}
    ${groupableIds.length ? `<div class="sl-bar sl-top">${btn(`Tout confirmer (${groupableIds.length} faits clairs)`, 'sl-confirm-all', draft.id, '', 'pri big')}</div>` : ''}${secs || '<p class="sl-empty">Rien n\'a pu être lu dans ce texte. Il est conservé tel quel ; saisissez les chiffres à la main.</p>'}${unk}
    ${draft.unparsed.length ? `<details class="sl-sec"><summary>Texte non compris (${draft.unparsed.length})</summary><p class="sl-fs sl-orig" translate="no">${draft.unparsed.map(esc).join(' · ')}</p></details>` : ''}</div>`;
}

// ---- case ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ---- FACTS: the current value of every fact, where it comes from, and the way to change it (one authoritative state; Terrain and Expert show the same values) ------------------------------------------------------
export const SOURCE_FR = { USER_PROVIDED: 'saisi ou corrigé par vous', SUPPLIER_CLAIM: 'dit par le fournisseur', IMAGE_OBSERVED: 'lu sur une photo', DOCUMENT_OBSERVED: 'lu dans un document', SYSTEM_DERIVED: 'calculé par Nordla', VERIFIED: 'vérifié', UNATTRIBUTED_LEGACY: 'origine non tracée' };
export const REVIEW_STATUS_FR = { NOT_REVIEWED: 'pas relu', CONFIRMED: 'confirmé', CORRECTED: 'corrigé par vous', REVERTED: 'correction annulée', REJECTED: 'rejeté', CONFLICT: 'contradiction' };
const MODE_FR = { terrain: 'mode terrain', expert: 'mode expert', salon: 'Salon', system: 'Nordla' };
export function factValueText(f) {
  const v = f.value; const u = f.unit; if (v === null || v === undefined) return 'inconnu';
  if (v === 'IN_STOCK') return 'en stock'; if (v === 'OUT_OF_STOCK') return 'pas en stock';
  if (Array.isArray(v)) return v.join(', '); if (typeof v === 'object') return v.amount !== undefined ? `${v.amount} ${v.unit ?? ''}`.trim() : v.max !== undefined ? `${v.max} jours` : JSON.stringify(v);
  return `${v}${f.fact_type === 'MOQ' ? ' pièces' : f.fact_type === 'PRICE' ? (u ? ` ${u}` : ' — devise à confirmer') : f.fact_type === 'LEAD_TIME' ? ' jours' : f.fact_type === 'OUTPUT_COUNT' ? ' sorties' : ''}`;
}
const ALWAYS = ['PRICE', 'CURRENCY', 'MOQ', 'MODEL', 'LEAD_TIME', 'INCOTERM', 'MATERIAL', 'PACKAGING'];
const FACT_LABELS = { PRICE: 'Prix unitaire', CURRENCY: 'Devise', MOQ: 'Minimum de commande (MOQ)', MODEL: 'Modèle', LEAD_TIME: 'Délai de production', INCOTERM: 'Incoterm', MATERIAL: 'Matière', PACKAGING: 'Emballage', POWER: 'Puissance', CAPACITY: 'Capacité', OUTPUT_COUNT: 'Nombre de sorties', COLOURS: 'Couleurs', STOCK_STATUS: 'Stock', PORT: 'Port ou lieu' };
const HINT = { PRICE: 'ex. 6.80', CURRENCY: 'USD, CNY ou EUR', MOQ: 'ex. 500', MODEL: 'tel qu\'écrit', LEAD_TIME: 'jours, ex. 20', INCOTERM: 'EXW, FOB, DAP…', MATERIAL: 'ex. acier inox 304', PACKAGING: 'ex. sachet OPP', POWER: 'watts, ex. 45', CAPACITY: 'ex. 20000 mAh', OUTPUT_COUNT: 'ex. 4', COLOURS: 'ex. bleu, blanc, noir', STOCK_STATUS: 'IN_STOCK ou OUT_OF_STOCK', PORT: 'ex. Ningbo' };
const fmtAt = (at) => (at ? String(at).slice(0, 16).replace('T', ' ') : '');
export function factsHtml({ facts, audit = [], observations = [], editing = null, caseId, board = [], correcting = null }) {
  const have = new Map(facts.map((f) => [f.fact_type, f])); const proposedOnly = new Set(board.filter((b) => b.state === 'PROPOSED' || b.state === 'AMBIGUOUS').map((b) => b.fact_type)); const order = [...ALWAYS, ...facts.map((f) => f.fact_type).filter((t) => !ALWAYS.includes(t))].filter((t) => have.has(t) || !proposedOnly.has(t));
  const form = (t, f) => `<form data-form="sl-fact" data-id="${esc(t)}" class="sl-inline"><input type="hidden" name="caseId" value="${esc(caseId)}"><input type="hidden" name="factType" value="${esc(t)}"><input name="value" ${/PRICE|MOQ|LEAD|OUTPUT|POWER/.test(t) ? 'inputmode="decimal"' : ''} value="" placeholder="${esc(HINT[t] ?? 'Valeur exacte')}" autocomplete="off" autofocus><button class="sl-btn pri" type="submit">OK</button></form>${f ? `<small class="sl-fs">Valeur actuelle : ${esc(factValueText(f))}. L'ancienne valeur reste dans l'historique.</small>` : ''}`;
  const rows = order.map((t) => { const f = have.get(t);
    if (!f) return `<li class="sl-fact UNKNOWN"><div class="sl-fh"><b>${esc(FACT_LABELS[t])}</b>${pill('inconnu', 'rv-UNKNOWN')}</div><div class="sl-acts">${btn('Saisir', 'sl-fact-edit', t, '', 'ghost')}</div>${editing === t ? form(t, null) : ''}</li>`;
    const ref = f.source_reference ?? {}; const src = [SOURCE_FR[f.source_type] ?? f.source_type, ref.offerId ? `offre ${ref.offerId.slice(-4)}` : null, ref.revisionId ? 'dans votre version corrigée du texte' : null, ref.mode ? MODE_FR[ref.mode] : null, ref.origin && !ref.mode ? MODE_FR[ref.origin] : null].filter(Boolean).join(' · ');
    const mine = f.ledger_id && f.source_type === 'USER_PROVIDED' && f.provenance?.corrected; const hist = f.history ?? [];
    return `<li class="sl-fact ${cls(f.review_status)}"><div class="sl-fh"><b>${esc(f.label)}</b>${pill(REVIEW_STATUS_FR[f.review_status] ?? f.review_status, `rv-${f.review_status}`)}</div>
      <div class="sl-fv">${esc(factValueText(f))}</div><div class="sl-fs">${esc(src)}${f.created_at ? ` · ${esc(fmtAt(f.created_at))}` : ''} · version ${f.revision || '?'}${f.ledger_id ? '' : ' · <b>origine non tracée</b>'}</div>
      ${ref.rawText ? `<div class="sl-fs">« ${esc(ref.rawText)} »</div>` : ''}${f.provenance?.previousValue !== null && f.provenance?.previousValue !== undefined ? `<div class="sl-fs">avant : ${esc(factValueText({ ...f, value: f.provenance.previousValue }))}</div>` : ''}
      <div class="sl-acts">${btn('Corriger', 'sl-fact-edit', t)}${mine ? btn('Annuler ma correction', 'sl-fact-revert', f.ledger_id, '', 'ghost') : ''}</div>${editing === t ? form(t, f) : ''}
      ${hist.length > 1 ? `<details class="sl-sec"><summary>Historique (${hist.length})</summary><ul class="sl-list">${hist.map((h) => `<li>${esc(factValueText({ ...f, value: h.value }))} · ${esc(SOURCE_FR[h.source_type] ?? h.source_type)}${h.voided ? ' · annulée' : ''} · ${esc(fmtAt(h.created_at))}${h.provenance?.reason ? ` · ${esc(h.provenance.reason)}` : ''}</li>`).join('')}</ul></details>` : ''}</li>`; }).join('');
  const alerts = audit.filter((a) => a.kind !== 'UNATTRIBUTED_VALUE').map((a) => `<div class="sl-conf"><b>${a.kind === 'CORRECTION_EQUALS_PRICE' ? 'Correction à vérifier' : 'Ancienne correction'}</b><p>${esc(FACT_LABELS[a.fact_type] ?? a.key)} : le fournisseur disait ${esc(String(a.originalValue))}, une correction à ${esc(String(a.correctedValue))} a été enregistrée${a.offerId ? ' sur une ancienne offre' : ''}${a.kind === 'STALE_CORRECTION' ? `, mais le dossier indique aujourd'hui ${esc(String(a.currentValue))}` : ' : cette valeur est égale au prix unitaire, elle a peut-être été saisie au mauvais endroit'}.</p>${a.ledgerId ? `<div class="sl-acts">${btn('Annuler cette correction', 'sl-fact-revert', a.ledgerId)}</div>` : ''}</div>`).join('');
  const obs = observations.filter((o) => o.state === 'PROPOSED').map((o) => `<li class="sl-fact"><div class="sl-fh"><b>${esc(FACT_LABELS[o.factType] ?? o.key)}</b>${pill(SOURCE_FR[o.sourceType] ?? o.sourceType, 'warn')}</div><div class="sl-fv">${esc(factValueText({ fact_type: o.factType, value: o.value }))}</div><div class="sl-fs">Pas encore un fait du dossier : à accepter ou ignorer.</div><div class="sl-acts">${btn('Accepter', 'sl-obs-accept', o.id, '', 'pri')}</div></li>`).join('');
  // what the supplier said and nobody confirmed: visible with its status; confirming or correcting is the owner's explicit act
  const props = board.filter((b) => b.state === 'PROPOSED' || b.state === 'AMBIGUOUS').map((b) => `<li class="sl-fact ${b.state}"><div class="sl-fh"><b>${esc(FACT_LABELS[b.fact_type] ?? b.label)}</b>${pill(b.state === 'AMBIGUOUS' ? 'ambigu : à corriger' : 'à confirmer', b.state === 'AMBIGUOUS' ? 'rv-CONFLICT' : 'rv-PENDING')}</div><div class="sl-fv">${esc(b.proposedValueText ?? '')}</div><div class="sl-fs">dit par le fournisseur · pas encore confirmé${b.rawText ? ` · « ${esc(b.rawText)} »` : ''}</div>${b.warnings.map((w) => `<small class="need">${esc(w)}</small>`).join('')}<div class="sl-acts">${b.canConfirm ? btn('Confirmer', 'sl-confirm', b.candidateId, '', 'pri') : ''}${btn('Corriger', 'sl-correct-open', b.candidateId)}${btn('Rejeter', 'sl-reject', b.candidateId, '', 'ghost')}</div>${correcting === b.candidateId ? `<form data-form="sl-correct" data-id="${esc(b.candidateId)}" class="sl-inline"><input type="hidden" name="id" value="${esc(b.candidateId)}"><input name="value" placeholder="${esc(HINT[b.fact_type] ?? 'Valeur exacte')}" autocomplete="off" autofocus><button class="sl-btn pri" type="submit">OK</button></form>` : ''}</li>`).join('');
  return `${alerts}${props ? `<h3 class="sl-h3">À confirmer (dit par le fournisseur)</h3><ul class="sl-facts">${props}</ul>` : ''}${obs ? `<h3 class="sl-h3">Lu mais pas encore accepté</h3><ul class="sl-facts">${obs}</ul>` : ''}<ul class="sl-facts">${rows}</ul><p class="sl-hint">Ce sont les mêmes valeurs que dans les modes terrain et expert. Une correction ajoute une version : rien n'est effacé.</p>`;
}
const UNKNOWN_FR = (x) => ({ 'unit price': 'prix unitaire', MOQ: 'MOQ', Incoterm: 'Incoterm', 'landed cost': 'coût rendu', 'maximum purchase price': "prix d'achat maximum", 'sample cost': "coût de l'échantillon", 'target purchase price': "prix cible", margin: 'marge', cash: 'cash' }[x] ?? fr(x));
const SAMPLE_FR = { NONE: 'aucun', REQUESTED: 'demandé', RECEIVED: 'reçu', EVALUATED: 'évalué' };
const VERDICT_SAMPLE_FR = { PASS: 'OK', CONCERNS: 'réserves', FAIL: 'échec' };
// The red "blocked" block, first level: a title and 2-4 short words; everything the engine knows stays one tap away (nothing is removed, no gate is weakened).
const BLOCK_SHORT = { PRODUCT_NOT_IDENTIFIED: 'Numéro de modèle', MODEL_NOT_ESTABLISHED: 'Numéro de modèle', MODEL_NOT_CONFIRMED: 'Modèle à confirmer', MODEL_CONTRADICTORY: 'Modèles contradictoires', PRODUCT_IDENTITY_UNRESOLVED: 'Identification technique incomplète', NO_PRICE: 'Prix unitaire', LANDED_UNKNOWN: "Coûts d'import", CRITICAL_COST_UNKNOWN: "Coûts d'import", LEGAL_REQUIREMENT_UNRESOLVED: 'Règles applicables à déterminer', REQUIRED_DOCUMENT_MISSING: 'Documents de conformité', DOCUMENT_CONTRADICTS_CASE: 'Document contraire au modèle', OPEN_CONTRADICTION: 'Contradiction à lever' };
const cap = (x) => String(x).charAt(0).toUpperCase() + String(x).slice(1);
const TRAIT_FR = { 'electrical.present': 'électrique', 'battery.present': 'batterie', 'radio.present': 'radio', childrenUse: 'usage enfant', foodContact: 'contact alimentaire', cosmetic: 'cosmétique', ppe: 'protection individuelle (EPI)', textile: 'textile', medical: 'médical', chemicalMixture: 'mélange chimique' };
const IDENT_CODES = new Set(['MODEL_NOT_ESTABLISHED', 'MODEL_NOT_CONFIRMED', 'MODEL_CONTRADICTORY', 'PRODUCT_IDENTITY_UNRESOLVED', 'PRODUCT_NOT_IDENTIFIED']);
const MODEL_SRC_FR = { SUPPLIER_CLAIMED: 'annoncé par le fournisseur, accepté par vous', USER_STATED: 'saisi par vous', DOCUMENT: 'lu dans un document', VERIFIED: 'vérifié par une source indépendante' };
/** The identification gaps in plain French, each told once with its real cause and the place where it is fixed. A known model never reads as missing; a known model never reads as proof of conformity. */
export function identityLines(idn) {
  const m = idn.model; const t = idn.technical; const lines = []; const actions = [];
  if (m.state === 'ABSENT') { lines.push("Numéro de modèle : aucun n'est connu. Demandez-le au fournisseur."); actions.push({ label: 'Poser la question du modèle', act: 'sl-case-tab', key: 'ask' }); }
  else if (m.state === 'PROPOSED') { lines.push(`Numéro de modèle : ${m.proposed.join(' / ')} est proposé mais pas encore confirmé. Confirmez-le, corrigez-le ou rejetez-le.`); actions.push({ label: 'Voir dans Infos', act: 'sl-case-tab', key: 'facts' }); }
  else if (m.state === 'CONTRADICTORY') { lines.push(`Numéro de modèle : le fournisseur et le dossier ne s'accordent pas (${m.values.join(' / ')}). Décidez lequel est le bon.`); actions.push({ label: 'Voir dans Infos', act: 'sl-case-tab', key: 'facts' }); }
  else lines.push(`Numéro de modèle ${m.value} : connu (${MODEL_SRC_FR[m.level] ?? 'accepté par vous'}). Cela ne prouve ni l'identification technique ni la conformité.`);
  if (!t.complete) {
    const traits = t.unresolved.map((x) => TRAIT_FR[x] ?? x);
    const assumed = (t.assumed ?? []).map((x) => TRAIT_FR[x] ?? x);
    if (!t.categoryConfirmed) lines.push(`Identification technique incomplète : la catégorie du produit n'est pas confirmée${traits.length ? `, donc ${traits.length} caractéristiques de sécurité restent à établir (${traits.join(', ')})` : assumed.length ? `, et les ${assumed.length} caractéristiques de sécurité (${assumed.join(', ')}) ne sont que supposées d'après le nom du produit` : ''}. Confirmez la catégorie : les caractéristiques qu'elle suppose resteront « supposées » jusqu'à votre confirmation.`);
    else lines.push(`Identification technique incomplète : ${traits.length} caractéristique${traits.length > 1 ? 's' : ''} non établie${traits.length > 1 ? 's' : ''}${traits.length ? ` (${traits.join(', ')})` : ''}.`);
  }
  return { lines, actions, needsCategory: !t.complete && !t.categoryConfirmed };
}
export function blockerSummary(ev, a) {
  const hard = a?.decision?.hardBlockers ?? []; const codes = [...new Set([...(ev?.blockingCodes ?? []), ...hard.map((b) => b.code)])]; const idn = ev?.identification ?? null;
  const modelCode = codes.some((c) => c === 'MODEL_NOT_ESTABLISHED' || c === 'MODEL_NOT_CONFIRMED' || c === 'MODEL_CONTRADICTORY' || c === 'PRODUCT_NOT_IDENTIFIED'); const techCode = codes.includes('PRODUCT_IDENTITY_UNRESOLVED');
  const labels = [...new Set(codes.map((c) => (modelCode && techCode && IDENT_CODES.has(c) ? 'Modèle et identification technique' : (BLOCK_SHORT[c] ?? cap(BLOCK_CODE_FR[c] ?? c.toLowerCase().replace(/_/g, ' '))))))]; // both gaps at once share ONE short word at the first level (the details tell them apart)
  if (!labels.length && !(ev?.blocking ?? []).length) return null;
  const toFix = codes.some((c) => /CONTRADICT/.test(c)); const k = labels.length; const noun = k > 1 ? 'éléments critiques' : 'élément critique';
  const details = []; const seen = new Set(); const add = (t) => { const x = String(t); if (x && !seen.has(x)) { seen.add(x); details.push(x); } };
  const idl = idn ? identityLines(idn) : null; if (idl) for (const l of idl.lines) add(l); // the identification gaps first, told once (the engine's own sentences for them are not repeated)
  (ev?.blocking ?? []).forEach((t, i) => { if (!(idn && IDENT_CODES.has(ev.blockingCodes?.[i]))) add(fr(t)); });
  for (const b of hard) if (!(idn && IDENT_CODES.has(b.code))) add(`${cap(BLOCK_CODE_FR[b.code] ?? b.code)} : ${fr(b.detail)}`);
  const docs = (a?.decision?.gaps?.missingDocs ?? []).map((m) => fr(String(m.label ?? m.docType ?? m)));
  return { title: `Bloqué — ${k} ${noun} ${toFix ? 'à régler' : k > 1 ? 'manquants' : 'manquant'}`, labels, details, docs, actions: idl?.actions ?? [], needsCategory: idl?.needsCategory === true };
}
export function blockerHtml(ev, a) {
  const b = blockerSummary(ev, a); if (!b) return '';
  return `<div class="sl-blk"><p class="sl-blkt"><b>${esc(b.title)}</b></p><ul class="sl-blkl">${b.labels.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <details class="sl-blkd"><summary>Voir les détails</summary>${b.details.length ? `<ul class="sl-list">${b.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}${b.docs.length ? `<h3 class="sl-h3">Documents à obtenir</h3><ul class="sl-list">${b.docs.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}</details></div>`;
}
export const kv = (k, v, cls2 = '') => `<div class="sl-kv ${cls2}"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
export function truthHtml(card) {
  const f = card.evidenceHealth.facts; const c = card.evidenceHealth.counts;
  const risks = Object.entries(card.risk).map(([k, v]) => `<li class="sl-risk lv-${cls(v.level)}"><b>${esc(RISK_FR[k] ?? k)}</b> ${pill(LEVEL_FR[v.level], `lv-${v.level}`)}<span>${esc(frList(v.why))}</span></li>`).join('');
  const mem = card.memory.notes.length ? `<ul class="sl-list">${card.memory.notes.map((n) => `<li>${esc(fr(n))}</li>`).join('')}</ul>` : '<p class="sl-hint">Rien à signaler pour l\'instant (pas de changement ni de promesse non tenue enregistrés).</p>';
  const ext = card.external.items.length ? `<ul class="sl-list">${card.external.items.map((e) => `<li>${esc(e.provider)} : ${esc(e.claim)} ${pill(STATUS_FR[e.status] ?? e.status)}${e.note ? `<small> ${esc(e.note)}</small>` : ''}</li>`).join('')}</ul>` : `<p class="sl-hint">${esc(fr(card.external.note))}</p>`;
  return `<dl class="sl-dl">${kv('Fournisseur', `${esc(card.identity.supplier.name ?? 'inconnu')} ${pill(STATUS_FR[card.identity.supplier.status] ?? '')}`)}${kv('Contact', esc(card.identity.contact.value ?? 'inconnu'))}${kv('Usine ou négociant', `${esc({ FACTORY: 'usine', TRADING: 'négociant', UNKNOWN: 'inconnu' }[card.identity.kind.value] ?? card.identity.kind.value)} ${pill(STATUS_FR[card.identity.kind.status])}`)}${kv('Stand / lieu', esc([card.identity.location.booth, card.identity.location.market, card.identity.location.city].filter(Boolean).join(' · ') || 'inconnu'))}</dl>
    <h3 class="sl-h3">Solidité de ce qu'on sait</h3><p class="sl-counts">${['VERIFIED', 'SUPPLIER_CLAIM', 'ESTIMATED', 'UNKNOWN', 'CONFLICT'].map((k) => `<span class="sl-cnt ${k}">${MARK[k]} ${c[k]} ${esc(STATUS_FR[k])}</span>`).join('')}</p>
    <ul class="sl-list sl-compact">${f.map((x) => `<li><span class="sl-mk ${cls(x.status)}">${MARK[x.status]}</span> <b>${esc(fr(x.label))}</b> <span class="sl-fv2">${x.value !== null ? esc(typeof x.value === 'object' ? JSON.stringify(x.value) : fr(String(x.value))) : '<em>inconnu</em>'}</span><small>${esc(fr(x.why))}</small></li>`).join('')}</ul>
    <h3 class="sl-h3">Risques</h3><ul class="sl-list">${risks}</ul><h3 class="sl-h3">Comportement du fournisseur</h3>${mem}<h3 class="sl-h3">Vérifications externes</h3>${ext}`;
}
export function fitHtml(fit) {
  const rows = fit.dimensions.map((d) => `<li class="sl-fit st-${cls(d.state)}"><div><b>${esc(d.labelFr)}</b> ${pill(FITSTATE_FR[d.state], `fs-${d.state}${d.lean === 'AGAINST' ? ' against' : ''}`)}</div><small>${esc(fr(d.why))}</small>${d.needs ? `<small class="need">À faire : ${esc(fr(d.needs))}</small>` : ''}</li>`).join('');
  return `<p class="sl-fitl">${pill(FIT_FR[fit.label] ?? fit.label, `fit-${fit.label}`)} <small>${fit.counts.supported} oui · ${fit.counts.partial} en partie · ${fit.counts.unknown} inconnus</small></p>${fit.profile.present ? '' : '<p class="sl-flash">Profil marchand non chargé : rien ne peut être jugé. Connectez-vous une fois au serveur.</p>'}<ul class="sl-list">${rows}</ul><p class="sl-hint">${esc(fr(fit.rule))}</p>`;
}
export function dealHtml(d) {
  const q = d.quoted; const rows = [];
  rows.push(kv('Prix proposé', q.status === 'SUPPLIER_CLAIM' ? `${esc(moneyText(q.unitPrice, q.currency))} pour ${esc(q.atQty ?? '?')} pièces ${pill('dit par le fournisseur')}` : '<em>inconnu</em>'));
  rows.push(kv('MOQ', q.moq !== null ? `${esc(q.moq)} pièces` : '<em>inconnu</em>'), kv('Incoterm', esc(q.incoterm ? `${q.incoterm}${q.port ? ` ${q.port}` : ''}` : 'inconnu')));
  rows.push(kv('Coût rendu / pièce', d.landed.display ? `${esc(d.landed.display)} ${pill(d.landed.isLowerBound ? 'minimum' : 'estimé')}` : `<em>inconnu</em><small>${esc(fr(d.landed.reason ?? ''))}</small>`));
  rows.push(kv('Prix d\'achat maximum', d.maxPurchasePrice.display ? `${esc(d.maxPurchasePrice.display)}${d.maxPurchasePrice.status === 'UPPER_BOUND' ? ' (plafond théorique)' : ''}` : `<em>inconnu</em><small>${esc(fr(d.maxPurchasePrice.reason ?? ''))}</small>`));
  rows.push(kv('Prix cible', d.targetPurchasePrice.display ? `${esc(d.targetPurchasePrice.display)}<small>${esc(fr(d.targetPurchasePrice.basis))}</small>` : `<em>aucune cible</em><small>${esc(fr(d.targetPurchasePrice.reason ?? ''))}</small>`));
  rows.push(kv('Marge', d.margin.pct !== null ? `${(d.margin.pct * 100).toFixed(1)} %${d.margin.status === 'UPPER_BOUND' ? ' (maximum)' : ''} · objectif ${esc(d.margin.targetPct ?? '?')} %` : `<em>inconnue</em><small>${esc(fr(d.margin.reason ?? ''))}</small>`));
  rows.push(kv('Cash à engager', d.cash.goodsEurMinor !== null ? `marchandise ${eur(d.cash.goodsEurMinor)}${d.cash.depositEurMinor !== null ? ` · acompte ${eur(d.cash.depositEurMinor)}` : ''}${d.cash.landedTotalEurMinor !== null ? ` · total rendu ${eur(d.cash.landedTotalEurMinor)}` : ''}` : '<em>inconnu</em>'));
  rows.push(kv('Échantillon', d.cash.sample.status === 'SUPPLIER_CLAIM' ? `${esc(moneyText(d.cash.sample.amount, d.cash.sample.currency))}${d.cash.sample.refundable === 'REFUNDABLE' ? ' · remboursable' : d.cash.sample.refundable === 'NOT_REFUNDABLE' ? ' · non remboursable' : ''}` : '<em>inconnu</em>'));
  const bps = d.breakpoints.length ? `<h3 class="sl-h3">Paliers de prix</h3><ul class="sl-list">${d.breakpoints.map((b) => `<li><b>dès ${b.minQty} pcs</b> ${esc(moneyText(b.unitPrice, b.currency))} → rendu ${b.landedPerUnitEurMinor !== null ? eur(b.landedPerUnitEurMinor) : '?'}/pce · cash ${b.cashTotalEurMinor !== null ? eur(b.cashTotalEurMinor) : '?'}${b.withinMaxPrice === false ? ' <span class="sl-pill bad">au-dessus du maximum</span>' : ''}</li>`).join('')}</ul>` : '';
  return `<dl class="sl-dl">${rows.join('')}</dl><p class="sl-hint">${esc(fr(d.incotermEffect.text))}</p>${bps}${d.insights.length ? `<ul class="sl-list">${d.insights.map((x) => `<li>${esc(fr(x))}</li>`).join('')}</ul>` : ''}${d.unknown.length ? `<p class="sl-hint">Inconnu : ${esc(d.unknown.map(UNKNOWN_FR).join(', '))}</p>` : ''}<p class="sl-hint">${esc(fr(d.note))}</p>`;
}
export function changedHtml(w) {
  if (!w.available) return `<p class="sl-hint">${esc(fr(w.reason))}</p>`;
  const rows = w.changes.length ? w.changes.map((c) => `<li class="sl-chg ${cls(c.direction)}"><b>${esc(c.labelFr)}</b><span>${esc(c.fromText ?? 'inconnu')} → ${esc(c.toText ?? 'inconnu')}</span>${DIR_FR[c.direction] ? pill(DIR_FR[c.direction], `dir-${c.direction}`) : ''}${c.kind !== 'CHANGED' ? pill(c.kind === 'ADDED' ? 'nouveau' : 'retiré') : ''}</li>`).join('') : '<li>Aucun terme n\'a changé.</li>';
  const l = w.landed; const land = l.from && l.to ? `${esc(l.from.display)} → ${esc(l.to.display)}${DIR_FR[l.direction] ? ` ${pill(DIR_FR[l.direction], `dir-${l.direction}`)}` : ''}` : `<em>${esc(fr(l.note ?? 'inconnu'))}</em>`;
  return `<p class="sl-ctx">Depuis l'offre ${w.from.n} (${esc(w.from.at.slice(11, 16))}) → offre ${w.to.n} (${esc(w.to.at.slice(11, 16))})</p><ul class="sl-list">${rows}</ul>
    <dl class="sl-dl">${kv('Coût rendu', land)}${kv('Recommandation', `${esc(REC_FR[w.recommendation.from] ?? w.recommendation.from)} → ${esc(REC_FR[w.recommendation.to] ?? w.recommendation.to)}${w.recommendation.changed ? ' ' + pill('a changé', 'warn') : ''}<small>${esc(w.recommendation.source === 'RECORDED' ? 'telle qu\'enregistrée à l\'époque' : 'recalculée avec ce qu\'on savait alors')}</small>`)}</dl><p class="sl-hint">L'offre précédente est conservée : rien n'est écrasé.</p>`;
}
export function memoryHtml(h) {
  if (!h) return '<p class="sl-hint">Pas d\'historique.</p>';
  return `<p class="sl-ctx">${h.cases.length} produit${h.cases.length > 1 ? 's' : ''} · ${h.offers.length} offre${h.offers.length > 1 ? 's' : ''}</p>${h.notes.length ? `<ul class="sl-list">${h.notes.map((n) => `<li>${esc(fr(n))}</li>`).join('')}</ul>` : '<p class="sl-hint">Aucun changement de prix, de MOQ ou de matière enregistré.</p>'}
    ${h.promisedCertificates.length ? `<h3 class="sl-h3">Documents annoncés</h3><ul class="sl-list">${h.promisedCertificates.map((c) => `<li>${esc(DOC_NAME_FR[c.claim] ?? c.claim)} : ${esc(DOC_STATE_FR[c.current] ?? c.current)}${c.matched ? ' (document reçu, au bon modèle)' : ''}</li>`).join('')}</ul>` : ''}
    ${h.previousRecommendations.length ? `<h3 class="sl-h3">Recommandations passées</h3><ul class="sl-list">${h.previousRecommendations.map((r) => `<li>${esc(REC_FR[r.value] ?? r.value)} · ${esc(String(r.at).slice(0, 16).replace('T', ' '))}</li>`).join('')}</ul>` : ''}`;
}
export function caseHtml({ info, tab, v, history, flash = '', factsView = null }) {
  const rec = v.recommendation; const ev = v.evidenceStatus; const top = v.askNow.items.slice(0, 3);
  const head = `<div class="sl-sum"><div class="sl-row">${pill(`Seule : ${REC_FR[rec.value]}`, `rec-${rec.value}`)}${pill(EV_FR[ev.evidenceCompleteness], `ev-${ev.evidenceCompleteness}`)}${pill(FIT_FR[v.merchantFit.label] ?? '', `fit-${v.merchantFit.label}`)}</div>
    <p class="sl-why">${esc(fr(rec.why))}. <small>Cette recommandation concerne cette offre prise seule ; la comparaison peut conclure autrement. Elle attend votre décision : rien n'est acheté ni payé.</small></p>
    ${blockerHtml(ev, v.assessment)}${ev.whatWouldImprove.length ? `<p class="sl-imp"><b>Pour améliorer :</b> ${esc(frList(ev.whatWouldImprove.slice(0, 3)))}</p>` : ''}</div>
    <div class="sl-acts main">${btn('Demander', 'sl-ask', info.caseId, '', 'pri')}${btn('Négocier', 'sl-neg', info.caseId)}${btn("Mettre à jour l'offre", 'sl-update-offer', info.caseId)}${btn('Relire', 'sl-review', info.caseId, '', 'ghost')}</div>`;
  const tabs = [['sum', 'Résumé'], ['facts', 'Faits'], ['truth', 'Fournisseur'], ['fit', 'Fit'], ['deal', 'Chiffres'], ['changed', 'Changements'], ['mem', 'Historique'], ['more', 'Plus']];
  const nav = `<div class="sl-tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" data-act="sl-case-tab" data-key="${k}" aria-selected="${tab === k}">${l}</button>`).join('')}</div>`;
  const body = tab === 'facts' ? factsHtml(factsView ?? { facts: [], audit: [], observations: [], editing: null, caseId: info.caseId }) : tab === 'truth' ? truthHtml(v.truthCard) : tab === 'fit' ? fitHtml(v.merchantFit) : tab === 'deal' ? dealHtml(v.deal) : tab === 'changed' ? changedHtml(v.whatChanged) : tab === 'mem' ? memoryHtml(history) : tab === 'more' ? moreHtml(info, v) : `<h3 class="sl-h3">À demander maintenant</h3>${askListHtml(v.askNow, info.caseId, true)}`;
  return `<div class="sl"><header class="sl-hd"><div><h1>${esc(info.supplier ?? 'Fournisseur')}</h1><p class="sl-sub">${esc(info.title)}</p></div>${btn('Fermer', 'sl-nav', 'home', '', 'ghost')}</header>${flash ? `<p class="sl-flash">${esc(flash)}</p>` : ''}${head}${nav}<div class="sl-pane">${body}</div></div>`;
}
function moreHtml(info, v) {
  const s = v.truthCard.risk.quality; const smp = info.sample;
  return `<h3 class="sl-h3">Échantillon</h3><p class="sl-hint">${esc(smp.status === 'NONE' ? 'Aucun échantillon enregistré.' : `Échantillon : ${SAMPLE_FR[smp.status] ?? smp.status}${smp.verdict ? ` (${VERDICT_SAMPLE_FR[smp.verdict] ?? smp.verdict})` : ''}`)}</p><div class="sl-acts">${btn('Demandé', 'sl-sample', info.caseId, val({ status: 'REQUESTED' }))}${btn('Reçu', 'sl-sample', info.caseId, val({ status: 'RECEIVED' }))}${btn('OK', 'sl-sample', info.caseId, val({ status: 'EVALUATED', verdict: 'PASS' }))}${btn('Réserves', 'sl-sample', info.caseId, val({ status: 'EVALUATED', verdict: 'CONCERNS' }))}${btn('Échec', 'sl-sample', info.caseId, val({ status: 'EVALUATED', verdict: 'FAIL' }))}</div><p class="sl-hint">Qualité : ${esc(LEVEL_FR[s.level])} — ${esc(frList(s.why))}</p>
    <h3 class="sl-h3">Vos chiffres</h3>${numbersForm(info)}<h3 class="sl-h3">Autres écrans</h3><div class="sl-acts">${btn('Parler au fournisseur (mode guidé)', 'sl-expert', info.caseId, val('field'))}${btn('Vue détaillée (expert)', 'sl-expert', info.caseId, val('expert'))}</div>`;
}
export function numbersForm(info) {
  const n = info.numbers ?? {};
  return `<form data-form="sl-numbers" class="sl-form sl-grid"><input type="hidden" name="caseId" value="${esc(info.caseId)}"><label>Prix de vente TTC (€)<input name="price" inputmode="decimal" value="${esc(n.price ?? '')}"></label><label>Marge visée (%)<input name="target" inputmode="decimal" value="${esc(n.target ?? '')}"></label>
    <label>Transport total (€)<input name="freight" inputmode="decimal" value="${esc(n.freight ?? '')}"></label><label>Droit de douane (%)<input name="duty" inputmode="decimal" value="${esc(n.duty ?? '')}"></label><label>Taux de change → €<input name="fx" inputmode="decimal" value="${esc(n.fx ?? '')}"></label><label>Quantité envisagée<input name="qty" inputmode="numeric" value="${esc(n.qty ?? '')}"></label>
    <button class="sl-btn pri" type="submit">Enregistrer</button></form><p class="sl-hint">Estimations de votre part. Une case vide reste inconnue : rien n'est supposé.</p>`;
}

// ---- ask / negotiate ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ASK NEXT, scannable at the stand: a short title, ONE compact tag for why it matters, the English line, the Chinese line, a Copy button. The long explanation stays in the data (whyFr) but is not shown.
const ASK_TITLE = { COMPLIANCE_BLOCKER: 'Document à corriger', IDENTITY: 'Modèle exact', CONFLICT_PRICE: 'Prix ou quantité contradictoires', CONFLICT: 'Contradiction à lever', PRICE: 'Prix unitaire', MOQ: 'Minimum de commande', MATERIAL: 'Matière', CERTIFICATION: 'Documents de conformité', INCOTERM: 'Incoterm', LEAD_TIME: 'Délai de production', PAYMENT: 'Paiement', SAMPLE: 'Échantillon', CARTON: 'Carton', OTHER: 'À préciser' };
const ASK_TAG = { COMPLIANCE_BLOCKER: 'Bloquant pour conformité', IDENTITY: 'Bloquant pour conformité', CERTIFICATION: 'Bloquant pour conformité', CONFLICT_PRICE: 'Bloquant pour calcul', CONFLICT: 'Bloquant pour calcul', PRICE: 'Bloquant pour calcul', MOQ: 'Bloquant pour calcul', INCOTERM: 'Bloquant pour calcul' };
// the engine files the model AND the manufacturer under IDENTITY: the manufacturer question must not be titled "Modèle exact"
export const askTitle = (kind, id = '', verify = false) => { const t = id === 'manufacturer' ? 'Fabricant (nom et adresse)' : ASK_TITLE[kind] ?? ASK_TITLE.OTHER; return verify ? `Vérifier : ${t}` : t; };
// a fact the supplier already gave and nobody confirmed is VERIFIED with the supplier, not asked again
export const askTag = (kind, verify = false) => (verify ? 'À confirmer' : ASK_TAG[kind] ?? 'Important avant achat');
export const askCopyText = (i) => [i.en, i.zh?.text].filter(Boolean).join('\n\n');
export function askListHtml(ask, caseId, compact = false) {
  if (ask.empty) return `<p class="sl-hint">${esc(fr(ask.message))}</p>`;
  const items = ask.items.map((i) => `<li class="sl-q"><div class="sl-fh"><b>${i.rank}. ${esc(askTitle(i.kind, i.id, Boolean(i.verify)))}</b>${i.state !== 'OPEN' ? pill({ ASKED: 'posée', ANSWERED: 'répondue', SKIPPED: 'passée', ASKED_NO_ANSWER: 'sans réponse' }[i.state] ?? i.state, 'warn') : ''}</div>
    <span class="sl-tag t-${i.verify ? 'imp' : i.kind === 'COMPLIANCE_BLOCKER' || i.kind === 'IDENTITY' || i.kind === 'CERTIFICATION' ? 'conf' : ASK_TAG[i.kind] ? 'calc' : 'imp'}">${esc(askTag(i.kind, Boolean(i.verify)))}</span>
    <p class="sl-lang">EN</p><p class="sl-qen" lang="en">${esc(i.en ?? '')}</p>${i.zh ? `<p class="sl-lang">中文</p><p class="zh sl-qzh" lang="zh-Hans">${esc(i.zh.text)}</p>` : `<small class="sl-zhn">${esc(fr(i.zhNote))}</small>`}
    <div class="sl-acts">${btn('Copier', 'sl-copy', i.id, ` data-case="${esc(caseId)}"`, 'ghost')}${compact ? '' : `${btn('Montrer', 'sl-show', i.id, ` data-case="${esc(caseId)}"`, 'pri')}${btn('Posée', 'sl-ask-state', i.id, `${val('ASKED')} data-case="${esc(caseId)}"`)}${btn('Répondue', 'sl-ask-state', i.id, `${val('ANSWERED')} data-case="${esc(caseId)}"`)}${btn('Passer', 'sl-ask-state', i.id, `${val('SKIPPED')} data-case="${esc(caseId)}"`, 'ghost')}`}</div></li>`).join('');
  return `<p class="sl-hint">${esc(fr(ask.message))}</p>${ask.items.some((i) => i.zh) ? `<p class="sl-hint sl-zhwarn">${esc(fr(ask.chineseNote))}</p>` : ''}<ol class="sl-qs">${items}</ol>`;
}
export function askHtml({ info, ask, flash = '' }) { return `<div class="sl"><header class="sl-hd"><div><h1>Demander</h1><p class="sl-sub">${esc(info.supplier ?? info.title)}</p></div>${btn('Fiche', 'sl-open-case', info.caseId, '', 'ghost')}</header>${flash ? `<p class="sl-flash">${esc(flash)}</p>` : ''}${askListHtml(ask, info.caseId)}</div>`; }
export function showHtml({ item }) { return `<div class="sl-showq"><button type="button" class="sl-btn ghost" data-act="sl-show-close">Fermer</button><p class="sl-qen big" lang="en">${esc(item.en ?? '')}</p>${item.zh ? `<p class="zh sl-qzh big" lang="zh-Hans">${esc(item.zh.text)}</p><small>Phrase fixe, pas relue par un locuteur natif.</small>` : '<small>Pas de phrase chinoise disponible pour cette question.</small>'}</div>`; }
export function negotiateHtml({ info, plan, embedded = false }) {
  const cur = plan.currentOffer; const tg = plan.target; const wa = plan.walkAway;
  const lever = (l) => `<li class="sl-lv"><b>${esc(fr(l.ask))}</b><small>${esc(fr(l.why))}${l.basis ? ` · ${esc(fr(l.basis))}` : ''}</small>${l.zh ? `<p class="zh sl-qzh" lang="zh-Hans">${esc(l.zh)}</p>` : `<small class="sl-zhn">${esc(fr(l.zhNote))}</small>`}</li>`;
  return `<div class="sl">${embedded ? '' : `<header class="sl-hd"><div><h1>Négocier</h1><p class="sl-sub">${esc(info.supplier ?? info.title)}</p></div>${btn('Fiche', 'sl-open-case', info.caseId, '', 'ghost')}</header>`}
    <dl class="sl-dl">${kv('Offre actuelle', cur.unitPrice ? `${esc(moneyText(cur.unitPrice, cur.currency))} · MOQ ${esc(cur.moq ?? '?')} · ${esc(cur.incoterm ?? 'Incoterm ?')}` : '<em>pas de prix</em>')}${kv('Objectif', tg.status === 'CONFIGURED_STEP' ? `${esc(tg.display)}<small>${esc(fr(tg.basis))}</small>` : `<em>${plan.status === 'READY' ? 'aucune cible configurée' : 'données insuffisantes'}</em><small>${esc(fr(tg.reason ?? ''))}${tg.missing ? ` Manque : ${esc(tg.missing.map(fr).join(', '))}` : ''}</small>`)}${kv('Limite (prix d\'achat max)', wa.display ? esc(wa.display) : `<em>inconnue</em>${wa.missing ? `<small>Manque : ${esc(wa.missing.map(fr).join(', '))}</small>` : ''}`)}</dl>
    ${plan.status !== 'READY' ? '<p class="sl-flash">Pas assez d\'éléments pour fixer un objectif de prix. Posez d\'abord les questions ci-dessous.</p>' : ''}
    <h3 class="sl-h3">À demander maintenant</h3><ul class="sl-list">${plan.askNow.map(lever).join('') || '<li>Rien de plus à demander.</li>'}</ul>
    ${plan.ifPriceRefused.length ? `<h3 class="sl-h3">Si le prix est refusé, échangez</h3><ul class="sl-list">${plan.ifPriceRefused.map((x) => `<li><b>${esc(fr(x.ask))}</b><small>${esc(fr(x.why))}</small></li>`).join('')}</ul>` : ''}<p class="sl-hint">${esc(fr(plan.noForecast))} Nordla ne négocie pas à votre place.</p></div>`;
}

// ---- comparison ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function compareHtml({ view, saved, flash = '' }) {
  const a = view.summary.answers; const name = (id) => view.cards.find((c) => c.caseId === id)?.supplier ?? id;
  const qa = [
    ['Qui paraît le plus solide ?', a.strongest.caseId ? `${esc(name(a.strongest.caseId))} (préféré)` : `Personne n'est préféré. ${a.strongest.bestSupported?.length ? `Mieux documenté : ${esc(a.strongest.bestSupported.map((x) => name(x.caseId)).join(', '))}.` : ''}<small>${esc(fr(a.strongest.basis))}</small>`],
    ['Qui est le moins cher ?', a.cheapest.caseId ? `${esc(name(a.cheapest.caseId))} : ${esc(moneyText(a.cheapest.unitPrice, a.cheapest.currency))}${a.cheapest.incoterm ? ` ${esc(a.cheapest.incoterm)}` : ''}<small>le plus bas prix annoncé, pas la meilleure offre</small>` : `<em>non comparable</em><small>${esc(fr(a.cheapest.note))}</small>`],
    ['Meilleur coût rendu ?', a.bestLanded.caseId ? `${esc(name(a.bestLanded.caseId))} : ${esc(a.bestLanded.display)}${a.bestLanded.provisional ? ' <span class="sl-pill warn">provisoire</span>' : ''}` : `<em>inconnu</em><small>${esc(fr(a.bestLanded.note))}</small>`],
    ['Qui est bloqué ?', a.blocked.length ? a.blocked.map((x) => `${esc(name(x.caseId))} (${esc(fr(x.why))})`).join('<br>') : 'Personne'],
    ['Preuves faibles ?', a.weakEvidence.length ? a.weakEvidence.map((x) => `${esc(name(x.caseId))}`).join(', ') : 'Aucun'],
    ['Contradictions ?', a.contradictions.length ? a.contradictions.map((x) => `${esc(name(x.caseId))} : ${esc(fr(x.what))}`).join('<br>') : 'Aucune enregistrée'],
  ].map(([q, r]) => `<div class="sl-qa"><dt>${esc(q)}</dt><dd>${r}</dd></div>`).join('');
  const summary = `<p class="sl-head ${view.summary.noWinnerReason ? 'none' : 'win'}">${esc(fr(view.summary.headline))}</p>${view.summary.noWinnerReason ? `<p class="sl-hint">${esc(fr(view.summary.noWinnerReason))}</p>` : ''}<dl class="sl-dl">${qa}</dl><p class="sl-hint">Aucun gagnant au seul prix.</p>`;
  const cards = view.cards.map((c) => `<article class="sl-ccard r-${cls(c.role)}"><div class="sl-fh"><b>${esc(c.supplier ?? c.title)}</b>${pill(ROLE_FR[c.role], `role-${c.role}`)}</div><div class="sl-row">${pill(REC_FR[c.recommendation], `rec-${c.recommendation}`)}${pill(EV_FR[c.evidenceCompleteness], `ev-${c.evidenceCompleteness}`)}${c.fit ? pill(FIT_FR[c.fit] ?? c.fit, `fit-${c.fit}`) : ''}</div>
    <dl class="sl-dl tight">${kv('Prix', `${MARK[c.price.status]} ${esc(fr(c.price.text))}`)}${kv('Coût rendu', `${MARK[c.landed.status]} ${esc(fr(c.landed.text))}`)}${kv('Marge', `${MARK[c.margin.status]} ${esc(fr(c.margin.text))}`)}</dl>
    ${c.flags.length ? `<div class="sl-row">${c.flags.map((f) => pill({ BLOCKED: 'bloqué', CONTRADICTION: 'contradiction', WEAK_EVIDENCE: 'preuves faibles', CHEAPEST_QUOTE: 'moins cher', BEST_LANDED: 'meilleur coût rendu' }[f.kind] ?? f.kind, `fl-${f.kind}`)).join('')}</div>` : ''}${c.askTop ? `<p class="sl-askp"><b>À demander :</b> ${esc(c.askTopKind ? askTitle(c.askTopKind, c.askTopId) : '')} <span class="sl-orig" lang="en">${esc(c.askTop)}</span></p>` : ''}${btn('Ouvrir la fiche', 'sl-open-case', c.caseId, '', 'ghost')}</article>`).join('');
  const dec = view.decisive.map((d) => `<li>${d.text ? `<b>${esc(fr(d.label))}</b><br>${esc(fr(d.text))}` : `<b>${esc(fr(d.label))}</b><br>mieux : ${esc(d.best.name)} (${esc(fr(d.best.text))}) · moins bien : ${esc(d.worst.name)} (${esc(fr(d.worst.text))})`}</li>`).join('') || '<li>Pas de différence décisive comparable pour l\'instant.</li>';
  const risks = `${view.risks.conflicts.map((c) => `<li class="sl-risk lv-HIGH"><b>${esc(c.kind === 'CROSS_CASE_CLAIM' ? 'Entre deux offres' : 'Contradiction')}</b><span>${esc(fr(c.text))}</span></li>`).join('')}${view.risks.high.map((r) => `<li class="sl-risk lv-HIGH"><b>${esc(view.cards.find((c) => c.caseId === r.caseId)?.supplier ?? r.caseId)} · ${esc(RISK_FR[r.area] ?? r.area)}</b><span>${esc(frList(r.why))}</span></li>`).join('')}` || '<li>Aucun risque élevé enregistré.</li>';
  const eco = `${view.economics.deals.reasons.length ? `<ul class="sl-list">${view.economics.deals.reasons.map((r) => `<li>${esc(fr(r))}</li>`).join('')}</ul>` : ''}<ul class="sl-list">${view.economics.perCase.map((p) => `<li><b>${esc(view.cards.find((c) => c.caseId === p.caseId)?.supplier ?? p.caseId)}</b> ${p.deal ? `${esc(p.deal.quoted.unitPrice ?? '?')} ${esc(p.deal.quoted.currency ?? '')} ${esc(p.deal.quoted.incoterm ?? '')} → rendu ${esc(p.deal.landed.display ?? '?')} · max ${esc(p.deal.maxPurchasePrice.display ?? '?')}` : ''}</li>`).join('')}</ul>`;
  const evid = `<ul class="sl-list">${view.evidence.map((e) => `<li><b>${esc(e.name)}</b> ${pill(EV_FR[e.completeness], `ev-${e.completeness}`)}${e.blocking.length ? `<small>Bloque : ${esc(frList(e.blocking))}</small>` : ''}${e.improve.length ? `<small>Pour améliorer : ${esc(frList(e.improve.slice(0, 3)))}</small>` : ''}</li>`).join('')}</ul>`;
  const ask = `<ul class="sl-list">${view.askNext.map((n) => `<li><b>${esc(n.name)}</b>${n.items.length ? n.items.map((i) => `<small><b>${esc(askTitle(i.kind, i.id, Boolean(i.verify)))}</b> · ${esc(askTag(i.kind, Boolean(i.verify)))}<br><span lang="en">${esc(i.en ?? '')}</span></small>`).join('') : '<small>Rien de décisif à demander.</small>'}${n.items.length ? btn('Demander', 'sl-ask', n.caseId, '', 'ghost') : ''}</li>`).join('')}</ul>`;
  const r = view.recommendation;
  const rec = `<p class="sl-head ${r.caseId ? 'win' : 'none'}">${r.caseId ? `${esc(REC_FR[r.value])} : ${esc(view.cards.find((c) => c.caseId === r.caseId)?.supplier ?? r.caseId)}` : esc(REC_FR[r.value])}</p><ul class="sl-list">${r.why.map((w) => `<li>${esc(fr(w))}</li>`).join('')}</ul><p class="sl-hint">Recommandation du sourcing, en attente de votre décision. Elle ne déclenche aucun achat ni paiement.</p>`;
  return `<div class="sl"><header class="sl-hd"><div><h1>Comparaison</h1><p class="sl-sub">${view.cards.length} fournisseurs</p></div>${btn('Fermer', 'sl-nav', 'home', '', 'ghost')}</header>${flash ? `<p class="sl-flash">${esc(flash)}</p>` : ''}
    ${section('summary', 'Résumé', summary)}${section('cards', 'Fournisseurs', `<div class="sl-ccards">${cards}</div>`)}${section('decisive', 'Ce qui fait la différence', `<ul class="sl-list">${dec}</ul>`)}${section('risks', 'Risques et contradictions', `<ul class="sl-list">${risks}</ul>`, false)}${section('economics', 'Chiffres', eco, false)}${section('evidence', 'Preuves', evid, false)}${section('askNext', 'À demander', ask)}${section('recommendation', 'Recommandation', rec)}
    <div class="sl-bar">${saved ? '<span>Enregistrée</span>' : ''}${btn(saved ? 'Mettre à jour' : 'Enregistrer cette comparaison', 'sl-save-cmp', '', '', 'pri')}</div></div>`;
}
