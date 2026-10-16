# PR — Stock / Achats V1 (chantier 2) → `integration/nordla-convergence-v1`

**Ne pas fusionner automatiquement.** Base : `2c8871d`. Branche : `feature/stock-achats-v1-finalisation`. Bilan : `docs/architecture/stock-achats-v1-finalisation-bilan.md`. Transmission : `docs/integration/stock-achats-v1-transmission-chantiers-1-et-3.md`.

## Ce que cette PR ajoute
- Demandes d'ajustement / d'inventaire décidées par une autre personne, exception propriétaire confirmée par opération et journalisée, historique par produit.
- 12 routes V1 (fournisseurs, offres, confirmation/clôture, demandes et décisions, transferts, aperçu d'inventaire, historique, emplacements), droits explicites (`RECEIVE`, `ADJUST`, `APPROVE_PO`).
- Écrans téléphone correspondants ; interface compatible avec le serveur hébergé (`/procurement/`, session + CSRF).
- Magasin PostgreSQL optionnel dans le montage hébergé ; preuves PostgreSQL (coexistence avec les migrations d'A, redémarrage, sauvegarde/restauration).
- Contrat Shopify (document), patchs vérifiés pour les fichiers d'autres chantiers, contrat des 11 outils de Parle à Nordla figé par test.

## Ce qu'elle ne fait pas
Aucune écriture Shopify, aucune migration appliquée, aucun déploiement, aucun fichier des chantiers 1 et 3 modifié, aucun test sur un vrai staging / téléphone.

## Tests (voir le bilan §4)
Mémoire et fichier : 165 tests, 146 réussis, 0 échec, 19 ignorés. PostgreSQL réel jetable : 142 tests, 141 réussis, 1 ignoré ; coexistence 93/93.

## Revue demandée
`src/procurement/service.js` (requireApproval, requestStockChange / decideStockChange), `src/procurement/server/{permissions,routes-v1,hosted}.js`, `src/procurement/ui/*`.
