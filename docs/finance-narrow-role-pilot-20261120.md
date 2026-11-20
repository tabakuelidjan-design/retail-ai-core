# Pilote local : chemin facturation étroit sur rôle limité (Finance)

Statut : **local uniquement**. Rien n'est appliqué à staging, Supabase distant ou Railway. Rien n'est poussé, fusionné ni déployé.

## Base et état du dépôt

- Base : `release/finance-staging` @ `361c06f5` (contient déjà les migrations de durcissement `20261120083356` et `20261120085527`).
- Branche pilote : `pilot/finance-narrow-role-20261120`, worktree isolé `C:\Users\etaba\Desktop\nordla-finance-pilote-20261120` (nom exact : `nordla-finance-pilot-20261120`).
- Autres worktrees non touchés (ex. `nordla-finance-mfa-wt`, dont le SHA a changé entre-temps : ce n'est pas le nôtre).
- Compteur de numérotation staging (lecture seule, avant tout nouvel essai) : la numérotation est une **ligne** de `fin_number_sequences` (upsert), pas une séquence PostgreSQL. Un rollback annule donc bien l'avance. Vérifié : 0 ligne de compteur, 0 facture et 0 marchand fictifs subsistent après le test de staging précédent. Aucun compteur n'a été modifié.

## Chemin retenu (étroit)

Émission d'une facture approuvée : `store.getDocument(id)` puis `store.issueDocument(...)`, qui appelle `fin_issue_document`.

Lectures et écritures descendant en base :

| Étape | Accès réel en base | Rôle pilote |
|---|---|---|
| `getDocument` | `select * from fin_documents where id and merchant_id` | SELECT fin_documents + policy |
| `fin_issue_document` (SECURITY INVOKER) | `SELECT ... FOR UPDATE` fin_documents ; `UPDATE` fin_documents ; `INSERT` fin_events ; appel `fin_next_number` ; `extensions.digest` ; `to_jsonb` | UPDATE fin_documents, INSERT fin_events, EXECUTE 3 fonctions |
| `fin_next_number` | `INSERT ... ON CONFLICT DO UPDATE` fin_number_sequences | SELECT/INSERT/UPDATE fin_number_sequences |
| Triggers | `fin_documents_guard` (pas de lecture externe), `fin_credit_ceiling_guard` (retourne tôt pour une facture), `fin_append_only` sur fin_events | rien de plus |

## Fichiers modifiés (branche pilote, commit local, non poussé)

- `supabase/migrations/20261120110000_fin_issuer_narrow_role.sql` (nouveau) : rôle `nordla_fin_issuer_pilot` NOLOGIN NOINHERIT NOBYPASSRLS ; fonction de contexte `nordla_fin_pilot_merchant()` (`app.merchant_id`, NULL si absent) ; RLS activé sur fin_documents, fin_number_sequences, fin_events ; grants minimaux ; trois policies scellées au rôle.
- `supabase/rollback/20261120110000_fin_issuer_narrow_role.down.sql` (nouveau) : retire policies, grants, fonction ; rôle supprimé en dernier (voir limite ci-dessous).
- `src/finance/runtime/narrow-issue-path.js` (nouveau) : adaptateur à pool injecté ; chaque transaction fait `set_config('app.merchant_id')` puis `set local role nordla_fin_issuer_pilot` ; aucune lecture d'environnement ; aucun repli.
- `src/finance/supabase-store.js` (modifié, minimal) : `createSupabaseFinanceStore(supabase, { merchantId, narrowIssuePath = null })`. Si `narrowIssuePath` est fourni, `getDocument` et `issueDocument` l'utilisent exclusivement. Sans lui, le comportement est strictement inchangé.
- `test/pg/98-narrow-issue-path.pg.test.js` (nouveau) : 7 tests.
- `docs/finance-narrow-role-pilot-20261120.md` (ce fichier).

## Résultats des tests locaux (PostgreSQL 17, base jetable, deux marchands synthétiques)

Suite `test/pg/98-narrow-issue-path.pg.test.js` : **7/7 verts**.

| Cas | Résultat |
|---|---|
| Nominal : lecture de son brouillon, émission de deux factures | ISSUED, numéros FACT-2026-0001 et 0002 sans trou ni doublon |
| Sans contexte (`app.merchant_id` absent) | 0 ligne lue, `nordla_fin_pilot_merchant()` = NULL, INSERT sur fin_number_sequences refusé (42501) |
| Croisement : B lit ou émet un document de A | `getDocument` → null ; `issueDocument` → `FIN_NOT_FOUND` ; brouillon de A inchangé |
| Croisement : contexte A écrit une séquence de B / met à jour un document de B | INSERT refusé (42501) ; UPDATE → 0 ligne |
| Opérations interdites (DELETE fin_documents, INSERT fin_documents, UPDATE fin_events, SELECT fin_bank_transactions, fin_record_payment, CREATE TABLE, GRANT) | refusées ; aucun privilège gagné ensuite (vérifié) |
| Attributs du rôle | `rolbypassrls=false`, `rolsuper=false`, `rolcreaterole=false`, `rolinherit=false` |
| Connexion en échec | `NARROW_CONNECTION_FAILED` levée ; le client service n'est jamais appelé |
| Store avec chemin étroit | lecture + émission passent par le chemin étroit ; 0 appel au client service |
| Rollback | retire policies, grants, fonction ; privilèges de `service_role` inchangés |

Suites non-régression :
- `test/pg/96-security-search-path` et `test/pg/97-service-role-billing` : 7 tests verts (dans le worktree pilote).
- `test/tenant-isolation.test.js` : vert.
- `finance-bank-csv-atomic`, `finance-contacts-roles`, `finance-pack`, `finance-purchase-document` : **non exécutés proprement** ; échec à l'import (`pdfkit` absent du worktree neuf). Ce n'est pas causé par le pilote. Il faudra un `npm ci` dans un environnement autorisé, pour lancer ces tests.

## Appels Finance non couverts par le pilote

Le pilote ne couvre que `getDocument` et `issueDocument`. Tout le reste reste sur `service_role` :
- les autres méthodes du store (environ 160 appels Supabase par branche, dont paiements `fin_record_payment`, `fin_allocate_payment`, rapprochement `fin_bank_*`, `fin_void_payment`, `fin_reverse_allocations`, `fin_peppol_*`, `fin_seller_profile_record`) ;
- les lectures de `readiness` (société, profil vendeur, lignes) ;
- `resettle` (avoirs), `hooks.afterIssue` (stock), `hooks.onIssued` (archives légales) ;
- `peekNextNumber` (lecture du compteur dans l'app) et `saveDocument` ;
- la route `app.js` et les autres serveurs qui appellent `createSupabaseFinanceStore` (sourcing, procurement host, CLI) : non modifiés, donc toujours `service_role`.

Conséquence : une approbation complète (`decide APPROVE`) passe encore en partie sur `service_role` avant l'émission. Le pilote prouve la partie émission, pas le flux complet.

## Risques de déploiement (pour plus tard, pas maintenant)

1. **Dépendance `pg`** : le produit n'en dépend pas. Le pool doit être construit par l'entrypoint (variable d'environnement à créer), pas dans le module. Non ajouté ici pour éviter un téléchargement.
2. **Connexion** : un login `NOLOGIN` ne se connecte pas ; il faut un login membre du rôle, avec mot de passe généré hors chat et stocké hors dépôt. Non créé.
3. **Mode pooler** : `set local role` et `set_config(..., true)` sont par transaction ; compatible avec un pooler en mode transaction, mais pas en mode session partagé sans reset.
4. **Rôle cluster-wide** : `drop role` échoue tant qu'une autre base (modèle ou autre) garde des privilèges. Le rollback retire les objets ; la suppression du rôle doit suivre sur toutes les bases.
5. **Pas de repli** : si la connexion ou une requête échoue, l'approbation échoue. C'est voulu, mais le service doit afficher l'erreur et ne pas réessayer en `service_role`.
6. **Compteur** : un rollback annule l'avance (table). Mais une émission réussie puis annulée par l'appelant ne doit jamais être répétée à la main.
7. **RLS et `service_role`** : `service_role` garde BYPASSRLS ; le pilote n'enlève rien à ce rôle. Il faut donc retirer les appels `service_role` du chemin une fois couvert, sinon la protection est contournable.
8. **Migration** : l'appliquer à staging seulement après revue. Elle ne modifie pas les grants existants de `service_role`, mais elle crée un rôle cluster-wide.

## Étapes avant une recette staging

1. Revue humaine de la migration `20261120110000` et de l'adaptateur.
2. Exécuter les 4 suites unitaires bloquées après `npm ci` autorisé.
3. Choisir un login de test dédié, à créer dans staging, dont le mot de passe n'apparaît jamais dans le chat ni dans le dépôt.
4. Appliquer la migration à staging (après accord explicite), puis relancer la lecture seule des droits et des conseils Supabase.
5. Recette avec un marchand fictif : émission nominale, refus sans contexte, refus croisé, puis rollback vérifié.
6. Décider du périmètre suivant (paiements, rapprochement) avant toute généralisation.
