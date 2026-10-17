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

### 2026-10-15 — Core P0 : Création locale (sans fournisseur)
- `src/creative-e2e/asset.js` : **seul changement dans le code Création** = `dimensionsOf` est désormais exporté (mot-clé `export`, aucun
  changement de comportement). Réutilisé par `src/core-pilot/creation.js` pour lire les dimensions JPEG/PNG.
- `src/core-pilot/creation.js` réutilise sans les modifier : `buildDesignDocument` / `renderDesignDocument` (creative-intelligence),
  `renderProductionPng` (resvg), `measureProductFidelity`, `decodePng`, et le Gardien de marque via `src/core-pilot/branding.js`.
- N'utilise PAS `buildProductMask` (défaut PM-6) : la photo est dessinée telle quelle (PIXEL_PRESERVE).
- Configuration marchand : `config/merchants/habb/creation.json` (typographie = décision propriétaire existante du Benchmark 001).

## 2026-10-15 — Chantier A (intégration, infrastructure, stabilité) / Chantier B (évolution fonctionnelle du Core)

**Référence stable à transmettre au Chantier B** : branche `claude/nordla-core-p0`. Code : `9e25f1d` (CI : china-sourcing, intégration
Node 20 + 24, Creative Intelligence = PASS ; suite complète locale 3875 tests, 0 échec). Le commit suivant du Chantier A n'ajoute que
tests, CI et documentation (voir le journal git). Le Chantier B part de ce HEAD sur **sa propre branche** ; aucune intégration de ses
commits dans `claude/nordla-core-p0` sans vérification CI et déclaration ici.

### Propriété des fichiers
| Chantier B (évolution Core) — A n'y touche pas sans déclaration | Chantier A (stabilité, déploiement) — B n'y touche pas sans déclaration |
|---|---|
| `src/socle-decision/**` | `deploy/**`, `railway.json`, `railpack.json`, `.github/workflows/**` |
| `src/core-pilot/runtime.js`, `journal.js`, `ask.js`, `answers.js`, `config.js`, `sourcing-facts.js` | `tools/**`, `ops/**`, `supabase/migrations/**` (propriété Infrastructure) |
| `config/merchants/*/core-decision.json` | `src/sourcing/server/**` (démarrage, sécurité, sauvegardes), `src/security/**`, `src/identity/**` |
| tests `test/core-pilot*`, `test/socle-*` | `docs/infrastructure/**`, tests `test/core-modules*`, `test/core-backup-restore*`, `test/e2e/**` |

**Partagés (déclarer ici avant modification, un seul chantier à la fois)** : `src/core-pilot/http.js` (routes `/api/core/*`),
`src/core-pilot/{finance-reader,analytics-reader,branding,campaign,creation}.js`, `src/sourcing/ui/modules-panel.js`,
`src/sourcing/ui/core-panel.js`, `package.json`, ce fichier.

### Contrats existants (ne pas casser sans version)
- Identité : `actor = { userId?, role }` vient **toujours** de la session (jamais du corps de requête) ; rôles `OWNER`, `ADMIN`,
  `COLLABORATOR` ; décisions Branding / Marketing / Création = `OWNER` uniquement, raison obligatoire.
- Routes `/api/core/*` (en-tête de `src/core-pilot/http.js`) : `status`, `modules`, `ask`, `decisions`, `cases/<id>/analyse`,
  `decisions/<id>/{human,result}`, `branding{,/check,/approve}`, `campaigns{,/<id>/decision}`, `creation{,/<id>.png,/<id>/decision}`.
- Runtime : `createCoreRuntime({ merchantId, config, journal })` → `ready, analyseCase, decideHuman, recordResult, overview, entry,
  forCase` ; journal chaîné, en ajout seul, rejoué au démarrage (un journal qui ne se vérifie pas désactive le Core, sans le toucher).
- Lecteurs (lecture seule) : Finance `payables() / treasury({horizonDays}) / purchases({from,to}) / today()` ; Analytics
  `salesEvolution({periodKey})` — chaque réponse porte source, période, fraîcheur, données manquantes.
- Données sur le volume : `core/decision-journal.jsonl`, `core/brand-approved.json`, `core/campaigns.jsonl`, `core/creations/` —
  formats en ajout seul ; couverts par la sauvegarde (test `core-backup-restore`).
- Modules (`GET /api/core/modules`) : états `DISPONIBLE, LECTURE SEULE, À APPROUVER, LIMITÉ, BLOQUÉ, NON RACCORDÉ, NON CONFIGURÉ`.

### Peut avancer en parallèle
B : capacités du Core (sujets, leviers, règles, Parle à Nordla) sur sa branche. A : Supabase staging, Railway, sauvegardes, protocole
Xiaomi, CI. Point de jonction : une fusion B → `claude/nordla-core-p0` préparée par B, vérifiée (CI + e2e) par A, décidée par le propriétaire.

### Branches (état vérifié le 15/10)
- `integration/nordla-pre-china` @ `f7197d5` : ses 3 correctifs CI sont **déjà** dans `claude/nordla-core-p0` (seules différences :
  déclenchement sur `claude/nordla-core-p0`, tests Core en Node 24 seulement). Branche **remplacée**, à ne plus faire avancer.
- `claude/blissful-babbage-z0nrt2` @ `2b6b983` : 1 document (`docs/infrastructure/nordla-cloud-plan.md`), **absent** de Core P0 mais
  cité par 4 fichiers (dont `tools/sourcing-backup.mjs`) ; fusion sans conflit vérifiée (`git merge-tree`). **Proposée, non exécutée.**

## 2026-10-15 — Core P0 : fiabilité du Core (mandat P1–P7), branche `claude/nordla-core-reliability`

Branche créée depuis `claude/nordla-core-p0` @ `f721e49`. **Rien n'est fusionné dans `claude/nordla-core-p0` ni déployé** ; la fusion est préparée par Core P0, vérifiée par la CI, décidée par le propriétaire.
Fichiers touchés (déclarés avant fusion, un seul chantier à la fois) :

| Fichier | Nature | Propriété habituelle | Note |
|---|---|---|---|
| `src/core-pilot/journal.js`, `runtime.js` | modifiés | Chantier B | format des événements **inchangé** ; signatures publiques inchangées (ajouts : `status()`, `inspectJournalText`, option `hooks` / `lock` de `createFileJournal`) |
| `src/core-pilot/campaign.js`, `creation.js` | modifiés | partagés | lectures strictes ; vérification d'état + ajout = une opération |
| `src/core-pilot/{durable-file,journal-recovery,deployment-guard}.js` | **nouveaux** | Core P0 | primitives d'ajout durable ; reprise contrôlée ; garde « journal dans le volume Railway » |
| `src/sourcing/server/index.js` | **2 lignes** (import + garde dans `buildCore`) | Chantier A | si Railway et dossier de données hors `RAILWAY_VOLUME_MOUNT_PATH` → Core OFF avec le motif ; rien ne change hors Railway |
| `tools/sourcing-backup.mjs` | modifié | Infrastructure | vérifie la chaîne du journal dans l'archive, rogne la **copie** d'une ligne coupée, `restorable`, refus de restauration d'un journal incohérent, ignore `*.lock` ; format d'archive **inchangé** (champs ajoutés en lecture seule) |
| `tools/core-journal-recover.mjs`, `tools/core-reliability-mutation.mjs` | **nouveaux** | Core P0 | reprise contrôlée (diagnose / prepare / verify / apply) ; balayage de mutations |
| `test/finance-privacy.test.js` | **1 exemption** (2 lignes) | partagé | le dossier `test/fixtures/core-journal-v1/` (journal de référence : empreintes SHA-256 d'événements synthétiques) est exclu de la garde « aucune chaîne hexadécimale de 64 caractères » ; même précédent que `test/fixtures/fonts/FONTS.json` ; la garde reste entière partout ailleurs |
| `.gitattributes` | 1 ligne | partagé | `test/fixtures/core-journal-v1/** -text` (journal de référence : aucune conversion de fin de ligne) |
| `.github/workflows/core-reliability.yml` | **nouveau** | partagé | Linux Node 24 (fiabilité + suite complète) et Windows Node 24 (fiabilité) ; ne se déclenche que sur `claude/nordla-core-reliability` |
| `test/core-reliability.test.js`, `core-backup-integrity.test.js`, `core-deployment-guard.test.js`, `test/fixtures/core-journal-v1/**` | **nouveaux** | Core P0 | aucun test existant modifié ni affaibli |
| `docs/integration/core-journal-reliability.md` | **nouveau** | Core P0 | garanties, limites, reprise, sauvegardes, reporté |

À savoir pour Infrastructure : la documentation Railway rattache un volume à un seul service et ne documente aucun montage partagé ; la sauvegarde doit rester dans le service du Core. Le journal exige que `SOURCING_DATA_DIR` soit **dans** `RAILWAY_VOLUME_MOUNT_PATH`.

## 2026-10-16 (nuit) — Chantier A : vérification de `claude/nordla-core-reliability` (rien fusionné)

Fusion **simulée** localement (`claude/nordla-core-p0` @ `d9b630a` + `d85ec46`) : aucun conflit ; suite complète Node 24 : 362 fichiers,
3 918 tests, 0 échec (3 ignorés, identiques sur la branche actuelle). Garde « journal sur le volume Railway » compatible avec la
configuration `sourcing-staging` (`/app/data`, `SOURCING_DATA_DIR=/app/data/sourcing`). Les 2 lignes dans `src/sourcing/server/index.js`
et les changements de `tools/sourcing-backup.mjs` (périmètre A) sont acceptés côté Chantier A. Fusion : décision du propriétaire
(`docs/integration/bilan-2026-10-16.md`, D1).

## 2026-10-16 — Chantier A : préparation de l'activation staging (après la fusion #10)

| Fichier | Nature | Note |
|---|---|---|
| `src/sourcing/server/hosted.js`, `src/sourcing/server/index.js` | garde de projet Supabase ; nouvel essai de sauvegarde 1 h après un échec | sur Railway, `NORDLA_SUPABASE_PROJECT_REF` obligatoire ; `SUPABASE_URL` et clés JWT d'un autre projet refusées ; hors Railway, comportement inchangé si la variable n'est pas posée |
| `tools/sourcing-backup.mjs` | `list`, `drill` (restauration indépendante de l'archive hors serveur la plus récente) | format d'archive inchangé ; vérification du journal du Chantier B réutilisée telle quelle |
| `.github/workflows/staging-backup-drill.yml`, `ops/staging-backup/request.json` | **nouveaux** | restauration indépendante sur un runner GitHub, verrouillée comme `staging-db-ops` (`run: false`) |
| `.github/workflows/core-reliability.yml` | déclencheur `claude/nordla-core-p0` ajouté | Linux + Windows sur chaque commit candidat |
| `test/sourcing-hosted-project-pin.test.js` (nouveau), `test/sourcing-backup-full-restore.test.js`, `test/sourcing-hosted-identity.test.js` | tests | aucun test du Chantier B modifié |

## 2026-10-16 (suite) — Chantier A : vérifications avant l'autorisation finale

| Fichier | Nature | Note |
|---|---|---|
| `src/core-pilot/durable-file.js` (**Chantier B**, déclaré ici) | 3 lignes dans `withWriteLock` | si le contenu du verrou ne peut pas être écrit (disque plein / lecture seule), le verrou que l'on vient de créer est supprimé avant l'erreur. Trouvé sur un vrai tmpfs plein (`test/core-storage-realfs.test.js`) : un verrou vide bloquait toute écriture jusqu'à 15 s après redémarrage. Suites de fiabilité et `tools/core-reliability-mutation.mjs` inchangées et vertes. Le Chantier B peut reprendre la formulation |
| `src/sourcing/server/{hosted,index,app}.js` | vérification en direct du projet Supabase au démarrage ; `GET /healthz/backup` ; état des sauvegardes | périmètre A |
| `tools/sourcing-backup.mjs` | copie isolée B2 (ajout seul) + `drill-isolated` | optionnelle, inactive sans ses variables |
| `.github/workflows/staging-backup-monitor.yml`, `ops/staging-monitor/target.json` | **nouveaux** | alerte externe (désactivée) |
| tests `test/core-storage-realfs.test.js`, `test/sourcing-backup-health.test.js`, `test/sourcing-backup-isolated.test.js` | **nouveaux** | aucun test du Chantier B modifié |

## 2026-10-16 — Core P0 : assistant de terrain (PR #12 fusionnée, `c2d01be`) et phase 2 (branche `feature/core-field-assistant-phase2`)

PR #12 fusionnée dans `claude/nordla-core-p0` sur autorisation du propriétaire : code validé `fe0360b` (CI : nordla-integration-pre-china Node 24 + 20, core-reliability Linux + Windows, china-sourcing = succès) ; `1d89984` n'ajoute que de la documentation.

| Fichier | Nature | Note |
|---|---|---|
| `src/core-pilot/ask.js` (Core), `field-intents.js`, `field-facts.js`, `field-answers.js`, `field-context.js` (**nouveaux**) | assistant de terrain, lecture seule | paramètre opt-in `conversation` ; nouveau statut de réponse `ACTION_REFUSED` ; flux existants inchangés |
| `src/core-pilot/http.js` (**partagé, déclaré ici avant modification ; aucun autre chantier ne le tient**) | route `POST /api/core/ask` | 3 lignes : lit `conversation` du corps **seulement si la clé est présente**, la reconstruit par `validateConversation` (jamais fait confiance au client), la passe à `askNordla`. Sans la clé : comportement identique. Test `test/core-http-conversation.test.js` (rouge sans le changement) |
| `src/sourcing/core/decision.js` (périmètre China Sourcing, **ajout seul**) | champ `verdictDisplay` sur la carte de décision | `verdict` inchangé (tests figés) ; `CONDITIONAL_GO` avec blocage dur ouvert → `CONDITIONAL_GO_BLOCKED`. Aucune autre branche ne touchait ce fichier au 2026-10-16 (balayage de toutes les branches et worktrees). Test `test/sourcing-verdict-display.test.js` |
| `src/core-pilot/sourcing-facts.js` (Core) | `assessment.verdictDisplay` | 1 champ ajouté ; `input` (sujet Core) inchangé |

Contrats : `ask` renvoie `{status, answer, sources, limits}` + `intent, sections` pour les réponses de terrain (+ `conversation`, `notice` si l'appelant a envoyé `conversation`). L'assistant lit `decision.verdictDisplay` : la règle n'existe qu'à un endroit (le moteur). Tests de contrat : `test/core-field-assistant-contracts.test.js`.

## 2026-10-16 — Core P0 : assistant de terrain, phase 3 (branche `feature/core-field-assistant-phase3`, rien de fusionné)

| Fichier | Nature | Note |
|---|---|---|
| `src/sourcing/nordla-ui/nordla-ask.js` (**nouveau**) | écran « Parle à Nordla » : réponses structurées, bandeau de blocage, conversation conservée sur le téléphone, bouton « Nouvelle conversation » | rendu pur (valeurs échappées) + contrôleur ; aucun appel réseau propre |
| `src/sourcing/ui/core-panel.js` (**partagé ; fichier aussi modifié par la PR #11 ouverte**, `integration/core-postmerge-validation`) | 4 lignes : import, création du contrôleur, une ligne de dispatch `core-ask*`, remplacement du bloc de question | **dépendance à coordonner** : si #11 est fusionnée avant, le conflit est limité à ces 4 lignes (le reste de `core-panel.js` n'est pas touché) ; ne pas fusionner la phase 3 avant d'avoir vérifié l'ordre avec le propriétaire de #11 |
| `src/core-pilot/field-answers.js` (Core) | champs additifs de la réponse : `case`, `verdict`, `orderBlocked`, `blockers`, `knownTitle` | forme documentée par le test de contrat ; aucun champ retiré |
| `test/e2e/nordla-ask-ui.e2e.js`, `test/nordla-ask-ui.test.js`, `test/core-field-assistant-corpus.test.js` (**nouveaux**) | tests | `test/e2e/**` appartient au Chantier A : fichier **ajouté**, aucun test existant modifié |
Non touchés : `src/sourcing/server/**`, `index.html`, `sw.js`, `app.css` (le CSS de l'écran est injecté par le module, namespace `.nxa-*`), workflows, `http.js`.

## 2026-10-16 (soir) — Core P0 : fusions #11 et #14 ; branche d'intégration `integration/parle-a-nordla-convergence` (rien de fusionné dans la convergence)

PR #11 (journal : messages d'erreur de l'UI) fusionnée dans `claude/nordla-core-p0` (`4d09629`) après correction de son test (chargement des panneaux par le chargeur d'UI commun : il échouait sur Linux) — ses trois workflows verts sur `e6c5102`. PR #14 (Parle à Nordla phase 3) fusionnée (`6b48b38`) : trois workflows verts sur `ab0ec10` (`creative-refine` RF-2, Node 24, a échoué une fois puis réussi à la relance du même commit ; voir le rapport §13).
Branche d'intégration (PR brouillon vers la convergence) : convergence `e08d98d` + chantier C `b3d4161` + P0 `6b48b38` + le patch de compatibilité de Parle à Nordla + recherche de fournisseur par nom.

| Fichier | Nature | Note |
|---|---|---|
| `src/core-pilot/ask.js`, `procurement-compare.js`, `pending-approvals.js`, `procurement-supplier.js` (Core P0) | hooks Stock/Achats : comparaison, validations en attente, recherche de fournisseur par nom (affichage selon le rôle), panne ou absence du module | un ordre d'agir reste refusé ; texte distinct « proposer » / « exécuter » |
| `src/procurement/assistant.js` (**chantier C, ajout seul**) | outil `find_supplier` (lecture seule ; ne renvoie que nom, pays, devise, Incoterm, délai : ni contacts ni banque) | patch pour C : `chantier-c-find-supplier.patch` ; 16 outils au lieu de 15 |
| `src/integration/procurement-policy.js`, `procurement.js` (**convergence/C**) | `find_supplier` en lecture seule ; 3 règles de routage ajoutées en fin de liste | tests de comptage mis à jour (16 outils, 14 lectures, 18 actions) |
| tests : `core-procurement-routing`, `integration-router-precedence` | nouveaux | — |

## Design System v1 (Chantier A, 2026-10-17)

| Date | Session | Fichier(s) | Commit | Note |
|---|---|---|---|---|
| 2026-10-17 | Chantier A (Design System v1, branche `claude/nordla-design-system-v1`) | `src/sourcing/server/app.js` (bloc isolé : import `readNordlaShared`, table `NORDLA_PAGES`, 2 lignes de routage `/nordla*` et `/nordla-assets/*`), `package.json` (script `nordla:design:e2e`) ; nouveaux : `src/sourcing/nordla-ui/nordla-{ds.css,ds.js,view.js,home.js}`, `src/shared/assets/nordla/brand/` (pack officiel NORDLA Brand Assets V1, fichiers inchangés, ajout seul dans la zone partagée), `nordla.html`, tests `nordla-design-system`, `e2e/nordla-design` | voir journal git | Page `/nordla` en lecture des API Core existantes ; **service worker, application terrain, Finance, Stock & Achats non modifiés**. `app.js` fusionne sans conflit avec la convergence ; le seul conflit (`src/procurement/server/hosted.js`) existe déjà entre `claude/nordla-core-p0` et la convergence, sans lien avec cette PR. Ne pas fusionner tant que la PR #24 (tête `claude/nordla-core-p0`) est ouverte. Détail : `docs/design/nordla-design-system-v1.md`. |
