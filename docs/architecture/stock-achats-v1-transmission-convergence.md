# Stock / Achats (chantier C) — transmission finale au responsable de convergence

Livraison acceptée : `1db1359` (branche `feature/stock-achat-v1`). Statut : **PRÊT POUR CONVERGENCE — pas encore PRÊT POUR PRODUCTION.** Aucune fusion, aucun déploiement, aucune migration appliquée. Le détail complet est dans `stock-achats-v1-livraison-convergence.md`.

## 1. Les six commits, dans l'ordre de dépendance (tous après `c4d2e3f`, déjà intégré)
1. `7b5190d` — vues de compatibilité A↔C (`src/integration/procurement-compat.js`, policy, 2 commandes hub en lecture seule).
2. `3a471a1` — écrans téléphone (stock, réception, photos Sourcing, état réseau, taux) + `case-source`. Touche `server/app.js`, aussi modifié par la convergence : 0 conflit textuel constaté.
3. `a97e3bd` — préparation staging PostgreSQL : **migration de permissions + retour arrière**, runner gardé, import fichier→PostgreSQL, procédure téléphone.
4. `56c3166` — comparateur canonique de l'import. Dépend de 3.
5. `f3f5f59` — import vérifié (`validateSourceState`, `runImport`), test anti-double-comptage, textes d'erreur français. Dépend de 3 et 4.
6. `04f6ac3` — preuve PostgreSQL (coexistence avec les migrations de A dans les deux ordres, redémarrage, sauvegarde/restauration). Test uniquement.

## 2. Migration de permissions (indissociable du schéma)
`supabase/migrations-pending/20261016091000_procurement_permissions.sql` (retour arrière : `supabase/rollback/20261016091000_procurement_permissions.down.sql`). La convergence n'a repris que le schéma `…090000…` : sans la permission, `proc_*` n'est protégé que par les droits par défaut et la RLS. À appliquer **après** le schéma, jamais seule ; rollback dans l'ordre inverse (permissions d'abord). Rien n'est appliqué sur un environnement partagé.

## 3. Contrat canonique A/C
La commande Buying (`PurchaseOrder` de C) est la source de vérité. `PurchasePlan` = bon `DRAFT|PENDING_APPROVAL|APPROVED` (vue dérivée, lecture seule). `IncomingExpectation` = lignes restant à recevoir d'un bon `ORDERED|CONFIRMED|PARTIALLY_RECEIVED`, jamais comptées disponibles. `BUY_CANDIDATE` et `sourcing_cases` restent à A (C ne garde que des références). Si les tables `integration_*` de A sont alimentées, elles le sont depuis ces vues, jamais indépendamment. Prouvé : un bon est exactement un des {plan, attendu, rien} à chaque statut ; somme des attendus = `stockPosition.incoming`.

## 4. Import et résultats
Procédure : `runImport({state, target, merchantId})` (essai à blanc) puis `apply: true`. Statuts : `REFUSED_SOURCE_INVALID`, `REFUSED_TARGET_NOT_EMPTY`, `DRY_RUN_OK`, `IMPORTED_VERIFIED` (seul succès), `IMPORTED_NOT_EQUIVALENT` (jamais un succès). Le fichier source n'est jamais modifié (hachage prouvé) ; retour arrière = retirer `PROCUREMENT_PG_URL` ou abandonner la base cible.
Résultats : mémoire 100/0 échec, fichier 100/0, parité PostgreSQL 15/15 suites (import 7/7), coexistence/redémarrage/restauration 49/49, workflow `procurement-stock-v1` vert sur `1db1359`. Suite complète du dépôt non relancée (une autre tournait) ; deux workflows d'autres chantiers ont été annulés par leur limite de durée sur ce push.

## 5. Les trois réserves
1. **Approbation des réceptions** : en mode hébergé, seul le propriétaire a `canApprove`, donc un rôle magasin ne peut pas réceptionner. Décision de politique du propriétaire ; rien n'a été changé.
2. **Photos Sourcing** : `hosted.js` ne fournit pas `photosDir` ; les miniatures affichent « photo sur le téléphone du terrain ». À brancher si le magasin de photos de A est monté côté serveur.
3. **Validation sur téléphone réel** : non faite (caméra, tunnel HTTPS, service worker). Procédure : `docs/operations/procurement-phone-test-procedure.md`. Également non faits : base Supabase réelle ; dépendance `pg` non ajoutée.
