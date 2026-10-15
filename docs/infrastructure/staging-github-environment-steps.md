# Supabase STAGING — créer l'environnement GitHub protégé et lancer le workflow `staging-db-ops` (pas à pas)

Projet staging : `fvhiammdskpcnfodsnrc`. Migrations à appliquer : 2 à 5 (`identity_rate_limits`, `identity_members`,
`identity_modules_sessions`, `identity_module_sourcing`). La migration 1 (`identity_sessions_events`) est déjà appliquée et **n'est
pas dans la demande** ; de plus, le script saute toute migration dont le nom figure déjà dans `supabase_migrations.schema_migrations`.

Ce que le workflow garantit (corrections `5dc4064` + `b0207c9`, essai local refait) :
- garde : URL contenant `fvhiammdskpcnfodsnrc`, refus de la référence de production, marchand marqueur staging présent ;
- empreinte SHA-256 de chaque fichier SQL vérifiée avant exécution ;
- sauvegarde chiffrée (`pg_dump`, AES-256) puis **restauration prouvée** dans un PostgreSQL 17 jetable, sans erreur masquée,
  avec comparaison des données **et** de la structure (tables, colonnes, contraintes, index, fonctions, déclencheurs, politiques,
  droits). Tout écart → arrêt avant la moindre migration ;
- **couverture déclarée** (`coverage.txt`) : `public` et `supabase_migrations` restaurés et vérifiés ; `auth` et `storage` présents
  dans la sauvegarde mais leur restauration n'est **pas** prouvée ; **les fichiers Storage ne sont pas dans la sauvegarde** ;
- une transaction par migration (fichier + ligne d'historique ensemble) ;
- contrôles finaux : RLS, aucun droit `anon`/`authenticated`, aucune fonction `SECURITY DEFINER` exposée, essai fonctionnel annulé,
  données préexistantes inchangées.

## État vérifié le 15/10 (fin d'après-midi)

- L'environnement `supabase-staging` **existe déjà** : GitHub l'a créé automatiquement lors des deux passages `run: false`
  (runs 38736831014 et 38743908758), **sans protection** : ces passages n'ont attendu aucune approbation.
- Aucun secret n'y est encore (vous n'avez rien configuré) : une exécution `run: true` s'arrêterait au contrôle de l'URL.
- Corrigé dans le dépôt : une tâche « gate » **sans environnement** lit la demande ; la tâche protégée ne démarre que pour
  `run: true` **depuis `claude/nordla-core-p0`** et refuse tout autre projet que staging (vérifié localement sur 4 cas).

## Étapes (vous, dans GitHub — aucun secret dans le chat)

1. **Ouvrir l'environnement existant** : GitHub → dépôt `retail-ai-core` → *Settings* → *Environments* → `supabase-staging`.
2. Dans cet environnement :
   - *Required reviewers* : cochez et ajoutez-vous (chaque exécution attendra votre clic « Approve ») ;
   - *Deployment branches and tags* : *Selected branches* → `claude/nordla-core-p0` uniquement.
3. *Environment secrets* → *Add secret* (valeurs collées directement dans GitHub) :
   - `STAGING_DATABASE_URL` : Supabase → projet **nordla-finance-staging** → *Connect* → *Session pooler* → URI (avec le mot de
     passe de la base staging). Vérifiez que l'URI contient `fvhiammdskpcnfodsnrc`.
   - `STAGING_BACKUP_PASSPHRASE` : une phrase de passe d'au moins 16 caractères. **Gardez-la** dans votre gestionnaire de mots de
     passe : sans elle, la sauvegarde chiffrée est illisible.
   - `STAGING_OWNER_EMAIL` : l'adresse e-mail de **votre** compte (étape 3 bis). Elle n'est jamais écrite dans le dépôt.
3 bis. **Votre compte** (staging uniquement) : Supabase → projet **nordla-finance-staging** → *Authentication* → *Users* →
   *Add user* → *Create new user* : votre e-mail, un mot de passe choisi par vous, cochez *Auto Confirm User*. Personne d'autre ne
   crée ce compte ni ne connaît ce mot de passe.
4. Me dire « environnement prêt ». Je modifie alors **une seule ligne** de `ops/staging-db/request.json` (`"run": true`) et je pousse.
   Le push déclenche le workflow, qui **attend votre approbation** (GitHub → *Actions* → *staging-db-ops* → *Review deployments*).
5. Vous approuvez → exécution (≈ 5 min). Je lis le résultat et l'artefact (sauvegarde chiffrée, empreintes, écarts, journal,
   historique) et je vous rends compte ; en cas d'arrêt, rien n'a été migré et je présente la cause.
6. Je remets `"run": false` immédiatement après.

Ensuite (2ᵉ exécution, après votre accord distinct) : `"bootstrap": true` dans `ops/staging-db/request.json` →
`ops/staging-db/bootstrap-habb-test.sql`, en une transaction : marchand **HABB (test staging)** avec son propre identifiant
`67646dbb-5e2e-4cd7-aad6-0ab289b068cb` (jamais celui de la production), votre adhésion OWNER (par la fonction d'identité, qui
journalise), module `sourcing` ACTIVE, bucket privé `nordla-backups` sans aucune politique d'accès. Refusé si votre compte n'existe pas
ou n'est pas confirmé ; relançable sans effet. Prouvé sur un vrai PostgreSQL 17 (image Supabase) :
`test/postgres/staging-bootstrap.pg-smoke.mjs`, 15/15 (refus sans compte, refus d'un compte non confirmé, idempotence, isolation).

## Retour arrière

- Avant migration : rien n'a changé.
- Après une migration : chaque migration est dans sa propre transaction ; la sauvegarde chiffrée de l'exécution permet de restaurer
  `public` et `supabase_migrations` (preuve faite dans le même job). `auth` / `storage` : non prouvés, à ne pas restaurer depuis
  cette sauvegarde sans test préalable.
