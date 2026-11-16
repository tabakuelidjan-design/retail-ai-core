// Growth > À corriger maintenant - the "dossier de correction" export for ONE tenant (same contract as server/content.js: the merchant
// is fixed by the server context, never taken from a request). READ ONLY: it reads what Core already synced and what the engines
// decided; it writes nothing, in Nordla or in Shopify. The file itself is built by the shared generator (src/shared/corrections).

import { loadDataset } from '../../metrics/load.js';
import { mergeConfig } from '../../metrics/config.js';
import { contentFacts, WEEKS } from '../content/facts.js';
import { buildContent } from '../content/content.js';
import { requireTimeZone } from '../../metrics/profile.js';
import { renderDossier } from '../../shared/corrections/dossier.js';

const DAY = 86400000;
const blank = (v) => v == null || String(v).trim() === '';
const MODULE = 'growth';
const MODULES = { growth: 'Nordla Growth' };

/** Categories of "À corriger maintenant" that can be exported. Same ids as the screen's groups (content problem codes + purchaseCost). */
export const CORRECTION_CATEGORIES = [
  { id: 'purchaseCost', title: 'Coût d’achat non vérifié ou absent', itemLabel: ['produit', 'produits'],
    problem: 'Le coût d’achat de produits vendus n’est pas renseigné ou n’est pas vérifié.',
    impact: 'Sans coût d’achat vérifié, la marge n’est pas fiable : Nordla ne peut pas recommander de pousser ces produits, et le bénéfice affiché reste une estimation.' },
  { id: 'noImage', title: 'Sans image', itemLabel: ['produit', 'produits'],
    problem: 'La fiche produit n’a aucune image (absence prouvée par la synchronisation).', impact: 'Un produit sans image se vend très mal en ligne et ne peut pas être mis en avant.' },
  { id: 'noAltText', title: 'Image sans texte alternatif', itemLabel: ['produit', 'produits'],
    problem: 'L’image principale n’a pas de texte alternatif.', impact: 'Moins bonne accessibilité et moins bon référencement des images.' },
  { id: 'noType', title: 'Sans type de produit', itemLabel: ['produit', 'produits'],
    problem: 'Le champ « type de produit » est vide.', impact: 'Les produits sont plus difficiles à regrouper, filtrer et analyser.' },
  { id: 'noCollection', title: 'Hors collection', itemLabel: ['produit', 'produits'],
    problem: 'Le produit n’appartient à aucune collection (absence prouvée par la synchronisation).', impact: 'Le produit est plus difficile à trouver en naviguant dans la boutique.' },
  { id: 'missingSku', title: 'SKU manquant', itemLabel: ['variante sans SKU', 'variantes sans SKU'],
    problem: 'Au moins une variante n’a pas de SKU. Un produit peut avoir plusieurs variantes dont certaines ont déjà un SKU : seules les variantes vides sont des cas.',
    impact: 'Sans SKU, la variante est difficile à identifier en stock, en caisse, sur d’autres canaux et à rapprocher des factures fournisseurs.' },
  { id: 'duplicateTitle', title: 'Titre en double', itemLabel: ['produit', 'produits'],
    problem: 'Plusieurs produits actifs ont le même titre.', impact: 'Risque de confusion pour les clients, dans les listes de stock et dans les analyses.' },
];
export const CORRECTION_IDS = CORRECTION_CATEGORIES.map((c) => c.id);

const adminBase = (shop) => {
  const h = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/i.exec(String(shop?.myshopifyDomain ?? '').trim());
  return h ? `https://admin.shopify.com/store/${h[1].toLowerCase()}` : null;
};
const numericId = (gid) => /\/(\d+)$/.exec(String(gid ?? ''))?.[1] ?? null;
/** A link only when it can be built from reliable parts (a Shopify gid + the shop's myshopify handle). Never guessed. */
const productLinks = (shop, p, active) => {
  const base = adminBase(shop); const id = numericId(p.source_id);
  const admin = base && id ? `${base}/products/${id}` : null;
  const domain = /^[a-z0-9.-]+$/i.test(String(shop?.domain ?? '')) ? shop.domain : null;
  const url = domain && active && !blank(p.handle) && /^[a-z0-9-]+$/i.test(p.handle) ? `https://${domain}/products/${p.handle}` : null;
  return { adminUrl: admin, url };
};
const variantLink = (shop, p, v) => { const base = adminBase(shop); const pid = numericId(p.source_id); const vid = numericId(v.source_id); return base && pid && vid ? `${base}/products/${pid}/variants/${vid}` : null; };
const shape = (sku) => String(sku).trim().replace(/[A-Za-z]/g, 'A').replace(/\d/g, '9');

/**
 * @param {{ supabase: object, merchantId: string, timeZone: string, shop?: {name?: string, platform?: string, domain?: string, myshopifyDomain?: string},
 *   productPotential?: (() => Promise<object>)|null, config?: object, now?: () => Date, load?: Function }} p
 */
export function createCorrectionsSource({ supabase, merchantId, timeZone, shop = {}, productPotential = null, config = mergeConfig(), now = () => new Date(), load = loadDataset }) {
  if (typeof merchantId !== 'string' || !merchantId) throw new TypeError('createCorrectionsSource: merchantId is required (server context)');
  requireTimeZone(timeZone, 'createCorrectionsSource');
  return async function corrections({ category = 'all' } = {}) {
    if (category !== 'all' && !CORRECTION_IDS.includes(category)) { const e = new Error('unknown category'); e.code = 'BAD_CATEGORY'; throw e; }
    const t = now();
    const data = await load(supabase, merchantId, { since: new Date(t.getTime() - (WEEKS * 7 + 2) * DAY) });
    const content = buildContent(contentFacts({ data, now: t, timeZone, config }));
    const byId = new Map((data.products ?? []).map((p) => [p.id, p]));
    const variantsBy = new Map();
    for (const v of data.variants ?? []) (variantsBy.get(v.product_id) ?? variantsBy.set(v.product_id, []).get(v.product_id)).push(v);
    const stableId = (row, kind = 'product') => (blank(row.source_id) ? `nordla:${kind}:${row.id}` : row.source_id);
    const evidence = (what) => `${what} — lecture des données synchronisées dans Nordla le ${t.toISOString().slice(0, 10)}`;
    const head = (p) => ({ id: stableId(p), title: p.title, ...productLinks(shop, p, String(p.source_status ?? '').toUpperCase() === 'ACTIVE') });
    const anomalies = []; const cats = CORRECTION_CATEGORIES.map((c) => ({ ...c }));
    const cat = (id) => cats.find((c) => c.id === id);
    const sources = [{ module: MODULE, status: 'ok' }];

    // SKU convention: what the catalog itself shows (never invented). Existing SKUs are preserved; the shape is only an observation.
    const allSkus = (data.variants ?? []).map((v) => v.sku).filter((s) => !blank(s)).map((s) => String(s).trim());
    const shapes = new Map(); for (const s of allSkus) shapes.set(shape(s), (shapes.get(shape(s)) ?? 0) + 1);
    const topShapes = [...shapes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
    const seen = new Map(); for (const s of allSkus) seen.set(s.toLowerCase(), (seen.get(s.toLowerCase()) ?? 0) + 1);
    const dupSkus = [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s).sort();

    for (const row of content.rows) {
      const p = byId.get(row.id); if (!p) continue; const pr = head(p);
      const mk = (category, field, rest) => anomalies.push({ module: MODULE, system: 'shopify', category, field, itemType: 'product', itemId: pr.id, product: pr, resolution: 'possible', ...rest });
      if (row.problems.includes('noImage')) mk('noImage', 'product.featuredImage', { current: null, evidence: evidence('image absente, absence prouvée par la synchronisation'), nextStep: 'Ajouter une image fidèle au produit ; ne pas en inventer une.', resolution: 'to_find', notes: ['Une image doit être fournie par le marchand (photo du produit).'] });
      if (row.problems.includes('noAltText')) mk('noAltText', 'product.featuredImage.altText', { current: null, evidence: evidence(`image présente (${p.image_url}) sans texte alternatif`), nextStep: 'Rédiger un texte alternatif descriptif à partir de l’image et du titre.' });
      if (row.problems.includes('noType')) mk('noType', 'product.productType', { current: null, evidence: evidence('type de produit vide'), nextStep: 'Choisir un type cohérent avec ceux déjà utilisés dans le catalogue.', notes: [`Types déjà utilisés : ${content.filters.categories.join(', ') || 'aucun'}`] });
      if (row.problems.includes('noCollection')) mk('noCollection', 'product.collections', { current: null, evidence: evidence('aucune appartenance à une collection, absence prouvée par la synchronisation'), nextStep: 'Rattacher le produit à la collection existante la plus cohérente (ou signaler le cas si aucune ne convient).' });
      if (row.problems.includes('duplicateTitle')) {
        const same = content.rows.filter((r) => r.id !== row.id && String(r.title).trim().toLowerCase().replace(/\s+/g, ' ') === String(row.title).trim().toLowerCase().replace(/\s+/g, ' ')).map((r) => byId.get(r.id)).filter(Boolean);
        mk('duplicateTitle', 'product.title', { current: p.title, evidence: evidence(`${same.length + 1} produits actifs portent ce titre`), nextStep: 'Vérifier s’il s’agit d’un doublon à fusionner/archiver ou de produits distincts à différencier par le titre ; ne pas décider seul.',
          notes: same.map((q) => `Même titre : ${mdSafe(q.title)} — ${stableId(q)}`) });
      }
      if (row.problems.includes('missingSku')) {
        const vs = variantsBy.get(p.id) ?? [];
        for (const v of vs.filter((x) => blank(x.sku))) {
          const siblings = vs.filter((x) => !blank(x.sku)).map((x) => `${x.title ?? x.id} = ${String(x.sku).trim()}`);
          anomalies.push({ module: MODULE, system: 'shopify', category: 'missingSku', field: 'variant.sku', itemType: 'variant', itemId: blank(v.source_id) ? `nordla:variant:${v.id}` : v.source_id, product: pr,
            variant: { id: blank(v.source_id) ? `nordla:variant:${v.id}` : v.source_id, title: v.title, adminUrl: variantLink(shop, p, v) ?? undefined },
            current: null, resolution: 'possible', evidence: evidence(`SKU vide sur la variante « ${v.title ?? '—'} » (${vs.length} variante(s) sur ce produit, ${vs.filter((x) => blank(x.sku)).length} sans SKU)`),
            nextStep: 'Attribuer un SKU unique en conservant les SKU existants de ce produit ; vérifier l’absence de doublon dans le catalogue.',
            notes: siblings.length ? [`SKU déjà présents sur ce produit (à conserver) : ${siblings.join(' ; ')}`] : ['Aucune variante de ce produit n’a de SKU.'] });
        }
      }
    }
    // A check the data cannot run (absence not proven by the sync, nothing synced) is NOT "no problem": say it is not verifiable.
    for (const ch of content.checks) if (!ch.available) { const c = cat(ch.code); if (c) { c.status = 'unavailable'; c.limit = 'Non vérifiable avec les données synchronisées (l’absence n’est pas prouvée par la synchronisation) : ce n’est pas une preuve d’absence d’anomalie.'; } }
    const skuCat = cat('missingSku');
    skuCat.preface = [
      'Convention de SKU : **aucune convention n’est déclarée dans Nordla**. Ce que le catalogue montre :',
      allSkus.length ? `${allSkus.length} SKU existants, formes observées (A = lettre, 9 = chiffre) : ${topShapes.map(([s, n]) => `${s} (${n})`).join(' ; ')}.` : 'Aucun SKU existant dans le catalogue : il n’y a rien à imiter.',
      dupSkus.length ? `Doublons déjà présents dans le catalogue (${dupSkus.length}) : ${dupSkus.slice(0, 15).join(', ')}${dupSkus.length > 15 ? ` … (+${dupSkus.length - 15} autres)` : ''}. À ne pas aggraver ; à signaler au marchand.` : 'Aucun doublon de SKU dans le catalogue synchronisé.',
      'Consigne : si une convention existe et que la forme dominante la confirme, la reprendre ; sinon **proposer une convention cohérente et la soumettre au marchand avant** de remplir les cas. Vérifier chaque SKU proposé contre tout le catalogue (doublons, casse).',
    ];

    // Purchase cost: from the Produits Potentiels source (the same rows as the screen). Unavailable source -> the category is NOT evaluated (never read as "no problem").
    const costCat = cat('purchaseCost');
    if (category === 'all' || category === 'purchaseCost') {
      let P = null;
      try { P = productPotential ? await productPotential() : null; } catch (e) { console.error('growth corrections: products source failed:', e?.message ?? e); }
      if (!P || !Array.isArray(P.rows)) {
        costCat.status = 'unavailable'; costCat.limit = 'La source Produits Potentiels est indisponible : les coûts d’achat n’ont pas pu être évalués.';
        sources.push({ module: MODULE, status: 'partial', note: 'coûts d’achat non évalués (source Produits Potentiels indisponible)' });
      } else {
        const rows = P.rows.filter((r) => r.margin && ['UNVERIFIED', 'MISSING', 'PARTIAL'].includes(r.margin.tier));
        const unmatched = [];
        for (const r of rows) {
          const p = byId.get(r.id); if (!p) { unmatched.push(r.title ?? r.id); continue; } const pr = head(p); const missing = r.margin.tier === 'MISSING';
          anomalies.push({ module: MODULE, system: 'shopify', category: 'purchaseCost', field: 'variant.unitCost', itemType: 'product', itemId: pr.id, product: pr, current: missing ? null : 'non vérifié',
            resolution: 'to_find', evidence: evidence(`marge ${missing ? 'impossible (aucun coût)' : r.margin.tier === 'PARTIAL' ? 'partielle (coût manquant sur une part du chiffre d’affaires)' : 'calculée sur un coût non vérifié'}`),
            nextStep: 'Retrouver le coût d’achat unitaire de chaque variante dans une source fiable (facture fournisseur, bon de commande), puis le faire valider par le marchand.',
            notes: [`Variantes : ${(r.variants ?? []).map((v) => `${v.title ?? v.id} (${v.id})`).join(' ; ') || 'non détaillées par la source'}`, 'Ne pas déduire un coût d’un prix de vente ni d’un autre produit.'] });
        }
        costCat.declaredTotal = rows.length;
        if (unmatched.length) costCat.limit = `${unmatched.length} ligne(s) de vente sans fiche produit dans le catalogue (${unmatched.slice(0, 5).map((x) => `« ${mdSafe(x)} »`).join(', ')}) : elles ont un coût manquant mais aucune fiche à corriger ; non exportées.`;
      }
    }
    const filtered = category === 'all' ? anomalies : anomalies.filter((a) => a.category === category);
    const ordered = CORRECTION_IDS.flatMap((id) => filtered.filter((a) => a.category === id));
    const md = renderDossier({
      merchant: { name: shop.name ?? 'Boutique', platform: shop.platform ?? 'Shopify', shop: shop.myshopifyDomain ?? shop.domain ?? null, timeZone }, generatedAt: t, modules: MODULES,
      scope: `Produits actifs du catalogue synchronisé dans Nordla : ${content.scope.analysed} analysés sur ${content.scope.catalog} (${content.scope.activeOnly ? 'statut ACTIVE uniquement' : 'statut non fourni par la source : tous les produits'}). Ventes de référence : ${WEEKS} semaines complètes (${content.window.start.slice(0, 10)} → ${content.window.end.slice(0, 10)}).`,
      selection: category === 'all' ? { all: true } : { all: false, category }, categories: cats, anomalies: ordered, sources,
      context: ['Les identifiants (gid Shopify) sont les identifiants stables à utiliser. Les liens (fiche d’administration, page publique) ne sont présents que lorsqu’ils peuvent être construits de façon fiable.'],
    });
    return { markdown: md, anomalies: ordered, filename: `dossier-correction-${category === 'all' ? 'tous' : category}-${t.toISOString().slice(0, 10)}.md`, counts: Object.fromEntries(CORRECTION_IDS.map((id) => [id, anomalies.filter((a) => a.category === id).length])) };
  };
}
const mdSafe = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
