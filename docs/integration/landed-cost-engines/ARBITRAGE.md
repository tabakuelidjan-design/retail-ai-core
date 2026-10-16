# Coût rendu : trois moteurs, un seul doit faire autorité — inventaire, mesure et proposition (2026-10-16)

Décision attendue du propriétaire. Rien n'a été migré ni supprimé. Mesure reproductible : `node docs/integration/landed-cost-engines/compare.mjs` (données synthétiques).

## 1. Inventaire
| | A — Sourcing | B — Finance | C — Buying |
|---|---|---|---|
| Fichier | `src/sourcing/core/landed.js` (`landedCost`) | `src/finance/purchase-analysis.js` (`analyzePurchase`) | `src/buying/economics.js` (`landedCost`) |
| Usage réel | décision d'achat China Sourcing (`assess`), Core (`sourcing-facts`), assistant de terrain | comparaison d'offres Stock/Achats (`queries.compareSuppliers`), hub d'intégration (`purchase-analysis`), analyse de marge/trésorerie | évaluation de **candidats** (bandes best/nominal/worst, pairs, calibrage) |
| Représentation | cents entiers (EUR) ; prix fournisseur converti en cents **avant** calcul | cents entiers + points de base ; **prix en micro-unités (4 décimales)** | nombres flottants par unité |
| Lignes de coût | origine, fret, assurance, courtier, inspection, tests, étiquetage, emballage, REP, logistique d'entrée, préparation Amazon, **droits** (taux sur valeur en douane) | fret, « autres coûts », droits (taux) | prix, fret, droits (montant), autre — par unité |
| Incoterm | **oui** (qui paie quoi : sert à la complétude) | non | non |
| Base des droits | marchandise + origine + fret + assurance | marchandise + fret | aucune (le droit est un montant fourni) |
| Devise | taux **explicite** exigé, jamais supposé | taux **explicite, de provenance humaine** exigé, refus sinon (`CURRENCY_CONFLICT`) | `FX_MISSING` sans taux ; avec taux, jamais meilleur qu'« ESTIMATED » |
| Donnée manquante | classes KNOWN / ESTIMATED / UNKNOWN ; `INFORMATION_INSUFFICIENT` (critique), `LOWER_BOUND`, `RANGE` | calcule avec 0 et **signale** `COST_UNKNOWN` (statut `ANALYZED`) | `missing[]`, pire cas `null`, nominal = borne basse |
| TVA d'import | calculée, non comptée dans le coût | calculée, comptée dans la trésorerie, pas dans le coût | — |
| Arrondi | demi-supérieur « away from zero », **une fois par ligne** | demi-supérieur sur entiers (BigInt pour le taux) | aucun (flottant), `round4` à l'affichage |
| Tests | ≈ 25 fichiers de test l'exercent (calculateurs, produits, terrain, réalistes) | `integration-contracts`, `procurement-sourcing` (+ tests propres) | `buying.test.js` (41) |

## 2. Mesure : mêmes entrées, trois moteurs
| Scénario | A Sourcing | B Finance | C Buying | Lecture |
|---|---|---|---|---|
| S1 USD 4,20 × 1000, taux 0,92, fret 600 €, droit 2,7 % | 4 584,53 € | 4 584,53 € | 4,584528 /u | **identiques** |
| S2 prix 4,3333 USD × 777, taux 0,9137, fret 333,33 €, droit 3,7 % | **3 533,46 €** | **3 535,89 €** | 4,5507 /u (≈ 3 535,9 €) | **A diverge de 2,43 €** (voir D1) |
| S3 + assurance 50 € | 4 635,88 € (assurance + droit sur assurance) | 4 584,53 € (**assurance absente**) | idem B | B et C ne peuvent pas la représenter (D3) |
| S4 fret non saisi | `INFORMATION_INSUFFICIENT`, borne basse 3 864,00 € | **`ANALYZED`**, 3 968,33 € avec fret = 0 et `COST_UNKNOWN` | `OK`, `missing: freight, duties` | B rend un chiffre « analysé » sans fret (D2) |
| S5 USD sans taux | refus (`fx.USDEUR`) | refus (`CURRENCY_CONFLICT`) | `FX_MISSING` | **identiques** (refus) |
| S6 EUR, fret 600 €, droit 0 | 4 800,00 € | 4 800,00 € | 4,80 /u | identiques |
| S7 EXW, mêmes chiffres | 4 800,00 € | 4 800,00 € | 4,80 /u | l'Incoterm ne change le montant dans aucun moteur ; il ne sert qu'à A pour juger la complétude |

## 3. Défauts constatés (à traiter quel que soit le moteur retenu)
- **D1 (A, intégrité)** : le prix unitaire fournisseur est arrondi **au cent** avant multiplication (`toMinor('4.3333')` = 433 ; `0,4249` → 0,42). Sur un article à 0,4249 USD × 50 000, l'écart dépasse 240 USD. Stock/Achats sait que les prix ont jusqu'à 4 décimales (tarifs 0,420 / 0,500) et refuse au-delà de 4. Le chemin Sourcing doit passer en micro-unités.
- **D2 (B, sécurité du chiffre)** : une donnée critique manquante (fret) donne `status: ANALYZED` avec fret = 0 ; seul le champ `risks` le signale. Un appelant qui lit le montant sans lire `risks` affiche un coût rendu faux. A refuse (`INFORMATION_INSUFFICIENT`) ; C marque la borne basse.
- **D3 (B et C)** : pas d'assurance, d'inspection, de tests, d'étiquetage, d'emballage, de REP, de logistique d'entrée ni de préparation Amazon ; base de droits différente de A (assurance). Un coût « rendu » B peut donc être inférieur au vrai pour un achat réel.
- **D4 (C)** : flottants, sans quantité ni taux de droit : outil de classement de candidats, **pas** un moteur de coût rendu ; son nom prête à confusion.

## 4. Critères d'arbitrage (pas le nom, pas l'ancienneté)
1. **Exactitude arithmétique** (entiers, précision de prix) : B > A (D1) > C.
2. **Honnêteté face au manque** (ne jamais afficher un chiffre incomplet comme complet) : A > C > B (D2).
3. **Couverture des coûts réels** (lignes, Incoterm, base des droits) : A >> B, C.
4. **Règle de devise** : A = B > C.
5. **Preuves** (tests, usage en production de décision) : A (≈ 25 fichiers) > B > C.
6. **Rattachement** : B est déjà l'appelé par Stock/Achats et le hub ; A est celui du dossier China Sourcing.

## 5. Proposition
**Moteur officiel unique : le moteur Finance (`analyzePurchase`, propriétaire Finance), dans une version 2 qui reprend le modèle de A** — c'est-à-dire : arithmétique B (entiers, micro-unités, taux de provenance humaine) + lignes de coût, Incoterm, base des droits et **sémantique de complétude** de A (`COMPLETE / LOWER_BOUND / RANGE / INFORMATION_INSUFFICIENT`, jamais « analysé » avec un coût critique manquant). Raison : aucun des deux ne suffit seul ; A porte la sémantique métier la plus riche et la mieux testée, B porte la bonne arithmétique et la porte d'entrée commune (Achats, hub). **C cesse d'être un « coût rendu »** : il garde les bandes et la comparaison de candidats mais consomme le coût rendu officiel.
Si le propriétaire préfère un seul changement minimal : **garder A comme moteur officiel après correction de D1** et faire de B un adaptateur de A (même résultat, moins de code neuf, mais Finance cesserait d'être propriétaire du calcul).

## 6. Plan de migration (réversible, sans arrêt)
1. **Maintenant, indépendant du choix** : corriger D1 dans A (prix en micro-unités) avec test de non-régression sur S2 ; corriger D2 côté appelants de B (refuser d'afficher un total si `COST_UNKNOWN`) ; renommer C pour qu'il ne s'appelle plus `landedCost`.
2. Tests de parité (le script `compare.mjs` en est la base) : 30 scénarios dont les 7 ci-dessus, tolérance 0 cent sur les cas communs, écarts documentés sur les autres.
3. Étendre B (v2) avec les lignes et la complétude de A ; parité A=B à 0 cent sur tous les cas où les deux ont les mêmes lignes.
4. Adaptateur dans Sourcing : `landedCost` appelle B v2 derrière un indicateur ; **mode ombre** (les deux calculent, A reste affiché, tout écart est journalisé) pendant une période définie.
5. Basculer l'affichage sur B v2 quand l'écart ombre est nul ; C consomme B v2.
6. Retirer A (garder ses tests, repris comme tests de B v2).
Retour arrière à chaque étape : l'indicateur remet A.
