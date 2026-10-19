// MARKET RADAR screen block (phone): what the last "Rechercher les prix en Europe" brought back, read from the CASE (so it stays readable offline and later). Every listing shows seller, price, source, date and a link that says what it
// really is (a Google Shopping page, never presented as a direct Amazon / bol.com page). Excluded listings (lots, accessories, different capacity, aberrant prices) stay visible with their reason: nothing is silently removed.
import { esc } from '../dom.js';
import { getBlob } from '../storage.js';

const CLASS = { EXACT_MATCH: 'Correspondance exacte', PROBABLE_MATCH: 'Correspondance probable', SIMILAR_PRODUCT: 'Produit similaire' };
const FLAG = { PACK_OR_LOT: 'lot ou pack ?', PROMO_PRINTED: 'promotionnel / personnalisé ?', NO_TEXT_OVERLAP: 'sans rapport avec la recherche ?', ACCESSORY_SUSPECTED: 'accessoire ?', PRICE_OUTLIER_HIGH: 'prix très élevé (aberrant ?)', PRICE_OUTLIER_LOW: 'prix très bas (aberrant ?)', CAPACITY_DIFFERS: 'capacité différente', CAPACITY_NOT_STATED: 'capacité non indiquée', MODEL_NOT_IN_TITLE: 'modèle absent du titre', BRAND_NOT_IN_TITLE: 'autre marque (ou marque absente)', VARIANT_DIFFERS: 'autre variante', TYPE_DIFFERS: 'autre type de produit', VARIANT_NOT_STATED: 'variante non indiquée', NO_PRICE: 'pas de prix', FOREIGN_CURRENCY_NO_RATE: 'devise sans taux' };
const MP = { 'amazon.be': 'Amazon.be', 'bol.com': 'bol.com', amazon: 'Amazon' };
const eur = (n) => `${Number(n).toFixed(2).replace('.', ',')} €`;
const when = (iso) => { try { return new Intl.DateTimeFormat('fr-BE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Brussels' }).format(new Date(iso)); } catch { return String(iso ?? ''); } };
const safeUrl = (u) => (/^https:\/\//i.test(String(u)) ? u : null);

function card(e) {
  const s = e.specs ?? {}; const url = safeUrl(e.url); const flags = (s.flags ?? []).map((f) => `<span class="fm-chip warn">${esc(FLAG[f] ?? f)}</span>`).join('');
  const price = e.price ? `<b>${esc(eur(e.price.amount))}</b>${e.price.currency !== 'EUR' ? ` ${esc(e.price.currency)}` : ''}` : '<span class="fm-d">prix absent</span>';
  const link = url ? `<a class="fm-lnk2" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${s.linkKind === 'GOOGLE_SHOPPING_PAGE' ? 'Ouvrir la page Google Shopping' : 'Ouvrir la page du marchand'}</a>` : '<span class="fm-d">lien absent</span>';
  return `<div class="fm-rl"><div class="fm-rl-t">${esc(s.title ?? '(sans titre)')}</div>
    <div class="fm-rl-m"><span>${esc(e.seller ?? 'vendeur inconnu')}${s.marketplace ? ` <span class="fm-chip">${esc(MP[s.marketplace] ?? s.marketplace)}</span>` : ''}</span><span>${price}</span></div>
    ${flags ? `<div class="fm-rl-f">${flags}</div>` : ''}<div class="fm-rl-s">${esc(CLASS[e.matchType] ?? e.matchType)} · ${esc(e.reason ?? '')}</div>
    ${s.pack ? `<div class="fm-rl-s">≈ <b>${esc(eur(s.pack.unitEur))}</b> la pièce (estimation : prix ÷ ${esc(s.pack.n)} lu dans le titre, non vérifiée ; hors prix de référence)</div>` : ''}<div class="fm-rl-s">Source : Google Shopping (via DataForSEO) · relevé le ${esc(when(e.observedAt))} · <b>disponibilité non vérifiée</b></div><div class="fm-rl-l">${link}</div></div>`;
}
const group = (title, rows, open = false) => (rows.length ? `<details class="fm-rg" ${open ? 'open' : ''}><summary>${esc(title)} (${rows.length})</summary>${rows.map(card).join('')}</details>` : '');

/** @param {object|undefined} rec the last marketSearches entry of the case (with .radar) */
export function radarResultBlock(rec) {
  const r = rec?.radar; if (!rec || !r) return '';
  const pending = !!(r.question && (r.question.options ?? []).length); const ev = rec.evidence ?? []; const inc = ev.filter((e) => !e.specs?.excluded); const exc = ev.filter((e) => e.specs?.excluded);
  const legacy = !Array.isArray(r.groups); const relGroups = (r.groups ?? []).filter((g) => g.reliable); const smallGroups = (r.groups ?? []).filter((g) => !g.reliable);
  const hasFlag = (e, f) => (e.specs?.flags ?? []).includes(f); const lots = exc.filter((e) => hasFlag(e, 'PACK_OR_LOT')); const accs = exc.filter((e) => !hasFlag(e, 'PACK_OR_LOT') && hasFlag(e, 'ACCESSORY_SUSPECTED')); const others = exc.filter((e) => !lots.includes(e) && !accs.includes(e));
  const by = (t) => inc.filter((e) => e.matchType === t); const mk = r.marketplaces ?? {}; const cmp = r.comparison; const ref = r.reference;
  const found = (k, label) => `<div class="fm-li"><i class="fm-dot ${mk[k] ? 'ok' : ''}"></i><span>${label} : <b>${mk[k] ? `trouvé dans cette recherche (${mk[k]})` : 'absent de ces résultats'}</b></span></div>`;
  return `${identBlock(r.identification)}${confirmLine(r.confirmation)}${questionCard(r.question)}${ev.length ? preciseBox() : ''}<div class="fm-k2">Résultat de la recherche</div>
    <p class="fm-note">Relevé le <b>${esc(when(r.observedAt ?? rec.completedAt))}</b> · marché <b>Belgique</b> (${esc(r.market?.searchDomain ?? 'google.be')}) · ${ev.length} annonce(s) · exactes ${r.summary?.exact ?? 0}, probables ${r.summary?.probable ?? 0}, similaires ${r.summary?.similar ?? 0}${r.cached ? ' · <b>résultat déjà obtenu (aucune nouvelle recherche payée)</b>' : ''}${r.partial ? ' · <b>résultat partiel (délai dépassé)</b>' : ''}.<br>Requêtes : ${(r.queries ?? []).map((q) => `« ${esc(q.text)} » <small>(${esc(q.via)})</small>`).join(' ; ') || '—'}</p>
    ${ev.length === 0 ? '<p class="fm-note"><b>Aucune annonce fiable trouvée par cette recherche.</b> Cela ne veut pas dire que le produit n’est pas vendu en Europe.</p>' : ''}
    ${pending && ev.length ? '<p class="fm-note fm-warnline" role="status"><b>Prix de référence en attente de votre précision :</b> les annonces mélangent plusieurs tailles, Nordla ne calcule pas de médiane tant que vous n’avez pas répondu (ou dit « Je ne sais pas »).</p>' : ''}
    ${ev.length && (r.summary?.exact ?? 0) === 0 ? '<p class="fm-note"><b>Aucun produit exact trouvé.</b> Les annonces ci-dessous sont, au mieux, des correspondances probables : elles ne sont jamais présentées comme le même produit.</p>' : ''}
    ${!pending && ev.length && (legacy ? (!ref || ref.reliable === false) : !relGroups.length) ? unreliableBox(ref, r.confirmation, r.queries) : ''}
    ${!pending && legacy && ref && ref.reliable !== false ? groupBox({ class: ref.matchClass, count: ref.count, minEur: ref.minEur, medianEur: ref.medianEur, maxEur: ref.maxEur }, false, exc.length, ref.note) : ''}
    ${!pending && !legacy ? relGroups.map((g, i) => groupBox(g, (r.groups ?? []).length > 1, i === 0 ? exc.length : 0, null)).join('') : ''}
    ${!pending && !legacy && relGroups.length && smallGroups.length ? `<p class="fm-note">Groupes trop petits pour un prix (minimum 3 annonces comparables, pas de médiane) : ${smallGroups.map((g) => `${esc(groupLabel(g))} — ${g.count} annonce(s) : ${(g.pricesEur ?? []).map((x) => esc(eur(x))).join(' · ')}`).join(' ; ')}.</p>` : ''}
    ${!pending && (r.indicative ?? []).length ? indicativeBox(r.indicative) : ''}
    <div class="fm-k2">Amazon.be et bol.com (vérifiés séparément)</div>${found('amazon.be', 'Amazon.be')}${found('bol.com', 'bol.com')}
    <p class="fm-note">« Trouvé » = une annonce nommant ce vendeur est revenue dans <b>cette</b> recherche. « Absent » ne veut pas dire « non vendu ». Les liens ouvrent <b>la page Google Shopping</b> du produit, pas une page directe d’Amazon ou de bol.com.</p>
    ${cmp && !pending ? `<div class="fm-k2">Comparaison avec le prix fournisseur</div><p class="fm-note">${esc(cmp.note ?? '')}${cmp.supplierEur != null ? ` (prix fournisseur converti : ${esc(eur(cmp.supplierEur))}, taux BCE du ${esc(cmp.ecbDate ?? '?')})` : ''}</p><ul class="fm-lim">${(cmp.caveats ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="fm-k2">Annonces</div>${group('Correspondances exactes', by('EXACT_MATCH'), true)}${group('Correspondances probables', by('PROBABLE_MATCH'), true)}${group('Produits similaires', by('SIMILAR_PRODUCT'))}${group('Lots et packs — hors prix de référence (prix à la pièce estimé)', lots)}${group('Accessoires — exclus des prix', accs)}${group('Écartées du calcul (avec la raison)', others)}
    <p class="fm-note">Ces preuves sont conservées dans le dossier avec leur source et leur date. Une annonce prouve que quelqu’un vend quelque chose de comparable à ce prix, pas que vous pouvez vendre ce produit.</p>`;
}


/** ONE question at most, built by the server from evidence only: every option says where it comes from, none is preselected, "Je ne sais pas" is always there. Answering re-reads the listings already obtained: no paid call. */
function questionCard(q) {
  if (!q || !(q.options ?? []).length) return '';
  const opts = q.options.map((o, i) => `<button type="button" class="btn sec fm-opt" data-act="market-answer" data-key="${i}"><b>${esc(o.label)}</b>${o.evidence ? `<small>${esc(o.evidence)}</small>` : ''}</button>`).join('');
  return `<div class="fm-rbox fm-q" role="group" aria-label="Une précision"><div class="fm-k2 first">Une précision (une touche)</div><p class="fm-note"><b>${esc(q.prompt)}</b> Nordla ne choisit pas à votre place : ces valeurs viennent de l’étiquette ou des annonces relevées. Aucune n’est cochée d’avance.${q.allowOther ? ' Si la bonne n’y est pas, écrivez-la dans « Autre ».' : ''}</p>
    <div class="fm-opts">${opts}${q.allowOther ? `<label class="fm-other"><span><b>Autre</b> — ${esc(q.otherPlaceholder ?? 'à saisir')}</span><span class="fm-other-row"><input type="text" data-other-input maxlength="40" autocomplete="off" aria-label="Autre : saisie libre"><button type="button" class="btn sec" data-act="market-other">Valider</button></span></label>` : ''}<button type="button" class="btn sec fm-opt fm-unk" data-act="market-answer" data-key="unknown"><b>${esc(q.unknownLabel ?? 'Je ne sais pas')}</b></button></div>
    <p class="fm-note">Répondre ne lance <b>aucune recherche payante</b> : les annonces déjà relevées sont relues, gratuitement.</p></div>`;
}
const confirmLine = (c) => {
  if (!c) return '';
  const v = c.accumulated ?? (c.unknown ? {} : c.value) ?? {};
  const what = [v.capacityMl ? `taille <b>${esc(fmtMlView(v.capacityMl))}</b>` : '', v.model ? `modèle <b>${esc(v.model)}</b>` : '', v.variant ? `variante <b>${esc(v.variant.label)}</b>` : '', v.productType ? `type <b>${esc(TYPE_LABEL[v.productType] ?? v.productType)}</b>` : ''].filter(Boolean).join(' · ');
  const unk = c.unknown ? '<p class="fm-note">Précision : <b>vous ne savez pas</b> — pas de filtre ajouté sur ce point : les prix sont donnés <b>par groupe</b> (jamais mélangés) et restent non fiables s’il y a trop peu d’annonces comparables.</p>' : '';
  const rec = what ? `<p class="fm-note">Précision confirmée par vous : ${what}. Les annonces dont la taille, le modèle, la variante ou la marque ne correspondent pas (ou ne se vérifient pas) sont écartées du calcul mais restent consultables avec leur raison.</p>` : '';
  return unk + rec;
};
const fmtMlView = (ml) => (ml >= 1000 ? `${(ml / 1000).toFixed(2).replace(/0$/, '').replace(/\.$/, '').replace('.', ',')} L` : `${ml} ml`);
/** No median unless at least 3 really comparable listings: otherwise Nordla says so instead of showing a misleading number. A confirmed answer that the listings could not match offers an explicit, capped, PAID new search. */
function unreliableBox(ref, c, queries) {
  const prices = (ref?.pricesEur ?? []).map((x) => esc(eur(x))).join(' · ');
  const known = (queries ?? []).map((q) => String(q.text).toLowerCase()).join(' ');
  const cv = c?.accumulated ?? (c && !c.unknown ? c.value : null); const wants = cv && ((cv.model && !known.includes(String(cv.model).toLowerCase())) || (cv.capacityMl && !/\d\s?(l|ml|cl|oz)\b/.test(known)));
  return `<div class="fm-rbox fm-unrel" role="status"><div class="fm-k2 first">Prix de référence non fiable</div><p class="fm-note"><b>Nordla ne donne pas de médiane</b> : ${esc(ref?.note ?? 'aucune annonce vraiment comparable n’a été trouvée')}.${prices ? ` Prix des annonces comparables (à lire une par une) : ${prices}.` : ''} Les autres annonces restent listées plus bas, avec la raison de leur exclusion.</p>
    ${wants ? '<p class="fm-note">Une recherche plus précise avec votre réponse est possible : <b>c’est une nouvelle recherche payante</b> (quelques centimes, plafond appliqué par le serveur). Elle ne part que si vous appuyez.</p><button type="button" class="btn sec" data-act="market-rerun">Chercher avec cette précision (payant)</button>' : ''}</div>`;
}
const TYPE_LABEL = { bottle: 'gourde / bouteille', tumbler: 'gobelet de voyage', jug: 'cruche / carafe', none: 'type non précisé' };
const groupLabel = (g) => [CLASS[g.class], g.type ? TYPE_LABEL[g.type] ?? g.type : '', g.variant && g.variant.key !== 'none' ? g.variant.label : g.variant ? 'variante non indiquée' : '', g.size?.label].filter(Boolean).join(' · ');
/** One homogeneous group (a class, a size, a variant): its own range, never averaged with another. */
function groupBox(g, labelled, excCount, note) {
  return `<div class="fm-rbox"><div class="fm-k2 first">Prix constatés${labelled || g.variant || g.size ? ` — ${esc(groupLabel(g))}` : ''}</div><p class="fm-rbig">${esc(eur(g.minEur))} – <b>${esc(eur(g.medianEur))}</b> – ${esc(eur(g.maxEur))}</p><p class="fm-note">minimum · médiane · maximum, sur ${g.count} annonce(s) (${esc(CLASS[g.class]?.toLowerCase() ?? g.class)}). ${excCount ? `${excCount} annonce(s) écartée(s) du calcul (lots, accessoires, autres marques, tailles ou variantes différentes, prix aberrants) : elles restent listées plus bas.` : ''} ${note ? `<br><b>${esc(note)}</b>` : ''}</p></div>`;
}
/** PERMANENT "Préciser": the owner types a size, a model or a variant even when no automatic question was asked. Same server validations as "Autre"; the listings already obtained are re-read for free (no paid call, nothing sent). */
const preciseBox = () => `<details class="fm-prec"><summary>Préciser la taille, le modèle ou la variante</summary>
  <p class="fm-note">Si vous les connaissez, écrivez-les : les annonces déjà relevées sont relues <b>gratuitement</b> (aucune recherche payante, aucune photo envoyée).</p>
  <label class="fm-other"><span>Taille — ex. 64 oz ou 1,89 L</span><input type="text" data-prec="capacity" maxlength="40" autocomplete="off" aria-label="Taille"></label>
  <label class="fm-other"><span>Modèle — la référence imprimée</span><input type="text" data-prec="model" maxlength="40" autocomplete="off" aria-label="Modèle"></label>
  <label class="fm-other"><span>Variante — le mot qui la distingue</span><input type="text" data-prec="variant" maxlength="40" autocomplete="off" aria-label="Variante"></label>
  <button type="button" class="btn sec fm-opt" data-act="market-precise"><b>Appliquer</b></button></details>`;
/** INDICATIVE prices per family: similar products of the same family, not the same product. Shown apart from the reference price, never used for the supplier comparison. */
const indicativeBox = (ind) => `<div class="fm-rbox fm-ind" role="note"><div class="fm-k2 first">Prix indicatifs par famille — pas un prix de référence</div>${ind.map((g) => `<p class="fm-note"><b>${esc(TYPE_LABEL[g.type] ?? g.type)}</b> : ${esc(eur(g.minEur))} – <b>${esc(eur(g.medianEur))}</b> – ${esc(eur(g.maxEur))} sur ${g.count} annonce(s) <i>similaires</i></p>`).join('')}<p class="fm-note">Produits de la même famille que le vôtre, <b>pas le même produit</b> : ni correspondance exacte ni probable, rien ne prouve la même taille ou le même modèle. À lire comme un ordre de grandeur, jamais comme un prix de référence, ni pour comparer au prix fournisseur.</p></div>`;
const CONF = { HIGH: 'élevée (code-barres valide)', MEDIUM: 'moyenne (marque et modèle lus)', LOW: 'faible (un nom de catégorie seulement)', NONE: 'aucune' };
/** What Nordla recognised, where it comes from, and what is only a machine proposal. */
function identBlock(i) {
  if (!i) return '';
  const src = i.source === 'LOCAL_BARCODE' ? `Code-barres lu <b>sur le téléphone</b>${i.photo ? ` (photo n°${Number(i.photo.index) + 1})` : ''}${i.engine ? ` · lecteur : ${esc(i.engine)}` : ''} — <b>aucune photo n’a été envoyée</b>.`
    : i.source === 'PHOTO_VISION' ? `Lu par <b>Google Cloud Vision</b> (États-Unis), avec votre accord${i.photo?.consentAt ? ` du ${esc(when(i.photo.consentAt))}` : ''}${i.photo ? ` pour la photo n°${Number(i.photo.index) + 1}` : ''}. <b>Valeurs proposées par une machine : à confirmer.</b>` : 'Saisi par vous.';
  const rows = [['Code-barres', (i.eans ?? []).join(', ')], ['Marque (logo vu)', (i.logos ?? []).join(', ')], ['Modèle lu sur l’étiquette', (i.models ?? []).join(', ')], ['Nom estimé', (i.bestGuess ?? []).join(' ; ')]].filter(([, v]) => v).map(([k, v]) => `<div class="fm-li"><i class="fm-dot ${i.source === 'LOCAL_BARCODE' ? 'ok' : ''}"></i><span>${esc(k)} : <b>${esc(v)}</b></span></div>`).join('');
  const gl = i.gtinLookup; const lookup = gl ? (gl.found ? `<p class="fm-note">Ce code-barres est enregistré dans la base ouverte <b>${esc(gl.source)}</b> comme : <b>${esc([gl.brand, gl.name, gl.quantity].filter(Boolean).join(' · '))}</b> (<a href="${esc(gl.url)}" target="_blank" rel="noopener noreferrer">voir la fiche</a>). C’est ce que le code-barres désigne, pas une preuve que l’objet photographié est ce produit. Seul le numéro a été envoyé à ce service public.</p>` : `<p class="fm-note">Ce code-barres n’est pas dans les bases ouvertes (courant pour les produits non alimentaires) : seul le numéro leur a été envoyé. Les annonces trouvées par le numéro seul ne peuvent pas être vérifiées.</p>`) : '';
  return `<div class="fm-k2">Reconnu par Nordla</div><p class="fm-note">${src}</p>${lookup}${rows || '<p class="fm-note">Rien d’exploitable n’a été reconnu.</p>'}<p class="fm-note">Confiance : <b>${esc(CONF[i.confidence] ?? i.confidence ?? '—')}</b>.${i.confidence === 'LOW' ? ' <b>Les résultats ci-dessous sont des produits COMPARABLES, pas le produit identifié.</b> Un nom de modèle ou un code-barres améliorerait beaucoup la recherche.' : ''}</p>`;
}
const photoCard = (c, m) => {
  if (!m) return ''; const n = Number(m.i) + 1;
  if (m.stage === 'scanning') return `<p class="fm-note">Photo n°${n} : lecture du code-barres <b>sur le téléphone</b>… aucune photo n’est envoyée.</p>`;
  if (m.stage === 'searching') return `<p class="fm-note">Photo n°${n} : ${m.ident?.source === 'LOCAL_BARCODE' ? 'code-barres lu' : 'photo reconnue'}, recherche des prix en cours…</p>`;
  if (m.stage === 'no-code') return `<p class="fm-note fm-warnline">Aucun code-barres lisible sur la photo n°${n}. ${m.reason === 'NO_KEY' || m.reason === 'NOT_ENABLED_BY_OPERATOR' ? 'La reconnaissance par photo n’est pas activée sur ce serveur : rien n’a été envoyé. Reprenez la photo avec le code-barres bien net et bien droit, ou donnez un nom ou une marque au produit : Nordla cherchera à partir de là.' : 'Rien n’a été envoyé.'}</p>`;
  if (m.stage === 'consent') return `<div class="fm-rbox"><div class="fm-k2 first">Votre accord est nécessaire</div><p class="fm-note">Aucun code-barres n’a été lu sur la photo n°${n}. Pour la reconnaître, <b>cette photo</b> (réduite à ${esc(m.width)}×${esc(m.height)} px, ${Math.round(m.bytes / 1024)} Ko) serait envoyée au service <b>Google Cloud Vision, aux États-Unis</b>, depuis le serveur Nordla. Elle n’est ni conservée ni journalisée par Nordla. Coût estimé : ${esc(String(m.estimate ?? '0,0065'))} $ au maximum.</p><p class="fm-note">Empreinte de l’accord (SHA-256) : <code>${esc(String(m.sha256).slice(0, 16))}…</code> : l’accord ne vaut que pour cette image.</p><div class="fm-btns"><button type="button" class="fm-btn fm-primary" data-act="market-photo-send">J’autorise l’envoi de cette photo</button><button type="button" class="fm-btn" data-act="market-photo-cancel">Non, ne rien envoyer</button></div></div>`;
  if (m.stage === 'sending') return `<p class="fm-note">Photo n°${n} envoyée à Google Cloud Vision avec votre accord, analyse en cours…</p>`;
  if (m.stage === 'confirm') return `<div class="fm-rbox"><div class="fm-k2 first">À confirmer (une touche)</div><p class="fm-note">Nordla croit voir : <b>${esc((m.ident?.bestGuess ?? [])[0] ?? '—')}</b>${(m.ident?.logos ?? []).length ? ` · marque possible : <b>${esc(m.ident.logos.join(', '))}</b>` : ''}. Aucune marque ni modèle n’a été lu avec assez de certitude : c’est un nom de catégorie, pas un produit précis. Nordla peut chercher des <b>produits comparables</b>, sans prétendre que c’est le même.</p><div class="fm-btns"><button type="button" class="fm-btn fm-primary" data-act="market-photo-go">Chercher des produits comparables</button><button type="button" class="fm-btn" data-act="market-photo-cancel">Annuler</button></div></div>`;
  if (m.stage === 'none') return `<p class="fm-note fm-warnline">Nordla n’a rien reconnu de fiable sur la photo n°${n}. Rien n’est inventé. Photographiez l’étiquette ou le code-barres, ou donnez un nom au produit.</p>`;
  if (m.stage === 'error') return `<p class="fm-note fm-warnline">${esc(m.msg ?? 'Une erreur est survenue.')} Rien n’a été modifié.</p>`;
  return '';
};
const thumbs = (c) => {
  const ph = c.identity?.photos ?? []; if (!ph.length) return '<p class="small muted">Aucune photo dans ce dossier. Prenez une photo du produit, de son étiquette ou de son code-barres : elle apparaîtra ici.</p>';
  return `<div class="fm-thumbs">${ph.map((_, i) => { const url = getBlob(`photo:${c.id}.${i}`); return url ? `<button type="button" class="fm-thumb" data-act="market-photo" data-key="${i}" aria-label="Chercher à partir de la photo ${i + 1}"><img src="${esc(url)}" alt="Photo ${i + 1}"><span>Photo ${i + 1}</span></button>` : ''; }).join('')}</div>`;
};

/** The whole block for the Expert "Marché" screen (reached from the fiche: "Prix en Europe"): explanation, the buttons, the photo flow, the last answer. */
export function radarPanel(c, { busy = false, flash = '', btnClass = 'btn', photo = null } = {}) {
  const last = (c.marketSearches ?? []).filter((x) => x.radar).at(-1);
  return `<div class="card fm-radar"><h2>PRIX EN EUROPE · RECHERCHE AUTOMATIQUE</h2>
    <p class="small muted">Nordla cherche lui-même les produits identiques ou comparables vendus en Belgique : vendeur, prix, lien et date, puis compare avec le prix du fournisseur.</p>
    <h3>À partir d’une photo du dossier</h3><p class="small muted">Nordla lit d’abord le <b>code-barres sur le téléphone</b> (aucune photo n’est envoyée). Sans code-barres, il propose d’envoyer la photo à Google Cloud Vision, <b>seulement avec votre accord pour cette photo</b>.</p>${thumbs(c)}${photoCard(c, photo)}
    <h3>À partir du nom, de la marque, du modèle ou du code-barres du dossier</h3><button type="button" class="${esc(btnClass)}" data-act="market-run" ${busy ? 'disabled' : ''}>${busy ? 'Recherche en cours…' : 'Rechercher les prix en Europe'}</button><p class="small muted">Texte seulement, aucune photo (Google Shopping via DataForSEO, depuis le serveur Nordla).</p>${flash ? `<p class="fm-note fm-warnline">${esc(flash)}</p>` : ''}
    ${last ? radarResultBlock(last) : '<p class="small muted">Aucune recherche faite pour ce dossier. Elle ne part que si vous appuyez.</p>'}</div>`;
}
