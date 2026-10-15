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
| 2026-10-15 | Core P0 | `src/sourcing/store/photo-store.js`, routes `/api/cases/<id>/photos` | `20ee43d` | Point 3 ci-dessous : copie durable des photos **dans le répertoire de données du service** (`<SOURCING_DATA_DIR>/photos`, même volume que les dossiers), jamais d'écrasement ni de suppression par l'API, hash SHA-256 vérifié. Import jusqu'à 64 Mo. |
| 2026-10-15 | Core P0 → Infrastructure | `supabase/migrations-pending/20261015093000_identity_module_sourcing.sql` | `6d721c4` | **Fichier dans une zone Infrastructure, à reprendre par Infrastructure.** Ajoute le module `sourcing` aux contrôles d'identité (`module_entitlements`, `identity_module_set`, `identity_open_session`). Vérifié sur PostgreSQL 16 local isolé uniquement. Prérequis : les migrations d'identité elles-mêmes (absentes de la production au 2026-10-15). |
| 2026-10-15 | Core P0 | `src/sourcing/server/{hosted,session-gate}.js`, `src/identity/{modules,access,service}.js` | `6d721c4` | Point 1 : connexion Core (Supabase Auth + membre ACTIF du marchand + module `sourcing` ACTIF), cookies `__Host-`, CSRF, origine exacte, en-têtes Railway. Aucun jeton de développement accepté en mode hébergé (`SOURCING_HOSTED=1`). |
| 2026-10-15 | Core P0 | `src/service-start.js` (`NORDLA_SERVICE=sourcing`) | `3df304c` | Point 2. Le service exige Node 24 (garde au démarrage) : **Infrastructure** choisit Node 24 pour ce service Railway. |
| 2026-10-15 | Core P0 | `src/core-pilot/**`, `src/buying/sourcing-purchase.js`, `config/merchants/habb/core-decision.json`, `package.json` (script `core:e2e`), `.github/workflows/{china-sourcing,nordla-integration-pre-china}.yml` | voir journal git | Nordla Core actif dans le service `sourcing` : `/api/core/*` derrière la même session. Journal de décisions `<SOURCING_DATA_DIR>/core/decision-journal.jsonl` (append-only, chaîné SHA-256) : **à inclure dans les sauvegardes** du volume, comme `cases/` et `photos/`. |
| 2026-10-15 | Infrastructure (même session, à la demande du propriétaire) | `docs/infrastructure/sourcing-railway-go-live.md`, `supabase/rollback/2026-10-sourcing-identity.rollback.sql`, `supabase/provisioning/habb-owner-sourcing.sql`, `tools/sourcing-backup.mjs` (copie hors serveur), `src/sourcing/server/index.js` (sauvegarde quotidienne, `PORT` Railway), `test/sourcing-backup-full-restore.test.js`, `test/remaining-tenant-decoupling.test.js` | voir journal git | Runbook de mise en ligne ; séquence de 5 migrations d'identité testée en base isolée avec retour arrière prouvé ; aucune action sur Railway, Supabase réel ou DNS. |
| 2026-10-15 | Infrastructure (code) ↔ session Railway (ChatGPT) | `deploy/sourcing/Dockerfile`, `deploy/sourcing/docker-entrypoint.sh`, `src/sourcing/server/{app,index}.js`, `supabase/provisioning/staging-habb-merchant.sql`, `test/postgres/sourcing-identity-sequence.pg-smoke.mjs` | voir journal git | Service Railway `sourcing-staging` préparé par la session Railway (non déployé). Côté code : volume root → entrypoint qui passe à `node` ; `/healthz` pour la sonde Railway ; HSTS ; sauvegardes bornées au volume de 1 Go. **Le service doit pointer sur ce commit, pas `e84918e`**, avec la commande de démarrage `/app/docker-entrypoint.sh node src/service-start.js`. |
| 2026-10-15 | Infrastructure ↔ propriétaire | `.github/workflows/staging-db-ops.yml`, `tools/staging-db/run.sh`, `ops/staging-db/request.json` | `3b18ea1` | Canal contrôlé pour les migrations d'identité 2–5 sur Supabase **staging** (le connecteur Supabase bloque les textes à plusieurs `DELETE`). `run: false` tant que le propriétaire n'a pas donné son accord et configuré l'environnement GitHub `supabase-staging`. |
| 2026-10-15 | Core P0 | `src/core-pilot/{finance-reader,analytics-reader,answers}.js`, `src/sourcing/server/index.js` | `c333f1a` | Finance et Analytics lus par le Core en **lecture seule** sur le même projet Supabase et le même marchand que la connexion ; services Finance / Analytics existants **non modifiés**. Variables du service `sourcing-staging` à ajouter côté Railway : `MERCHANT_TIMEZONE=Europe/Brussels` (sans elle : non raccordés, dit comme tel). |

## Attendu d'Infrastructure (pour Core P0)
1. Authentification réelle devant China Sourcing sur Railway (aucun Caddy devant le service : la couche doit être dans l'application ou un
   module dédié ; modèle existant `src/analytics-premium/server/hosting.js`).
2. Entrée `sourcing` dans `src/service-start.js` : fichier Core P0, à faire par Core P0 **quand** Infrastructure confirme la forme du service.
3. Stockage durable des photos côté serveur : Core P0 écrit le contrat d'envoi (route, taille, `merchant_id`) dès que le stockage est choisi.
4. Adresse stable `app.nordla.app` avant le départ : l'origine ne doit plus changer ensuite (chaque changement d'origine = stockage vide).

### État au 2026-10-15 (Core P0)
- Points 1, 2, 3 : faits côté application (commits ci-dessus), testés localement et en navigateur réel derrière un proxy HTTPS imitant Railway.
  **Rien n'est déployé.** Pour que le service hébergé fonctionne, il faut côté Infrastructure / propriétaire :
  a. appliquer sur Supabase (après test en environnement isolé) les migrations d'identité, puis `20261015093000_identity_module_sourcing.sql` ;
  b. créer le service Railway `sourcing` (Node 24, volume persistant monté sur `SOURCING_DATA_DIR`, `NORDLA_SERVICE=sourcing`, `SOURCING_HOSTED=1`,
     `NORDLA_MERCHANT_ID`, `SOURCING_PUBLIC_ORIGIN=https://app.nordla.app`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
     `NORDLA_IDENTITY_RATE_LIMIT_KEY`, `NORDLA_CSRF_KEY`, `SOURCING_MERCHANT_ID=habb`) ;
  c. créer le compte Supabase Auth du propriétaire, son adhésion OWNER au marchand et activer le module `sourcing` ;
  d. sauvegarde isolée du volume (`cases/`, `photos/`, `core/`) et restauration vérifiée.
- Point 4 : non fait (DNS / domaine = propriétaire + Infrastructure).
