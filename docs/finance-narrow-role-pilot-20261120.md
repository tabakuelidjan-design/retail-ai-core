# Pilote Finance : approbation et archivage d'une facture sur rôles PostgreSQL limités

## 1. État actuel (2026-11-20, unique et à jour)

- **Branche pilote** : `pilot/finance-narrow-role-20261120`, commit `d76bda7d` (audit complet + rôle d'archive). Base : `361c06f5`.
- **Intégration** : `release/finance-staging` avance à `d76bda7d` (fast-forward ; la release n'avait aucun commit absent du pilote). Poussée sur `origin`.
- **Déploiement Railway (staging)** : projet `261a1971-…`, environnement `staging`, service `finance-staging` (`b9494727-…`). Déploiement `a67673e4-d72e-489f-b6c8-f82ddbfd9e87` : commit `d76bda7d`, statut SUCCESS. URL `https://finance-staging-staging.up.railway.app` répond HTTP 200.
- **Mode limité : activé sur staging** (déploiement `1bf7a0c8`, commit `08bedfbe`, SUCCESS). Variables Railway : `FINANCE_RUNTIME_DB=narrow-pilot`, `FINANCE_PILOT_CA_FILE=config/certs/supabase-root-2021-ca.pem`, `FINANCE_PILOT_DATABASE_URL` (valeur jamais affichée). Journal de démarrage : session `nordla_fin_pilot_staging`, marchand lié vérifié, TLS vérifié, tenant « HABB (test staging) ».
- **Login pilote** : `nordla_fin_pilot_staging`, créé le 2026-11-20 ; rôles `nordla_fin_issuer_pilot`, `nordla_fin_reader_pilot`, `nordla_fin_archive_pilot` uniquement ; NOBYPASSRLS, sans superutilisateur ; lié à `67646dbb-5e2e-4cd7-aad6-0ab289b068cb` (« HABB (test staging) »). Mot de passe : aléatoire, généré localement, injecté dans Railway sans affichage ; seul son vérificateur SCRAM a été transmis à la base. Fichiers temporaires supprimés.
- **Marchand configuré** : `NORDLA_MERCHANT_ID = 67646dbb-5e2e-4cd7-aad6-0ab289b068cb`, nom « HABB (test staging) », source `nordla-staging` / `habb-test`, créé le 2026-10-15. Vérifié comme marchand de test ; non modifié.
- **Périmètre couvert par les rôles limités (si le mode est activé)** : lecture de la facture, liaison, ledger, émission (`service.decide(APPROVE)`), et l'archivage en base (artefacts, versions du vendeur, événements). Les octets PDF/XML restent dans le stockage existant.
- **Hors lot** : stock, avoirs (`resettle`), paiements, rapprochement, Peppol, réglages, sociétés, banque.
- **Aucun repli vers `service_role`** : toute erreur d'identité, de TLS, de configuration ou de connexion arrête le démarrage ou refuse l'opération.

## 2. Preuves LOCALES (PostgreSQL 17 jetable, deux marchands synthétiques, vrais logins)

Exécution en série (`node --test --test-concurrency=1`), commit `d76bda7d` :

| Suite | Tests | Résultat |
|---|---|---|
| `test/pg/98` parcours fonctionnel, rollback jusqu'à v7 | 8 | vert |
| `test/pg/99` identités | 4 | vert |
| `test/pg/100` audit exact du rôle d'émission | 6 | vert |
| `test/pg/101` connexion (TLS, paramètres SSL refusés) | 6 | vert |
| `test/pg/102` matrice EXECUTE × `extensions` | 1 | vert |
| `test/pg/103` PUBLIC SELECT sur `extensions` | 1 | vert |
| `test/pg/104` démarrage `createRuntime` en mode limité | 4 | vert |
| `test/pg/105` `service.decide(APPROVE)` : nominal, étranger, sans liaison, panne | 4 | vert |
| `test/pg/106` audit du rôle de lecture | 2 | vert |
| `test/pg/107` détection de chaque droit excessif (audits lecture et émission) | 11 | vert |
| `test/pg/108` archive : isolation, refus, doublon, reprise après panne, intégrité à la lecture | 6 | vert |
| `test/finance-narrow-config.test.js` configuration de démarrage | 4 | vert |

Total : **57 tests locaux verts**. Les suites `finance-pack` en échec signalées auparavant ne concernent pas le pilote.

Limites des tests 108 : l'isolation et les refus sont vérifiés au niveau de l'adaptateur et de la base avec de vrais logins. La reprise après panne est testée au niveau de l'écriture en base ; le scénario « octets écrits dans le stockage, puis panne avant l'insertion » n'est pas rejoué de bout en bout, faute d'un faux stockage complet dans `createLegalArtifacts`.

## 3. Preuves STAGING

### 3.1 Base de données (projet `fvhiammdskpcnfodsnrc`)

- Migrations appliquées : v4 `fin_issuer_narrow_role` et v5 `fin_reader_narrow_role` (antérieures), **v6 `fin_pilot_audit_hardening`** et **v7 `fin_archive_narrow_role`** (appliquées le 2026-11-20 depuis `d76bda7d`).
- Contrôle après application : `fin_pilot_reader_audit()`, `fin_pilot_transfer_audit()` et `fin_pilot_archive_audit()` ne renvoient aucune ligne en échec.
- Données : aucune donnée réelle, aucune donnée du marchand de test modifiée par les migrations (DDL uniquement).

### 3.2 Serveur (Railway)

- Déploiement SUCCESS (voir §1). Le code déployé est celui de `d76bda7d`.
- Mode limité non activé : **le serveur ne passe pas encore par les rôles limités sur staging**.

### 3.3 Staging exécuté avec les rôles limités (historique, lot précédent)

Mêmes entreprises fictives A et B, login de test lié à A, client de substitution (clé de service absente du PC) :

- Approbation nominale d'une facture fictive A → `ISSUED`, `INV-2026-0003`.
- Aucun appel au client de substitution pendant l'approbation.
- Facture fictive de B approuvée par le runtime de A → `DOCUMENT_NOT_FOUND`.
- Démarrage avec le marchand B alors que le login est lié à A → refus.
- Panne de connexion → approbation refusée, rien émis.

Ces preuves valent pour les migrations v4/v5 seulement ; elles ne couvrent ni l'archive ni le serveur complet.

### 3.4 Ce qui n'est PAS prouvé

- Le serveur complet avec ses vrais hooks (archive légale, stock) sur staging : **non fait**, le mode limité n'est pas activé.
- Recette Core : **non faite**.
- Refus entre entreprises sur le serveur déployé, reprise après panne sur le serveur déployé : **non faits**.
- Sauvegarde/restauration base et fichiers : **non faite**.

## 4. Migrations

- v4 `20261120110000_fin_issuer_narrow_role.sql` (commit `f9c7c48e`), rollback `…down.sql`.
- v5 `20261120120000_fin_reader_narrow_role.sql` (commit `57580f27`), rollback `…down.sql`.
- v6 `20261120130000_fin_pilot_audit_hardening.sql` (commit `d76bda7d`), rollback `…down.sql` (restaure le corps d'audit v5).
- v7 `20261120140000_fin_archive_narrow_role.sql` (commit `d76bda7d`), rollback `…down.sql` (retire les politiques, les droits et le rôle ; ne supprime aucune ligne).

## 5. Comptes privilégiés et accès administratifs

### 5.1 Comptes privilégiés de la base staging (lecture seule, vérifiée)

| Rôle | Privilèges | Remarque |
|---|---|---|
| `postgres` | BYPASSRLS, CREATEROLE, CREATEDB, LOGIN ; **membre des trois rôles pilote** | propriétaire plateforme, exemption explicite des audits |
| `supabase_admin` | SUPERUSER, BYPASSRLS | plateforme Supabase, non utilisé par le projet |
| `service_role` | BYPASSRLS, sans LOGIN | clé de service du serveur Railway |
| `supabase_etl_admin` | BYPASSRLS, lecture de toutes les données | rôle plateforme ; à vérifier : utilisé ou non |
| `supabase_read_only_user` | BYPASSRLS, lecture de toutes les données | rôle plateforme ; à vérifier : utilisé ou non |
| `anon`, `authenticated` | aucun | |
| rôles pilote | NOLOGIN, NOBYPASSRLS | aucun privilège d'attribut |

### 5.2 Accès administratifs encore utilisés par le serveur (`service_role`)

| Moment | Accès | Statut |
|---|---|---|
| Démarrage | résolution du marchand (`merchants`), connecteurs | `service_role` |
| Stockage des PDF / XML (archive) | API Storage (bucket `finance-inbox`), clé de service | `service_role`, **non changé** (décision : stockage existant conservé) |
| Après émission | hooks stock (`afterIssue`), avoirs (`resettle`, `restockDecisionNeeded`) | `service_role` |
| Échec de hook | journal | `service_role` |

Risque concret pour ce périmètre : tant que la clé de service est chargée par le serveur, un défaut de code dans un chemin `service_role` peut lire ou écrire tous les marchands. Le mode limité réduit la base de données, pas le stockage.

## 6. Plateforme : six fonctions de `extensions`

`returns event_trigger`, `SECURITY INVOKER`, `search_path=""`, propriété `supabase_admin`. Elles ne peuvent pas être appelées directement (`0A000`). Exceptions explicites de l'audit.

## 7. Obstacles avant activation du mode limité sur staging

1. **Login PostgreSQL pilote** : à créer par le propriétaire (voir §8). Le mot de passe doit être généré et stocké hors chat et hors dépôt.
2. **Variables Railway** à définir : `FINANCE_RUNTIME_DB=narrow-pilot`, `FINANCE_PILOT_DATABASE_URL` (pooleur, login `<login>.fvhiammdskpcnfodsnrc`), `FINANCE_PILOT_CA_FILE` (chemin d'un PEM présent dans le conteneur ; le CA est public mais le code exige un fichier).
3. **Principal lié** : `nordla_runtime.fin_pilot_principals` doit lier le login au marchand de test `67646dbb-…`.
4. Sauvegarde/restauration base et fichiers : non faite.

## 8. Actions humaines nécessaires

1. Créer, dans l'éditeur SQL Supabase de `fvhiammdskpcnfodsnrc`, le login pilote avec un mot de passe généré par vous, grant des rôles `nordla_fin_issuer_pilot`, `nordla_fin_reader_pilot`, `nordla_fin_archive_pilot`, puis la ligne dans `nordla_runtime.fin_pilot_principals` pour `67646dbb-5e2e-4cd7-aad6-0ab289b068cb`.
2. Fournir l'URL de connexion pilote à Railway sans la coller dans le chat (`railway variable set … --stdin`).
3. Vérifier la double authentification du propriétaire sur votre appareil (non testable ici).
4. Confirmer si `supabase_etl_admin` et `supabase_read_only_user` sont utilisés ; sinon, les désactiver côté plateforme.

## 9. Prochaine portion

Une fois le login créé : activer le mode limité sur le service staging, rejouer le parcours complet depuis Core, tester refus entre entreprises et reprise après panne sur le serveur déployé, puis sauvegarde/restauration.

## 10. Recette sur le serveur staging déployé (2026-11-20, marchand de test, document fictif)

Parcours joué depuis Core (session propriétaire déjà ouverte dans Chrome ; aucun identifiant saisi, aucun jeton saisi) :

1. Plus → Serveur et jeton d'accès → Ouvrir Nordla → Finance → Ouvrir le tableau de bord Finance : OK (tableau de bord du marchand « HABB (test staging) »).
2. Création d'une facture fictive : client « Client fictif recette 20261120 », adresse fictive, TVA fictive `BE1000000120` (somme de contrôle valide), 1 × 100,00 € HTVA, TVA 21 %, base « Nouvelle vente B2B ». Brouillon enregistré.
3. Soumission puis émission (confirmée dans la fenêtre « Émettre le document ») : statut `ISSUED`, numéro `INV-2026-0002`, `lockedAt` et `snapshotHash` posés.
4. Archive écrite par le serveur pendant l'émission (lecture de la base staging, en lecture seule) :
   - `PDF_ORIGINAL` : 7 017 octets, SHA-256 `8303a9d5d96a211a2d6d4940ade18e09d8e6d913fbf7cb9063245e5b529c449e`, chemin préfixé par le marchand ;
   - `STRUCTURED_ORIGINAL` (UBL) : 3 832 octets, SHA-256 `3213a7fc8e2a3492e97d0c4ec71b7ae5e300c66f5a8712c72dbfd93d5eaf66e7`, chemin préfixé par le marchand ;
   - deux événements `ARTIFACT_ARCHIVED` pour ce document.

**Non prouvé ici, à dire clairement :**
- Téléchargement du PDF et vérification octet par octet : le navigateur bloque la lecture directe de l'URL de téléchargement depuis la page ; je ne peux donc pas comparer le fichier reçu au SHA-256 archivé.
- Preuve que l'écriture passe par le login pilote : les journaux PostgreSQL accessibles ne contiennent pas d'entrée pour `nordla_fin_*` sur la fenêtre. Le démarrage en mode limité est confirmé ; le chemin d'écriture de l'archive est câblé sur ce mode dans `runtime.js`.
- Refus entre entreprises sur le serveur déployé : le serveur ne sert qu'un marchand (`NORDLA_MERCHANT_ID`) ; ce cas est couvert par la suite 108 au niveau base de données, pas sur le serveur.
- Reprise après panne sans réémission sur le serveur déployé : non testée (il faudrait provoquer une panne côté base sur un service partagé) ; couverte par la suite 108.
- Sauvegarde et restauration : non faites (voir le runbook).

Le brouillon de test `0b0aeb60-3083-4a50-9ec5-43141bbbea1a` (client fictif incomplet, non émis) reste dans le marchand de test ; il est à annuler par le propriétaire si vous le souhaitez.
