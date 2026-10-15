# Coordination Core P0 ↔ Infrastructure

Base commune : `claude/nordla-core-p0`. Infrastructure part de cette branche ; Core P0 intègre le travail Infrastructure par **merge commit**
(jamais de rebase ni de réécriture de la branche de l'autre). Une ligne par changement de fichier partagé ou par transfert de propriété :
qui, quoi, sur quel commit. Ajouter en bas, ne pas réécrire les lignes passées.

## Propriété des fichiers (décision propriétaire 2026-10-14)

| Core P0 | Infrastructure | Partagés (à coordonner ici) |
|---|---|---|
| `src/**` (sauf un module d'authentification dédié créé par Infrastructure, ex. `src/platform/auth/**`), `test/**`, `docs/integration/**`, `docs/architecture/**`, le lockfile pour les dépendances fonctionnelles | `supabase/**`, configuration de déploiement (Railway, Docker, nixpacks/railpack, `.nvmrc`, `engines`), `docs/infrastructure/**`, scripts de sauvegarde | `package.json`, service worker China Sourcing (`src/sourcing/ui/sw.js`), `.github/workflows/**` |

## Journal

| Date | Session | Fichier(s) | Commit | Note |
|---|---|---|---|---|
| 2026-10-14 | Core P0 | `package.json` `engines >=24`, `.nvmrc`, `Dockerfile` racine | `1d55245` | Fait avant réception de la décision 4. |
| 2026-10-15 | Core P0 | `Dockerfile` → `deploy/sourcing/Dockerfile` | `2edfbf9`, `18a316b` | Un Dockerfile à la racine aurait remplacé le build Railpack de Finance / Analytics. |
| 2026-10-15 | Core P0 | `engines` remis à `>=20`, `.nvmrc` retiré | `54af219` | Décision 4. **Proposition à Infrastructure** : `engines >=24` + `.nvmrc` `24`, après vérification de Finance, Analytics, Growth sur Railway. Preuves côté code : suite complète Node 24 3847 tests / 0 échec ; CI Marketing, Activation, Provider, intégration verte sous Node 24. |
| 2026-10-15 | Core P0 | `package.json` : script `sourcing:e2e:migration` | `28fcfe2` | Script de test uniquement. |
| 2026-10-15 | Core P0 → Infrastructure | **Transfert de propriété** : `supabase/migrations-pending/**` (persistance intégration + `sourcing_cases`, policies RLS, `search_path` `fin_*`), `test/postgres/core-p0-pending.pg-smoke.mjs`, `tools/sourcing-backup.mjs`, `deploy/sourcing/**` | `0b7dbd2`, `77e06b6` | Préparés par Core P0 avant la décision 2 ; validés localement (33/33 et tests de sauvegarde). Infrastructure les reprend, les modifie ou les remplace ; Core P0 ne les modifie plus. Les **contrats** de persistance (formes, `merchant_id`) restent ceux de `src/integration/*` et de `src/sourcing/store/*`. |
| 2026-10-15 | Core P0 | `.github/workflows/{marketing-v1,activation-channel-execution-v1,provider-provisioning-live-connections-v1,creative-intelligence-v1,nordla-core-resilience,nordla-integration-pre-china,china-sourcing}.yml` | `24cb0f6`, `7681aa2`, `577ba8c`..`83278fb`, `28fcfe2` | Suite complète sous Node 24 ; reprise des 3 correctifs de `integration/nordla-pre-china` ; E2E de migration ajouté. |
| 2026-10-15 | Core P0 | `src/sourcing/ui/storage.js` (pas le SW) | `77e06b6` | Ajout de `navigator.storage.persist()` uniquement ; aucune migration, aucun effacement. Le service worker n'est pas modifié. |

## Attendu d'Infrastructure (pour Core P0)
1. Authentification réelle devant China Sourcing sur Railway (aucun Caddy devant le service : la couche doit être dans l'application ou un
   module dédié ; modèle existant `src/analytics-premium/server/hosting.js`).
2. Entrée `sourcing` dans `src/service-start.js` : fichier Core P0, à faire par Core P0 **quand** Infrastructure confirme la forme du service.
3. Stockage durable des photos côté serveur : Core P0 écrit le contrat d'envoi (route, taille, `merchant_id`) dès que le stockage est choisi.
4. Adresse stable `app.nordla.app` avant le départ : l'origine ne doit plus changer ensuite (chaque changement d'origine = stockage vide).
