# Stock / Achats sur Railway staging — addendum de préparation (RIEN N'EST ACTIVÉ)

Branche d'intégration `integration/stock-achats-v1-wave2` (base convergence `2c8871d`). **Aucune variable réelle modifiée, aucune migration appliquée, aucun déploiement, aucune fusion.** Ce document complète `dossier-activation-staging-xiaomi-18-10.md` ; il ne le remplace pas.

## 1. Ce qui change pour le déploiement
| Sujet | Avant | Après cette branche |
|---|---|---|
| Écrans Stock / Achats | API montée seulement (`/api/procurement/*`) | + écrans servis à `/procurement/` (une ligne statique dans `src/sourcing/server/app.js`) ; **les données restent derrière la session, le CSRF et le rôle** |
| Dépendances (`npm ci --omit=dev` dans `deploy/sourcing/Dockerfile`) | — | + `pg` 8.13.1 (JavaScript pur, 13 paquets) ; **chargé seulement si `PROCUREMENT_PG_URL` est défini** |
| Dockerfile / `.dockerignore` | — | **inchangés** : `COPY src` embarque `src/procurement/**` (écrans compris) ; `docs`, `test`, `supabase` n'entrent pas dans l'image et ne sont pas nécessaires |
| Stockage Stock / Achats | `<SOURCING_DATA_DIR>/procurement/procurement.json` (+ `uploads/`) | inchangé : **dans le volume**, donc dans la **sauvegarde chiffrée** (prouvé : `test/procurement-backup-restore.test.js`) |
| Supabase | aucun appel de Stock / Achats | inchangé en mode fichier. PostgreSQL = option future (voir §3) |

## 2. Variables (aucune n'est obligatoire pour le staging)
| Variable | Rôle | Valeur staging proposée | À saisir par |
|---|---|---|---|
| `PROCUREMENT_GRANTS` | autorisations explicites `{"<userId>":["RECEIVE","ADJUST","APPROVE_PO"]}` ; **absente = seul le propriétaire réceptionne, ajuste, approuve** ; une valeur invalide met le module **OFF** | **absente** (le compte de test est propriétaire) | propriétaire |
| `PROCUREMENT_DISABLED` | `1` = module OFF au démarrage, rien d'ouvert, données intactes (**retour arrière sans redéploiement**) | absente (module actif) ; à poser à `1` pour un repli immédiat | propriétaire |
| `PROCUREMENT_PG_URL` / `PROCUREMENT_PG_POOL_MAX` | magasin PostgreSQL (jamais de repli silencieux sur le fichier) | **absentes** : pas de PostgreSQL pour Stock / Achats au staging du 18/10 | — |
| `PROCUREMENT_DEV` | ne pas mettre en cache les écrans (développement) | **jamais** en staging | — |
Variables existantes (identité, Supabase, `NORDLA_MERCHANT_ID`, CSRF, sauvegarde) : **inchangées**. Le magasin de Stock / Achats utilise l'identifiant de commerçant hébergé déjà configuré.

## 3. PostgreSQL pour Stock / Achats — pas au 18/10
Prêt mais **non appliqué** : migrations `supabase/migrations-pending/20261016090000_procurement_stock.sql` + `…091000_procurement_permissions.sql` (déjà dans la convergence, ensemble), retours arrière `supabase/rollback/*.down.sql`, migration d'intégration **scindée** (sans `integration_purchase_plans` ni `integration_incoming_expectations`). Preuves sur PostgreSQL 17 jetable (rôles Supabase simulés) : `procurement-coexistence.pg-smoke.mjs` **95/95** (deux ordres, redémarrage, sauvegarde/restauration, smoke d'A 28/28 sur le schéma scindé). Avant toute application : autorisation du propriétaire, projet Supabase dédié, sauvegarde, `docs/operations/procurement-postgres-raccordement.md`, import vérifié (`runImport` = `IMPORTED_VERIFIED`).

## 4. Volume, conteneur, démarrage (vérifié sur le code et par test local)
- Une seule réplique (le verrou du fichier suppose un seul écrivain ; Railway interdit de toute façon les répliques avec volume).
- Conteneur en lecture seule + non-root : Stock / Achats n'écrit que dans le volume (`procurement/`), jamais dans `/tmp` ni dans l'image.
- Au démarrage il crée, **dans le volume**, `procurement/procurement.json` avec deux emplacements par défaut (réception, quarantaine) si le fichier n'existe pas : c'est la seule écriture sans action d'une personne. `PROCUREMENT_DISABLED=1` l'évite.
- Le journal de démarrage dit l'état : `Stock / Achats ON (<chemin>; N authorization(s) granted)` ou `OFF (<code>)` (jamais de secret).
- Un échec de Stock / Achats **n'empêche pas** Nordla de démarrer (isolement).

## 5. Vérifications après déploiement (lecture seule, à faire par une personne)
1. Journal : `Stock / Achats ON (…)` et `uid 1000` (pas `uid 0`).
2. `GET /healthz` → 200 ; `GET /procurement/` → 200 (page) ; `GET /api/procurement/stock` **sans session** → 401.
3. Connecté en propriétaire : `/procurement/` s'ouvre, l'onglet Stock se charge ; `GET /api/procurement/me` → `role: OWNER`.
4. Un collaborateur **sans** autorisation : lecture seule ; `POST` d'une réception → 403.
5. Une écriture sans en-tête CSRF → 403 (garde de l'hôte).
6. Redémarrer le service : les données saisies sont toujours là.
7. Une sauvegarde chiffrée contient `procurement/procurement.json` (`sourcing-backup verify`).

## 6. Retour arrière (du plus léger au plus lourd) — aucun ne touche une base partagée
| Niveau | Action | Effet sur les données |
|---|---|---|
| 1 | `PROCUREMENT_DISABLED=1` puis redémarrage | écrans, API et outils de Parle indisponibles pour Stock / Achats ; **fichier intact** ; Parle répond « non raccordé » ; retirer la variable ramène tout |
| 2 | Redéployer le commit **précédent épinglé** (jamais « dernière version ») | module de l'ancienne version ; le fichier de données reste lisible (format inchangé ; les demandes de stock sont de simples événements du journal, que l'ancienne version n'interprète pas : elles y apparaîtraient comme événements inconnus et ne seraient pas décidables avant le retour à la nouvelle version) |
| 3 | Restaurer la dernière sauvegarde chiffrée dans un dossier vide (`restore` refuse d'écraser) | retour à l'état de la sauvegarde |
| 4 | (PostgreSQL, plus tard seulement) scripts `supabase/rollback/*.down.sql` : permissions d'abord, puis schéma ; refus s'il y a des lignes sans `--data-exported --accept-data-loss` | export obligatoire |

## 7. Opérations qui restent soumises à l'autorisation du propriétaire
Fusion de la branche d'intégration · déploiement du service · saisie de `PROCUREMENT_GRANTS` / `PROCUREMENT_DISABLED` sur Railway · toute migration (Stock / Achats ou d'intégration) · `PROCUREMENT_PG_URL` · tout raccordement Shopify.
