# Durcissement des fonctions Finance — 2026-11-20

Projet staging : `nordla-finance-staging` (fvhiammdskpcnfodsnrc). Production : aucun changement.

## Migrations

| Migration | Fichier | Effet |
|---|---|---|
| `20261120083356_fin_function_search_path` | `supabase/migrations/20261120083356_fin_function_search_path.sql` | Fixe `search_path = public, extensions, pg_temp` sur les 33 fonctions `public.fin_*` (SECURITY INVOKER). Aucun corps, propriétaire, grant ni politique modifié. |
| `20261120085527_fin_function_execute_scope` | `supabase/migrations/20261120085527_fin_function_execute_scope.sql` | Retire EXECUTE à `PUBLIC`, `anon`, `authenticated` sur `fin_issue_document`, `fin_next_number`, `fin_payable_cents`. `service_role` conserve EXECUTE. |

Rollbacks : `supabase/rollback/20261120083356_fin_function_search_path.down.sql` et `supabase/rollback/20261120085527_fin_function_execute_scope.down.sql`.

Tests : `test/pg/96-security-search-path.pg.test.js` (5 tests, vert sur PostgreSQL 17 local). Suites `30-p0-regression`, `50-essential-payments`, `70-bank` : 77 tests verts après la première migration.

## Droits effectifs vérifiés (staging, lecture seule)

- Schéma `public` : seul `postgres` a CREATE. `anon`, `authenticated`, `service_role` ont USAGE seulement. `PUBLIC` n'a pas CREATE. Rien à corriger.
- Schéma `extensions` : seul `postgres` a CREATE (`dashboard_user` a UC, hérité de la plateforme, non modifié).
- EXECUTE des fonctions `fin_*` non déclencheurs : après correction, `anon` et `authenticated` n'ont plus EXECUTE nulle part dans `fin_*`. `service_role` garde EXECUTE partout.
- Les fonctions déclencheurs gardent leurs grants : elles ne sont pas exposables par l'API (type de retour `trigger`) et leur retrait n'apporterait rien.

Pourquoi le retrait est sûr pour Finance : le serveur Finance appelle toutes les RPC `fin_*` avec la clé `service_role` (`src/supabase/client.js`). Aucun appel client `anon` ou `authenticated` n'existe pour ces trois fonctions.

## Exception de sécurité : `nordla_is_active_member(uuid)` garde `authenticated`

Statut : **exception de sécurité justifiée et testée**, pas une simple alerte ignorée.

Définition : `SECURITY DEFINER`, `search_path=""`, migration Core `20261119150000_security_client_tenant_guards.sql`. Staging conforme (vérifié : `prosecdef`, `proconfig = {search_path=""}`, EXECUTE pour `authenticated` et `postgres`/`service_role`, pas pour `anon`).

Justification : les politiques restrictives `nordla_tenant_guard` (52 tables sur staging) l'appellent en contexte `authenticated`. Retirer EXECUTE fermerait l'accès des utilisateurs connectés à leurs propres données. Le droit est donc maintenu volontairement.

Pourquoi c'est borné :
- entrée unique `p_merchant uuid` ; l'identité vient de `auth.uid()`, jamais d'un paramètre ;
- sortie booléenne ; aucune donnée renvoyée ;
- `SECURITY DEFINER` nécessaire pour lire `merchant_members` sous RLS sans ouvrir cette table aux clients ;
- `search_path` vide, donc les noms non qualifiés ne sont pas redirigeables.

Tests (test/pg/96, vert sur PostgreSQL 17 local) : membre `ACTIVE` non retiré → vrai ; `SUSPENDED` → faux ; `removed_at` renseigné → faux ; autre entreprise → faux ; `anon` sans EXECUTE ; `authenticated` avec EXECUTE. Le test reproduit la forme de table Core (`removed_at`) et la fonction source à l'identique.

Rappel de réexamen : si une politique RLS ne l'utilise plus, retirer EXECUTE à `authenticated` redevient la règle par défaut.

## Tests de facturation sous rôles réels (2026-11-20)

- Local (test/pg/97) : `service_role` émet deux factures fictives ; numéros `FACT-2026-0001` puis `FACT-2026-0002`, statut `ISSUED`, sans trou ni doublon. `anon` et `authenticated` sont refusés (`42501`) sur `fin_issue_document`, `fin_next_number`, `fin_payable_cents`, sans rien numéroter ni émettre.
- Staging (transaction annulée, marchand fictif `99999999-…f1c5`) : `service_role` émet deux factures → `ISSUED_COUNT=2`, `NUMBERS=FACT-2026-0001,FACT-2026-0002`. Second contrôle (`…f1c6`) : `anon` et `authenticated` → `42501` sur les trois fonctions, 0 facture émise. Aucune ligne fictive ne subsiste (vérifié : 0).

## Réconciliation des versions

Les fichiers portent désormais les versions réellement enregistrées sur staging (renommage dans la commit `a8d4f8be`, sans réécriture d'historique) :
- `20261120083356_fin_function_search_path` (au lieu de `20261120090000`)
- `20261120085527_fin_function_execute_scope` (au lieu de `20261120100000`)

Le texte exécuté est le corps SQL des fichiers, à partir de `begin;` ; seul l'en-tête de commentaires diffère (références de nom de fichier mises à jour). Les empreintes ci-dessous portent sur les fichiers versionnés.

## Intégration aux branches

- `release/finance-staging` : `a81ffcde` → `a8d4f8be` (fast-forward).
- `release/sourcing-staging` (Core) : `414c613c` → `e9583407` (fast-forward), mêmes migrations, rollbacks et ce document. Pas de code applicatif modifié.

## Correspondance migration appliquée / fichier

Le texte SQL envoyé à `apply_migration` est le corps des fichiers ci-dessus. Empreintes SHA-256 des fichiers versionnés :

- `20261120083356_fin_function_search_path.sql` : `8fd804713f1d3c73c45671f6311bd39eef56c2da667ba534d52aec1a3127ff87`
- `20261120085527_fin_function_execute_scope.sql` : `7eca96ea8461fb1d68a4b5e95d6ee726a3268f30a5dfa0203ecfa6fd231ec537`

La preuve côté base est le résultat catalogue (33/33 fonctions épinglées, EXECUTE retiré sur les trois fonctions) ; l'outil ne renvoie pas le texte stocké des migrations.

## Non traité

- Protection des mots de passe divulgués : nécessite Pro, hors périmètre (aucun abonnement).
- Raccordement des services aux rôles PostgreSQL limités : demande de créer des rôles et des identifiants, ainsi que la configuration Railway. Non fait ici.
