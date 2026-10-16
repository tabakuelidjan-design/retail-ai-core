# Tableau de convergence Nordla — avant le départ en Chine (2026-10-16)

Branche `integration/nordla-convergence-v1` (worktree `retail-ai-core-convergence-wt`), **locale, non poussée, non fusionnée**.
Base vérifiée : `origin/claude/nordla-core-p0` @ `92297c8` (PR #10, #12, #13 déjà revues : fiabilité B, Core, Parle phase 1-2, intégration).
Fusionné dessus : `feature/stock-achat-v1` (chantier C) @ `c4d2e3f` → commit `f88e225`. **Un seul conflit**, dans
`.github/workflows/nordla-integration-pre-china.yml` (résolu en gardant le côté core-p0 : Node 20 exclut les tests Core/sourcing).
Aucune branche A, B ou C n'a été modifiée. Aucun secret, déploiement, DNS, migration ou fusion dans main.

Règle : « fonctionnel » = prouvé de bout en bout. Des tests unitaires verts ne suffisent pas.

## 1. Les trois chantiers

| Chantier | Branche · tip | Dans la base de convergence ? | Preuves | Reste / blocage réel |
|---|---|---|---|---|
| **A — Parle à Nordla** | `claude/nordla-core-p0` 92297c8 (phases 1-2 fusionnées, PR #12/#13) ; **phase 3 UI** `feature/core-field-assistant-phase3` 0dc2dbb, **en cours dans une autre session** (commit de ce matin) | phases 1-2 : oui. Phase 3 : **non** (en mouvement, à fusionner quand A la déclare stable) | 16 intentions lecture seule, 56/56 sur le harnais ; e2e navigateur 390 px (phase 3) | Pas de LLM ni de voix Xiaomi. Contexte conversationnel branché en HTTP à partir de la phase 2. **Parle ne sait pas encore interroger Achats/Stock** (voir §3) |
| **B — Infra / Railway** | même branche (staging-db, handoff Railway) + `claude/nordla-core-reliability` d85ec46 (déjà fusionné par #10) | oui | Supabase staging : migrations identité 2-5 appliquées, marchand HABB test, sauvegarde/restauration prouvée ; image Docker auditée en local (healthz, 401, 403, 421, CSP) ; CI verte Node 20+24 | **Service `sourcing-staging` non activé** (accord + 2-4 $/mois), secrets à saisir par vous, DNS `app.nordla.app` non autorisé. Dernier run staging-db : mot de passe refusé par le pooler (corrigé ensuite, voir bilan) |
| **C — Stock / Achats** | `feature/stock-achat-v1` c4d2e3f (pushé) | **oui** (`f88e225`) | 3 magasins (mémoire/fichier/PG) avec parité ; CI `procurement-stock-v1` verte Node 20+24 + PG | PG non branché en prod ; **serveur Achats autonome, pas monté sur le serveur hébergé** (§3) ; jamais testé sur vrai téléphone |

### Tests de la base de convergence (Node 24.19, Windows)
- Cibles : `integration-contracts`, `integration-workflows`, `procurement-*`, `core-field-assistant` → **153 tests : 142 pass, 0 fail, 11 skipped** (skips = chemins PostgreSQL / fournisseur réel, comme sur les branches d'origine).
- Suite complète : voir §7 (en cours au moment de la rédaction).

## 2. Matrice des composants

| Composant | Réellement fonctionnel (prouvé) | Intégrable maintenant | Bloqué / manquant |
|---|---|---|---|
| Identity | Sessions serveur, rôles, OWNER staging, RLS vérifiée | oui (seam `actor` du serveur hébergé) | Achats a **son propre login** (`PROCUREMENT_USERS`) : deux identités |
| China Sourcing | Dossiers, photos, hors-ligne, sync, sauvegarde chiffrée + restauration | oui | Non testé sur Xiaomi (test prévu 18/10) ; 8 tests sourcing échouent sur Windows (chemin `C:\C:\`), **identiques sur la base d'origine** |
| Buying | `PurchaseOrder` DRAFT→…→RECEIVED, approbation nommée usage unique, séparation des tâches | oui | modèle canonique **à valider** (§4) |
| Stock | Registre de mouvements, valorisation moyenne pondérée, réceptions | oui | pas d'écrans réception/ajustement/inventaire |
| Finance | Lecture seule (échéances, trésorerie, achats), `purchase-analysis` pour le coût rendu | oui | 3 moteurs de coût rendu coexistent : **un seul doit faire autorité** (décision en suspens depuis le 14/10) |
| Parle à Nordla | 16 intentions terrain, verdict honnête | partiellement | pas relié à Achats/Stock ; pas de LLM |
| Hub d'intégration | Politique d'approbation, registre d'identifiants, ledger, 15 outils Achats déclarés | oui en bibliothèque | **jamais instancié par le serveur hébergé** (seul `creative-e2e` l'appelle) |

## 3. Constat central : les modules ne sont pas encore « un seul système »

Vérifié par `grep` sur la base de convergence :
1. `src/sourcing/**` et `src/core-pilot/**` ne référencent **pas** `procurement` → Parle à Nordla ne peut pas lire une commande ni un stock.
2. `src/procurement/server` est un **serveur à part** (port propre, utilisateurs propres, `data/local/procurement`), pas monté sur `app.js` du serveur hébergé.
3. Le hub `src/integration` est une bibliothèque testée, sans appelant côté serveur.

Conséquence : le parcours demandé (connexion → Parle → Sourcing → comparaison → fournisseur → bon de commande brouillon → retrouver dans Nordla → fermer/rouvrir → approbations) n'est **pas démontrable aujourd'hui** en une seule application, même si chaque maillon a ses tests. Le seam propre existe : `src/sourcing/server/app.js:78` délègue déjà `/api/core/*` à `core.handle(req,res,url,actor)`.

### Plan d'intégration minimal (vague 1, aucun nouveau module)
| # | Travail | Fichiers partagés touchés | Risque |
|---|---|---|---|
| 1 | Monter l'app Achats sur `/api/procurement/*` du serveur hébergé, authentifiée par l'`actor` Identity (supprime `PROCUREMENT_USERS`) | `src/sourcing/server/app.js` (1 ligne de routage) + `hosted.js` | moyen (fichier de A) |
| 2 | Instancier le hub dans le Core et l'appeler depuis `ask.js` pour les intentions Achats/Stock/coût rendu | `src/core-pilot/ask.js`, `field-intents.js` (A) | moyen — **à faire après la phase 3 de A** |
| 3 | Test d'intégration transactionnel : compte → dossier Sourcing → 2-3 offres → coût rendu Finance → PO brouillon → approbation refusée au non-autorisé → redémarrage → données retrouvées | nouveaux fichiers de test seulement | faible |
| 4 | Fusion de la phase 3 (UI Parle) quand A la déclare stable | — | à coordonner |
| 5 | Écran « Achats » dans l'entrée Nordla (le téléphone ouvre déjà l'app Achats autonome ; à rattacher au menu) | UI hébergée | moyen |

## 4. Un seul événement métier = une seule vérité (recouvrement résolu, **à valider par vous**)
Source : `stock-achats-v1-ac-arbitrage.md` (chantier C, non commité dans sa branche) + `src/integration/procurement-compat.js`.

| Objet | Propriétaire canonique | Traitement |
|---|---|---|
| `BUY_CANDIDATE` (verdict + approbation) | Sourcing/A, écrit une fois | C n'en garde que la **référence** |
| `PurchasePlan` | **`PurchaseOrder` de C** | le plan devient une **vue** (DRAFT/PENDING/APPROVED) |
| `IncomingExpectation` | **C**, dérivé | = quantités restantes des commandes **passées** ; jamais stocké ; jamais compté dans le disponible |
| Réception / stock | C | — |
| Journal inter-modules | A (ledger du hub) ; C garde `proc_events` (métier) | deux portées distinctes |

Décisions qui vous reviennent : (a) PurchaseOrder = modèle canonique, (b) ne **pas appliquer** les tables `integration_purchase_plans` et `integration_incoming_expectations` de la migration préparée par A, (c) « attendu en entrée » = commandé et non reçu. **Ne pas exécuter la migration de A telle quelle** tant que ce n'est pas tranché.

## 5. Pôle Branding · Marketing · Création · Assets · Validation

État réel, sans optimisme :

| Pôle | État réel | Déjà utilisable | Manque / blocage | Dépendances |
|---|---|---|---|---|
| **Branding** | Module complet en code (Gardien, mémoire, contrats) ; proposition HABB tirée de `business-principles.md` | Contrôle automatique de textes/affirmations | **Proposition non approuvée par vous** ; aucun logo/couleur approuvé dans le module ; aucune affirmation produit approuvée | Votre approbation dans l'app (rôle Propriétaire) ; source riche existante : `HABB_OS/BRAND_RULES.md`, `VISUAL_RULES.md`, `MARKETING.md` |
| **Marketing** (M1→M4) | Propositions de campagne sur données Analytics, calendrier/signaux, blocages listés, décision humaine journalisée | Idées/priorités à partir des ventes | Sans affirmations approuvées, ne passe pas à la Création ; pas de **calendrier éditorial réel** alimenté ; données réelles HABB non lues (connecteur non conforme) | Branding approuvé ; Analytics synchronisé |
| **Création** | Visuel **local sans fournisseur** : photo gardée au pixel + titre Playfair → PNG 1080×1350 reproductible, contrôles de fidélité, décision propriétaire. Génération IA = **BLOQUÉ** | 1 mise en page (photo + titre) | Pas de fournisseur IA (Alibaba prévu, clés + budget = **votre décision**) ; pas de stories/variantes/formats multi-canaux ; PM-6 non corrigé (non utilisé par le visuel local) | Photos produits HABB (dossier `Produits HABB`) |
| **Assets** | Photos produits, mockups, logos/icône, cartes de visite, affiches existent **sur disque** (dossiers HABB) | — | **Aucun import dans Nordla**, pas d'index ; tri « approuvé / non approuvé » à faire | Vous (validation des références) |
| **Workflow de validation** | Propose → décision PROPRIÉTAIRE avec raison → journal : **existe** pour Branding/Marketing/Création | Oui, dans l'app | La mise en file « publication prête » : l'exécution Instagram/TikTok/GBP est `ADAPTER_READY` seulement (tests sur doubles) | OAuth, coffre d'identifiants, validation des apps = **pas avant le départ** |
| **Contenus prêts avant départ** | **0 contenu réel** produit par Nordla | — | Le moteur ne produira pas 2 semaines de contenu avant le 18/10 sans fournisseur IA | voir plan ci-dessous |

### Plan le plus court (honnête)
Nordla **ne peut pas** produire une réserve de 2 semaines avant le départ avec ses seuls moteurs actuels : la génération est bloquée, la publication n'est pas connectée. Pour que la présence HABB reprenne **malgré** cela :
1. **Maintenant, sans Nordla** : réserve de 14 jours (calendrier, légendes fr-BE, accroches, visuels) produite avec ce que vous payez déjà (Canva — connecteur disponible dans cette session —, CapCut, ChatGPT) et les règles `HABB_OS`, avec les agents HABB (marketing-growth, creative-director, content-producer). Validation par vous, publication manuelle/planifiée via Meta Business Suite/Canva.
2. **Dans Nordla** : importer ce stock dans le workflow de validation existant (assets + textes approuvés) ; approuver la proposition de marque (5 min) pour débloquer la chaîne Marketing → Création locale.
3. **Après le départ** : fournisseur IA + budget, puis publication gouvernée.

Je ne lance pas cette production sans votre feu vert (c'est un volume de travail et de décisions de marque).

## 6. Parcours utilisateur (9 étapes)

| # | Étape | Statut aujourd'hui |
|---|---|---|
| 1 | Connexion | prouvé en local ; staging : compte OWNER prêt, service non activé |
| 2 | Parle consulte un fournisseur | partiel : lit les dossiers Sourcing/Core, **pas Achats** |
| 3 | China Sourcing : enregistrer un produit en visite | prouvé (Sourcing e2e ; Achats a sa propre capture) — Xiaomi non testé |
| 4 | Comparer offres + coûts rendus | comparateur P11-lite + `purchase-analysis` ; **moteur de coût rendu faisant autorité à choisir** |
| 5 | Sélectionner un fournisseur | prouvé côté Achats ; **non relié** au verdict Core |
| 6 | PO brouillon dans Buying | prouvé côté Achats (autonome) |
| 7 | Retrouver commande/produits depuis Nordla | **non câblé** (§3) |
| 8 | Fermer/rouvrir : persistance | prouvé séparément (journal Core, fichier/PG Achats) ; pas dans un seul parcours |
| 9 | Approbations explicites | prouvé (politique du hub, usage unique, séparation des tâches) |

**Aucune étape n'a été jouée de bout en bout sur une instance unique.** C'est la vague 1 ci-dessus.

## 7. Anomalies préexistantes
| Anomalie | Impact démontré | Classe |
|---|---|---|
| 8 tests `sourcing-*` échouent sur Windows (`C:\C:\`) | identiques sur base d'origine ; passent sous Linux/CI | non bloquant |
| `Creative Intelligence V1` rouge par intermittence (benchmark-preflight, Node 24) | flake documenté, relance verte | non bloquant |
| `verdictDisplay` : CONDITIONAL_GO avec blocage dur | corrigé côté A (PR #13) | résolu |
| « Dois-je acheter » journalise à chaque question | bruit de journal | à surveiller |
| PM-6 masque produit instable sous charge | pas utilisé par le visuel local | non bloquant (Création IA) |

## 8. Conditions exactes de mise en service de test
1. Votre accord : activation `sourcing-staging` (2-4 $/mois), secrets saisis par vous, adresse (Railway d'abord, `app.nordla.app` si DNS autorisé).
2. Vague 1 §3 faite et tests verts sur une branche **poussée** (CI Node 20+24) — nécessite votre accord pour pousser.
3. Décisions §4 et moteur de coût rendu.
4. Test Xiaomi du 18/10 (fiche 12 lignes) : rien n'est « prêt pour la Chine » sans lui.
5. Retour arrière : aucune branche source modifiée ; la convergence se jette en supprimant `integration/nordla-convergence-v1` ; staging : restauration prouvée (artefact conservé jusqu'au 14/11).
6. Réseau : tout est local au téléphone (file d'envoi) sauf sync, connexion, Parle (serveur), sauvegarde hors serveur ; l'écran doit le dire (à vérifier au test).

## 9. Opérations soumises à votre approbation (rien n'a été fait)
Pousser la branche · activer Railway · DNS · appliquer des migrations · fournisseur IA/budget · approuver la marque · publier quoi que ce soit.
