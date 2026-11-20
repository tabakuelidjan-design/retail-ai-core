# Pilote Finance : lecture et émission de facture sur rôle PostgreSQL limité

## 1. État actuel (2026-11-20, unique et à jour)

- **Branche** : `pilot/finance-narrow-role-20261120`, dernier commit `f9c7c48e`. Base : `release/finance-staging` @ `361c06f5`, inchangée. Rien n'est fusionné dans une branche release, rien n'est déployé.
- **Périmètre** : deux méthodes du store Finance, `getDocument` (lecture d'une facture) et `issueDocument` (émission via `fin_issue_document`). Tout le reste reste sur `service_role`.
- **Mode** : désactivé par défaut. `FINANCE_RUNTIME_DB=narrow-pilot` active le chemin limité au démarrage de `createRuntime` (le même point d'entrée que le serveur et la CLI). Toute erreur d'identité, de TLS ou de configuration arrête le démarrage ; aucun repli vers `service_role`.
- **Staging** (projet d'essai `fvhiammdskpcnfodsnrc`) : migration v4 appliquée (voir §4). Aucun marchand réel, aucune donnée réelle. Les entreprises fictives A et B ont été utilisées.

## 2. Preuves LOCALES (PostgreSQL 17 jetable, deux marchands synthétiques, vrais logins)

| Suite | Tests | Résultat |
|---|---|---|
| `test/pg/98` parcours fonctionnel | 8 | vert |
| `test/pg/99` identités (non liée, désactivée, privilégiée, non membre, liaison immuable) | 4 | vert |
| `test/pg/100` audit exact du rôle | 6 | vert |
| `test/pg/101` connexion (TLS, paramètres SSL refusés, identité au démarrage) | 6 | vert |
| `test/pg/102` matrice EXECUTE rôles × fonctions `extensions` (avant / après / rollback) | 1 | vert |
| `test/pg/103` PUBLIC SELECT sur une relation `extensions` | 1 | vert |
| `test/pg/104` démarrage `createRuntime` en mode limité, panne, mode service | 4 | vert |
| `test/finance-narrow-config.test.js` configuration de démarrage | 4 | vert |

Total : 34 tests locaux verts. Les quatre suites `finance-pack` en échec ne sont pas liées au pilote : elles échouent à l'identique sur `361c06f5` (vérifié).

## 3. Preuves STAGING (fictif uniquement, pooleur `aws-1-eu-west-1`, TLS strict avec le CA officiel)

Exécuté par `createRuntime` lui-même, avec `NORDLA_MERCHANT_ID` = entreprise fictive A et un client Supabase de substitution (la clé de service n'est pas disponible sur ce poste, et elle n'a pas été demandée) :

- Démarrage : identité `session_user` vérifiée, liaison au marchand A confirmée, TLS vérifié. Journal : « narrow-pilot (session user login, bound merchant verified, TLS verified) ».
- Lecture d'un brouillon de A : OK. Émission : `FACT-2026-0002`, statut `ISSUED`.
- Appels reçus par le client service pendant lecture et émission : **aucun**.
- Refus entre entreprises : lecture d'un brouillon de B → `null` ; émission d'un brouillon de B → `DOCUMENT_NOT_FOUND` ; réémission du brouillon de A → `CONCURRENT_MODIFICATION`.
- Démarrage avec le marchand B alors que le login est lié à A → refus (`FIN_PILOT_MERCHANT_MISMATCH`), aucun runtime retourné.
- Panne de connexion après démarrage : lecture et émission refusées (`NARROW_CONNECTION_FAILED`), rien n'est lu ni émis par le client service.
- Panne au démarrage (mauvais port) : démarrage refusé.
- Nettoyage : login supprimé, liaison désactivée, brouillon fictif B supprimé. Restent : les entreprises fictives A et B, deux factures fictives émises pour A (`FACT-2026-0001`, `FACT-2026-0002`, immuables par conception), la migration.

Limite : le parcours de décision complet (`service.decide` avec readiness, hooks de stock et d'archive) n'a pas été exécuté sur staging, faute de clé de service.

## 4. Migration et rollback (staging)

- Migration `20261120110000_fin_issuer_narrow_role.sql` (v4), appliquée telle que committée dans `f9c7c48e`. Rollback : `supabase/rollback/20261120110000_fin_issuer_narrow_role.down.sql`.
- Contenu : rôle `nordla_fin_issuer_pilot` (sans login, sans BYPASSRLS), liaison immuable login→entreprise, garde restrictive par entreprise, droits minimaux, retrait de PUBLIC EXECUTE sur `extensions` et de PUBLIC SELECT sur ses relations avec préservation des droits de chaque rôle, audit exact qui échoue fermé.
- Audit sur staging : 7 contrôles au vert. Droits de `anon`, `authenticated`, `service_role` inchangés (54 fonctions chacun).

## 5. Appels `service_role` avant et après l'émission

Chemin d'approbation `service.decide(id, 'APPROVE')` (code `src/finance/service.js`) :

| Étape | Accès | Chemin |
|---|---|---|
| `must(id)` → `store.getDocument` | lecture de la facture | **limité** (si mode activé) |
| `readiness` → `validateForIssue` | calcul, sans base | — |
| `readiness` → `linkage` → `ledgerProvider()` | chargement des commandes (`loadRetail`) | **service_role** |
| `readiness` → `linkage` → `store.listDocuments` | lecture des factures du marchand | **service_role** |
| `readiness` (avoir) → `store.getDocument` de la facture liée | lecture | limité |
| `store.issueDocument` | émission | **limité** |
| après émission : `resettle` (avoirs seulement) | `listPayments`, `listAllocations`… | **service_role** |
| après émission : `hooks.afterIssue` (stock) | écritures de stock | **service_role** |
| après émission : `hooks.onIssued` (archive légale) | fichiers et tables d'archive | **service_role** |
| `appendEvent` des échecs de hook | journal | **service_role** |

Autres chemins Finance : paiements, rapprochement bancaire, Peppol, réglages, sociétés, avoirs, devis : **tous sur `service_role`**.

## 6. Plateforme : six fonctions de `extensions` (lecture seule sur staging)

Toutes sont `returns event_trigger`, `SECURITY INVOKER`, `search_path=""`, propriété `supabase_admin`, volatilité `v`. Elles s'exécutent comme déclencheurs d'événements (pg_cron, pg_graphql, pg_net, PostgREST DDL/drop, placeholder GraphQL). PostgreSQL refuse leur appel direct (`0A000`, « trigger functions can only be called as triggers », vérifié localement sur une fonction de même type). Elles restent des exceptions explicites de l'audit ; elles ne sont pas modifiées.

## 7. Risques de déploiement (non traités ici)

1. Clé de service : le serveur Finance a besoin de `SUPABASE_SERVICE_ROLE_KEY` pour le reste du parcours ; la limiter aux seuls appels restants exige de réécrire les appels de §5.
2. `service_role` garde BYPASSRLS : tant que ces appels existent, la protection reste contournable par ce chemin.
3. Configuration hors dépôt : `FINANCE_PILOT_DATABASE_URL` (login du pooleur), `FINANCE_PILOT_CA_FILE` (PEM officiel), `FINANCE_PILOT_SERVER_NAME` si besoin. Aucun secret dans le dépôt.
4. Pool : limité à 3 connexions, timeouts ; le pooleur de transaction (6543) et de session (5432) ont été vérifiés.
5. Rollback : `DROP ROLE` est cluster-wide ; la suppression du rôle suit sur toutes les bases.

## 8. Prochaine portion à sécuriser

Parcours d'approbation complet : déplacer `ledgerProvider`, `listDocuments` de la vérification de liaison, puis les hooks de stock et d'archive sur des rôles limités, avant de généraliser à d'autres chemins (paiements, rapprochement). Première étape proposée : la vérification de liaison (`checkLinkage`), qui ne lit que des factures du marchand.
