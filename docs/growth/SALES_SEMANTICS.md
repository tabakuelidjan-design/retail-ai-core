# Nordla — sémantique des ventes et des remboursements (Growth)

Décision propriétaire du 2026-09-28 (Deep Audit Growth, P1-1). Code : `src/metrics/net-sales.js`. Test de cohérence entre pages :
`test/growth-sales-semantics.test.js`.

## A. Ventes nettes (performance commerciale)

Pour tous les KPI de ventes, de produits, de magasin, de clients et toutes les comparaisons entre périodes :

- une vente appartient à la **date de sa commande** ;
- chaque remboursement des lignes de cette commande **réduit le montant net de cette commande**, quelle que soit sa date ;
- un remboursement d'une ancienne commande ne crée donc **jamais** de « vente négative » dans la période courante : il réduit la période de la commande.

Fonctions : `orderNetFacts()`, `netSalesInWindow()`, `netSalesByProduct()`.

Taux de remboursement dans ce cadre : unités remboursées des ventes de la période ÷ unités vendues dans la période (même rattachement à la commande).

## B. Activité de remboursement

Uniquement quand une page analyse explicitement les remboursements (remboursements émis pendant une période, événements, tendance) :

- un remboursement appartient à la **date où il a été émis**, quelle que soit la date de commande.

Fonction : `refundActivity()`. Aucune page Growth ne l'affiche aujourd'hui.

## Règle

Ne jamais mélanger A et B dans un même chiffre.

| Page Growth | Chiffres de ventes | Règle |
|---|---|---|
| Produits Potentiels | CA net 8 semaines, taux de remboursement | A |
| Contenu | ventes 8 semaines (priorisation) | A |
| Croissance magasin | CA, commandes, panier, part, produits, jours, taux de remboursement | A |
| Audience | CA de fenêtre (90 jours), panier, CA observé par segment | A |

Marge (Produits Potentiels) : la marge brute est calculée avant remboursements, la datation des remboursements ne la modifie donc pas.

Écart connu, hors Growth : Analytics › Explorer (module gelé) date les remboursements de ses totaux de fenêtre à la date du
remboursement. Un même total de fenêtre peut donc différer entre Analytics et Growth quand une commande et son remboursement
tombent dans des périodes différentes. À aligner lors d'une future tâche Analytics, sur décision du propriétaire.
