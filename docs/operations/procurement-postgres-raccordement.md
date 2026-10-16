# Stock / Achats — raccordement PostgreSQL : état vérifié et procédure (RIEN N'EST APPLIQUÉ)

Audit fait sur le code de la branche `feature/stock-achats-v1-finalisation` (base `2c8871d`). **Aucune migration n'a été lancée sur une base partagée, aucune donnée réelle n'a été touchée.** Les preuves ci-dessous viennent de conteneurs PostgreSQL 17 jetables avec des rôles Supabase simulés ; rien n'a été constaté sur un vrai projet Supabase.

## 1. Les sept points demandés
| Point | État | Preuve / où |
|---|---|---|
| **Schéma et migrations** | Prêts, **non appliqués**. 2 fichiers dans `supabase/migrations-pending/` : `…090000_procurement_stock.sql` (17 tables `proc_*`, registre en ajout seul, soldes par trigger, garde des transitions) et `…091000_procurement_permissions.sql` (droits, politiques restrictives, fonctions à `search_path` fixe). Retours arrière dans `supabase/rollback/`. | `test/postgres/procurement.pg-smoke.mjs`, `procurement-staging-tool.pg-smoke.mjs`, `procurement-coexistence.pg-smoke.mjs` (93 contrôles, 4 variantes) |
| **Permissions** | `anon` / `authenticated` : lecture et écriture refusées, un `GRANT` fait par erreur ne rend rien (politique restrictive). `service_role` lit et écrit mais ne peut **ni UPDATE ni DELETE** le registre et le journal. Isolation par commerçant (clés étrangères composites, clé d'idempotence par commerçant). | coexistence smoke (aucun rôle client n'accède à `proc_*` ni aux tables d'A) |
| **Dépendance `pg`** | **Absente** du `package.json` racine et de l'image. Elle n'existe que dans `test/pg` (8.13.1, test uniquement). L'application hébergée la charge dynamiquement **seulement si** `PROCUREMENT_PG_URL` est défini ; absente → le module s'arrête proprement (`PG_DRIVER_MISSING`). | patch prêt : `docs/integration/stock-achats-v1-patch-pg-dependency.patch` (ajoute `pg` 8.13.1 exact + `package-lock.json`, vérifié par `git apply --check`, **non appliqué**) |
| **Persistance** | Magasin fichier (`<data>/procurement/procurement.json`, dans le volume sauvegardé) = **seul stockage en service aujourd'hui**. PostgreSQL : redémarrage du serveur PostgreSQL et redémarrage du montage hébergé prouvés (lignes, soldes, demandes en attente, historique intacts). | coexistence smoke (redémarrage) ; `test/procurement-hosted.test.js` (PostgreSQL réel) |
| **Concurrence** | Réceptions, ajustements, réservations, décisions de demandes : une seule décision gagne, y compris à 3 approbations simultanées ; soldes jamais négatifs ; unicité des numéros de bon. | `procurement-invariants` (3), `procurement-pg-faults` (11), `procurement-stock-requests` (10), `procurement-server-v1` |
| **Reprise après échec** | Perte de connexion pendant la validation (COMMIT) : rejouer avec la même clé d'idempotence ne double rien ; erreurs transitoires rejouées 2 fois avec la même clé ; un import interrompu laisse la cible vide. | `procurement-pg-faults`, `procurement-import` |
| **Rollback** | Schéma : `run.mjs rollback` (permissions d'abord, puis schéma), refusé s'il y a des lignes sans `--data-exported --accept-data-loss`. Bascule : retirer `PROCUREMENT_PG_URL` ramène au fichier, **jamais modifié** par l'import. | `procurement-staging-tool.pg-smoke.mjs` ; `docs/operations/procurement-staging-migration.md` §5 |

## 2. Le serveur utilise-t-il PostgreSQL ? — Non, pas encore
Dans le serveur hébergé (`src/procurement/server/hosted.js`), le magasin est **le fichier** sauf si l'opérateur définit `PROCUREMENT_PG_URL`. Si PostgreSQL est demandé et échoue, le module passe **OFF** (jamais de repli silencieux sur le fichier : cela couperait les données en deux). Variables : `PROCUREMENT_PG_URL` (connexion directe Postgres, jamais exposée au navigateur), `PROCUREMENT_PG_POOL_MAX` (5 par défaut). L'identifiant de commerçant du serveur hébergé doit exister dans `merchants` (c'est le cas du commerçant hébergé).

## 3. Les tables d'A exclues : migration à scinder
Fichier : `supabase/migrations-pending/20261015090000_integration_objects_and_sourcing_cases.sql` (chantier A / convergence). Il crée, dans **une seule transaction**, sept tables ; deux sont **exclues par décision de convergence** (le bon de commande de Stock / Achats est canonique) :
- `integration_purchase_plans` (lignes 26-44) + sa fonction de garde `integration_purchase_plans_guard` et son déclencheur (lignes 120-132) ;
- `integration_incoming_expectations` (lignes 46-61, clé étrangère vers les plans) + son déclencheur `integration_incoming_write_once` (ligne 140) ;
- leurs deux noms dans la boucle « service role only » (ligne 181).
Les cinq autres (`integration_buy_candidates`, `integration_campaign_contracts`, `integration_tracking_definitions`, `integration_trace_ledger`, `sourcing_cases`) **n'en dépendent pas**.
**Proposition** (non appliquée, le fichier appartient à A / convergence) : `docs/integration/stock-achats-v1-patch-split-integration-migration.patch`, produit et vérifié par `tools/procurement-staging/split-integration-migration.mjs` (refuse de deviner si le fichier change de forme). Preuve sur PostgreSQL jetable, dans les deux ordres : les deux tables n'existent pas, les cinq autres existent avec RLS et droits clients retirés, les 17 tables `proc_*` coexistent, 0 table sans RLS, 0 politique permissive.

## 4. Prérequis qui empêchent encore le raccordement (à lever, dans cet ordre)
1. **Autorisation écrite du propriétaire** d'appliquer des migrations sur un projet Supabase **dédié** (staging), jamais la production ni un staging partagé.
2. **Décision sur la migration d'A** (scission proposée ci-dessus) : tant qu'elle est appliquée telle quelle, elle crée les deux tables exclues.
3. **`pg` dans les dépendances** (patch prêt) — modification de `package.json` / `package-lock.json` / image Docker : **chantier 3**.
4. **Un seul écrivain** pendant la bascule : arrêter le serveur, importer (`runImport`, `IMPORTED_VERIFIED` exigé), démarrer avec `PROCUREMENT_PG_URL`.
5. Constat sur le vrai Supabase de ce que le simulateur ne couvre pas (`auth.uid()`, extensions, quotas).

## 5. Procédure (à n'exécuter qu'après autorisation) — inchangée dans l'esprit
`docs/operations/procurement-staging-migration.md` §3 : plan → sauvegarde → apply (gardé) → verify → import vérifié → parcours complet → démarrage avec `PROCUREMENT_PG_URL`. Retour arrière : §5 du même document.
