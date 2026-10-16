# `sourcing-staging` — plan de PREMIER déploiement du candidat `2c8871d` (préparé, **rien n'est déclenché**)

Constat Railway transmis par le propriétaire (16/10, contrôle direct, **non revérifié par cette session** : aucun outil Railway) : `sourcing-staging` n'existe que comme **création préparée** (`staged-create`) dans l'environnement staging ; **aucun déploiement actif, aucune adresse publique, aucun volume opérationnel** ; commit épinglé = `ab02b77`. Le service **n'a jamais été en ligne** : il n'y a donc pas de « version précédente » à restaurer (voir §6).

## 1. CI obligatoire du candidat — terminée
`2c8871d` : `china-sourcing`, `nordla-integration-pre-china` (workflow_dispatch sur `candidate/p0-convergence`, plus push sur la convergence) et `core-reliability` (Linux + Windows) — **tous success, sans relance** (lu le 2026-10-16).

## 2. Fusion contrôlée convergence → P0 (préparée, **non exécutée** : autorisation A1)
| Élément | Valeur |
|---|---|
| Source | `candidate/p0-convergence` = `integration/nordla-convergence-v1` = `2c8871d` |
| Cible | `claude/nordla-core-p0` = `6b48b38` |
| Nature | `6b48b38` est ancêtre de `2c8871d` : **avance rapide**, aucun commit de fusion, aucun conflit possible (`git merge-tree` : arbre sans conflit) |
| Effet | la branche que suit `sourcing-staging` passe à `2c8871d` ; l'épinglage Railway, lui, **ne bouge pas** tout seul |
| Commande (le jour de A1) | `git push origin 2c8871d:claude/nordla-core-p0` (sans `--force` : refusé si P0 a avancé entre-temps → alors réévaluer) |
| Vérif. avant | `git merge-base --is-ancestor origin/claude/nordla-core-p0 2c8871d` ; P0 toujours `6b48b38` ; CI verte lue (§1) |
| Retour arrière | `git push --force-with-lease origin 6b48b38:claude/nordla-core-p0` **sur accord explicite** (aucun service Railway ne l'a encore déployé) |
La fusion n'a **aucun effet** sur Railway tant que le commit épinglé n'est pas changé et que « Deploy » n'est pas cliqué.

## 3. Écart entre la configuration Railway préparée et les besoins du candidat
| Sujet | Préparé (`ab02b77`) | Candidat (`2c8871d`) | Écart / action |
|---|---|---|---|
| **Commit épinglé** | `ab02b77` | `2c8871d` | **UN changement** : épingle → `2c8871d` (après A1, car la source est `claude/nordla-core-p0`) |
| Image (Dockerfile `deploy/sourcing/`, entrypoint, `railway.json`, `railpack.json`, `package-lock.json`) | — | **identiques** (`git diff ab02b77 2c8871d` vide sur ces fichiers ; `package.json` : +3 scripts) | aucune ; même image, même `npm ci` |
| Le Dockerfile copie `src/` : Stock/Achats (`src/procurement`) et l'assistant (`src/core-pilot`, `src/sourcing/ui`) sont donc **dans l'image** | — | oui | aucune ; aucun import hors `src/` (vérifié) |
| Variables | liste du lot (`railway-changeset-audit.md` §2) | **aucune nouvelle obligatoire** | aucune ; ne **pas** définir `PROCUREMENT_*`, `SOURCING_CASES_DIR`, `SOURCING_PHOTOS_DIR` |
| Volume | `sourcing-staging-data` 1 Go sur `/app/data` | Stock/Achats écrit `/app/data/sourcing/procurement/` (fichier JSON + `uploads/`) | aucune ; **1 Go suffit** pour le test (JSON + quelques pièces) ; surveiller si on charge beaucoup de pièces jointes |
| Migrations / base | — | 2 SQL Achats **non appliqués** (`supabase/migrations-pending/`) | aucune ; ne rien appliquer |
| Healthcheck | `/healthz` | `/healthz` (inchangé, répond avant le contrôle d'hôte) | aucune |
| Lot en attente | 32 lignes A (service + volume) | inchangé | **réaudit** après changement d'épingle : toujours 32 lignes, 0 B, 0 C |
Il n'y a donc **aucun écart de configuration à créer** hormis l'épingle du commit.

## 4. Actions exactes dans Railway (à exécuter seulement après A1 puis A2 ; **R** = exécutant Railway, **P** = propriétaire)
1. **P** autorise A1 (fusion) puis **R**/**I** l'exécute (§2) ; I vérifie que `origin/claude/nordla-core-p0` = `2c8871d`.
2. **R** (lecture) : confirmer dans l'environnement `staging` : service `sourcing-staging` en `staged-create`, source = dépôt `retail-ai-core` branche `claude/nordla-core-p0`, constructeur Dockerfile `deploy/sourcing/Dockerfile`, démarrage `/app/docker-entrypoint.sh node src/service-start.js`, healthcheck `/healthz`, 1 réplique, mise en veille désactivée, volume `sourcing-staging-data` 1 Go → `/app/data`.
3. **R** : changer **uniquement** le commit épinglé `ab02b77` → `2c8871d` (SHA complet : `git rev-parse 2c8871d` à fournir par I).
4. **R** : relire le lot : 32 lignes A + 5 secrets (saisis par **P**, scellés) + `SOURCING_PUBLIC_ORIGIN=https://app.nordla.app` ; **« 0 ligne hors service »** ; aucune variable partagée ; aucune valeur contenant `xbtzjabbseclmqfozjeo` ou `36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5` ; `NORDLA_MERCHANT_ID=67646dbb-5e2e-4cd7-aad6-0ab289b068cb` ; `NORDLA_SUPABASE_PROJECT_REF=fvhiammdskpcnfodsnrc` ; `ANTHROPIC_API_KEY`, `SOURCING_VISION_PROVIDER`, `SOURCING_TOKEN` **absentes**.
5. **P** écrit : « J'autorise le Deploy du lot staging de `sourcing-staging` sur `2c8871d` » (**A2**, avec ce SHA).
6. **R** : *Deploy* (un seul clic ; il applique tout le lot en attente de l'environnement).
7. Après le premier démarrage : *Generate Domain* (port cible **8787**) ou domaine `app.nordla.app` selon le DNS (`domaine-app-nordla-app.md`). Tant que `SOURCING_PUBLIC_ORIGIN` ne correspond pas à l'adresse utilisée → **421** (fermé par défaut, voulu).
8. Données TEST : **seulement** après A3 (`seed-test-data.mjs`), jamais avec le Deploy.

## 5. Vérifications après la mise en ligne (ordre ; arrêt au premier rouge)
| # | Vérification | Comment | Attendu |
|---|---|---|---|
| V1 | Déploiement réel | tableau de bord Railway : statut du déploiement, commit | `ACTIVE`, commit **`2c8871d`**, 1 réplique ; **les autres services : mêmes déploiements qu'avant** (aucun redéploiement) |
| V2 | Démarrage | journaux | `Supabase project check (fvhiammdskpcnfodsnrc): VERIFIED` · `Nordla Core ON for merchant 67646dbb-…` · `uid 1000` · `Stock / Achats ON (/app/data/sourcing/procurement/procurement.json)` · aucun secret |
| V3 | **Volume persistant** | journaux : pas de `JOURNAL_NOT_ON_A_VOLUME` ; Railway : volume `sourcing-staging-data` monté sur `/app/data`, utilisation > 0 après démarrage ; **test de persistance** : redémarrer le service (accord de P), puis revoir `Nordla Core ON` et `Stock / Achats ON` + C12 après A3 | fichiers toujours présents après redémarrage |
| V4 | **Santé HTTP** | `GET /healthz` | `200 {"ok":true}` (répond avant le contrôle d'hôte) |
| V5 | Sauvegarde | `GET /healthz/backup` ; +10 min : journal | `PENDING_FIRST_RUN` puis `Backup OK … copied off-server` ; objet dans `nordla-backups` (métadonnées par Infrastructure) |
| V6 | **Sécurité** | sur l'adresse finale : `GET /api/core/modules` sans session ; requête avec un autre `Host` ; `http://` ; en-têtes | `401` ; `421` ; redirection https ; en-têtes de sécurité (contrôles 1–10 de `railway-handoff-9e25f1d.md`) |
| V7 | Modules | connecté (P) : `/api/core/modules` | `procurement` = `DISPONIBLE` ; Finance/Analytics = `NON RACCORDÉ` |
| V8 | Rien d'autre touché | Railway : historique des déploiements des autres services ; Supabase : aucune migration nouvelle | inchangés |
| V9 | Restauration indépendante | workflow `staging-backup-drill`, `run: true` après accord | rapport sans donnée ni secret |
Puis C1–C12 (`controles-apres-activation.md`, `docs/integration/xiaomi/DOSSIER-DECISION-STAGING.md`). **Le staging n'est pas « opérationnel » avant V2, V3, V4, V5, V6 et V9.**

## 6. Procédure de repli d'un service jamais mis en ligne
Il n'existe **aucun déploiement précédent** vers lequel revenir ; « redéployer `ab02b77` » n'est qu'un autre premier déploiement, pas un retour à un état connu. Repli réel :
1. **Arrêt immédiat** : *Remove* du déploiement actif (ou 0 instance). Le service redevient « créé, non actif ». Aucun autre service n'est touché.
2. **Données** : le volume `sourcing-staging-data` reste (neuf, vide à l'origine) ; **ne pas le supprimer** sans accord ; la base staging n'a pas été modifiée (aucune migration) ; production jamais concernée.
3. **Défaut du candidat seul** : remettre l'épingle sur `ab02b77` et redéployer **uniquement** si P le décide (même image, sans assistant ni Stock/Achats : Parle à Nordla ne sera plus testable).
4. **Défaut de configuration** (variable, secret) : corriger la variable et redéployer ; ne pas modifier le code.
5. **Domaine** : retirer le CNAME/TXT ou le domaine généré ; sans effet sur les autres services.
6. **Données TEST** (si A3 donné) : étiquetées `[TEST]`/`TEST-…` ; suppression de `/app/data/sourcing/procurement/` **sur accord** de P.
7. Branche P0 : revenir à `6b48b38` seulement sur accord explicite (§2).
Règle : au premier rouge, **arrêt et diagnostic sur staging** ; rien n'est supprimé.

## 7. Risques
| Risque | Gravité | Parade |
|---|---|---|
| Aucune version antérieure à restaurer | moyenne | repli = arrêt du service (§6) ; aucune donnée utilisateur réelle n'existe encore sur ce volume |
| Le lot « Deploy » applique tout l'environnement | haute | réaudit ligne par ligne avant A2 (§4.4) ; « 0 ligne hors service » exigé |
| Épingle encore sur `ab02b77` au moment du Deploy → l'assistant et Stock/Achats absents | moyenne | V1 vérifie le commit ; V2 doit montrer `Stock / Achats ON` |
| Adresse ≠ `SOURCING_PUBLIC_ORIGIN` → 421 pour tous | basse (fermé par défaut) | corriger la variable, redéployer ce seul service ; le téléphone n'utilise que l'adresse **finale** |
| Clé/projet Supabase erroné | haute | le service refuse de démarrer (garde de projet, `HOSTED_MERCHANT_NOT_IN_PROJECT`) |
| Volume plein (1 Go) | basse | 503, jamais de fausse décision ; sauvegardes refusées avec `BACKUP_LOW_SPACE` ; agrandir sur accord |
| Coût | basse | 1 service, 1 réplique, alerte d'usage 8 USD (voir `procedure-activation-staging.md`) |
| Intermittences CI connues | info | `docs/integration/ci-intermittences-report.md` ; CI du candidat verte sans relance |
| Données TEST prises pour réelles | moyenne | étiquetage `[TEST]`, A3 séparée, scénario P6–P12 vérifie la mention |

## 8. Ce qui reste interdit sans nouvelle autorisation écrite
Fusion dans P0 (A1) · changement d'épingle et Deploy (A2) · exécution du script de données TEST (A3) · toute modification de `main`, de la production ou d'un autre service.
