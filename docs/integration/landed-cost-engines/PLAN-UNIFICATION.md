# Coût rendu — dossier de décision et plan d'unification réversible (candidat : moteur Finance enrichi de la structure et des règles de complétude de Sourcing)

**Statut : proposition. Aucun moteur de calcul officiel n'a été modifié.** Mesures reproductibles : `node docs/integration/landed-cost-engines/compare.mjs` (sortie brute : `compare-output.txt`). Comparatif général : `ARBITRAGE.md`.

## 1. Résultats détaillés des sept scénarios (données synthétiques)
A = Sourcing `landedCost` · B = Finance `analyzePurchase` · C = Buying `landedCost` (par unité, flottants).
| # | Entrées | A Sourcing | B Finance | C Buying | Écart A–B | Origine de l'écart |
|---|---|---|---|---|---|---|
| S1 | USD 4,20 × 1000 ; taux 0,92 ; fret 600 € ; droit 2,7 % ; autres coûts à 0 | 4 584,53 € (4,58 /u) | 4 584,53 € (4,58 /u) | 4,584528 /u | **0,00** | — |
| S2 | USD 4,3333 × 777 ; taux 0,9137 ; fret 333,33 € ; droit 3,7 % | 3 533,46 € (4,55 /u) | 3 535,89 € (4,55 /u) | 4,550701 /u (≈ 3 535,89 €) | **− 2,43 €** | A arrondit le prix unitaire au cent avant de multiplier (4,3333 → 4,33 : 0,0033 × 777 = 2,56 USD ≈ 2,34 € + droit 3,7 % = 2,43 €). B garde 4 décimales. |
| S3 | S1 + assurance 50 € | 4 635,88 € | 4 584,53 € | = B | **+ 51,35 €** | A compte l'assurance (50 €) et applique le droit sur marchandise + fret + assurance (1,35 €). B et C n'ont pas de ligne assurance : elle est ignorée en silence. |
| S4 | S1 sans fret | `INFORMATION_INSUFFICIENT`, borne basse 3 864,00 € | `ANALYZED` 3 968,33 € + `COST_UNKNOWN` | `OK` 3,864 /u + `missing: freight, duties` | **− 104,33 €** | A n'ajoute pas le droit tant que la base douanière est incomplète (borne basse = marchandise seule) ; B calcule le droit sur la marchandise et met le fret à 0 ; C ne calcule pas de droit sans montant fourni. Seul A **refuse** un statut « complet ». |
| S5 | USD sans taux de change | refus (`fx.USDEUR` critique) | refus (`CURRENCY_CONFLICT`) | `FX_MISSING` | — | **Comportement identique** (aucun taux supposé). |
| S6 | EUR 4,20 × 1000, fret 600 €, droit 0 | 4 800,00 € | 4 800,00 € | 4,80 /u | 0,00 | — |
| S7 | S6 en EXW | 4 800,00 € | 4 800,00 € | 4,80 /u | 0,00 | L'Incoterm ne change le montant dans aucun moteur ; seul A l'utilise pour juger la complétude (qui doit payer le fret). |
**Lecture** : sur les cas communs les trois concordent à l'arrondi près ; les écarts viennent de **trois causes seulement** — précision du prix (A), lignes de coût absentes (B, C), traitement d'une donnée critique manquante (B : chiffre « analysé »).

## 2. Politique de précision et d'arrondi proposée (pour le moteur officiel)
| Élément | Règle |
|---|---|
| Prix unitaire fournisseur | chaîne décimale, **micro-unités (4 décimales)** ; au-delà : refus explicite (comme `PRICE_PRECISION_EXCEEDS_FINANCE_ENGINE`), jamais d'arrondi silencieux |
| Montants | entiers en centimes (BigInt si dépassement possible) |
| Taux de change | chaîne décimale ≤ 6 décimales, **provenance humaine obligatoire** (`USER_PROVIDED`/`VERIFIED`), date ; jamais déduit |
| Conversion | prix × quantité en devise fournisseur d'abord, **puis** conversion, arrondi demi-supérieur **une seule fois par ligne** |
| Taux de droit | points de base ; droit = arrondi(base × taux) |
| Base du droit | marchandise + frais d'origine + fret + assurance **jusqu'à la frontière UE** (règle de A, selon l'Incoterm) |
| Total | somme des lignes **déjà arrondies** ; le coût par unité est total ÷ quantité arrondi pour **l'affichage seulement** (jamais re-multiplié) |
| TVA d'import | calculée à part, jamais dans le coût rendu (déjà le cas) |

## 3. Gestion des données manquantes (règle unique)
Statuts : `COMPLETE`, `RANGE`, `LOWER_BOUND`, `INFORMATION_INSUFFICIENT`.
- **Critique** (donne `INFORMATION_INSUFFICIENT`, aucun total « analysé ») : prix unitaire, quantité, taux de change si devise étrangère, fret si l'Incoterm ne le met pas à la charge du vendeur, taux de droit si l'origine est hors UE.
- **Non critique** (donne `LOWER_BOUND`, total étiqueté « au moins ») : assurance, courtier, inspection, tests, étiquetage, emballage, REP, logistique d'entrée, préparation Amazon.
- **Jamais** : traiter un manquant comme 0 sans le dire ; rendre un total sans son statut. Un appelant qui affiche un montant **doit** afficher le statut (les réponses de Parle à Nordla le font déjà : « au moins », « incalculable »).
- Un manquant saisi explicitement à `0` (« coût réellement nul ») est une donnée, pas un manquant.

## 4. Risques de migration
| Risque | Gravité | Parade |
|---|---|---|
| Les montants des dossiers existants changent de quelques centimes (fin de l'arrondi au cent) et un verdict proche d'un seuil peut basculer | moyenne | mode **ombre** : les deux moteurs calculent, tout écart est journalisé avec le dossier et sa version ; aucun verdict ne change avant revue des écarts |
| Journal Core et faits déjà enregistrés (coût rendu à 2 décimales) | moyenne | les faits gardent leur `case_version` ; le moteur et sa version sont ajoutés aux nouveaux faits ; **aucune réécriture** du journal |
| Perte de sémantique de A (Incoterm, plages, classes KNOWN/ESTIMATED) lors du transfert | haute | tests de A repris tels quels comme tests de la version 2 de B avant bascule ; parité à 0 centime exigée sur tous les cas communs |
| Dépendance de Sourcing à Finance (couplage) | moyenne | adaptateur pur, pas d'accès base ; Finance expose une fonction, pas un service |
| Propriété (Finance vs Sourcing) | organisationnelle | décision du propriétaire sur le rôle de Finance ; la parité est vérifiée par la CI, pas par la confiance |
| Régression de performance | faible | calcul pur, entiers : négligeable (à mesurer) |

## 5. Plan de retour arrière
1. **Indicateur par site d'appel** : `LANDED_ENGINE = sourcing | shadow | finance` (défaut `sourcing`).
2. Étape « ombre » : A reste affiché ; B v2 calcule en parallèle ; écart ≠ 0 → journal d'écarts + alerte, jamais d'affichage de B.
3. Bascule : seulement si l'écart ombre est nul sur la période convenue ET les tests de parité sont verts ; le retour à `sourcing` est une variable de configuration, **sans redéploiement de code**, et sans migration de données.
4. A n'est retiré qu'après une période de non-régression ; ses tests sont conservés.

## 6. Étapes proposées et ce qui est modifié (rien avant votre accord)
| Étape | Modification | Fichiers | Test d'acceptation |
|---|---|---|---|
| 0 (corrections sans choix de moteur) | prix en micro-unités dans A (D1) ; refus d'affichage d'un total B si `COST_UNKNOWN` (D2) ; renommer le « landedCost » de C | `sourcing/core/landed.js`, `money.js`, appelants de B, `buying/economics.js` | scénario S2 : A = B à 0 centime ; S4 : aucun total sans statut |
| 1 | 30 scénarios de parité (les 7 ci-dessus + 23) | `test/` | parité A=B sur les cas communs |
| 2 | B v2 : lignes de coût, Incoterm, base de droit, statuts | `finance/purchase-analysis.js` (+ tests de A repris) | tests de A passent contre B v2 |
| 3 | adaptateur + mode ombre | `sourcing/core/case.js` (appel), configuration | écarts journalisés = 0 |
| 4 | bascule d'affichage ; C consomme le coût officiel | `buying/*`, UI | verdicts inchangés sur le jeu de dossiers |
| 5 | retrait de A | `sourcing/core/landed.js` | — |

**Décision demandée au propriétaire** : (a) valider ou non le candidat « Finance v2 enrichi » ; (b) autoriser l'étape 0 seule (corrections de D1 et D2, sans changer de moteur).
