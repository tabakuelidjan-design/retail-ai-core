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

## Étapes (vous, dans GitHub — aucun secret dans le chat)

1. **Créer l'environnement d'abord.** GitHub → dépôt `retail-ai-core` → *Settings* → *Environments* → *New environment* → nom exact
   `supabase-staging`. (À faire **avant** tout passage à `run: true` : sinon GitHub le créerait automatiquement, sans protection.)
2. Dans cet environnement :
   - *Required reviewers* : cochez et ajoutez-vous (chaque exécution attendra votre clic « Approve ») ;
   - *Deployment branches and tags* : *Selected branches* → `claude/nordla-core-p0` uniquement.
3. *Environment secrets* → *Add secret* (valeurs collées directement dans GitHub) :
   - `STAGING_DATABASE_URL` : Supabase → projet **nordla-finance-staging** → *Connect* → *Session pooler* → URI (avec le mot de
     passe de la base staging). Vérifiez que l'URI contient `fvhiammdskpcnfodsnrc`.
   - `STAGING_BACKUP_PASSPHRASE` : une phrase de passe d'au moins 16 caractères. **Gardez-la** dans votre gestionnaire de mots de
     passe : sans elle, la sauvegarde chiffrée est illisible.
4. Me dire « environnement prêt ». Je modifie alors **une seule ligne** de `ops/staging-db/request.json` (`"run": true`) et je pousse.
   Le push déclenche le workflow, qui **attend votre approbation** (GitHub → *Actions* → *staging-db-ops* → *Review deployments*).
5. Vous approuvez → exécution (≈ 5 min). Je lis le résultat et l'artefact (sauvegarde chiffrée, empreintes, écarts, journal,
   historique) et je vous rends compte ; en cas d'arrêt, rien n'a été migré et je présente la cause.
6. Je remets `"run": false` immédiatement après.

Ensuite seulement (dépend des tables des migrations 2–5), dans les limites de votre autorisation initiale : le marchand HABB de test
et le bucket privé `nordla-backups` sur staging.

## Retour arrière

- Avant migration : rien n'a changé.
- Après une migration : chaque migration est dans sa propre transaction ; la sauvegarde chiffrée de l'exécution permet de restaurer
  `public` et `supabase_migrations` (preuve faite dans le même job). `auth` / `storage` : non prouvés, à ne pas restaurer depuis
  cette sauvegarde sans test préalable.
