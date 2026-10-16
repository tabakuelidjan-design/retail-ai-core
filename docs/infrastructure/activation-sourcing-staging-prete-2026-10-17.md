# Activation de `sourcing-staging` — dossier prêt, lecture seule (2026-10-17, après la fusion)

Fusion exécutée sur autorisation du propriétaire. **Rien n'est déployé** ; aucune migration ; aucun secret ajouté ; ni `main` (reste `a9d0e2f`) ni la production touchés.

## 1. La fusion
| Contrôle avant fusion | Résultat |
|---|---|
| Tête de `integration/staging-candidate-final` | `99919d6` (local = distant) |
| Commits postérieurs à `ca345f8` | 1 seul : `99919d6`, **documentation uniquement** (2 fichiers `docs/infrastructure/*.md`) |
| `claude/nordla-core-p0` avait-elle avancé ? | non : toujours `5a57d0b`, ancêtre de la candidate → **aucun travail d'un autre chantier n'est écrasé** |
| Périmètre exact (`5a57d0b..99919d6`) | 39 fichiers : `src/procurement/**`, tests/docs/outils Stock/Achats, workflow `procurement-stock-v1`, **1 ligne** dans `src/sourcing/server/app.js`, 3 lignes dans `.gitattributes`. Rien sous `src/core-pilot`, `src/integration`, `src/identity`, `src/security`, `src/finance`, `deploy/`, `package*.json` |
| Fusion | commit de fusion `--no-ff` **`0f83fd2b28f7114ba2919557fc9d32d031104cc4`**, arbre identique à la candidate, poussé sans `--force` sur `claude/nordla-core-p0` |

## 2. Vérifications sur le SHA exact `0f83fd2` (aucun résultat d'un autre SHA repris)
| Workflow GitHub Actions | Run | Résultat |
|---|---|---|
| `core-reliability` | 38978561162 | **success** — Windows Node 24 ✔, Linux Node 24 + suite complète ✔ |
| `china-sourcing` | 38978561269 | **success** — unit ✔, e2e fieldv1 / recovery / fieldmode / terrain v2 / reconnect (bloquants) ✔, pwa / asr (informatifs) ✔ |
| `nordla-integration-pre-china` | 38978561235 | **success** — suite complète Node 20 ✔ et Node 24 ✔ (inclut Stock/Achats, Parle à Nordla, bail du verrou, écrans montés) |
| `Activation & Channel Execution V1` | 38978561224 | success |
| `Provider Provisioning & Live Connections V1` | 38978561248 | success |

Local (Windows, Node 24, sur `0f83fd2`) :
- Stock/Achats + Parle à Nordla (`procurement-*`, `convergence-journey`, `core-procurement-routing`, `integration-procurement`, `core-field-assistant`, `core-pilot`) : **205 tests, 187 réussis, 0 échec, 18 ignorés** (PostgreSQL / Node 24 seul).
- `verify-candidate.mjs` : 8 PASS, 1 FAIL : le test navigateur `core-pilot.e2e` (0/5 : première page non prête en 20 s). **Ce n'est pas une régression de la fusion** : mesuré sur 6 exécutions chacun (journaux, pas codes de sortie, qui sont peu fiables ici), la base `5a57d0b` réussit 5/6 et `0f83fd2` réussit 4/6 ; l'échec est toujours le délai de première page sous charge de cette machine (même famille que celle corrigée par la PR #16 pour deux autres tests ; un correctif de test seulement, 20 s → 60 s, est proposé, non fait). Ce test n'est pas dans la CI ; les e2e `china-sourcing` Linux sont verts.
**Aucune CI n'a échoué : la progression vers Railway n'est pas arrêtée.**

## 3. Configuration (lecture seule)
- `deploy/sourcing/railway.json` : constructeur `DOCKERFILE` (`deploy/sourcing/Dockerfile`), démarrage `/app/docker-entrypoint.sh node src/service-start.js`, healthcheck `/healthz` 120 s, 1 réplique, redémarrage `ON_FAILURE` ×3, pas de mise en veille. **Inchangé** depuis `5a57d0b` ainsi que Dockerfile, script d'entrée, `package.json`, `package-lock.json` (aucune dépendance ajoutée, pas de `pg`) : l'image que j'ai construite et éprouvée en conteneur est celle de ce commit.
- Variables : chaque variable que le code exige en mode hébergé figure dans `ops/railway-staging/staged-corrections.json` (aucune manquante, aucune superflue) ; ce fichier est mis à jour sur la branche `integration/staging-activation-prep` : commit épinglé **→ `0f83fd2…`**, deux réglages ajoutés (voir §5), variables à laisser absentes complétées (`PROCUREMENT_USERS`, `PROCUREMENT_PG_URL`, `SOURCING_CASES_DIR`).
- Prouvé en conteneur avec ces mêmes variables (secrets factices) : démarrage 2–3 s, `Stock / Achats ON`, `uid 1000`, `/healthz` 200, aucun secret dans les journaux, arrêt propre / plantage / second conteneur traités (bail).

## 4. Railway, état réel (CLI, lecture seule)
- Projet `app.nordla.app` (`261a1971-15da-432b-9bdd-0cde6a1e8815`). Environnement `production` : `Analytics`, `Core`, `Finance` en ligne, `nordla` en veille — **non touchés**. Environnement `staging` : `finance-staging`, `core-staging`, `analytics-staging`, `shopify-stub-staging` (déployés par envoi direct, sans lien Git, base synthétique) — **aucun `sourcing-staging`** : la CLI répond `ServiceInstance not found`. Le service n'existe donc qu'en **brouillon** (« staged-create ») dans l'interface, ce que les documents de la session Railway décrivent (29 changements, volume 1 Go, commit épinglé `c2c314d`).
- Le volume et les 29 lignes ne sont **pas lisibles** depuis ma CLI (ni l'API de lecture que j'ai) : ce que je donne vient de l'audit de la session Railway. Pour une lecture réelle : export du tableau des changements par la session Railway, ou `railway setup agent`.

## 5. Les 29 changements en attente, état après la fusion (aucun appliqué)
| Classe | Contenu | Action |
|---|---|---|
| Nécessaires | service ; dépôt ; Dockerfile ; commande ; `/healthz` ; 1 réplique ; pas de veille ; région ; volume 1 Go sur `/app/data` ; variables du fichier | garder |
| **Obsolète** | commit épinglé `c2c314d` | **remplacer par `0f83fd2b28f7114ba2919557fc9d32d031104cc4`** |
| **À ajouter** | (1) « Config as code » = `/deploy/sourcing/railway.json` ; (2) déploiement automatique désactivé ou épinglé (la branche `claude/nordla-core-p0` reçoit des poussées de plusieurs chantiers) | **le lot passera de 29 à ≈ 31 lignes** : chaque ligne doit rester dans le service `sourcing-staging` |
| Risqués | « Deploy » applique tout le lot ; sans (1) le `railway.json` racine passe devant (service en root) ; sans (2) redéploiements non voulus | traités par les deux lignes ci-dessus |
| Bloquants | secrets (5) saisis par le propriétaire ; `SOURCING_PUBLIC_ORIGIN` après génération du domaine (second déploiement) ; secrets GitHub `supabase-staging` ; DNS | autorisations / saisies |
| Interdits (à retirer s'ils apparaissent) | autre service, variable partagée, suppression, domaine, environnement `production`, valeur `xbtzjabbseclmqfozjeo` ou `36b1a1a7-…` | arrêt |

## 6. Séquence d'activation (à exécuter seulement sur autorisation explicite ; R = session Railway, P = propriétaire)
1. **R** : exporter le tableau des changements ; vérifier ≈ 31 lignes toutes dans `sourcing-staging` ; appliquer le fichier `staged-corrections.json` (épingle `0f83fd2`, Config as code, auto-déploiement off) **sans** Deploy.
2. **P** : saisir les 5 secrets (clés Supabase staging, deux clés de 32 octets différentes, phrase de sauvegarde).
3. **R** : Deploy ; relever l'adresse générée ; **P/R** : poser `SOURCING_PUBLIC_ORIGIN`, redéployer.
4. Contrôles : journal `Supabase project check (fvhiammdskpcnfodsnrc): VERIFIED`, `Core ON`, `Stock / Achats ON`, **`uid 1000`** (`uid 0` = NO-GO), `/healthz` 200, `/api/core/modules` 401 sans session, `/healthz/backup` `PENDING_FIRST_RUN` puis `Backup OK` à +10 min ; redémarrage du service : Achats revient (≤ 70 s après un plantage, immédiat après un arrêt propre).
5. Graine TEST (séparée, journalisée), puis scénario du 18 (`docs/integration/xiaomi/`). Données de test uniquement.
Arrêt à tout contrôle rouge ; rien n'est supprimé.

## 7. Rollback
Service à 0 instance ou redéploiement de `ab02b77` ; volume, base staging, production intacts ; `procurement/` additif ; la fusion elle-même se défait par un `git revert` du commit `0f83fd2` (non fait, non nécessaire) ; la branche `integration/staging-candidate-final` reste intacte.

## 8. GO / NO-GO
- **Fusion et tests : GO.** `0f83fd2` : 5 workflows verts sur le SHA exact (dont `core-reliability`, `china-sourcing`, `nordla-integration-pre-china`) ; Stock/Achats et Parle à Nordla verts en local (205 tests, 0 échec).
- **Activation de `sourcing-staging` : NO-GO tant que** : (a) vous autorisez le tri/application du lot corrigé (épingle `0f83fd2`, Config as code, auto-déploiement) ; (b) vous saisissez les secrets ; (c) vous autorisez le Deploy. Aucun de ces points n'est de mon ressort.
- Réserves : test navigateur `core-pilot` instable en local (identique avant fusion) ; le lot réel n'a pas pu être relu ligne à ligne ; 8 migrations du dépôt non appliquées sur Supabase staging (sans effet sur Sourcing / Core / Achats) ; PR #17 (Chantier E) non intégrée.
