# Stock / Achats — préparation de la migration staging (NON EXÉCUTÉE)

**Statut : préparée, jamais appliquée.** Rien ici ne doit être lancé sur un environnement partagé sans validation explicite du propriétaire. La migration n'a été exécutée que sur des bases PostgreSQL jetables locales.

## Ce qui est prêt
- `supabase/migrations-pending/20261016090000_procurement_stock.sql` : 17 tables `proc_*`, additive, ne touche aucune table existante. Dépend uniquement de `merchants` (schéma phase 1).
- `supabase/rollback/20261016090000_procurement_stock.down.sql` : retire uniquement les objets `proc_*` (destructif pour les données du module).
- `src/procurement/pg-store.js` : adaptateur ; reçoit un pool compatible `pg` **injecté** (le dépôt n'ajoute aucune dépendance de pilote).
- Preuves : `node test/postgres/procurement.pg-smoke.mjs` (garanties du schéma, course à 2 sessions) et `node test/postgres/procurement-parity.mjs` (les mêmes suites que la mémoire, plus pannes réseau et concurrence).

## Décisions préalables (à valider)
1. **Dépendance `pg`** : l'adaptateur s'utilise avec la chaîne de connexion directe Postgres de Supabase (pas l'API PostgREST, qui ne sait pas faire de transaction multi-lignes). Cela demande d'ajouter `pg` aux dépendances du dépôt.
2. **Quel staging** : un projet Supabase **dédié et jetable** ou une branche Supabase, jamais la production ni un staging partagé avec d'autres chantiers.
3. **Migration `20260926160000` (Finance, « NOT APPLIED »)** : son état réel n'a pas été vérifié ; ce module n'en dépend pas, mais le staging doit être dans un état connu.

## Procédure proposée (à exécuter seulement après validation)
```text
1. Vérifier l'environnement cible (nom du projet, URL) : ce n'est PAS la production.
2. Sauvegarde : export du schéma et des données existantes.
3. Appliquer UNIQUEMENT 20261016090000_procurement_stock.sql dans une transaction.
4. Vérifier : tables proc_* présentes, RLS activé partout, aucune politique créée.
5. Lancer le test de parité contre une COPIE du schéma (jamais les données réelles).
6. Brancher : PROCUREMENT_PG_URL=<chaîne directe> (secret hors Git) ; démarrer le serveur ; parcours de visite complet.
7. Rollback si besoin : 20261016090000_procurement_stock.down.sql (après export).
```
Vérifications SQL après application :
```sql
select count(*) from information_schema.tables where table_name like 'proc\_%';              -- 17
select count(*) from pg_tables where tablename like 'proc\_%' and not rowsecurity;            -- 0
select count(*) from pg_policies where tablename like 'proc\_%';                              -- 0 (accès service uniquement)
```

## Risques
- Le serveur mobile utilise un fichier local tant que `PROCUREMENT_PG_URL` n'est pas défini : **aucune migration de données fichier → PostgreSQL n'est écrite**. Si des données de terrain existent dans le fichier avant la bascule, il faudra un export/import dédié (à construire et tester avant le voyage si la base doit être la source de vérité).
- Le rôle de connexion directe contourne RLS : il ne doit jamais être exposé côté navigateur.
