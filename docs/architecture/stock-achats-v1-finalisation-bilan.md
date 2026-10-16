# Stock / Achats V1 — bilan de finalisation (chantier 2)

Branche `feature/stock-achats-v1-finalisation`, créée à partir de `integration/nordla-convergence-v1` **`2c8871d`** (HEAD vérifié avant le premier commit ; `feature/stock-achat-v1` n'a pas servi de base : ses commits sont déjà intégrés). **Statut : PRÊT POUR REVUE / CONVERGENCE — PAS PRÊT POUR LA PRODUCTION.** Rien n'est fusionné, déployé ni migré ; aucun fichier des chantiers 1 et 3 n'est modifié (leurs besoins sont livrés en patchs vérifiés : `docs/integration/stock-achats-v1-transmission-chantiers-1-et-3.md`).

## 1. Fonctionnalités terminées (code + tests)
| Capacité demandée | Ce qui existe maintenant | Neuf ou déjà là |
|---|---|---|
| Fournisseurs et offres | liste, fiche (fiabilité mesurée, offres par palier, commandes, documents), création, ajout d'une offre | **neuf** (routes + écrans) |
| Visites et comparateur | inchangé (visites, saisie produit, comparaison par coût rendu) | déjà là |
| Bons de commande et suivi | envoi, approbation, commande, **confirmation fournisseur**, **clôture** (courte avec motif), annulation, réception | confirmation/clôture **neuves** (routes + boutons) |
| Réceptions complètes ou partielles | inchangé ; **droit explicite** : propriétaire ou personne autorisée (`RECEIVE`) | règle **neuve** |
| Ajustements de stock | **demande déposée, décidée par une autre personne** ; refus avec motif ; une seule décision par demande, même en simultané | **neuf** |
| Inventaires et écarts | comptage par emplacement, **aperçu des écarts sans rien écrire**, aucun écart = confirmé sans approbation, écarts = demande à approuver | **neuf** |
| Transferts | entre emplacements, idempotent, solde jamais négatif | route + écran **neufs** |
| Emplacements | création par le propriétaire (sans elle, un transfert est impossible sur le serveur hébergé) | **neuf** |
| Valorisation, coût moyen pondéré | inchangé (écran Stock) | déjà là |
| Traçabilité | **historique par produit** : chaque mouvement avec acteur, motif, approbation + journal (libellés français, jamais de code interne) | **neuf** |
| Propriétaire seul | exception **par opération**, confirmation explicite, journalisée (`separationWaived`, `waiver = CONFIRMED_FOR_THIS_OPERATION`) ; ne vaut que pour le propriétaire | **neuf** |
| Aucune IA n'approuve seule | approbation construite côté serveur depuis la personne authentifiée ; corps de requête ignoré ; approbateur non humain refusé ; assistant limité à `READ_ONLY` / `PROPOSE_ONLY` | **testé** |
| Shopify | **contrat seulement** (`docs/architecture/stock-achats-v1-contrat-shopify.md`) — aucun code, aucune écriture | contrat |
| PostgreSQL | magasin PostgreSQL **optionnel** dans le serveur hébergé (jamais de repli silencieux sur le fichier), preuves de coexistence/redémarrage/sauvegarde, migration d'A à scinder (patch), dépendance `pg` (patch) | préparé |

## 2. Écrans utilisables
Application téléphone (français) : onglets Visites · Produits · Comparer · Achats · Stock. **Nouveaux écrans** : Fournisseurs et offres (depuis Achats) · Nouveau fournisseur · Fiche fournisseur · Nouvelle offre · Ajuster · Transférer · Historique (depuis la fiche d'un produit en stock) · Inventaire · Demandes de stock (depuis Stock) · Nouvel emplacement (propriétaire). Le bon de commande gagne « Noter la confirmation du fournisseur », « Clôturer » et, pour le propriétaire qui a préparé le bon, « Approuver quand même (exception propriétaire) ».
**Vérifié dans un vrai navigateur (viseur 375 px)** avec des données jetables : parcours fournisseur → offre ; ajustement déposé puis appliqué par le propriétaire avec la confirmation d'exception (texte affiché, stock 100 → 97) ; transfert (77 / 20) ; historique ; inventaire avec motif exigé, aperçu, dépôt, approbation par une autre personne ; création d'emplacement ; mode hébergé (`/procurement/`, session par cookie, message de session expirée). **Limites** : le mode hébergé a été vu avec un enveloppeur de démonstration qui remplace la porte de session (pas la vraie), et le test avec la vraie porte utilise l'identité simulée de la convergence (pas de Supabase) ; **aucun vrai téléphone** (caméra, HTTPS, service worker non testés).
**Accessibles dans Nordla ?** Seulement après le patch d'une ligne sur `src/sourcing/server/app.js` (chantier 3) : sans lui, l'API `/api/procurement/*` est montée mais aucun écran n'est servi.

## 3. API disponibles (nouvelles routes, sous `/api/…` autonome ou `/api/procurement/…` hébergé)
`GET/POST /suppliers` · `GET /suppliers/:id` · `POST /suppliers/:id/offers` · `POST /purchase-orders/:id/confirm` · `POST /purchase-orders/:id/close` · `GET/POST /stock/requests` · `POST /stock/requests/:id/decision` · `POST /stock/transfers` · `POST /stock/counts/preview` · `GET /stock/:itemId/history` · `POST /locations`. `/me` renvoie les capacités (`read, prepare, canApprove, canReceive, canAdjust, canSelfApprove, grants`). Toutes : accès contrôlé d'abord, validation par les commandes du module, `Idempotency-Key` obligatoire à l'écriture, journalisation. Chaque route a ses tests de non-régression (`test/procurement-server-v1.test.js`, 13 tests).

## 4. Tests
| Niveau | Exécuté | Résultat |
|---|---|---|
| Unitaire / API / permissions / UI-logique / persistance fichier — magasin **mémoire** | 23 suites (20 `procurement-*` + 2 `integration-procurement*` + `core-procurement-routing`) | **165 tests : 146 réussis, 0 échec, 19 ignorés** |
| **Node 20** (conteneur `node:20`, sans dépendances installées) | les 20 suites `procurement-*` + `core-procurement-routing` | **tous réussis** (mêmes ignorés) ; `integration-procurement*` n'ont pas pu se charger faute de `@resvg/resvg-js` dans ce conteneur (limite du banc, pas du code) : elles tournent avec `npm ci` dans la CI |
| Mêmes suites — magasin **fichier** (persistance locale) | idem | **165 : 146 réussis, 0 échec, 19 ignorés** |
| **PostgreSQL réel** (PostgreSQL 17 jetable, rôles Supabase simulés) | parité des 20 suites `procurement-*` | **142 tests : 141 réussis, 0 échec, 1 ignoré** (mêmes suites, y compris concurrence, fautes réseau, hébergé sur PostgreSQL) |
| PostgreSQL réel — coexistence avec les migrations d'A (4 variantes, dont la scission), redémarrage serveur, sauvegarde/restauration | `procurement-coexistence.pg-smoke.mjs` | **93/93** |
| Contrat des 11 outils lus par Parle à Nordla | `procurement-assistant-contract` + suites de Parle (`core-procurement-routing` 10, `core-pilot` 8, `core-field-assistant` 31, `-contracts` 9, `convergence-journey` 1, `sourcing-hosted-identity` 7) | tous réussis |
| Montage sur le **vrai serveur hébergé** (identité simulée) avec le patch d'une ligne appliqué sur une copie jetable | `procurement-mounted-ui` | **réussi** (ignoré dans la branche tant que le patch n'est pas appliqué) |
| **Staging / Supabase réel / téléphone réel** | — | **jamais fait** |
**Ignorés (19)** : 18 sont réservés à PostgreSQL réel (exécutés dans la parité ci-dessus) et 1 (`procurement-mounted-ui`) attend le patch. Aucun test n'est désactivé, aucun test avec simulation n'est présenté comme une validation de staging.
Suite complète du dépôt : **non relancée** (une autre pouvait tourner ; ces suites ciblées sont celles du périmètre). Deux tests existants ont été **mis à jour** parce que la règle a changé volontairement : `/api/me` (champs de capacités ajoutés, anciens champs conservés) et le message de refus de réception.

## 5. Dépendances avec les chantiers 1 et 3
Voir `docs/integration/stock-achats-v1-transmission-chantiers-1-et-3.md`. Chantier 3 : patch d'une ligne (servir l'interface), `PROCUREMENT_GRANTS` sur Railway, `pg` dans l'image (si PostgreSQL), scission de la migration d'A, migrations Stock / Achats ensemble. `hosted.js` (écrit par la convergence) est modifié. Chantier 1 : **aucune modification demandée**, contrat des 11 outils figé par test.

## 6. Opérations nécessitant une autorisation (aucune n'a été faite)
Fusion de la PR · patchs sur les fichiers des chantiers 1/3 · migrations (Stock / Achats et d'A) sur un Supabase · variables Railway · `pg` dans l'image · raccordement Shopify · tout test sur le vrai staging.

## 7. Travail restant pour la mise en service réelle
1. **Chantier 3** : appliquer le patch de montage ; décider `PROCUREMENT_GRANTS` ; (option) `pg` + `PROCUREMENT_PG_URL`.
2. **Propriétaire** : confirmer la politique de rôles (réception / ajustement / exception) ; désigner qui reçoit `RECEIVE` / `ADJUST` (aujourd'hui **par variable d'environnement**, pas par une interface) ; créer les emplacements (magasin de Namur…).
3. **PostgreSQL** (si voulu) : autorisation, projet Supabase dédié, migration d'A scindée, application des deux migrations, import vérifié, bascule — `docs/operations/procurement-postgres-raccordement.md`.
4. **Téléphone réel** : `docs/operations/procurement-phone-test-procedure.md` (caméra, HTTPS, hors ligne, **et** les nouveaux écrans).
5. **Shopify** : décisions du propriétaire + données manquantes côté Core + migration additive, puis code (le contrat dit quoi tester). Tant que ce n'est pas fait, **le stock du module ne baisse pas avec les ventes**.
6. **Non fait dans cette phase (V1+)** : gestion des autorisations par l'interface ; lots avec numéro / péremption ; lecture des demandes en attente par Parle à Nordla (contrat séparé) ; incidents et documents fournisseur en écran ; paiements liés en écran ; test de charge ; revue de sécurité indépendante.
