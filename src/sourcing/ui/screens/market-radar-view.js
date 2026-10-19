// MARKET RADAR screen block (phone): what the last "Rechercher les prix en Europe" brought back, read from the CASE (so it stays readable offline and later). Every listing shows seller, price, source, date and a link that says what it
// really is (a Google Shopping page, never presented as a direct Amazon / bol.com page). Excluded listings (lots, accessories, different capacity, aberrant prices) stay visible with their reason: nothing is silently removed.
import { esc } from '../dom.js';

const CLASS = { EXACT_MATCH: 'Correspondance exacte', PROBABLE_MATCH: 'Correspondance probable', SIMILAR_PRODUCT: 'Produit similaire' };
const FLAG = { PACK_OR_LOT: 'lot ou pack ?', PROMO_PRINTED: 'promotionnel / personnalisé ?', ACCESSORY_SUSPECTED: 'accessoire ?', PRICE_OUTLIER_HIGH: 'prix très élevé (aberrant ?)', PRICE_OUTLIER_LOW: 'prix très bas (aberrant ?)', CAPACITY_DIFFERS: 'capacité différente', CAPACITY_NOT_STATED: 'capacité non indiquée', MODEL_NOT_IN_TITLE: 'modèle absent du titre', NO_PRICE: 'pas de prix', FOREIGN_CURRENCY_NO_RATE: 'devise sans taux' };
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
    <div class="fm-rl-s">Source : Google Shopping (via DataForSEO) · relevé le ${esc(when(e.observedAt))}</div><div class="fm-rl-l">${link}</div></div>`;
}
const group = (title, rows, open = false) => (rows.length ? `<details class="fm-rg" ${open ? 'open' : ''}><summary>${esc(title)} (${rows.length})</summary>${rows.map(card).join('')}</details>` : '');

/** @param {object|undefined} rec the last marketSearches entry of the case (with .radar) */
export function radarResultBlock(rec) {
  const r = rec?.radar; if (!rec || !r) return '';
  const ev = rec.evidence ?? []; const inc = ev.filter((e) => !e.specs?.excluded); const exc = ev.filter((e) => e.specs?.excluded);
  const by = (t) => inc.filter((e) => e.matchType === t); const mk = r.marketplaces ?? {}; const cmp = r.comparison; const ref = r.reference;
  const found = (k, label) => `<div class="fm-li"><i class="fm-dot ${mk[k] ? 'ok' : ''}"></i><span>${label} : <b>${mk[k] ? `trouvé dans cette recherche (${mk[k]})` : 'absent de ces résultats'}</b></span></div>`;
  return `<div class="fm-k2">Résultat de la recherche</div>
    <p class="fm-note">Relevé le <b>${esc(when(r.observedAt ?? rec.completedAt))}</b> · marché <b>Belgique</b> (${esc(r.market?.searchDomain ?? 'google.be')}) · ${ev.length} annonce(s) · exactes ${r.summary?.exact ?? 0}, probables ${r.summary?.probable ?? 0}, similaires ${r.summary?.similar ?? 0}${r.cached ? ' · <b>résultat déjà obtenu (aucune nouvelle recherche payée)</b>' : ''}${r.partial ? ' · <b>résultat partiel (délai dépassé)</b>' : ''}.<br>Requêtes : ${(r.queries ?? []).map((q) => `« ${esc(q.text)} » <small>(${esc(q.via)})</small>`).join(' ; ') || '—'}</p>
    ${ev.length === 0 ? '<p class="fm-note"><b>Aucune annonce fiable trouvée par cette recherche.</b> Cela ne veut pas dire que le produit n’est pas vendu en Europe.</p>' : ''}
    ${ref ? `<div class="fm-rbox"><div class="fm-k2 first">Prix constatés</div><p class="fm-rbig">${esc(eur(ref.minEur))} – <b>${esc(eur(ref.medianEur))}</b> – ${esc(eur(ref.maxEur))}</p><p class="fm-note">minimum · médiane · maximum, sur ${ref.count} annonce(s) (${esc(CLASS[ref.matchClass]?.toLowerCase() ?? ref.matchClass)}). ${exc.length ? `${exc.length} annonce(s) écartée(s) du calcul (lots, accessoires, capacités différentes, prix aberrants) : elles restent listées plus bas.` : ''} ${ref.note ? `<br><b>${esc(ref.note)}</b>` : ''}</p></div>` : ''}
    <div class="fm-k2">Amazon.be et bol.com (vérifiés séparément)</div>${found('amazon.be', 'Amazon.be')}${found('bol.com', 'bol.com')}
    <p class="fm-note">« Trouvé » = une annonce nommant ce vendeur est revenue dans <b>cette</b> recherche. « Absent » ne veut pas dire « non vendu ». Les liens ouvrent <b>la page Google Shopping</b> du produit, pas une page directe d’Amazon ou de bol.com.</p>
    ${cmp ? `<div class="fm-k2">Comparaison avec le prix fournisseur</div><p class="fm-note">${esc(cmp.note ?? '')}${cmp.supplierEur != null ? ` (prix fournisseur converti : ${esc(eur(cmp.supplierEur))}, taux BCE du ${esc(cmp.ecbDate ?? '?')})` : ''}</p><ul class="fm-lim">${(cmp.caveats ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="fm-k2">Annonces</div>${group('Correspondances exactes', by('EXACT_MATCH'), true)}${group('Correspondances probables', by('PROBABLE_MATCH'), true)}${group('Produits similaires', by('SIMILAR_PRODUCT'))}${group('Écartées du calcul (avec la raison)', exc)}
    <p class="fm-note">Ces preuves sont conservées dans le dossier avec leur source et leur date. Une annonce prouve que quelqu’un vend quelque chose de comparable à ce prix, pas que vous pouvez vendre ce produit.</p>`;
}

/** The whole block for the Expert "Marché" screen (reached from the fiche: "Prix en Europe"): explanation, the button, the last answer. */
export function radarPanel(c, { busy = false, flash = '', btnClass = 'btn' } = {}) {
  const last = (c.marketSearches ?? []).filter((x) => x.radar).at(-1);
  return `<div class="card fm-radar"><h2>PRIX EN EUROPE · RECHERCHE AUTOMATIQUE</h2>
    <p class="small muted">Nordla cherche lui-même, à partir de ce dossier (nom, marque, modèle, code-barres), les produits identiques ou comparables vendus en Belgique : vendeur, prix, lien et date. Il compare ensuite avec le prix du fournisseur. <b>Texte seulement : aucune photo n’est envoyée</b> (Google Shopping via DataForSEO, depuis le serveur Nordla).</p>
    <button type="button" class="${esc(btnClass)}" data-act="market-run" ${busy ? 'disabled' : ''}>${busy ? 'Recherche en cours…' : 'Rechercher les prix en Europe'}</button>${flash ? `<p class="fm-note fm-warnline">${esc(flash)}</p>` : ''}
    ${last ? radarResultBlock(last) : '<p class="small muted">Aucune recherche faite pour ce dossier. C’est facultatif et jamais automatique : elle ne part que si vous appuyez.</p>'}</div>`;
}
