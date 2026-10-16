# Convergence + staging Railway — audit et livraison (2026-10-16, soir)

Base auditée : `claude/nordla-core-p0` @ **`5a57d0b485b54161187004c52c5ee450302d7978`** (PR #18 fusionnée). Branche de travail initiale : `integration/staging-candidate-hardening` (`18acd04`, **remplacée par `integration/staging-candidate-final`** ; **rien fusionné, rien déployé, aucune variable ni secret, aucune production touchée**).

## 1. État réel des branches, PR et CI
| Élément | État vérifié (API GitHub, SHA exacts) |
|---|---|
| `claude/nordla-core-p0` | `5a57d0b` = `2c8871d` (fusion PR #16 dans `integration/nordla-convergence-v1`) + 1 commit (PR #18, `deploy/sourcing/railway.json`, 16 lignes). La convergence (A + B + C + Parle×Achats) **est déjà dans core-p0** |
| `integration/nordla-convergence-v1` | `2c8871d`, contenue dans core-p0 (0 commit en avance) |
| PR #18 (`fix/sourcing-staging-railway-config`) | fusionnée dans core-p0 ; ne change que `deploy/sourcing/railway.json` |
| PR #17 (Chantier E, Social Publishing V1) | **ouverte, brouillon**, base `integration/nordla-convergence-v1`, 31 fichiers (+3 794), hors `src/social`/`docs` : `package.json`, `scripts/social-export-jpeg.py`. **Non intégrée** au candidat ; CI/enregistrement `src/integration` et raccord Provider à faire ; hors périmètre du 18 |
| CI sur le SHA exact `5a57d0b` | `core-reliability` (push) run 38958305994 : success · `nordla-integration-pre-china` (push) run 38958306004 : success · même SHA en `workflow_dispatch` : `china-sourcing` 38956584961, `nordla-integration-pre-china` 38956580627, `core-reliability` 38956577756 : success. (Les verts de commits antérieurs ne sont pas comptés.) |

## 2. Vérification locale du candidat (Windows, Node 24.19, arbre propre sur `5a57d0b`)
`node docs/integration/xiaomi/verify-candidate.mjs --baseline ab02b77` : **8 PASS, 1 FAIL**.
PASS : commit, variables nouvelles (aucune obligatoire), syntaxe, **152/152 tests** (contrats, sécurité, routage, conversation, confidentialité, Achats, parcours), graine TEST idempotente, e2e navigateur `xiaomi-rehearsal` 10/10, `ask-ui` 11/11, `core-pilot` 5/5.
FAIL : `nordla-entry.e2e.js` 0/7 **dans l'enchaînement** ; relancé seul : **7/7**. Lecture : intermittence d'environnement (même famille que `docs/integration/ci-intermittences-report.md`), non reproduite ; à surveiller, pas classée « résolue ».

## 3. Image et conteneur (local, secrets factices, Supabase inexistant)
- L'image `deploy/sourcing/Dockerfile` se construit depuis le commit exact (Node 24).
- **Piège Windows** : construite depuis un checkout Windows (`core.autocrlf=true`), le script d'entrée prend des CRLF et le conteneur échoue (`exec /app/docker-entrypoint.sh: no such file or directory`). Railway construit depuis Git (LF) : **pas de risque sur Railway**, mais risque pour tout build local. Correction : `.gitattributes` (`*.sh text eol=lf`).
- Démarrage (après correction de ma configuration de test : `NORDLA_SERVICE=sourcing` obligatoire, refus explicite sinon ; garde-fou d'entrée qui refuse un dossier hors `/app/data` — constaté) : `Nordla Core ON`, `Stock / Achats ON (/app/data/sourcing/procurement/procurement.json)`, **processus Node en uid 1000**, `/healthz` 200 avec l'hôte `healthcheck.railway.app`, hôte inconnu 421, aucun secret dans les journaux (0 occurrence des clés fournies), vérification Supabase `UNVERIFIED_UNREACHABLE` (attendu).
- **Défaut trouvé** : après un `docker restart`, `Stock / Achats: NOT mounted (STORE_LOCKED)` — reproduit 2 fois sur 2 (verrou par numéro de processus, sans valeur d'un conteneur à l'autre). **Mon premier correctif (`18acd04`, suppression inconditionnelle du verrou) est remplacé** par un bail avec battement de cœur qui ne peut pas déloger un écrivain vivant : voir `candidat-staging-final-2026-10-17.md` §1 (tests et preuves en conteneur).
- Non prouvé en conteneur : les réponses 401 sans session (mes requêtes n'avaient pas les en-têtes de proxy `X-Real-IP` → 400 « requête invalide », comportement documenté) ; elles sont prouvées par les tests (`sourcing-hosted-identity`, `convergence-journey`) et à constater au contrôle C3 sur Railway.

## 4. Railway (lecture seule, CLI `railway status`, aucune modification)
| Environnement | Services | Source Git | Constat |
|---|---|---|---|
| `production` (vivant, **non touché**) | `Finance` (deploy 2026-09-26 22:27, branche `feature/finance-shipping-vat-fix` @ `21dc924` = tête actuelle de la branche), `Analytics` (09-26, `feature/explorer-period-selector` @ `e593475`), `Core` (09-29 13:37, source Git non exposée), `nordla` (Bun, **SLEEPING**) | oui (dépôt) | cohérent avec le dépôt pour Finance ; ces services portent les vraies données : **aucune intervention** |
| `staging` | `finance-staging` (09-29), `core-staging` (09-29), `analytics-staging` (09-29), `shopify-stub-staging` (09-27) | **aucune** (déployés par envoi direct) | pointent sur Supabase staging `fvhiammdskpcnfodsnrc` (marchand synthétique `4159734e-…`) ; **impossible de les rattacher à un SHA** ; sans lien avec `sourcing-staging` |
| `sourcing-staging` | **non visible** par la CLI dans `staging` | — | les documents le décrivent en `staged-create` (29 changements en attente, volume 1 Go `/app/data`, commit épinglé `c2c314d`) : **non vérifiable d'ici** ; l'épingle `c2c314d` est périmée (candidat = `5a57d0b`+correctif) |
- **Point critique de configuration** : le `railway.json` **racine** démarre `node src/service-start.js` sans l'entrée Docker (processus root, pas de volume préparé). Le service doit avoir **« Config as code » = `deploy/sourcing/railway.json`** (Dockerfile, `/healthz`, 120 s, 1 réplique). Contrôle : journal `uid 1000` ; `uid 0` = NO-GO.
- Variables : les noms des services `staging` existants ont été relevés **sans valeurs** (aucun secret exposé). Pour `sourcing-staging` la liste cible est dans `ops/railway-staging/staged-corrections.json` et `docs/infrastructure/dossier-activation-staging-xiaomi-18-10.md`.

## 5. Supabase staging `fvhiammdskpcnfodsnrc` (lecture des métadonnées uniquement)
28 migrations appliquées (identité 2–5 comprises) = historique documenté. **Écart dépôt ↔ base** : 8 migrations du dépôt ne sont pas appliquées sur staging (`analyses_truth_foundation`, `channel_execution_jobs`, `finance_belgium_peppol`, `finance_essential_bank`, `finance_essential_payments`, `finance_integrity_p0`, `merchants_deprecate_legacy_identity`, `provider_connections`). Aucune n'est requise pour le chemin hébergé Sourcing/Core/Achats (identité seule) ; **risque** : avec `MERCHANT_TIMEZONE` posé, Finance « lecture seule » interroge des tables/colonnes que ces migrations créent → réponses « données indisponibles » possibles (à constater au contrôle C9, jamais un chiffre inventé). Migrations Achats (`supabase/migrations-pending/*procurement*`) : **non appliquées, non prévues** (magasin fichier).

## 6. Tableau de livraison
| Composant | Intégré (core-p0 `5a57d0b`) | Déployé staging | Testé (preuve) | Bloquant |
|---|---|---|---|---|
| Core (décisions, journal) | oui | non (service absent) | 152 tests, e2e 5/5, conteneur : Core ON | activation |
| Identité / sessions | oui | non | `sourcing-hosted-identity`, parcours | activation + secrets du propriétaire |
| China Sourcing | oui | non | e2e, conteneur démarre | idem |
| Parle à Nordla (A) | oui (phases 1–3) | non | répétition Xiaomi 10/10, ask-ui 11/11 | pas de LLM ni voix (hors périmètre) |
| Stock/Achats (C) | oui (API montée) | non | parcours, routage, conteneur : ON ; **redémarrage corrigé** | correctif à fusionner ; PG non branché (volontaire) |
| Finance / Analytics (lecture) | oui | services `*-staging` anciens (synthétique) | tests `core-readers` | données réelles non autorisées ; 8 migrations non appliquées |
| Social Publishing (E, PR #17) | **non** (brouillon) | non | rapporté 56 tests (non revérifié ici) | hors candidat |
| Railway `sourcing-staging` | — | **non vérifiable** (staged-create) | — | autorisation + secrets + épingle à mettre à jour + config path |

## 7. Procédures de reprise (retour arrière)
1. Candidat : redéployer `ab02b77` (sans Parle×Achats) ou mettre `sourcing-staging` à 0 instance ; variables inchangées.
2. Code : aucune branche source modifiée ; supprimer `integration/staging-candidate-hardening` (ou ne pas la fusionner).
3. Données : le dossier `procurement/` du volume est additif (l'ancienne version l'ignore) ; volume, base staging et production intacts ; sauvegarde chiffrée (artefact 12010772510 conservé jusqu'au 14/11, restauration prouvée).

## 8. Opérations encore soumises à autorisation (rien n'a été lancé)
1. Fusionner `integration/staging-candidate-hardening` dans `claude/nordla-core-p0` (PR à revoir) — nouveau SHA candidat, nouvelle CI.
2. Mettre à jour l'épingle de `sourcing-staging` (Railway) vers ce SHA et vérifier « Config as code » = `deploy/sourcing/railway.json`.
3. Saisie des secrets Railway par le propriétaire ; **Deploy** (applique tout le lot : trier les 29 lignes avant).
4. Graine de données TEST (volume), jamais de données réelles.
5. DNS `app.nordla.app`, migrations (Achats, 8 en retard), PR #17, tout ce qui touche `main` ou la production.
