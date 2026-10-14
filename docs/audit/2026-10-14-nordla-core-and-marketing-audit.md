# Nordla — Audit de complétude Core et extensions Marketing

Date : 2026-10-14 · Branche : `claude/friendly-bell-1agyp0` (= `origin/main` @ `a9d0e2f`, 31 commits) · Nature : **audit en lecture seule**, aucun code modifié, rien de fusionné ni déployé.

## 0. Constats préalables (à lire d'abord)

1. **Le mot « Nordla » n'apparaît nulle part dans ce dépôt** (code, docs, commits, config). Le dépôt s'appelle `retail-ai-core`. Les décisions « Core non terminé » et « intelligences du 8 octobre 2026 » ne sont **ni documentées ni référencées ici** ; le dernier commit date du **2026-09-21**. Elles n'ont donc pas été « perdues » dans le code : elles n'ont jamais été écrites dans ce dépôt. Si un autre dépôt, une autre session ou un autre document les contient, je ne peux pas le voir : merci de l'indiquer.
2. **« L'architecture Marketing déjà développée » = uniquement de la mesure** (Phase 2D.1 mesure, 2D.2 visibilité de recherche). Il n'existe **ni agent Marketing, ni moteur de recommandation, ni connecteur runtime**. Si un Marketing plus avancé existe ailleurs, il n'est pas dans ce dépôt.
3. **Les règles actuelles de `CLAUDE.md` §8 interdisent** moteur de recommandation, dashboard, moteur de résultats et « agents supplémentaires » tant qu'ils ne sont pas explicitement approuvés. Toute phase ci-dessous exige donc un mandat écrit **et** une mise à jour de `CLAUDE.md`.
4. **Tests** : `npm ci && npm test` → **254/254 passent**. Sans `npm ci`, 2 fichiers échouent (`pdfkit` absent) : problème d'environnement, pas de code.
5. **Aucun CI** (pas de `.github/`), **aucune trace de déploiement production** : Supabase = projet *dev* uniquement (CLAUDE.md §6). Rien dans le dépôt ne prouve une validation en production.

Légende : **Codé** = existe + testé · **Connecté** = branché à un flux réel de données/autres modules · **Validé prod** = prouvé en production. Aucune capacité ci-dessous n'atteint « Validé prod » ; je ne peux attester « Connecté » que là où la doc le dit (données HABB réelles synchronisées vers Supabase dev : commits `64e727e`, `66e7474`, `34d0350`).

## A. NORDLA CORE COMPLETION MAP

### A.0 Ce qui existe réellement (≈ 7 800 lignes src, 3 460 lignes de tests)

| Couche du pipeline | Module | Preuves | Statut |
|---|---|---|---|
| DATA | sync Shopify lecture seule → Supabase (catalogue, stock, coûts, commandes, remboursements) | `src/sync/*`, `src/shopify/*`, migrations `2026092*`, commits `64e727e` `66e7474` `34d0350`, tests `catalog/cost/inventory/orders/normalize/shopify-client` | Codé + connecté (dev). Historique limité à 60 j |
| DATA QUALITY | règles + flags persistés | `src/quality/*`, table `data_quality_flags`, `test/quality.test.js`, `triage.test.js` (commit `92bceee`) | Codé + connecté |
| METRICS | ventes/profit, demande/stock | `src/metrics/*`, `src/demand/*`, `docs/metrics/*`, commits `a167ba6` `60fea27`, tests `metrics`, `demand` | Codé |
| Signaux | candidat commercial, risque cash | `src/signals/*` | Codé, sans recommandation |
| Décision (domaine achat) | table de décision déterministe | `src/buying/evaluate.js`, commits `dad5e52` `5c24c20` `e47f47f`, `buying.test.js` | Codé (un seul domaine) |
| Mesure marketing / clients | facts + gates + contrats « Phase 3 » | `src/marketing/*`, `src/customers/*`, commits `e07842f` `5fb8203` `9f60886` `c7f0f77` | Codé |
| Finance (module optionnel) | devis→facture→avoirs, TVA, pack comptable, journal d'événements immuable | `src/finance/*`, migration `20260921200000`, commit `d6fbfb6`, tests `finance-*` | Codé, rien d'envoyé à l'extérieur |
| EXPLICATION LLM | — | `grep` : **aucun appel LLM dans `src/`** | **Absent** |
| DECISION LEDGER / OUTCOME | — | schéma : « No metrics/decision/outcome tables » | **Absent** |

### A.1 Les cinq capacités

| # | Capacité | Objectif métier | Statut | Preuves | Écart vs cible | Travaux restants | Priorité / risque |
|---|---|---|---|---|---|---|---|
| 1 | **Company Intelligence / Brain** | Vue unifiée et mémorisée de l'entreprise à partir de tous les modules | **Absente** (briques partielles) | Convention de *provenance* par bloc (`evidence_kind`, `completeness`, `causal_claim:false`) ; `buildLedger` (`src/metrics/ledger.js`) ; `data_quality_flags` | Pas de modèle d'entités/faits partagé, pas de persistance des faits calculés (rapports = JSON locaux gitignorés), pas de mémoire, pas de lecture inter-modules sauf `loadDataset` | Schéma de faits persistés versionnés, registre d'entités, API de lecture unique, contrat de provenance commun | **P1** — fondation de tout le reste. Risque : sur-modélisation ; couplage si chaque module écrit son format |
| 2 | **Business Doctor** | Détecter les problèmes (qualité, marge, cash, stock, impayés) | **Partielle** | `src/quality`, `src/analysis/triage.js`, `src/signals/cash-risk.js`, `receivables.js`, `docs/data-quality/rules.md` | Détections isolées par module, pas de constat typé commun (gravité, preuve, propriétaire), pas de planification, pas d'historique des constats | Objet `Finding` unique + adaptateurs des signaux existants, persistance, dédoublonnage, exécution planifiée | **P1/P2**. Risque : « score global » (le projet a choisi *no score*) — à trancher |
| 3 | **Opportunity Engine** | Identifier et chiffrer les opportunités | **Partielle (fragments)** | `signals/commercial.js` (COMMERCIAL_CANDIDATE), signaux search (`HIGH_IMPRESSIONS_LOW_CTR`…, `recommendation:null`), `docs/principles/decision-principles.md` (« not yet enforced by code ») | Aucun objet Opportunité, aucun classement/chiffrage, principes de décision non appliqués en code | Objet `Opportunity`, adaptateurs, gabarit de chiffrage honnête (UNAVAILABLE si donnée manquante), filtre par principes | **P2**. Risque : opportunités basées sur 60 j d'historique |
| 4 | **Decision Engine** | Aider à décider, avec approbation humaine tracée | **Partielle, mono-domaine** | `buying/evaluate.js` (décision par checks nommés) ; finance : `APPROVE/MODIFY/REJECT` + `fin_events` append-only + hash SHA-256 | Pas de moteur générique ; l'approbation n'existe que pour les factures ; `docs/architecture/overview.md` : « Not built yet » | Objet `Decision` + règles déclaratives, généralisation du modèle d'approbation finance | **P2**. Risque : généraliser trop tôt le modèle finance |
| 5 | **Outcome Learning** | Mesurer le résultat des décisions | **Absente** | Seulement des contrats « Phase 3 » qui n'exposent des faits que si les gates sont ouverts (`marketing/phase3-contract.js`, `customers/phase3-contract.js`) | Aucune table, aucun suivi, aucun avant/après | Table résultats, fenêtres de mesure, comparaison contrefactuelle prudente, rétro-alimentation | **P3**. **Blocage dur** : ~60 j d'historique (`read_all_orders` refusé), un seul marchand, volumes faibles → pas de conclusion causale possible |

### A.2 Services transversaux

| Service | Statut | Preuves / écart | Travaux | Prio |
|---|---|---|---|---|
| Command Center & onboarding | **Absent** | Seulement des scripts `npm run …` ; dashboard interdit par CLAUDE.md §8 | Non démarrer avant Brain/Ledger ; onboarding marchand (connexion, config, qualité) | P4 |
| Identité entreprise, séparation marchands, autorisations | **Partielle** | `merchant_id` sur les tables, identité `(source_system, source_id)` (commit `7a73e7f`), RLS activé *service role seulement*. Finance : `FINANCE_ACTOR=merchant:<nom>` = **variable d'environnement, pas une authentification** | Utilisateurs, rôles, policies RLS par tenant, tests d'isolation multi-marchands (un seul marchand testé) | **P1** |
| Agent Registry / Orchestrator | **Absent** | « Finance Operations Agent » est un module CLI, pas un agent enregistré ; CLAUDE.md interdit d'autres agents | Registre minimal (capacités, entrées/sorties, permissions, budget) avant tout nouvel agent | P2 |
| Mémoire & Evidence Registry | **Partielle** | Provenance par bloc, `fin_events` ; pas de registre | Registre d'évidences adressables (id, source, fenêtre, version de calcul) référencé par constats/décisions | **P1** |
| Approval System & Decision Ledger | **Finance seulement** | `fin_events` (append-only), documents verrouillés par triggers | Ledger générique (décision + preuves + approbateur + version) | P2 |
| Communication entre modules | **Partielle** | Appels de fonctions + gates `phase3-contract` ; pas de bus, pas de jobs | Contrat d'événements/jobs, planificateur | P2 |
| Parle à Nordla | **Absent** | Aucun code LLM ; règle « pas de PII vers un LLM » en doc seulement | Couche LLM *lecture seule* sur Brain/Evidence, redaction PII, citations obligatoires | P3 (après ledger) |
| Sécurité, gouvernance IA, plafonds de dépense | **Partielle (docs)** | `docs/security/baseline.md`, Shopify lecture seule, clé client pseudonymisée HMAC. Rate limiting/CORS différés. Branch protection « not yet configured » (état actuel non vérifié). Pas de CI. Aucun plafond de dépense IA | CI, secret scanning, plafonds tokens/€ par marchand, journal des appels IA | P1 (CI/sécurité) / P3 (IA) |
| Résilience, sauvegardes, récupération | **Non trouvé** | Rien dans le code ; process décrit dans le skill `safe-deployment` (non vérifié ici) | Sauvegardes testées, runbook de restauration, migrations réversibles | P1 |

### A.3 Découpage proposé (à valider — la définition n'existe pas dans le dépôt)

- **Fondations techniques communes** : identité/autorisations multi-tenant, persistance des faits, Evidence Registry, planificateur/jobs, CI, sauvegardes, observabilité, plafonds de dépense.
- **Core Standard** : données fiables + qualité + métriques + signaux par domaine, décisions mono-domaine avec approbation humaine, Finance. **≈ largement atteint** en code (dev).
- **Core Complete** : Brain inter-modules, Business Doctor et Opportunity unifiés, Decision Engine + Ledger générique, Outcome Learning, Parle à Nordla, Command Center.

### A.4 Critères pour déclarer « Core complet » (proposition)

1. Un second marchand fictif et un marchand réel cohabitent avec **tests d'isolation** (RLS) passants.
2. Tout constat/opportunité/décision référence des évidences du registre ; **zéro chiffre non traçable**.
3. Au moins deux modules différents alimentent le Brain, et un constat croise leurs données.
4. Une décision traverse tout le pipeline : constat → explication → approbation humaine → ledger → mesure de résultat.
5. Aucune action externe sans approbation enregistrée ; plafonds IA appliqués et testés.
6. Sauvegarde restaurée avec succès en test ; CI verte ; migrations revues.
7. Déploiement production **approuvé explicitement** et exécuté au moins sur un marchand pilote (aujourd'hui : 0).

## B. NORDLA MARKETING INTELLIGENCE COVERAGE MAP

Recherche textuelle de chaque nom (store experience, search & demand, next best product, merchandising, lifecycle, contact pressure, creative fatigue, reputation, local events, social trend, competitor) dans code, docs et commits : **aucune occurrence**. Aucun mandat tracé dans le dépôt pour ces intelligences.

| Intelligence | Statut | Briques réutilisables (preuves) | Manque réel | Prio / risque |
|---|---|---|---|---|
| Store Experience | **Absente** (données voisines) | Faits de pages d'atterrissage des commandes, import trafic, gate de conversion (`marketing/traffic.js`, `build.js`) | Comportement par session (entonnoir, vitesse, appareil) : Shopify Analytics exige `read_reports` + données client protégées, **non disponible** | P3 — bloqué par accès données |
| Search & Demand | **Partielle (la plus avancée)** | `marketing/search-visibility.js` + signaux d'opportunité (commit `5fb8203`, `search-visibility.test.js`), `demand/*` (2B) | Import Search Console manuel seulement ; pas de tendance de demande externe ni mots-clés | **P1 marketing** — étendre, pas recréer |
| Merchandising / Next Best Product | **Absente** (données voisines) | Paires de co-achat (`customers/facts.js`), `demand/classify.js`, `signals/commercial.js`, `buying/*` | Logique de recommandation produit, règles de mise en avant ; volumes faibles | P3 — dépend du Decision Engine |
| Customer Lifecycle / Contact Pressure | **Absente** (données voisines) | Clé client pseudonyme, répétition, délai entre achats (`customers/customer-level.js`) | **Journal des contacts envoyés** (email/SMS) inexistant ; outils type Klaviyo exclus par CLAUDE.md §6 ; pas de prédiction (hors périmètre 2E) | P3 — besoin d'une source de contacts |
| Creative Fatigue & Reputation | **Absente** | Import pub (`marketing/paid.js`) : impressions/clics/coût par campagne, date optionnelle | Granularité créa/jour, fréquence, avis/réputation : aucune source | P4 |
| Local Events & Opportunities | **Absente** | Marchés cibles en config, règle d'intention `local` | Source d'événements externes, calendrier, géolocalisation magasin | P4 — dépend du socle signaux externes |
| Social Trend Radar | **Absente** | « Not built : external trend data » (`marketing-measurement.md`) ; listes d'hôtes sociaux pour classer le trafic | Sources de tendances, conformité CGU/scraping | P3 |
| Competitor & Market Radar | **Absente** (aucune trace) | — | Sources, légalité, fraîcheur | P3 |

### B.1 Architecture d'intégration proposée : 4 moteurs, pas 8 agents

1. **Measurement Engine** (existe : `src/marketing/*`) — absorbe Store Experience, Creative Fatigue (volet pub) et Search & Demand (faits internes). *Extension, non reconstruction.*
2. **External Signals Engine** (nouveau, un seul) — adaptateurs de sources externes avec provenance/fraîcheur/licence communes. Sert **Social Trend Radar, Competitor & Market Radar, Local Events, tendances de demande** : un moteur, plusieurs « lentilles ». Articulation voulue : Social Trend = signaux sur la *demande/attention* ; Competitor & Market = signaux sur *offre/prix/positionnement* ; même collecte, mêmes garde-fous.
3. **Customer Journey Engine** (extension de `customers/*` + nouveau journal de contacts) — Lifecycle + Contact Pressure.
4. **Merchandising Engine** (extension de `demand` + `customers` + `buying`) — Next Best Product.

Tous produisent des **faits + provenance** (`recommendation:null`) et passent par Finding/Opportunity/Decision du Core ; aucun n'agit seul.

## C. Plan par phases

Coûts : ordres de grandeur d'effort ingénieur, **estimations non mesurées** (S ≈ 2-4 j, M ≈ 1-2 sem., L ≈ 3-5 sem.).

| Phase | Contenu | Coût | Risques | Critères de validation |
|---|---|---|---|---|
| **0** Cadrage | Valider ce périmètre ; définitions Standard/Complete ; mise à jour de `CLAUDE.md` §8 ; nommer « Nordla » vs `retail-ai-core` | S | Mandat flou | Périmètre signé, `CLAUDE.md` aligné |
| **1** Fondations | CI, sauvegarde/restauration testée, identité + RLS multi-tenant, persistance des faits, Evidence Registry | L | Migrations sur données réelles ; isolation | Tests d'isolation, restauration réussie, CI verte, migrations revues |
| **2** Brain + Doctor + Opportunity | Modèle commun, objets Finding/Opportunity, adaptateurs des signaux existants | L | Couplage, ambiguïté « pas de score » | Constat croisant 2 modules, 100 % chiffres traçables |
| **3** Decision + Ledger + Registry d'agents | Ledger générique, généralisation approbations, registre minimal | M | Sur-généralisation | Décision de bout en bout, journal immuable (triggers) |
| **4** Parle à Nordla + plafonds IA | Couche LLM lecture seule, redaction PII, budget | M | PII, coûts, hallucination | Chaque phrase chiffrée cite une évidence ; plafond testé |
| **5** Outcome Learning | Suivi résultats | M | **Historique 60 j** | Mesure avant/après sur ≥ 1 décision réelle, sans claim causal |
| **6** Command Center | Interface + onboarding | L | Périmètre | Marchand de test onboardé sans CLI |
| **M1** (parallèle dès phase 1) | Search & Demand : connecteur Search Console, extension 2D.2 | M | OAuth/scopes | Import sans manuel, tests existants inchangés |
| **M2** | External Signals Engine + premier radar (Social **ou** Competitor) | L | Légalité/CGU, qualité des sources | Provenance + fraîcheur + licence par fait |
| **M3** | Customer Journey (+ journal de contacts) | M | PII, source de contacts | Contact pressure calculé sans PII brute |
| **M4** | Merchandising/Next Best Product, Local Events, Creative/Reputation, Store Experience | L | Données indisponibles | Chaque intelligence documente ses gates |

## D. Décisions demandées

1. Confirmer que « Nordla » = ce dépôt (ou indiquer où se trouvent les décisions du 8 octobre et tout Marketing plus avancé).
2. Valider le découpage Standard / Complete / Fondations (A.3).
3. Autoriser la levée des restrictions de `CLAUDE.md` §8 pour les phases choisies.
4. Choisir entre « no score » et un indicateur de santé global (Business Doctor).
5. Trancher `read_all_orders` (conditionne Outcome Learning) et `read_reports` (Store Experience).
6. Choisir le premier radar externe (Social Trend ou Competitor) et le cadre légal des sources.
