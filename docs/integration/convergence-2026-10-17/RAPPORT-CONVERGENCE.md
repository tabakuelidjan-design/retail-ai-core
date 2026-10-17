# Convergence de tous les modules Nordla — audit réel, raccordement, candidat staging (2026-10-17)

Branche de convergence : `integration/nordla-unified-convergence-candidate` (locale, **non poussée, non fusionnée**), depuis `origin/claude/nordla-core-p0` `ebff21e`.
Fusionnés localement dessus : PR #22 (design system `/nordla`), PR #19 (Parle à Nordla voix V2), PR #21 (Social Publishing + registre) ; puis 1 commit de convergence. Détail §5.
**Rien n'a été fusionné, déployé, poussé ni modifié côté Railway ou Supabase.** `main`, `core-p0`, la PR #24 et le service Railway actif n'ont pas été touchés.

Règle appliquée : « fonctionnel » = prouvé de bout en bout ; une PR n'est pas intégrable parce qu'elle est ouverte ou que sa CI est verte. Les faits ci-dessous viennent du code lu (annexes `annexe-audit-*.md`), des tests exécutés ici (Windows, Node 24) et des relevés en lecture seule de GitHub, de Supabase et (via la session Convergence) de Railway.

## 1. Constat central

1. **Il n'existe pas de serveur « Nordla » unique.** L'écran Nordla (`/nordla`, navigation, `/api/core/*`, Parle à Nordla, Stock/Achats `/api/procurement/*`) est **monté dans le serveur China Sourcing** (`NORDLA_SERVICE=sourcing`, identité Core). Finance, Analyses, Core-sync, Growth sont des **processus séparés**, avec leur propre jeton, hors de cette navigation. Social, Marketing, Création, Activation sont des **bibliothèques ou applications locales** sans serveur hébergé.
2. La navigation unifiée **existe déjà** (`GET /api/core/modules`, état réel par module). Elle ne listait que 8 modules. Le candidat en liste **13**, avec l'état réel et la raison pour chacun (§5).
3. Les modules hors Sourcing ne sont **pas mélangés** : un module absent dit « NON RACCORDÉ » sans bloquer les autres (testé).
4. Le plus gros risque transversal : **isolation des marchands purement applicative** (clé service role partout, RLS activée sans aucune politique), et **contrôles d'approbation hétérogènes** (§6).

## 2. Inventaire réel

### 2.1 Dépôt, branches, PR (vérifié par `git merge-base --is-ancestor` et `git merge-tree`)
| PR / branche | Contenu | Dans core-p0 ? | Intégrée au candidat ? | Remarque |
|---|---|---|---|---|
| core-p0 `ebff21e` | Core, Sourcing (+FR extract #23), Stock/Achats finalisation, Parle phases 1-3, Finance, Analyses, Growth, Branding/Marketing/Création (bibliothèques), Activation, Provider-connections, intégration | — | base | |
| PR #22 (`claude/nordla-design-system-v1`) | écran `/nordla` desktop+mobile | non | **oui** (fusion propre) | 13 modules affichés par la même vue |
| PR #19 (`feature/parle-a-nordla-v2-voice`) | dictée/lecture navigateur, correctif de sécurité des « ok Nordla, valide le paiement » | non | **oui** (propre) | jamais essayé sur Xiaomi ; la dictée Chrome envoie l'audio à Google |
| PR #21 (`feature/social-e-integration-registry`) | Social Publishing + registre `src/integration` | non | **oui** (propre) | remplace #17 et #20 (supersédées) |
| PR #24 (`candidate/sourcing-staging-fr-extract`) | candidat de release | — | **non touchée** (consigne) | |
| `integration/stock-achats-v1-wave2` | PG smoke, sauvegarde/restauration Achats | non | **non** | conflit préexistant `src/procurement/server/hosted.js` avec core-p0 ; ne pas fusionner dans cette branche (Convergence) |
| `release/sourcing-staging`, `candidate/sourcing-staging-*` (`a7ecccd`) | `railway.json` racine seul | non | **non** | ne jamais fusionner ce `railway.json` dans core-p0/main |
| `feature/chantier-d-branding-creative-pole` (D) | bibliothèque d'assets, composeur de visuels | non | **non** : essai fait puis retiré | 38 tests de D passent contre le vrai code E, **mais** casse 2 tests du candidat : `finance-privacy` (le fichier `docs/chantier-d/e-proposals/alternative-to.patch` contient une chaîne type e-mail) et `creative-production` LG-2 (`studio-compose/compose.js` importe `creative-production/raster-ops.js`, interdit par la garde « additif »). À corriger par D. |
| `fix/sourcing-extract-moq-leadtime` (5), `fix/sourcing-verdict-display` (1), `feature/creative-mask-determinism-diagnostic` (1) | correctifs/diagnostic | non | non | PR #7, #6, #8, #9 plus anciennes (branches cibles dans core-p0 ou diagnostics) : à trier par leurs propriétaires |
| `integration/nordla-convergence-v1` | ancienne ligne | non (supersédée) | non | |

### 2.2 Railway (relevé par la session Convergence, non vérifié par moi)
Projet app.nordla.app, environnement staging : service `sourcing-staging` déployé le 2026-10-17 11:19 UTC, branche `release/sourcing-staging` commit `a7ecccd` (= core-p0 `0f83fd2` + `railway.json` racine), commande `/app/docker-entrypoint.sh node src/service-start.js`. Les 4 autres services staging (finance, core, analytics, shopify-stub) inchangés depuis 09-27/29. Production inchangée. Les contrôles après déploiement (uid 1000, `/healthz`, Achats ON, sauvegarde hors serveur) sont **non vérifiés**. Fusionner dans core-p0 ne redéploie pas le staging.

### 2.3 Supabase (lecture seule : liste, migrations, conseillers ; aucune ligne lue, aucune écriture)
- Projets : `nordla-finance-staging` (`fvhiammdskpcnfodsnrc`, eu-west-1, sain) ; `retail-ai-core-dev` (`xbtzjabbseclmqfozjeo`, non audité).
- Staging : **28 migrations appliquées sur 35 du dépôt**. Non appliquées : `analyses_truth_foundation`, `channel_execution_jobs`, `finance_belgium_peppol`, `finance_essential_bank`, `finance_essential_payments`, `finance_integrity_p0`, `merchants_deprecate_legacy_identity`, `provider_connections` (+ le dossier `supabase/migrations-pending/` : intégration, `sourcing_cases`, tables `proc_*`). Le code Finance de core-p0 attend probablement ces migrations : à appliquer **avant** toute activation Finance staging (décision propriétaire).
- Tables du staging : 31 tables, **RLS activée sur toutes**. Conseillers sécurité : 33 tables « RLS activée sans politique » (= refus total aux rôles anon/authentifié ; l'accès passe par la clé service role), 6 fonctions `fin_*` au `search_path` mutable (WARN), protection des mots de passe divulgués désactivée (WARN). Le staging contient des **données de boutique réelles** (175 produits, 90 commandes, 320 factures fournisseurs, 420 transactions bancaires…) : à traiter comme confidentiel.
- Aucune table de Stock/Achats (`proc_*`) n'existe dans le staging : Achats fonctionne sur son fichier (mono-processus).

## 3. Tableau module par module

Légende des états de la navigation : DISPONIBLE (opérationnel) · LECTURE SEULE / LIMITÉ / À APPROUVER / À VÉRIFIER (partiel) · NON RACCORDÉ / NON CONFIGURÉ / BLOQUÉ (indisponible).

| # | Module | 1. Existant (prouvé) | 2. Intégration actuelle (core-p0) | 3. Raccordement indispensable | 4. Disponible après raccordement (candidat) | 5. Reporté | 6. Tests | 7. Blocages / décisions |
|---|---|---|---|---|---|---|---|---|
| 1 | **Core, Guardian, Validations** | journal de décisions chaîné par hachage, décision humaine nommée (machines refusées), config par marchand, sync Shopify avec garde tenant | monté dans le serveur Sourcing ; Guardian = `decideHuman` ; pas de file d'approbation unique | ligne « Règles et validations » honnête (créée) | état affiché : LIMITÉ, avec la liste des contrôles qui existent et de ceux qui manquent | file d'approbation unique ; maker/checker Finance | §7 G1 | clé service role + RLS sans politique ; mode jeton local = OWNER ; décision : politiques RLS (migration préparée non appliquée) |
| 2 | **Identity** | sessions Supabase Auth, rôles (5), membership relu à chaque requête, CSRF, hôte/origine épinglés | seul Sourcing l'utilise | **garde de rôle** sur les données Sourcing (VIEWER/ACCOUNTANT lisent seulement) : **corrigé** dans le candidat | Sourcing hébergé : rôles appliqués | Finance/Analyses sur l'identité Core | §7 G1, CV-1 | migration `identity_module_sourcing` appliquée en staging ; `merchants_deprecate_legacy_identity` non |
| 3 | **China Sourcing** | ~97 fichiers : moteurs déterministes, PWA hors ligne, extraction FR, sauvegarde chiffrée | DISPONIBLE (hébergé) | — | DISPONIBLE | voix (anglais, expérimentale, jamais sur appareil) ; OCR IA désactivée par défaut | §7 G3 | 2 tests Windows préexistants (chemin) ; plafond de taille de `documents/extract` non vérifié |
| 4 | **Stock / Achats** | commandes DRAFT→CLOSED, réceptions, ajustements, assistant 15 outils, PWA, bail de verrou | monté (`/api/procurement`) ; approbations propres à Achats (hors Guardian) | — | DISPONIBLE | PostgreSQL (le paquet `pg` est absent de `package.json` ; migrations en attente) ; wave2 | §7 G3 | mono-processus ; décision : brancher PG + appliquer migrations |
| 5 | **Buying / Demand / Signals** | bibliothèques pures testées | aucun serveur | aucun (utilisées via Achats/Core) | via Core et Parle | écran dédié | §7 G3 | — |
| 6 | **Parle à Nordla** | assistant déterministe (16 intentions), refus d'actions, sources, conversation côté navigateur ; PR #19 : dictée navigateur | `POST /api/core/ask` dans le serveur Sourcing | ligne `parle` dans la navigation (créée) ; PR #19 fusionnée dans le candidat | LIMITÉ : texte (+ dictée navigateur), Marketing et Création non interrogeables | LLM ; voix serveur ; entrée par le hub | §7 G4 | dictée Chrome → Google (Chine) : décision ; test sur vrai téléphone non fait |
| 7 | **Finance** | 66 fichiers, facturation, paiements, achats, banque CSV, trésorerie, Peppol prêt | service séparé, jeton partagé unique | lecteur lecture seule déjà dans le Core (si fourni) | LECTURE SEULE dans le Core quand le lecteur est branché | **point d'accès Peppol réel, PSD2, e-mail** : absents (ne pas présenter comme conforme) ; maker/checker ; identité Core | §7 G2 | écritures non gardées (paiements, banque, réglages, **stock → Shopify**) ; acteur d'audit codé en dur ; migrations 8 non appliquées en staging : décisions |
| 8 | **Analyses (Analytics Premium)** | rapports, explorateur, Ask déterministe | service séparé, Basic auth | lecteur lecture seule déjà dans le Core | LECTURE SEULE | fournisseur IA (registre vide) ; auth locale absente | §7 G2 | pas de consentement/porte contractuelle avant un futur adaptateur IA |
| 9 | **Growth** | priorités de vente, écran local | serveur local sans auth | ligne `growth` (créée) | NON RACCORDÉ (dit pourquoi) | exposition hébergée avec auth | §7 G2 | à ne pas exposer sans authentification |
| 10 | **Branding** | contrats + gardien + mémoire (~197 tests) | « À APPROUVER » : proposition non approuvée | approbation du propriétaire | selon l'état réel | logo/couleurs approuvés | §7 G5 | décision propriétaire |
| 11 | **Marketing** | contrats M1-M4, rapport CLI | LIMITÉ : propositions + décision humaine | — | LIMITÉ, aucune diffusion | exécution | §7 G5 | — |
| 12 | **Création** | visuel local (photo + titre), contrôles de fidélité, 13 dossiers `creative-*` | LIMITÉ/BLOQUÉ : aucun fournisseur IA | — | LIMITÉ | génération IA, provider réel | §7 G5 | CLI Gemini/MiniMax sans politique ni budget vérifiés |
| 13 | **Social Publishing** | vraie app (signature des approbations, verrou inter-processus, doublons, jeton hors dossier de données) | application séparée (loopback, 8980) ; PR #21 | **lecture seule dans la navigation** (`src/social/reader.js`, comptes uniquement) | LECTURE SEULE si `SOCIAL_DATA_DIR` nommé, sinon NON RACCORDÉ ; approuver/planifier/publier **jamais** depuis l'écran partagé | Meta réel ; persistance par tenant ; Connection Center | §7 G6, CV-3 | aucune publication réelle vérifiée ; décision : quand ouvrir un essai sur une Page de test |
| 14 | **Activation / Provider-connections** | exécuteur durable, adaptateurs IG/TikTok/Google avec faux, OAuth PKCE en CLI | bibliothèque | ligne `activation` (créée) | NON RACCORDÉ | écran Centre des connexions, identifiants, validation réelle | §7 G6 | dépendance ouverte : Connection Center |
| 15 | **Hub d'intégration** | politique par défaut refus, registre d'identifiants, ledger | **en mémoire**, non instancié par les serveurs | — | inchangé | persistance (tables préparées non appliquées) | §7 G1 | décision : modèle canonique PurchaseOrder (déjà proposé par Convergence) |

## 4. Plan d'intégration (basé sur le code présent)
1. (**fait dans le candidat**) navigation à 13 modules, état réel, aucune donnée simulée ; Social lecture seule ; garde de rôle Sourcing ; tests CV-1..5 ; PR #22, #19, #21 fusionnées localement.
2. Avant toute activation : appliquer en staging, **après décision du propriétaire**, les 8 migrations manquantes (+ la migration `pending` d'identité si nécessaire) ; ajouter le paquet `pg` si PostgreSQL est voulu pour Achats.
3. Décider du sort de D (corriger les 2 incompatibilités) puis fusionner.
4. Décider de la politique de dictée (Chrome/Google vs Chine) avant le test Xiaomi.
5. Gouvernance : maker/checker Finance, gardes des écritures Finance (stock → Shopify), file d'approbation unique : travaux séparés, hors raccordement.

## 5. Ce que le candidat contient exactement
- Merges locaux : `7b91d14` (#22), `85a8308` (#19), `99bbfc2` (#21) — tous propres, 0 conflit (vérifié par fusion réelle et `merge-tree`).
- Commit `ffbe2b2` (convergence) : `src/core-pilot/http.js` (+5 lignes de modules, paramètre `social`), `src/social/reader.js` (nouveau, lecture seule), `src/sourcing/server/index.js` (injection de `social` si `SOCIAL_DATA_DIR`), `src/sourcing/server/app.js` (garde de rôle), `src/sourcing/nordla-ui/nordla-view.js` (5 entrées de métadonnées), `test/core-modules.test.js` (liste attendue), `test/convergence-unified.test.js` (nouveau, CV-1..5).
- Aucun nouveau développement fonctionnel : uniquement du raccordement et de la vérité d'état.

## 6. Sécurité et confidentialité — contrôle obligatoire, point par point
| Point | Constat (preuve) | État |
|---|---|---|
| Authentification et séparation des commerçants | **Sourcing hébergé** : identité Core (Supabase Auth + membership actif + module `sourcing`), un service = un marchand = un volume, hôte/origine épinglés, CSRF (tests `sourcing-hosted-identity`, CV-1). **Finance / Analyses / Growth** : un jeton partagé (Finance : cookie + CSRF ; Analyses : Basic ; Growth : aucune authentification), pas d'identité par personne. Isolation des marchands **applicative seulement** : clé service role partout, RLS activée sans politique (33 tables). | Sourcing ✔ ; Finance/Analyses/Growth ✘ (non dans la navigation) |
| Permissions utilisateurs et agents | 5 rôles ; approbateurs machines refusés (`ledger.js`) ; **défaut corrigé dans le candidat** : en hébergé, VIEWER et ACCOUNTANT pouvaient modifier/supprimer des dossiers Sourcing, stocker des photos et envoyer documents/photos à un lecteur IA ; désormais `FORBIDDEN_ROLE` (CV-1, mutation détectée). | corrigé |
| Guardian et Validations avant actions sensibles | Core : décision humaine nommée journalisée ; Achats : approbation/commande/réception par rôle + autorisations + séparation des tâches (**hors Guardian/journal Core**) ; Marque, campagne, visuel : propriétaire seul. **Pas de file d'approbation unique** (dit dans la ligne « Règles et validations »). Finance : « approuver » = acteur marchand ; **pas de double contrôle**. | partiel |
| Fuite vers les modèles IA externes | Aucun appel réseau dans `src/core-pilot` ni dans le lecteur Social (test statique CV-5) ; Parle à Nordla et Finance : aucun LLM ; Analyses : registre de fournisseurs **vide** ; vision (Anthropic) : désactivée par défaut, consentement **par image** (HTTP 428), région CN refusée pour données non publiques, `minimizePayload` ne retire que e-mails/téléphones (noms de fournisseurs/prix dans du texte libre non rédigés) ; Alibaba : données publiques seulement, non branché au pipeline ; CLI Gemini/MiniMax : clés d'environnement **sans politique ni budget vérifiés** ; dictée Chrome : audio envoyé à Google (divulgué). | partiel |
| Journalisation des décisions | Journal Core chaîné (acteur : identifiant et rôle) ✔ ; événements Finance append-only mais acteur codé en dur `dashboard` ; **ledger d'intégration en mémoire** (perdu au redémarrage) ; Social : `audit.jsonl` local. | partiel |
| Protection des secrets et données financières | aucun secret dans le dépôt (`finance-privacy` passe) ; jeton Social hors du dossier de données ; clé de signature hors du dossier ; secrets Railway saisis par le propriétaire ; **le staging Supabase contient des données de boutique réelles** (à traiter comme confidentiel). | ✔ avec réserves |
| Absence de publication, paiement, achat ou écriture sensible non autorisée | Depuis la navigation unifiée : **aucune** action de ce type (refus d'actions par Parle, hub qui BLOQUE approve/schedule/publish, aucune route sociale d'écriture — CV-3). Hors navigation : Finance (paiements, banque, réglages, **application du stock vers Shopify**) = session + CSRF seulement ; Social et Achats = approbation du propriétaire dans leur application. | ✔ (nav) / ✘ (Finance) |

Toute capacité non prête reste désactivée sans bloquer la consultation : **testé** (CV-2, CV-4 : un dossier Social illisible → « À VÉRIFIER », les 12 autres modules répondent).

## 7. Résultats des tests (candidat `ffbe2b2`, Windows, Node 24.19, local)
| Groupe | Fichiers | Tests | Réussis | Échecs | Sautés | Durée |
|---|---|---|---|---|---|---|
| G1 Core, intégration, identité, tenant, sécurité, sync, Socle | `core-*`, `integration-*`, `convergence-*`, `identity-*`, `tenant-*`, `security-*`, `socle-*`, `sync-*`, `c6f-*`, `m2-*`, `merchant-*` | 515 | 513 | **0** | 2 | 186 s |
| G2 Finance, Analyses, métriques, clients, signaux | `finance-*`, `analytics-*`, `analyses-*`, `metrics*`, `customers*`, `signals*` | 1073 | 1073 | **0** | 0 | 229 s |
| G3 Sourcing, Stock/Achats, Buying, Demand | `sourcing-*`, `procurement-*`, `buying*`, `demand*` | 848 | 828 | **2** (identiques sur core-p0) | 18 (PostgreSQL, Node 24 seul) | 229 s |
| G4 Parle à Nordla | `core-field-assistant*`, `nordla-*`, `analytics-ask*`, routeur | 108 | 108 | **0** | 0 | 7 s |
| G5 Branding, Marketing, Création | `branding*`, `marketing*`, `creative-*` | 1272 | 1270 | **0** | 2 | 1536 s |
| G6 Social, Activation, Providers | `social-*`, `integration-social`, `channel-*`, `provider-*`, `merchant-connectors` | 218 | 217 | **0** | 1 (test POSIX) | 44 s |
| Navigateur réel (Edge headless), desktop 1440 px + téléphone 360/390/430 px | `test/e2e/nordla-design.e2e.js` | 7 parcours | 7 | 0 | — | — |
| Image de déploiement (Docker, Node 24) | `deploy/sourcing/Dockerfile` | démarrage + 13 modules + jeton exigé + uid 1000 | OK | — | — | — |

Les **2 échecs de G3** (`sourcing-field-v1-merchant-profile` : chemin de configuration, `sourcing-ui-syntax` : contrôle de syntaxe) sont **identiques sur core-p0 `ebff21e`** (vérifié fichier par fichier) : problème d'environnement Windows préexistant, pas dû au candidat.
Nouveaux tests : `convergence-unified` (CV-1..5) et `integration-social` (IS-1..10), mutations détectées (rôles ouverts, Social « disponible », lecteur qui écrit, Activation « disponible »).
Essais retirés : la fusion du chantier D cassait `finance-privacy` et `creative-production` LG-2 sur le candidat ; elle a donc été **retirée** (aucun test du candidat ne dépend d'elle). Le test complet du dépôt (`npm test`) n'a pas pu être terminé localement (le groupe Création seul dure 25 min) ; en CI, Creative Intelligence Node 24 et Alibaba restent des points de suivi.

## 8. Candidat staging réversible (non déployé)
- **Branche** `integration/nordla-unified-convergence-candidate` @ `ffbe2b2` (local). Rollback : rien à faire (non déployé) ; pour retirer : supprimer la branche locale. Le staging actif (`a7ecccd`) est inchangé.
- **Image** : construite en local depuis `deploy/sourcing/Dockerfile` (Node 24, dépendances de production seulement) puis lancée en mode local sans secret : démarre, **uid 1000**, jeton exigé (401 sans), `/api/core/modules` répond **13 modules**, aucun réseau. Les fichiers `src/social` sont dans l'image mais **rien ne les démarre** (le démarreur ne connaît que core, finance, analytics, core-once, sourcing). L'image de test locale a été supprimée.
- **Pour déployer plus tard (décision et action du propriétaire/Convergence, pas de moi)** : la voie utilisée aujourd'hui est la branche `release/sourcing-staging` = code + **un seul fichier racine `railway.json`**. Reproduire la même chose sur un commit du candidat ; **ne jamais fusionner ce `railway.json` racine dans core-p0 ou main** ; appliquer d'abord les migrations (§2.3) ; saisir soi-même les secrets ; vérifier ensuite les contrôles 1-10 de `docs/infrastructure/railway-handoff-9e25f1d.md` (non vérifiés à ce jour).
- Variables nouvelles de ce candidat : **aucune obligatoire**. `SOCIAL_DATA_DIR` (optionnelle) fait apparaître Social en lecture seule ; sans elle : « NON RACCORDÉ ».

## 9. Décisions et blocages à vous soumettre (regroupés)
1. **Fusion** : PR #22, #19, #21 dans core-p0, dans quel ordre ? (elles fusionnent proprement ensemble). #17 et #20 sont supersédées par #21 (à fermer à votre convenance).
2. **Chantier D** : le corriger (chaîne type e-mail dans `alternative-to.patch` ; `studio-compose` importe `creative-production`) avant de le fusionner ?
3. **Staging Supabase** : appliquer les 8 migrations manquantes ? Appliquer les politiques RESTRICTIVES préparées (`migrations-pending`) ? (actions Supabase : **non faites**, à votre accord explicite).
4. **Stock/Achats** : brancher PostgreSQL (ajout du paquet `pg`, migrations `proc_*`) ou rester sur le fichier mono-processus ? Que faire de `stock-achats-wave2` (conflit `hosted.js` préexistant) ?
5. **Finance** avant toute activation hébergée : double contrôle (maker/checker), gardes sur l'écriture du stock vers Shopify et les paiements, identité Core plutôt que jeton partagé ; **Peppol/PSD2 réels absents** (ne pas annoncer la conformité).
6. **Parle à Nordla** : la dictée navigateur (Chrome → Google) est-elle acceptable, notamment en Chine ? test sur vrai téléphone Xiaomi.
7. **IA** : avant tout adaptateur ou CLI payant, imposer politique de données + budget (Gemini/MiniMax) et consentement par marchand (Analyses).
8. **Alibaba (CI)** : annulé à 20 min sur plusieurs PR ; la suite complète du dépôt est très longue en local aussi (tests `creative-e2e-closure` > 15 min sous charge). Diagnostic par son propriétaire ou déclaration « non obligatoire ». **Creative Intelligence Node 24** : échec intermittent non reproduit.
9. **Social Publishing** : aucun usage réel ; quand ouvrir un essai sur une Page de test (identifiants Meta, persistance par tenant) ?
10. **Test navigateur** : j'ai prouvé desktop 1440 px et téléphone 360/390/430 px en navigateur réel (7/7) ; **pas sur un vrai téléphone**.

## 10. Limites de ce rapport
Audit du code par lecture (5 agents en lecture seule, échantillonnage partiel signalé dans les annexes) + tests exécutés ici (Windows, Node 24 ; la CI Linux/Node 20 n'a pas été rejouée sur ce candidat) ; Railway lu seulement par la session Convergence ; Supabase lu en lecture seule (aucune ligne) ; le projet `retail-ai-core-dev` n'a pas été audité ; le test complet du dépôt (≈ 3400 tests) n'a pas pu être terminé ici (suites de création très longues) : il est remplacé par 6 groupes ciblés + le parcours navigateur ; les échecs restants sont identiques sur core-p0.
