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

## Pourquoi `nordla_is_active_member(uuid)` garde `authenticated`

Fonction `SECURITY DEFINER` avec `search_path=""`, définie dans la migration Core `20261119150000_security_client_tenant_guards.sql`. Les politiques RLS restrictives `nordla_tenant_guard` (52 tables sur staging) l'appellent en contexte `authenticated` pour vérifier qu'un utilisateur est membre ACTIF, non retiré, de l'entreprise de la ligne. Si `authenticated` perd EXECUTE, ces politiques échouent en fermeture : les clients connectés ne voient plus rien. Le conseil Supabase « SECURITY DEFINER callable by authenticated » est donc un faux positif voulu. La fonction ne prend que `p_merchant`, lit `auth.uid()` (pas de paramètre utilisateur), et ne renvoie qu'un booléen. `anon` n'a pas EXECUTE.

Tests locaux : membre ACTIVE non retiré → vrai ; SUSPENDED → faux ; retiré → faux ; autre entreprise → faux ; `anon` sans EXECUTE ; `authenticated` avec EXECUTE.

## Correspondance migration appliquée / fichier

Le texte SQL envoyé à `apply_migration` est celui des fichiers ci-dessus. Empreintes SHA-256 des fichiers versionnés :

- `20261120083356_fin_function_search_path.sql` : `8fd804713f1d3c73c45671f6311bd39eef56c2da667ba534d52aec1a3127ff87`
- `20261120085527_fin_function_execute_scope.sql` : `7eca96ea8461fb1d68a4b5e95d6ee726a3268f30a5dfa0203ecfa6fd231ec537`

La preuve côté base est le résultat catalogue (33/33 fonctions épinglées, EXECUTE retiré sur les trois fonctions) ; l'outil ne renvoie pas le texte stocké des migrations.

## Non traité

- Protection des mots de passe divulgués : nécessite Pro, hors périmètre (aucun abonnement).
- Raccordement des services aux rôles PostgreSQL limités : demande de créer des rôles et des identifiants, ainsi que la configuration Railway. Non fait ici.
