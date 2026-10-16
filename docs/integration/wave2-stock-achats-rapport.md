# Convergence — vague 2 : intégration Stock / Achats V1 (chantier 3) — rapport

Branche d'intégration **isolée** : `integration/stock-achats-v1-wave2`, créée sur `integration/nordla-convergence-v1` **`2c8871d`** (HEAD vérifié le 2026-10-17, inchangé). **Rien n'est fusionné, déployé, migré ; aucune variable Railway touchée.**

## 1. Vérification de la livraison du chantier 2
| Contrôle | Résultat |
|---|---|
| Commit distant exact | `origin/feature/stock-achats-v1-finalisation` = **`8e46bfb`** (annoncé = réel) ; 16 commits après `2c8871d` |
| Compatibilité avec le HEAD de la convergence | fusion **sans conflit** (`a9f8a19`) ; aucun fichier des chantiers 1 / 3 touché par la livraison (hors patchs fournis à part) |
| CI GitHub de la livraison (lue sur les pages publiques, pas reprise du rapport) | `procurement-stock-v1` **succès** sur `311d8dc` (#7) et `8e46bfb` (#8) ; `Provider Provisioning` et `Activation & Channel Execution` **succès** sur `311d8dc` ; journaux détaillés illisibles sans authentification |
| Tests | rejoués ici (§3) : les chiffres annoncés sont confirmés, pas seulement repris |
| **Erreur trouvée dans la livraison** | le contrat de transmission affirmait que la convergence n'avait pas la migration de permissions `…091000…` : **faux**, elle y est déjà (avec son retour arrière). Aucune action requise ; corrigé ici. |
| **Défaut trouvé dans la livraison** | le patch `pg` (dépendance racine) **fait échouer `test/creative-intelligence-preflight.test.js`** (garde qui fige la liste exacte des dépendances) → `npm test` rouge dans 4 workflows. Constaté en CI (commit `5b5692d`), annulé (`ed65c58`), CI repassée au vert pour ce garde. |

## 2. Les quatre points de raccordement
| # | Point | Décision / état | Commit |
|---|---|---|---|
| 1 | Écrans dans `src/sourcing/server/app.js` | **Repris** : une ligne statique (`/procurement/`) ; données toujours derrière session + CSRF + rôle. Prouvé sur le **vrai serveur hébergé** (identité simulée) : `procurement-mounted-ui` passe (écrans servis, 401 sans session, CSRF exigé, rôles, rejeu idempotent). | `c4e9e11` |
| 2 | Dépendance `pg` | **Différée volontairement** (retour arrière `ed65c58`) : inutile en mode fichier ; l'ajouter exige de mettre à jour le garde de dépendances **dans le même commit** (décision explicite). Sans `pg`, `PROCUREMENT_PG_URL` met le module **OFF** (`PG_DRIVER_MISSING`), jamais de repli silencieux sur le fichier (vérifié dans l'image). | `053dbf1` → `ed65c58` |
| 3 | Scission de la migration d'intégration | **Reprise** : `20261015090000` ne crée plus `integration_purchase_plans` ni `integration_incoming_expectations` (le bon de commande est canonique). **Incompatibilité corrigée (périmètre convergence)** : le smoke d'A (`core-p0-pending.pg-smoke.mjs`) testait ces deux tables → 8 contrôles retirés / remplacés par 2 contrôles « les tables n'existent pas » (33 → 28) ; README mis à jour ; le smoke d'A peut maintenant tourner **sans `psql` hôte** (`PG_SMOKE_DOCKER`). | `3e56689` |
| 4 | Schéma + permissions Stock / Achats | **Déjà présents** dans la convergence (`…090000…` + `…091000…`, retours arrière `supabase/rollback/*.down.sql`), relus et rejoués sur PostgreSQL jetable avec la migration d'intégration scindée, dans les deux ordres. **Non appliqués.** | — |

`src/procurement/server/hosted.js` : **aucun conflit** (fusion automatique propre ; la convergence n'a pas modifié ce fichier depuis la livraison). Ajouts de la vague 2 : interrupteur `PROCUREMENT_DISABLED=1` (repli sans redéploiement, données intactes) et libération du magasin à l'arrêt du serveur (`src/sourcing/server/index.js`).

## 3. Tests (exécutés dans la branche d'intégration)
| Niveau | Résultat |
|---|---|
| Ciblés Stock / Achats, Parle à Nordla, intégration, identité, sécurité HTTP, hébergé, sauvegarde (59 fichiers) | **536 tests : 516 réussis, 0 échec, 20 ignorés** (PostgreSQL réel / Node 24) |
| Contrat des 11 outils lus par Parle à Nordla | réussi (`procurement-assistant-contract`, `core-procurement-routing` 10, `core-pilot` 8, `core-field-assistant` 31, `-contracts` 9, `convergence-journey`) |
| Authentification / permissions / CSRF | `sourcing-hosted-identity` 7, `sourcing-hosted-project-pin` 9, `security-http` 20, `procurement-mounted-ui` 1 (session, CSRF, rôle, rejeu), `procurement-server-v1` 13, `procurement-hosted` 8 + 1 ignoré (PostgreSQL) |
| Persistance du stockage | `procurement-backup-restore` (**nouveau**) : sauvegarde chiffrée du dossier de données → restauration dans un dossier vide → positions, journal, demande en attente identiques, puis le module continue (décision d'une demande, réception rejouée refusée) |
| **PostgreSQL 17 jetable** — parité des suites | **21 suites, 144 tests, 144 réussis, 0 échec** (concurrence, fautes réseau, hébergé sur PostgreSQL) |
| PostgreSQL jetable — coexistence (deux ordres × schéma complet / scindé), redémarrage, sauvegarde/restauration, **smoke d'A sur le schéma scindé** | **95/95** (dont A 28/28 dans les deux ordres) |
| Image Docker (`deploy/sourcing/Dockerfile`) construite depuis la branche, lancée en lecture seule, non-root (uid 1000), sans capacité | module **ON**, données persistées après réouverture, interrupteur OK, `PROCUREMENT_PG_URL` sans pilote → OFF, écrans présents dans l'image (**ce n'est pas un déploiement Railway**) |
| CI GitHub `integration/stock-achats-v1-wave2` | voir §4 |
Non fait : suite complète locale (interrompue : 87/399 fichiers en ~30 min sur ce poste, 0 échec sur ceux-ci ; la CI exécute `npm test` complet) ; staging et Supabase réels ; téléphone réel.

## 4. CI GitHub sur la branche d'intégration (pages publiques)
- `5b5692d` : `Provider`, `Activation`, `nordla-integration-pre-china`, `Creative Intelligence V1` **rouges** → cause **identifiée et annulée** : la dépendance `pg` contre le garde de dépendances (annotation lue : `creative-intelligence-preflight.test.js:335`).
- `c8be8b6` (sans `pg`) : `procurement-stock-v1` **succès** ; `Marketing V1` **succès** ; `nordla-integration-pre-china` **échec** sur **un seul fichier** : `test/creative-refine.test.js`, test **RF-2**, **Node 24 uniquement** (Node 20 : ce fichier passe ; toutes les autres suites Node 24 : exit 0). Aucun fichier creative n'est modifié par cette branche ; RF-2 est un **flake Node 24 déjà documenté** (« 1 unexplained Node 24 RF-2 flake » dans le bilan Creative) et `pre-china` était **vert sur `2c8871d`** (#113). Localement, ce fichier échoue **identiquement** sur `2c8871d` et sur la branche (poste Windows) : pas de différence. **Non prouvé comme flake** (pas de rejeu possible sans accès) : à confirmer par un second passage du même commit (déclenché par le commit de ce rapport).
- `Creative Intelligence V1`, `Provider`, `Activation` sur `c8be8b6` : voir le dernier relevé dans le message de livraison.

## 5. Railway staging (préparé, rien d'appliqué)
`docs/infrastructure/stock-achats-staging-addendum.md` : variables (aucune obligatoire ; `PROCUREMENT_GRANTS`, `PROCUREMENT_DISABLED`), Dockerfile / volume / sauvegarde / Supabase (inchangés), vérifications après déploiement, **retour arrière à 4 niveaux** (interrupteur → commit précédent épinglé → sauvegarde chiffrée → scripts SQL), et pourquoi **PostgreSQL n'est pas au programme du 18/10**.

## 6. Opérations qui restent soumises à autorisation
Fusion de `integration/stock-achats-v1-wave2` dans la convergence · déploiement du service Railway (commit à épingler) · saisie de `PROCUREMENT_GRANTS` / `PROCUREMENT_DISABLED` · toute migration (Stock / Achats ou d'intégration) · `pg` + `PROCUREMENT_PG_URL` · raccordement Shopify.

## 7. Verdict pour le staging
Voir le message de livraison : **GO technique conditionnel** pour un staging en **mode fichier** (sans PostgreSQL, sans Shopify), **NO-GO** pour PostgreSQL et pour tout usage terrain tant qu'un test sur téléphone réel n'a pas eu lieu.
