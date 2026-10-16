# Stock / Achats — PostgreSQL staging : préparation complète (NON EXÉCUTÉE)

**Statut : préparé et répété sur des bases jetables ; jamais appliqué sur un environnement partagé ni en production.** Rien ci-dessous ne doit être lancé sans l'autorisation écrite du propriétaire.

## 1. Ce qui est prêt
| Élément | Fichier | Preuve |
|---|---|---|
| Schéma (17 tables `proc_*`, additif, ne touche aucune table existante ; dépend seulement de `merchants`) | `supabase/migrations-pending/20261016090000_procurement_stock.sql` | `procurement.pg-smoke.mjs` (50 contrôles), parité 12 suites |
| Permissions explicites : droits retirés à PUBLIC/anon/authenticated, 1 politique RESTRICTIVE « deny » par table et par rôle, `search_path` fixe sur les fonctions, `UPDATE/DELETE/TRUNCATE` retirés au `service_role` sur le registre et le journal | `…/20261016091000_procurement_permissions.sql` | `procurement-staging-tool.pg-smoke.mjs` (voir §4) |
| Retour arrière (permissions d'abord, puis schéma) | `supabase/rollback/*.down.sql` | rejoué sur base jetable, puis ré-application |
| Runner à garde-fous (plan / verify / apply / rollback) | `tools/procurement-staging/run.mjs` | répété sur base jetable |
| Import fichier → PostgreSQL (tout ou rien, refuse une cible non vide, vérifie l'équivalence) | `src/procurement/import-file-to-pg.js` | `test/procurement-import.test.js` sur PostgreSQL réel |
| Adaptateur | `src/procurement/pg-store.js` | parité mémoire / fichier / PostgreSQL |
Les migrations sont dans `supabase/migrations-pending/` (convention du chantier A) : `supabase db push` et le banc CI **ne les prennent pas**.

## 2. Décisions préalables (à valider)
1. **Dépendance `pg`** : l'adaptateur s'utilise avec la chaîne de connexion directe Postgres de Supabase (l'API PostgREST ne sait pas faire de transaction multi-lignes). Cela demande d'ajouter `pg` aux dépendances du dépôt (non fait).
2. **Quel staging** : un projet Supabase **dédié et jetable** (ou une branche Supabase), jamais la production ni un staging partagé avec un autre chantier. **Recouvrement avec le chantier A** (`integration_purchase_plans`, `integration_incoming_expectations`) : voir `stock-achats-v1-ac-arbitrage.md` — à arbitrer avant d'appliquer l'un ou l'autre.
3. La migration Finance `20260926160000` (« NOT APPLIED ») : état réel non vérifié ; ce module n'en dépend pas.

## 3. Procédure (à exécuter seulement après autorisation)
```text
Variables (jamais committées) :
  PROCUREMENT_STAGING_URL, PROCUREMENT_OWNER_AUTHORIZATION="<phrase du propriétaire>", PROCUREMENT_PRODUCTION_HOSTS="<hôtes de production>"
1. node tools/procurement-staging/run.mjs plan                      # aucun contact base
2. Sauvegarde du projet cible (dashboard Supabase ou pg_dump) ; noter la commande de restauration.
3. node tools/procurement-staging/run.mjs apply --database <nom> --authorized-by "<nom>"
      refuse si : pas d'autorisation, pas de nom, nom de base mal saisi, hôte déclaré production, nom ne ressemblant pas à staging,
                  tables proc_ déjà présentes, table merchants absente. Chaque fichier = UNE transaction.
4. node tools/procurement-staging/run.mjs verify                    # 17 tables, RLS partout, 34 politiques deny, 0 permissive,
                                                                    # search_path fixe, 4 triggers append-only
5. Parcours de visite complet contre ce staging (PROCUREMENT_PG_URL + paquet `pg`), PUIS import des données de terrain si nécessaire :
      importFileState({ state, target, merchantId, dryRun: true })  -> relire les comptes -> dryRun: false -> compareStores() doit rendre []
```

## 4. Permissions : ce qui est prouvé (base jetable avec rôles Supabase simulés)
`anon` et `authenticated` : lecture, écriture du registre et appel de `proc_next_number` **refusés** ; un `GRANT` fait par erreur à `anon` ne rend toujours **aucune ligne** (politique restrictive) ; `service_role` lit et écrit, le trigger de solde fonctionne, mais ne peut ni `UPDATE` le registre ni `DELETE` le journal (second verrou après les triggers). Non prouvé : le comportement avec le vrai Supabase (rôles, `auth.uid()`, extensions) — à constater sur le staging dédié.

## 5. Plan de retour arrière
| Situation | Action | Perte |
|---|---|---|
| `apply` échoue | rien à faire : chaque fichier est une transaction ; le runner l'indique | aucune |
| Après `apply`, avant toute donnée | `run.mjs rollback … --data-exported` | aucune (tables vides) |
| Données présentes | **exporter d'abord** (`pg_dump --data-only -t 'proc_*'` + copie du fichier `procurement.json`), puis `rollback … --data-exported --accept-data-loss` | les données du module (sauvegardées) |
| Retour au fonctionnement fichier | retirer `PROCUREMENT_PG_URL` : le serveur repart sur `procurement.json` (inchangé par l'import) | aucune |
Le fichier source n'est **jamais modifié** par l'import : il reste la copie de secours jusqu'à décision contraire.

## 6. Risques résiduels
- Un seul écrivain à la fois pendant la bascule : arrêter le serveur de terrain avant l'import, puis importer, vérifier, puis démarrer avec `PROCUREMENT_PG_URL`. Les compteurs de version de ligne repartent à 1 (sans effet hors édition concurrente).
- Le rôle de connexion directe contourne RLS : ne jamais l'exposer côté navigateur.
- Hors périmètre : sauvegardes automatiques et supervision du staging (à définir avec le propriétaire du projet Supabase).
