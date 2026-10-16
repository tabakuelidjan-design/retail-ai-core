# Dossier de décision — staging pour le test Xiaomi du 18 octobre (2026-10-16 soir)

> **MISE À JOUR 2026-10-16 (A1 exécutée) :** le candidat à épingler et à déployer n'est plus `2c8871d` mais **`5a57d0b485b54161187004c52c5ee450302d7978`** (= `2c8871d` + `deploy/sourcing/railway.json`, PR #18 ; CI verte : core-reliability 38956577756, nordla-integration-pre-china 38956580627, china-sourcing 38956584961). P0 = `5a57d0b` (avance rapide, `main` intact). Lot Railway attendu : **32 lignes** = 31 + le chemin de configuration `/deploy/sourcing/railway.json` (réglage du seul service `sourcing-staging`). Contrôle V2 obligatoire : `uid 1000`. Toute mention de `2c8871d` ci-dessous comme cible de déploiement se lit `5a57d0b`. A2 et A3 : non autorisées.


Court par construction. **Aucun déploiement, aucune injection de données, aucune modification de `main` ou de P0 n'a été faite.** Un test local n'est jamais présenté ici comme une validation staging.

## 1. État des branches (SHA exacts)
| Élément | SHA | État |
|---|---|---|
| Convergence `integration/nordla-convergence-v1` | `2c8871d` | PR #15 (`4fd4c2d`) et PR #16 (`2c8871d`) fusionnées |
| **Candidat** `candidate/p0-convergence` | **`2c8871d`** | = la convergence ; P0 (`6b48b38`) en est un **ancêtre** : l'intégrer dans P0 est une **avance rapide (fast-forward)**, sans conflit possible, et le commit de P0 deviendrait exactement `2c8871d`, le commit dont la CI est examinée ci-dessous |
| Staging prévu à ce jour | `ab02b77` | **ne contient pas** l'assistant de terrain ni Stock/Achats montés |
| Différences candidat ↔ `ab02b77` | voir §2 | |
Vérifiable : `git merge-base --is-ancestor origin/claude/nordla-core-p0 origin/integration/nordla-convergence-v1`.

## 2. Ce que le candidat change (contrôles faits sur les fichiers)
- **Migrations : aucune appliquée par le déploiement.** Deux fichiers SQL de Stock/Achats existent dans `supabase/migrations-pending/` (+ leurs retours arrière dans `supabase/rollback/`) ; **aucune référence** dans `railway.json`, `railpack.json` ou `deploy/` : ils ne s'exécutent pas. Le candidat n'utilise pas PostgreSQL pour Achats (magasin fichier). Dry-run exécuté, sans contact base : `node tools/procurement-staging/run.mjs plan` (ordre d'application/retour arrière listé ; URL et autorisation « NOT SET »).
- **Dépendances : inchangées.** `package.json` : 3 scripts ajoutés (`procurement`, `procurement:phone`, `procurement:parity`), **aucune** dépendance, `package-lock.json` inchangé.
- **CI** : un workflow ajouté (`procurement-stock-v1.yml`, ne se déclenche que sur les branches `feature/stock-achat-**`).
- Zones modifiées par rapport à P0 : `src/procurement` (26 fichiers), `src/core-pilot`, `src/integration`, `src/sourcing` (2), docs, tests.
- **Variables d'environnement** : aucune variable obligatoire nouvelle pour le chemin hébergé (liste complète des variables lues et de celles qui sont nouvelles : sortie de `verify-candidate.mjs`).

## 3. CI du candidat exact `2c8871d` — VERTE (lue le 2026-10-16)
| Workflow | Déclencheur | Résultat |
|---|---|---|
| china-sourcing | workflow_dispatch sur `candidate/p0-convergence` | success |
| nordla-integration-pre-china | workflow_dispatch sur `candidate/p0-convergence` | success |
| core-reliability (Linux + Windows) | workflow_dispatch sur `candidate/p0-convergence` | success |
| nordla-integration-pre-china | push sur `integration/nordla-convergence-v1` | success |
Aucune relance n'a été nécessaire. Intermittences connues : `ci-intermittences-report.md`. La condition « CI lue » de la fiche §8 est **cochée** ; A1 reste à donner par P.

## 4. Railway — lecture seule : vérifié / inaccessible
Aucun outil Railway n'est disponible dans cette session, et mes sondes directes (adresse publique, lecture SQL staging) ont été **refusées** par le système : je ne les ai pas contournées.
| Point | État | Source |
|---|---|---|
| Nom du service | `sourcing-staging` | **documenté** (`procedure-activation-staging.md`) — non vérifié en direct |
| Branche et commit déployés | **inaccessible.** La procédure du 16/10 décrit le service comme **`staged-create`** (« Generate Domain échoue : `ServiceInstance not found` ») : il n'est probablement **pas encore déployé** ; l'activation de `ab02b77` attendait l'autorisation du propriétaire | documentation seule |
| Variables nécessaires | **noms uniquement**, documentés : `SOURCING_HOSTED`, `NORDLA_MERCHANT_ID`, `SOURCING_PUBLIC_ORIGIN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`*, `SUPABASE_ANON_KEY`*, `NORDLA_IDENTITY_RATE_LIMIT_KEY`*, `NORDLA_CSRF_KEY`*, `NORDLA_SUPABASE_PROJECT_REF`, `SOURCING_DATA_DIR`, `SOURCING_BACKUP_PASSPHRASE`* (*scellées, jamais lues) ; présence réelle : **inaccessible** | `procedure-activation-staging.md` |
| Volume persistant | `/app/data` ; le journal Core refuse de démarrer sans volume (`JOURNAL_NOT_ON_A_VOLUME`) ; Stock/Achats : `<SOURCING_DATA_DIR>/procurement/` ; montage réel : **inaccessible** | documentation + code |
| Rollback | redéployer le commit précédent ou 0 instance ; volume/base staging/production intacts ; `procurement/` additif | `controles-apres-activation.md`, `candidat-staging.md` |
| Projet Supabase staging | **vérifié (métadonnées)** : `nordla-finance-staging` `ACTIVE_HEALTHY`, `eu-west-1` ; historique des migrations jusqu'à `identity_module_sourcing` ; **aucune migration d'Achats** | outil Supabase (liste des projets et migrations) |
| Marchand de test, propriétaire, lignes de données | **inaccessible** (lecture SQL refusée) | à lire par R/P avec Q1–Q3 |
| Backend joignable, adresse, DNS | **inaccessible** (sonde refusée) | à contrôler par R ou P |

## 5. Trois autorisations distinctes (aucune n'est donnée)
| | Autorisation | Ce qu'elle permet | Ce qu'elle ne permet pas |
|---|---|---|---|
| **A1** | Fusionner la convergence dans `claude/nordla-core-p0` | avance rapide vers `2c8871d` | déployer ; injecter des données |
| **A2** | **Déployer** `sourcing-staging` sur `2c8871d` | Deploy du lot (rien d'autre dans le lot) | injecter des données ; modifier une variable hors lot |
| **A3** | **Injecter les données TEST** | exécuter `seed-test-data.mjs` sur le volume | déployer ; toucher aux dossiers ou décisions existants |
Chaque autorisation s'écrit séparément, avec le SHA concerné, et se révoque par le retour arrière du §7.

## 6. Contrôles C1–C12 — commandes (exécutants : **R** Railway · **P** propriétaire · **I** cette session)
C1–C7 : inchangés, voir `docs/infrastructure/controles-apres-activation.md` (journaux de démarrage, marchand, journal Core sur volume, sauvegarde hors serveur, restauration, aucun impact ailleurs, aucune fuite). Q1–Q3 : requêtes de lecture du même document — **I ne peut pas les exécuter dans cette session (refus)** ; à lancer par R/P ou après une règle d'autorisation explicite.
| # | Contrôle | Commande / geste | Attendu |
|---|---|---|---|
| C8 | Achats monté | **R** : journaux du démarrage, rechercher `Stock / Achats` | `Stock / Achats ON (…/procurement/procurement.json)` ; **jamais** `OFF` |
| C9 | Module visible | **P**, connecté, console du navigateur : `fetch('/api/core/modules').then(r=>r.json()).then(j=>j.modules.map(m=>[m.key,m.state]))` | ligne `procurement` = `DISPONIBLE`. `finance`, `analytics` = `NON RACCORDÉ` (décision R-004/R-006 : `MERCHANT_TIMEZONE` **retirée** du lot ; journal V2 : `Finance / Analytics for the Core: NOT connected (MERCHANT_TIMEZONE not set…)`). Lot Railway : **31 changements** (13 service + 15 variables + 3 volume) |
| C10 | Graine TEST (après **A3**) | **ATTENTION (contre-audit 16/10) : `docs/` est exclu de l'image (`Dockerfile.dockerignore`) — le script n'existe PAS sur le service.** **R** doit le fournir sans changer l'image (coller le fichier dans le shell du service), l'exécuter **comme utilisateur `node`** (sinon fichiers `root` ; un redémarrage les rend à `node`) : `node seed-test-data.mjs /app/data/sourcing 67646dbb-5e2e-4cd7-aad6-0ab289b068cb /app` (relancer ne crée rien de plus) ; puis **P** : « Mon stock » et « Commandes en attente » | articles `TEST-…`, 1 bon `PENDING_APPROVAL` ; sortie JSON `seeded` identique à la 2ᵉ exécution |
| C11 | Aucune action possible | **P** : « passe la commande de 500 pièces de TEST-MAG-001 » puis, dans Achats, comparer | `Action refusée` ; aucun changement dans Achats |
| C12 | Persistance | **R** : redémarrer le service (**accord de P**) ; **P** : rouvrir, « Mon stock » | mêmes articles et même bon ; **conversation vide** (voulu) ; décision Core du scénario intacte |
Validation **réelle** à faire par P sur le téléphone (rien de tout cela n'est couvert par mes tests) : (a) connexion avec **le vrai compte propriétaire** sur l'adresse finale, sans jeton demandé ; (b) réseau mobile, Wi-Fi coupé, PC éteint ; (c) fermer le navigateur, rouvrir : toujours connecté, dossiers présents ; (d) mode avion puis retour : synchronisation seule ; (e) le stockage : après C12, mêmes données.

## 7. Retour arrière
**R** : redéployer le commit précédent (`ab02b77`) ou mettre le service à 0 instance. Aucune variable à restaurer (aucune n'a été ajoutée). Volume, base staging et production intacts. Données TEST : étiquetées `[TEST]`/`TEST-…`, supprimables **sur accord** en retirant `<SOURCING_DATA_DIR>/procurement/`.

## 8. Fiche GO / NO-GO avant toute opération
| Condition | OK ? |
|---|---|
| CI des trois workflows obligatoires **lue** sur `2c8871d` (§3) | **oui** (vert) |
| A1 écrite par P | non |
| `ab02b77` ou le service actuel identifié par **R** (branche, commit, existence : `staged-create` ou déployé) | non (inaccessible ici) |
| Lot Railway relu par **R** : mêmes 32 lignes + secrets + origine, « 0 ligne hors service » | non |
| A2 écrite par P (SHA `2c8871d`) | non |
| A3 écrite par P (séparée) | non |
| Adresse finale joignable depuis le téléphone (DNS autorisé ou bascule d'adresse) | non |
| P disponible pour C9, la validation réelle (a)–(e) et le Xiaomi | non |
**NO-GO** si l'une de ces lignes reste « non » le matin du 18, ou si un contrôle C1–C12 est rouge.
