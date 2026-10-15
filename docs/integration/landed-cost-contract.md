# Contrat canonique du coût rendu (landed cost) — Sourcing, Buying, Finance

Statut : **contrat défini, adaptateurs non écrits** (décision propriétaire 2026-10-14, n° 6). Finance est l'autorité du calcul économique final.

## 1. Constat : trois moteurs, trois réponses possibles

| | Sourcing `src/sourcing/core/landed.js` | Buying `src/buying/economics.js` | Finance `src/finance/purchase-analysis.js` |
|---|---|---|---|
| Unités | centimes EUR (`toMinor`) | **flottants** (`value * fx`) | centimes, points de base, quantité entière |
| Devise étrangère | convertie avec un taux explicite | convertie avec l'hypothèse du marchand ; base ≤ ESTIMATED | **refusée** (`CURRENCY_CONFLICT`) sans taux `{ rate, provenance }` donné par un humain ; puis ESTIMATED |
| Valeur en douane | marchandise + frais d'origine + fret + assurance (selon Incoterm) | droits = **montant** fourni, pas un taux | marchandise + fret seulement (`other` hors valeur en douane, pas d'assurance) |
| Postes | Incoterm 2020 + 11 lignes (courtage, inspection, tests, étiquetage, emballage, EPR, logistique entrante, prép. Amazon…) | prix, fret, droits, autres | prix, fret, droits (taux), autres, TVA import |
| TVA import | calculée à part | absente | avancée dans le besoin de trésorerie, hors coût rendu (récupérable par hypothèse) |
| Inconnu | `UNKNOWN`, statut LOWER_BOUND / INFORMATION_INSUFFICIENT | `missing`, `worst = null` | compté 0 et listé (`unknown_inputs`), base LOWER_BOUND |
| Plages | min / max par ligne | best / nominal / worst | aucune |

Divergences réelles qui en découlent : droits plus bas chez Finance quand il y a des frais d'origine ou une assurance (valeur en douane plus
petite) ; écarts d'arrondi Buying (flottants) ; une même devise étrangère acceptée par Sourcing/Buying et refusée par Finance.

## 2. Règle
- **Le chiffre final (coût rendu, besoin de trésorerie, marge) vient de Finance, et de Finance seulement.** Sourcing et Buying peuvent afficher
  une **estimation de terrain**, toujours libellée comme telle, jamais présentée comme le coût final ni utilisée pour décider d'un achat.
- Une décision d'achat (BUY_CANDIDATE → PurchasePlan) lit uniquement la réponse Finance (déjà le cas : `buildPurchasePlan` exige
  `finance_analysis.status === 'ANALYZED'`).
- **Radar Marché Terrain reste indépendant** : recherche produit et présélection commerciale, sans transport, douane ni documents. Il ne
  consomme pas ce contrat et n'appelle pas Finance.

## 3. Requête canonique `LandedCostRequest` (vers Finance)
Toutes les sommes en **chaînes décimales** (jamais de flottant), chaque valeur avec sa provenance (`SUPPLIER_CLAIM`, `USER_PROVIDED`,
`OFFICIAL_LOOKUP`, `ESTIMATE`).

| Champ | Type | Règle |
|---|---|---|
| `merchant_id` | uuid | obligatoire |
| `supplier_unit_price`, `currency` | décimal ≤ 4 déc., ISO 4217 | prix fournisseur et sa devise |
| `qty` | entier > 0 | |
| `incoterm` | code Incoterm 2020 ou `null` | détermine les postes à la charge de l'acheteur |
| `lines[]` | `{ kind, amount, currency, per: 'TOTAL'|'UNIT', in_customs_value: bool, provenance, min?, max? }` | `kind` ∈ origin_charges, freight, insurance, brokerage, inspection, testing, labelling, packaging, epr, inbound_logistics, marketplace_prep, other ; `in_customs_value` vrai pour origin_charges, freight, insurance (valeur CIF à la frontière UE) |
| `duty_rate_pct` | décimal ≤ 2 déc. ou `null` | `null` = inconnu (jamais supposé) |
| `import_vat_rate_pct` | décimal | |
| `fx` | `{ rate, provenance }` ou `null` | obligatoire si une devise ≠ devise du marchand |
| `expected_selling_price_gross`, `selling_vat_rate_pct` | décimal | facultatifs ; absents = marge non calculée |
| `cash_available_cents` | entier | facultatif |

## 4. Réponse canonique `LandedCostResult` (de Finance)
`{ version, status: ANALYZED | CURRENCY_CONFLICT | INPUT_INVALID, components (centimes par poste), customs_value, duty, import_vat_advanced,
landed_cost: { total, per_unit, basis: CALCULATED | ESTIMATED | LOWER_BOUND, unknown_inputs[] }, cash_requirement, margin?, risks[] }` —
c'est la forme actuelle de `analyzePurchase`, étendue aux lignes du §3.

## 5. Travail restant (Core P0, après accord)
1. Étendre `analyzePurchase` aux `lines[]` et à `in_customs_value` (assurance et frais d'origine dans la valeur en douane), sans changer les
   résultats des cas existants (fret seul).
2. Adaptateur Sourcing → `LandedCostRequest` (depuis `landedCost` input) ; l'écran Sourcing affiche la réponse Finance quand elle existe et son
   propre chiffre sous le libellé « estimation terrain ».
3. Adaptateur Buying → `LandedCostRequest` ; retrait des flottants du chemin de décision.
4. Test de parité : un même achat donne le même coût rendu par les trois chemins (Finance fait foi).
