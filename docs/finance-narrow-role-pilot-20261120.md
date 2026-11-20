# Pilote : chemin facturation étroit sur rôle limité (Finance) — v2 identité liée

Statut : **local et branche poussée uniquement**. Rien n'est appliqué à staging, Supabase distant ou Railway. Rien n'est fusionné ni déployé.

## Base et dépôt

- Base : `release/finance-staging` @ `361c06f5` (contient déjà `20261120083356` et `20261120085527`).
- Branche pilote : `pilot/finance-narrow-role-20261120`, worktree `C:\Users\etaba\Desktop\nordla-finance-pilot-20261120`.
- Modèle de liaison réutilisé : `security/runtime-roles-20261120` @ `706b1158`, fichier `db/pending-migrations/20261120010000_runtime_principal_binding.sql` (table de liaison immuable, identité lue dans `session_user`, aucun LOGIN créé).
- Autres worktrees non touchés (ex. `nordla-finance-mfa-wt`, dont le SHA a changé : ce n'est pas le nôtre).
- Compteur de numérotation staging (lecture seule) : une **ligne** de `fin_number_sequences` (upsert), pas une séquence PostgreSQL. Un rollback annule l'avance. 0 ligne fictive restante.

## Ce que fait le chemin étroit

Émission d'une facture approuvée : `getDocument` (une ligne de `fin_documents`) puis `issueDocument` (appel de `fin_issue_document`). **Il ne couvre pas le parcours complet** : paiements, rapprochement, Peppol, réglages, lectures de `readiness`, `resettle`, hooks stock et archives restent sur `service_role` (voir plus bas).

## Identité (v2)

Avant : la politique faisait confiance à `app.merchant_id`. Un même login pouvait choisir un autre marchand. **Corrigé.**

Maintenant :
- Le marchand vient de la **connexion PostgreSQL** (`session_user`), liée une fois pour toutes dans `nordla_runtime.fin_pilot_principals` (login → marchand, activé/désactivé, jamais modifiable ni supprimable : trigger `fin_pilot_binding_guard`).
- `nordla_runtime.fin_pilot_bound_merchant()` (SECURITY DEFINER) renvoie ce marchand. Si `app.merchant_id` est défini et différent, la requête est refusée (`FIN_PILOT_CONTEXT_FORBIDDEN`). Un contexte absent ne donne que le marchand lié.
- `nordla_runtime.fin_pilot_assert(p_merchant)` (SECURITY DEFINER) est appelée par l'adaptateur à chaque transaction, **après** `SET LOCAL ROLE nordla_fin_issuer_pilot` : refuse si la connexion n'est pas liée à `p_merchant`, si le login est privilégié (`rolsuper`, `rolbypassrls`, `rolcreaterole`, `rolcreatedb`, `rolreplication`), s'il est membre d'un autre rôle que le pilote, ou s'il n'est pas membre du pilote.
- Une **garde restrictive** (`nordla_fin_pilot_guard_*`) limite chaque ligne au marchand lié : une politique permissive ajoutée plus tard ne contourne pas cette limite.
- Le rôle `nordla_fin_issuer_pilot` : NOLOGIN, NOINHERIT, NOBYPASSRLS, sans création. Droits : `fin_documents` (SELECT, UPDATE), `fin_number_sequences` (SELECT, INSERT, UPDATE), `fin_events` (INSERT), trois fonctions, `extensions.digest`, usage des schémas `public`, `extensions`, `nordla_runtime` (fonctions de liaison uniquement).
- Aucun repli vers `service_role` : une erreur d'identité, de connexion ou de requête est levée.

## Fichiers (branche pilote)

- `supabase/migrations/20261120110000_fin_issuer_narrow_role.sql` (v2) et `supabase/rollback/20261120110000_fin_issuer_narrow_role.down.sql` (v2).
- `src/finance/runtime/narrow-issue-path.js` (v2) : `verify()`, `getDocument`, `issueDocument`. Pool injecté. Aucune variable d'environnement.
- `src/finance/supabase-store.js` : `createSupabaseFinanceStore(supabase, { merchantId, narrowIssuePath = null })`. Sans adaptateur, comportement inchangé.
- `test/pg/lib/pilot.js` : création des deux vrais logins `nordla_fin_pilot_login_a` et `..._b` (mot de passe de test local, base jetable), liaison A et B.
- `test/pg/98-narrow-issue-path.pg.test.js` : 8 tests fonctionnels.
- `test/pg/99-narrow-identity.pg.test.js` : 4 tests d'identité.
- `docs/finance-narrow-role-pilot-20261120.md` (ce fichier).

## Résultats (PostgreSQL 17 local, base jetable, deux marchands synthétiques, vrais logins)

| Suite | Résultat |
|---|---|
| `98` : nominal (A émet FACT-2026-0001/0002, B émet FB-2026-0001, croisements refusés) | ✔ |
| `98` : pas de contexte, réutilisation du pool (contexte étranger laissé en session : refusé ; absent : A seulement) | ✔ |
| `98` : SET ROLE / RESET ROLE (service_role et postgres refusés ; session_user inchangée) | ✔ |
| `98` : politique permissive supplémentaire (`using (true)`) ne contourne pas la garde | ✔ |
| `98` : opérations interdites (DELETE, INSERT, UPDATE events, lecture bank, record_payment, CREATE, GRANT) | ✔ refusées, aucun privilège gagné |
| `98` : connexion en échec, aucun appel au client service | ✔ |
| `98` : le store passe par le chemin étroit (lecture + émission), 0 appel service | ✔ |
| `98` : rollback retire politiques, fonctions, table de liaison, grants ; privilèges service_role inchangés | ✔ |
| `99` : marchand demandé ≠ lié → `FIN_PILOT_MERCHANT_MISMATCH` | ✔ |
| `99` : login non lié, désactivé, membre de service_role (`FIN_PILOT_LOGIN_MEMBERSHIP_FORBIDDEN`), BYPASSRLS (`FIN_PILOT_LOGIN_PRIVILEGED`), non membre du pilote (refusé au SET ROLE) | ✔ |
| `99` : liaison immuable (merchant, login, suppression) | ✔ |
| `99` : le login ne lit pas la table de liaison et ne peut pas choisir une autre identité | ✔ |
| `96` et `97` (durcissement, facturation service_role) | 7/7 ✔ |
| `test/tenant-isolation.test.js` | ✔ |
| `finance-bank-csv-atomic`, `finance-contacts-roles` | ✔ (après `npm ci` depuis le lockfile) |
| `finance-pack.test.js` : 2 échecs d'isolation (`peppol-recommand.js` dans la liste des fichiers réseau ; `payment-channel.js` nomme un fournisseur) | ✘ **non causés par le pilote** : ces deux fichiers sont identiques à la base (diff = 0). Je n'ai pas relancé ces deux tests sur la base seule ; le constat repose sur l'absence de diff et sur le message d'échec. |
| `finance-purchase-document.test.js` | ✔ |

Dépendances installées par `npm ci` depuis `package-lock.json` (89 paquets, exit 0) dans le worktree pilote uniquement.

## Appels Finance non couverts (parcours complet, toujours `service_role`)

- Toutes les autres méthodes du store (environ 160 appels Supabase par branche) : paiements `fin_record_payment`, `fin_allocate_payment`, `fin_reverse_allocations`, `fin_void_payment`, rapprochement `fin_bank_*`, Peppol `fin_peppol_*`, `fin_seller_profile_record`, lectures et écritures diverses.
- Lectures de `readiness` (société, profil vendeur, lignes), `resettle` (avoirs), hooks stock et archives légales, `peekNextNumber`, `saveDocument`.
- Serveurs et CLI qui créent encore le store avec le client service : `src/finance/server/app.js`, `src/finance/cli.js`, `src/finance/runtime.js`, `src/sourcing/server/index.js`, `src/procurement/server/finance-handoff-host.js`.

Conséquence : une approbation complète (`decide APPROVE`) passe encore par `service_role` avant et après l'émission. Le pilote prouve la partie émission et lecture d'un document, rien d'autre.

## Risques de déploiement

1. **Dépendance `pg`** : absente du produit. Le pool doit être créé par l'entrypoint, à partir d'une configuration à définir hors dépôt.
2. **Logins** : non créés ici. Chaque login doit être créé par un opérateur, avec un mot de passe généré hors chat et hors dépôt, puis lié à une seule entreprise.
3. **Pooler** : `SET LOCAL ROLE` et l'assertion sont par transaction ; un pooler en mode transaction convient, un mode session partagé doit faire `RESET ROLE`.
4. **Rôle cluster-wide** : `DROP ROLE` échoue tant qu'une base du cluster (modèle compris) garde des grants. Le rollback retire les objets ; la suppression du rôle suit sur toutes les bases.
5. **Pas de repli** : une panne fait échouer l'approbation ; le service doit l'afficher sans réessayer en `service_role`.
6. **`service_role` garde BYPASSRLS** : tant que les appels ne sont pas retirés, la protection reste contournable par ce chemin.
7. **Migration** : ne pas appliquer sans revue. Elle crée un schéma et une table de liaison, et des fonctions SECURITY DEFINER.

## Étapes avant recette staging

1. Revue humaine de la migration v2, de l'adaptateur et des tests.
2. Décider du périmètre suivant (paiements) avant toute généralisation.
3. Login de test dédié, créé par un opérateur, lié à un marchand fictif.
4. Migration appliquée seulement après accord explicite, puis relecture des droits et des conseils Supabase.
5. Recette : émission nominale, refus sans liaison, refus de changement de contexte, refus d'un login privilégié, rollback vérifié.

## Audit du rôle `nordla_fin_issuer_pilot` (v3)

Fonction `nordla_runtime.fin_pilot_role_audit()` (SECURITY DEFINER, exécutable par `postgres` seulement). Elle contrôle :
- **privilèges réels** (aclexplode) : exactement l'ensemble attendu (3 fonctions, 3 schémas, 5 droits de tables fin_*), y compris les droits accordés à `PUBLIC` sur les schémas `public` et `nordla_runtime` (le `EXECUTE` de `PUBLIC` sur `extensions.digest` est retiré par la migration) ;
- **attributs** : ni superuser, ni BYPASSRLS, ni CREATEROLE, ni CREATEDB, ni REPLICATION, ni LOGIN, ni INHERIT ;
- **appartenances** : le rôle n'est membre d'aucun autre rôle (donc aucun `SET ROLE` vers une puissance supérieure) et personne ne peut le redonner (pas d'ADMIN OPTION) ;
- **membres** : chaque membre est non privilégié et n'appartient à aucun autre rôle ;
- **propriété** : le rôle ne possède aucune table, fonction ni schéma ; les tables `fin_*` ne lui appartiennent pas.

La migration **échoue fermée** à la fin si un contrôle échoue (`FIN_PILOT_ROLE_UNSAFE`), y compris quand le rôle existait déjà avec des attributs trop puissants. Tests : `test/pg/100-narrow-role-audit.pg.test.js` (6/6 : base saine, BYPASSRLS, privilège supplémentaire sur une table bancaire et sur PUBLIC, appartenance à service_role, membre privilégié, propriété, ADMIN OPTION, rôle préexistant trop puissant).

## Test de la fonction de comparaison (base 361c06f5)

Les deux tests `finance-pack` en échec (`ISOLATION: only company.js may touch the network…` et `the generic finance core contains no merchant name…`) échouent **à l'identique sur la base `361c06f5`** (même commande, même `package-lock.json` identique, même `node_modules` contenant `pdfkit`). Ils sont donc **préexistants** : la base contient déjà `peppol-recommand.js` dans la liste des fichiers réseau et `payment-channel.js` qui nomme un fournisseur. Le pilote ne modifie aucun de ces fichiers.

## Raccordement réel préparé (pas encore branché)

- Dépendance : `pg@8.16.3` (version exacte, ajoutée au `package.json` de la branche pilote).
- `src/finance/runtime/pg-connection.js` :
  - refuse les logins administratifs ou de plateforme (postgres, supabase_admin, service_role, authenticator, anon, authenticated, dashboard_user) et tout login hors préfixe `nordla_fin_pilot_` ;
  - TLS vérifié obligatoire hors loopback (`rejectUnauthorized: true`, CA fournie par l'entrypoint, `sslmode` refusé sauf `verify-full`) ;
  - texte clair accepté seulement en loopback avec un drapeau de test explicite ;
  - pool borné (max, timeouts de connexion et d'inactivité, `statement_timeout`) ;
  - `verifyPilotConnection` exécute la vérification d'identité au démarrage et renvoie `session_user` ; en cas d'échec, il lève une erreur, sans repli.
- `test/pg/101-pilot-connection.pg.test.js` : 5/5 verts (refus des logins, refus sans CA ou en `sslmode` non vérifié, loopback sans drapeau, options TLS du pool, identité A acceptée, B refusée, login non lié refusé).

## Recette staging : bloquée (accès manquant)

- Réseau : le pooler Supabase `aws-0-eu-west-1.pooler.supabase.com` (5432 session et 6543 transaction) **répond**. L'hôte direct `db.fvhiammdskpcnfodsnrc.supabase.co` n'est pas résolu depuis ce poste.
- TLS : la connexion échoue avec `SELF_SIGNED_CERT_IN_CHAIN` : le certificat de la chaîne n'est pas dans le magasin de confiance Node. **Il faut l'autorité de certification Supabase officielle (PEM)** pour une vérification réelle. La récupérer exige un téléchargement que je n'ai pas le droit de faire sans ton accord ; je ne contourne pas la vérification (`rejectUnauthorized: false` est interdit ici).
- Identifiants : aucun login de test n'a été créé sur staging. Le rôle MCP peut créer des rôles (CREATEROLE, vérifié), mais un login de test ne sert à rien sans le CA pour vérifier la connexion réelle ; je ne l'ai donc pas fait.
- Conséquence : `session_user` **via le pooler** (mode transaction 6543 et session 5432) n'a pas été démontré. Ce point reste ouvert.

Étapes restantes une fois le CA disponible : créer un login de test lié à une entreprise fictive, appliquer la migration v3 sur staging après accord explicite, vérifier `verifyPilotConnection` en session (5432) et en transaction (6543), puis la recette nominale et les refus.

## Corrections v4 (SSL, PUBLIC, audit) et recette staging (2026-11-20)

### Paramètres SSL de l'URL
Refusés : tout paramètre `ssl*` (sslcert, sslkey, sslrootcert, sslcrl, sslnegotiation, SSLROOTCERT…), et `sslmode` sauf `verify-full`. Le pool ne reçoit que la configuration TLS imposée (`rejectUnauthorized: true`, CA fournie, `servername` explicite). Tests : `test/pg/101` (6/6).

### Retrait de PUBLIC EXECUTE et de PUBLIC SELECT sur `extensions`
Mesure réelle sur staging (lecture seule) : 54 fonctions sur 55 sont exécutables par PUBLIC ; `anon`, `authenticated`, `service_role`, `authenticator`, `pgbouncer` et des rôles `supabase_*` n'ont ce droit **que** par PUBLIC. Un retrait brut les aurait cassés. La migration v4 rend d'abord explicite, pour chaque rôle, le droit qu'il possède, puis retire PUBLIC ; un instantané (`nordla_runtime.fin_pilot_ext_public_snapshot`) permet un retour arrière exact. Tests : `test/pg/102` (matrice rôles × fonctions avant/après/rollback : seul le pilote change) et `test/pg/103` (relation `pg_stat_statements`-like : PUBLIC retiré, droits préservés, rollback exact).

### Audit corrigé
- droits effectifs calculés avec `coalesce(acl, acldefault(...))` : les ACL NULL (droits implicites) sont comptés ;
- PUBLIC est compté dans `public`, `extensions` et `nordla_runtime` ;
- fonctions identifiées par leur signature exacte (`regprocedure`) ;
- comparaison en ensembles (manquant / en trop).

### Exceptions de plateforme explicites (à valider)
Six fonctions de `extensions` appartiennent à `supabase_admin` (non `postgres`) ; leur ACL ne peut pas être modifiée par cette migration. Elles restent exécutables par PUBLIC, sont `SECURITY INVOKER` et sont listées une à une dans l'audit : `grant_pg_cron_access`, `grant_pg_graphql_access`, `grant_pg_net_access`, `pgrst_ddl_watch`, `pgrst_drop_watch`, `set_graphql_placeholder`. Tout autre droit PUBLIC fait échouer l'audit. Risque résiduel : le pilote peut les appeler ; leur effet sous un rôle non privilégié n'a pas été vérifié.

### Membre automatique `postgres`
PostgreSQL 16+ ajoute le créateur d'un rôle comme membre avec ADMIN OPTION, accordé par le superutilisateur d'amorçage : cette migration ne peut pas le retirer. Le rôle `postgres` (propriétaire de la plateforme) est donc la seule exemption, explicite dans l'audit.

### Recette staging (projet `nordla-finance-staging`, entreprises fictives uniquement)
Réalisé :
- migration v4 appliquée sur staging après audit (l'audit a d'abord refusé deux fois, la transaction a été annulée à chaque fois ; état final : 7 contrôles au vert, rien d'autre changé) ;
- 57 entrées de sauvegarde ; `anon`, `authenticated`, `service_role` conservent leurs 54 droits ; le pilote n'a plus que `digest` et les 6 exceptions ;
- deux entreprises fictives (A et B), un brouillon chacune, une liaison login → A ;
- TLS : le CA officiel (racine « Supabase Root 2021 CA », empreinte SHA-256 `80:70:25:AD…:CA:FA`, identique à la racine présentée par le pooleur) est accepté ; un CA témoin est rejeté (`SELF_SIGNED_CERT_IN_CHAIN`) : la vérification est réelle. Aucune autorité Windows n'a été modifiée.
- refus : `sslcert` dans l'URL refusé ; CA absent refusé ; `SET ROLE` vers le pilote refusé pour le rôle `postgres`.

Non réalisé (bloqué) :
- **connexion pooleur** (6543 transaction, 5432 session) : le pooleur répond après un TLS vérifié mais renvoie « tenant/user not found » pour le login de test : ce rôle n'est pas enregistré dans la configuration du pooleur du projet. Il faut l'enregistrer côté plateforme.
- **connexion directe** : `db.fvhiammdskpcnfodsnrc.supabase.co` n'a qu'une adresse IPv6, et ce poste n'a aucune route IPv6 (`ENETUNREACH`).
- donc **session_user réelle via le pooleur** et **émission nominale par le login** : non démontrées.

Nettoyage : login de test supprimé, liaison désactivée (ligne conservée, suppression interdite par conception), brouillons fictifs supprimés. Restent sur staging : les deux entreprises fictives, la liaison désactivée, le schéma `nordla_runtime`, le rôle `nordla_fin_issuer_pilot` (sans login), la table d'instantané et la migration. Retour arrière : `supabase/rollback/20261120110000_fin_issuer_narrow_role.down.sql`.
