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
