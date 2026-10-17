# Essai de fusion — `integration/stock-achats-v1-wave2` → `integration/nordla-convergence-v1` (GO / NO-GO)

Fusion d'essai faite dans des worktrees **jetables, jamais poussés**. La convergence officielle, `main`, Railway et Supabase n'ont pas été touchés. Aucune migration appliquée, aucune variable modifiée, rien déployé.

## 1. HEAD des branches (relevés le 2026-10-17)
| Branche | SHA | Remarque |
|---|---|---|
| `integration/stock-achats-v1-wave2` | `be437363a55bc50770721fc1525fbfb2a7162532` | candidat |
| `integration/nordla-convergence-v1` | `2c8871d9bab5a22bd9afcf1e9c5bf458f8063ec9` | **= base commune** : la convergence n'a reçu aucun commit depuis la base ; le candidat en est un descendant direct |
| Fusion d'essai (`--no-ff`) | `b3774dc4b7ff5b9564723d1ac9e5dd825196ed98` | **arbre identique** à celui du candidat (aucun conflit) ; SHA exact testé ci-dessous |

## 2. Contenu du candidat (diff convergence → fusion d'essai)
- `package.json` / `package-lock.json` : **inchangés** ; `pg` **absent** → aucune dépendance PostgreSQL active (le code ne charge `pg` que si `PROCUREMENT_PG_URL` est défini ; sinon le module passe OFF ; vérifié dans l'image Docker).
- `supabase/migrations/` (voie appliquée) : **0 fichier modifié**. Seuls `supabase/migrations-pending/20261015090000_…sql` (scindée : plus de `integration_purchase_plans` ni de `integration_incoming_expectations`) et son `README.md` changent : **rien n'est appliqué**.
- `deploy/`, `railway.json`, `railpack.json`, `ops/`, Dockerfile : **inchangés** ; aucun secret ni variable Railway dans le diff (recherche faite).
- `src/` hors `src/procurement/` : **2 fichiers** — `src/sourcing/server/app.js` (+1 ligne : service statique `/procurement/`) et `src/sourcing/server/index.js` (libération du magasin à l'arrêt). `src/core-pilot/**` (Parle à Nordla) : **0 fichier modifié**. Test hors Stock / Achats modifié : `test/postgres/core-p0-pending.pg-smoke.mjs` (smoke d'A adapté à la scission : 33 → 28 contrôles).

## 3. Résultats sur la fusion d'essai `b3774dc`
| Contrôle | Résultat |
|---|---|
| Fichiers ciblés (60 : Stock / Achats, Parle à Nordla, intégration, Core, identité, sécurité HTTP, hébergé, sauvegarde) | **537 tests : 517 réussis, 0 échec, 20 ignorés** (PostgreSQL réel / Node 24) |
| 11 outils lus par Parle à Nordla | **inchangés** : `procurement-assistant-contract` 2, `core-procurement-routing` 10, `core-pilot` 8, `core-field-assistant` 31, `-contracts` 9 |
| Permissions, CSRF, session | `procurement-server-v1` (13), `procurement-hosted` (8 + 1 ignoré), `procurement-mounted-ui` (vrai serveur hébergé, identité simulée), `sourcing-hosted-identity` (7), `security-http` (20) |
| Persistance fichier | `procurement-durability`, `procurement-backup-restore` (sauvegarde chiffrée → restauration → positions, journal et demande en attente identiques) ; `procurement-file-lease` côté ligne staging |
| `PROCUREMENT_DISABLED=1` | test dédié dans `procurement-hosted` : module OFF, fichier de données **octet pour octet identique**, rien créé si désactivé dès le départ, retour avec ses données |
| Migrations scindées | PostgreSQL 17 jetable : coexistence **95/95** (deux ordres × complet / scindé, redémarrage, sauvegarde/restauration, smoke d'A 28/28 sur le schéma scindé) ; avec une référence **déjà scindée** (état après fusion) : **55/55** |
| PostgreSQL jetable — parité Stock / Achats | **21 suites, 144 tests, 144 réussis** |

## 4. CI GitHub (pages publiques ; journaux détaillés illisibles sans authentification)
| Commit | Résultat |
|---|---|
| `c8be8b6` | `procurement-stock-v1`, Marketing V1, Provider Provisioning, Activation & Channel Execution, Creative Intelligence V1 : **succès** ; `nordla-integration-pre-china` #122 : **échec** |
| `0d612fe` | `nordla-integration-pre-china` #125 : **succès** |
| `be437363` (candidat exact) | `nordla-integration-pre-china` #126 : **succès** |

**Échec #122** : l'annotation nomme `test/creative-refine.test.js`, test **RF-2**, **Node 24 uniquement**, une seule suite sur toutes. Le même code a réussi aux passages #125 et #126 → **intermittence** (déjà documentée : « 1 unexplained Node 24 RF-2 flake »). Cette fusion ne touche aucun fichier creative. **Une vraie régression, elle, a été distinguée** : sur `5b5692d`, quatre workflows étaient rouges à cause de l'ajout de `pg` (garde `creative-intelligence-preflight.test.js:335` sur la liste des dépendances) ; cause corrigée par le retrait de `pg` (`ed65c58`), vérifiée verte ensuite. Aucun test n'a été désactivé ni contourné.
**Limite** : le SHA de fusion lui-même n'a pas de CI (jamais poussé) ; l'arbre étant identique à `be43736`, ce sont les runs de `be43736` / `c8be8b6` qui font foi. À re-contrôler sur le vrai SHA de fusion.

## 5. Compatibilité avec les travaux parallèles
| Branche | Test | Résultat |
|---|---|---|
| `feature/parle-a-nordla-v2-voice` (`48f635f`, modifie `src/core-pilot/procurement-answers.js` et `field-intents.js`) | fusion d'essai à trois (`565d410`, jetable) + suites Parle, contrat des 11 outils, hébergé, journey | **aucun conflit, tout vert** (core-procurement-routing 10, core-pilot 8, core-field-assistant 31 + 9, contrat 2, mounted-ui 1, journey 1, nordla-ask-ui 10) |
| `feature/core-field-assistant-phase3`, `feature/chantier-d-branding-creative-pole`, `feature/social-publishing-e`, `integration/convergence-staging-candidate`, `fix/sourcing-staging-railway-config` | `git merge-tree` contre le candidat | **aucun conflit** |
| **`integration/staging-candidate-final` (`99919d6`), `integration/staging-activation-prep`, `claude/nordla-core-p0` (`0f83fd2`)** | `git merge-tree` + fusion d'essai | **1 conflit, `src/procurement/server/hosted.js`, un seul bloc.** Ces branches contiennent déjà la livraison du chantier 2 (`8e46bfb`) **et** le correctif de verrou « lease » (`ca345f8`, `file-store.js` + `hosted.js`) ; le candidat y ajoute l'interrupteur `PROCUREMENT_DISABLED` dans la signature de `buildHostedProcurement`. |

**Résolution** (prouvée sur une fusion d'essai jetable, SHA local `463f3a6`) : garder la signature de la ligne staging (`pgPool = null, lease = undefined`, `offSignals`) **et** ajouter le bloc « interrupteur ». Diff résultant : 13 lignes, `docs/integration/wave2-hosted-js-resolution-for-staging-line.patch`. Sur cette fusion : 30 fichiers (Stock / Achats, hébergé, `procurement-file-lease` 7, journey, Parle) — **201 tests, 183 réussis, 0 échec**. **Ordre recommandé** : fusionner d'abord le candidat dans la convergence (sans conflit), puis appliquer la résolution de 13 lignes au rapprochement avec la ligne staging. **Rien n'a été modifié sur ces branches** (propriété d'autres chantiers).

## 6. Retour arrière (sans base ni Railway)
1. **Avant fusion** : rien à faire (fusion d'essai jetable ; la convergence est intacte à `2c8871d`).
2. **Après fusion, avant déploiement** : `git revert -m 1 <commit de fusion>` sur la convergence, puis CI.
3. **Après déploiement** : `PROCUREMENT_DISABLED=1` + redémarrage (module OFF, fichier de données intact, Parle répond « non raccordé ») ; sinon redéployer le commit précédent épinglé ; sinon restaurer la sauvegarde chiffrée dans un dossier vide. Détails : `docs/infrastructure/stock-achats-staging-addendum.md` §6.
4. **Migrations** : aucune appliquée ; si un jour elles le sont, `supabase/rollback/*.down.sql` (permissions d'abord).

## 7. Verdict
**GO pour fusionner `integration/stock-achats-v1-wave2` dans `integration/nordla-convergence-v1`** (fusion directe sans conflit, 0 échec sur le SHA d'essai, aucune dépendance PostgreSQL active, aucune migration appliquée, aucune variable Railway, contrats de Parle à Nordla intacts), **sous trois conditions non techniques** :
1. votre autorisation expresse de fusionner (non donnée dans cette mission : **non faite**) ;
2. un re-contrôle CI sur le SHA de fusion réel, avec relecture de toute nouvelle intermittence RF-2 (déjà connue) ;
3. le rapprochement avec la ligne staging (`staging-candidate-final`, `claude/nordla-core-p0`) se fera avec la résolution de `hosted.js` ci-dessus : sans elle, cette ligne aura un conflit.

**NO-GO inchangé** pour PostgreSQL (`pg` + migrations + autorisation) et pour tout usage terrain sans test sur téléphone réel.
