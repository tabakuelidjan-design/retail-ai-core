# Sauvegarde et restauration — staging Finance (2026-11-20)

Périmètre : projet Supabase `fvhiammdskpcnfodsnrc` (base + bucket de stockage `finance-inbox`), service Railway `finance-staging`. Données fictives et marchand de test uniquement. Aucune donnée réelle, aucun abonnement modifié, aucune action en production.

## État vérifié

- Pas encore de sauvegarde ni de restauration exécutée.
- Base : l'accès à la base de staging depuis ce poste n'est pas disponible (aucun identifiant administrateur sur ce PC, par règle). Un export doit donc être lancé par le propriétaire ou par un canal autorisé.
- Stockage : l'accès au bucket demande la clé de service, présente seulement sur Railway. Même règle.

## Procédure (à exécuter dans un environnement isolé)

1. **Base** — exporter le schéma et les données du projet staging en format custom :
   `pg_dump --format=custom --no-owner --no-privileges -f finance-staging.dump "<URL_admin_staging>"`
   L'URL admin ne doit jamais être écrite dans ce dépôt ni dans le chat.
2. **Destination isolée** — restaurer dans le cluster de test local (port 54345, nom de cluster `nordla_finance_test`), base jetable `finance_test_restore_<date>`.
   `pg_restore --no-owner --no-privileges -d "<URL_locale_jetable>" finance-staging.dump`
   Les rôles Supabase absents localement sont créés par le harnais (`test/pg/lib/db.js`).
3. **Vérifications après restauration** :
   - comptes (`select count(*) from fin_documents`) identiques à la source ;
   - `fin_pilot_reader_audit()`, `fin_pilot_transfer_audit()`, `fin_pilot_archive_audit()` : aucune ligne en échec ;
   - chaque `fin_artifacts.sha256` correspond au fichier restauré (voir étape 4).
4. **Fichiers** — lister le bucket `finance-inbox` (clé de service, côté Railway seulement), copier les objets dans un dossier isolé, recalculer les SHA-256 et les comparer à `fin_artifacts.sha256`.
5. **Preuve** : consigner la date, la taille du dump, le nombre de lignes par table, le nombre d'objets et les hachages en échec (zéro attendu). Ne pas publier l'URL, ni la clé, ni le dump.
6. **Nettoyage** : supprimer la base jetable et le dossier de fichiers restaurés (fichiers un par un).

## Ce qui reste hors de portée de ce poste

- Export de la base de staging (identifiant administrateur requis).
- Lecture du bucket de stockage (clé de service requise).
- Test de restauration de bout en bout sur une base isolée distincte du cluster local : à faire avec l'un des deux accès ci-dessus.

## Point de restauration existant (à confirmer par le propriétaire)

Les sauvegardes automatiques de la plateforme Supabase dépendent du plan du projet. Le plan actuel n'a pas été vérifié depuis ce poste, et aucune modification d'abonnement n'est autorisée.

## Exercice réalisé (2026-11-20) — preuves

**Limites d'accès constatées (vérifiées, pas supposées)**
- Le conteneur staging n'a ni `pg_dump`, ni `psql`, ni `pg_restore`.
- Aucune variable de connexion administrateur à la base n'est présente. La seule URL PostgreSQL est celle du login pilote restreint (`nordla_fin_pilot_staging`) : elle ne peut lire que les lignes de son marchand, par les rôles limités. Ce n'est pas une sauvegarde complète.
- L'API REST avec la clé de service (dans le conteneur uniquement) permet de lire les tables finance et le stockage. Elle ne donne ni le schéma, ni les rôles, ni les droits : ceux-ci viennent des migrations du dépôt.
- L'accès SSH au conteneur a été ouvert par une clé temporaire, enregistrée puis retirée après usage (vérifié : aucune clé enregistrée à la fin).

**Sauvegarde** : export par l'API REST du marchand de test (`67646dbb-…`) : `fin_companies` 1, `fin_documents` 8, `fin_artifacts` 8, `fin_events` 42, `fin_seller_profile_versions` 1, `fin_number_sequences` 2 ; 8 objets de stockage, chacun dont le SHA-256 correspond à la base. Le dossier de sauvegarde reste hors du dépôt.

**Restauration** (base locale jetable, cluster de test, jamais staging) :
1. Schéma, rôles, appartenances, droits et politiques : rejoués depuis les migrations du dépôt (v1 à v7).
2. Lignes : rechargées depuis l'export ; nombre et contenu identiques (documents, numéros, statuts, hachages d'artefacts).
3. Fichiers : écrits dans un dossier isolé ; 8/8 vérifiés contre le hachage stocké et la base.
4. Audits pilote sur la base restaurée : lecture 0, émission 0, archive 0 écart.
5. Refus vérifiés : le rôle d'archive ne lit pas `fin_documents` (permission refusée) ; le rôle de lecture ne peut pas insérer (permission refusée) ; sans liaison de login, le rôle d'archive n'accède à aucun artefact (refus `FIN_PILOT_PRINCIPAL_UNKNOWN_OR_DISABLED`, pas une liste vide).

**Non couvert** : sauvegarde PostgreSQL complète (schéma, séquences système, extensions) et restauration sur une instance Supabase dédiée — impossible sans accès administrateur ou sans les sauvegardes de la plateforme. Procédure à compléter par le propriétaire si ce niveau est exigé.
