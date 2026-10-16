# Parle à Nordla — rapport de chantier « assistant de terrain, phase 1 »

Branche `feature/core-field-assistant` → PR brouillon vers `claude/nordla-core-p0`. Aucune fusion, aucun déploiement, aucune donnée réelle, aucun appel réseau, aucun nouveau fournisseur IA. Données de test : 100 % synthétiques.

## 1. Audit initial (avant toute modification)
Mesuré sur le commit de base `99f495b` avec les mêmes 56 questions que l’après (`core-field-assistant-eval/`, `results-before.json`).

| Constat | Détail |
|---|---|
| Questions de terrain comprises | **9 / 56**. Seuls « résume ce dossier », « dois-je acheter ? », Finance/Analytics « non raccordé » et le refus honnête répondaient. |
| « Qu’est-ce qui manque ? », « quels risques ? », « quelle marge ? », « quelle prochaine étape ? », « puis-je commander ? » | `NOT_UNDERSTOOD` (liste générique de ce que Nordla sait faire). |
| Données réellement disponibles et inexploitées | `assess()` fournit déjà : blocages durs, conditions, documents manquants, questions fournisseur (EN/ZH), coût rendu (complet / borne basse), marge (+ borne haute), prix maximum, origine du prix (OBSERVED/TARGET/ASSUMED), fraîcheur des sources. Le résumé existant n’en montrait qu’une partie. |
| Risque de confusion constaté | Le résumé existant affiche `verdict CONDITIONAL_GO` même quand un **blocage dur** interdit l’achat (le blocage n’est que dans une ligne séparée). Un lecteur pressé peut y voir un feu vert. |
| Données manquantes prises pour connues | Aucun cas d’invention de chiffre trouvé dans le flux existant (0 fuite sur les cas vides). Mais le coût rendu **borne basse** n’est pas transmis au sujet Core (`landed_total` = null) : le Core le traite comme « inconnu », ce qui est prudent mais peu parlant. |
| Limites du routeur (`integration/router.js`) | 7 règles, aucune pour manques/risques/marge/étape ; « résume » exige le mot « dossier » ; pas de tolérance fautes/accents/EN. Non modifié (fichier partagé). |
| Écriture sur question | « dois-je acheter ? » **journalise** une analyse à chaque question (conçu ainsi). Non modifié. |
| Règles propriétaire | `ownerRules: []` : aucune règle budget/marge/trésorerie ; respecté et énoncé dans les réponses. |

## 2. Comparaison mesurée avant / après
Même jeu (56 questions, 11 catégories), même moteur, mêmes dossiers synthétiques.

| Catégorie | Avant | Après |
|---|---|---|
| B1 comprendre un dossier | 1/7 | 7/7 |
| B2 risques et vérifications | 0/7 | 7/7 |
| B3 rentabilité et prix | 0/9 | 9/9 |
| B4 décisions et prochaines actions | 1/10 | 10/10 |
| B5 transversal (Finance/Analytics/modules) | 3/4 | 4/4 |
| Frontière marge fournisseur / ventes | 1/3 | 3/3 |
| Fautes et accents | 0/5 | 5/5 |
| Français/anglais mélangés | 0/3 | 3/3 |
| Limites honnêtes (multi-dossiers, hors sujet) | 3/3 | 3/3 |
| Pas de dossier ouvert | 0/2 | 2/2 |
| Dossier vide (aucun chiffre) | 0/3 | 3/3 |
| **Total** | **9/56** | **56/56** |

Fuites de chiffre sur dossier vide : **0 → 0**. Écritures inattendues : **0 → 0**.

**Lecture honnête du 56/56** : ce jeu a servi à régler les règles, il n’est donc pas un test indépendant. Un jeu de contrôle de 37 formulations nouvelles (`heldout.mjs`) a donné **29/37 avant réglage**, avec **0 mauvaise intention** : les 8 échecs étaient tous « non compris » ou « ambigu » (échec sûr, jamais une mauvaise réponse). J’ai ensuite ajouté les règles manquantes → 37/37, mais ce score-là n’est plus indépendant non plus. Estimation raisonnable de généralisation : environ 75–80 % de reconnaissance sur des formulations inédites, le reste tombant en question de précision.

## 3. Matrice question → intention → données → réponse → limites
(Exemples complets et réels : `core-field-assistant-eval/examples.md`.)

| Question type | Intention | Données utilisées | Réponse attendue | Limites |
|---|---|---|---|---|
| « Qu’est-ce qu’on sait sur ce fournisseur ? » | KNOWLEDGE | verdict, devis, coût rendu, marge, Safety Gate, inconnus | savoir / ne pas savoir / risques / prochaine vérification / sources | un dossier à la fois |
| « Qu’est-ce qui manque ? / dossier complet ? » | MISSING | documents manquants, coûts critiques, questions P1, rôle | liste des manques ; « pas complet » ; jamais « complet » sans preuve | « rien signalé » ≠ garanti complet |
| « Quels documents vérifier ? » | DOCUMENTS | `gaps.missingDocs`, contradictions, documents reçus et leur état | documents à obtenir/contrôler | un document reçu reste une déclaration du fournisseur |
| « Quels risques ? / qu’est-ce qui peut bloquer ? / quelles preuves manquent ? » | RISKS | blocages durs, conditions, couverture réglementaire, fraîcheurs | 3 niveaux : bloquant établi / alerte / pas évalué | n’invente aucun risque hors moteur |
| « Quelle marge ? / combien gagner ? » | MARGIN | contribution, % net, origine du prix, effet « si tout se vend » (levier Core) | marge unitaire + hypothèse + origine du prix ; ou « incalculable » et pourquoi | borne haute signalée si coûts inconnus |
| « Coût rendu ? » | LANDED_COST | `assess().landed` | coût complet, « au moins X » si borne basse, ou « incalculable » | — |
| « Combien coûte la commande ? » | ORDER_TOTAL | coût rendu total, achat vs import | total pour la quantité du devis | idem |
| « Quel prix manque pour la rentabilité ? » | PRICE_GAP | coûts critiques, prix de vente/TVA, prix max | liste exacte des données absentes | — |
| « Prix de vente observé ou estimé ? » | PRICE_BASIS | `priceBasis` | OBSERVED / TARGET / ASSUMED en clair | une annonce vue ≠ droit de vendre |
| « Quels coûts non pris en compte ? » | UNCOUNTED_COSTS | composants de coût non saisis | liste (assurance, inspection, tests…) | ne prouve pas l’absence d’autres coûts |
| « Et si j’achète la quantité minimale ? » | MOQ_SCENARIO | `economicsScenario` au MOQ + levier Core | coût rendu et marge à la quantité minimale | prix unitaire du devis supposé constant |
| « Puis-je commander ? » | CAN_ORDER | verdict, `canCommitMoney`, blocages, règles propriétaire | « Pas à ce stade » ou « pas une autorisation de payer » | Nordla ne commande/paie rien |
| « Quelle prochaine étape ? / que vérifier ? » | NEXT_STEP | blocages → action concrète | étape ordonnée par gravité | texte moteur original cité en anglais |
| « Quelles questions poser avant de signer ? » | SUPPLIER_QUESTIONS | questions P1 du moteur (EN + 中文) | liste prête à lire/envoyer | uniquement celles que le moteur génère |
| « Ce prix est-il bon ? » | PRICE_JUDGEMENT | prix du devis vs prix maximum calculé | sous / au-dessus du maximum | aucun prix de marché lu |
| « Pourquoi cette recommandation ? / options écartées ? / pourquoi Nordla hésite ? » | EXPLAIN_RECOMMENDATION | dernière entrée du journal du dossier | recommandation, raisons, faits déterminants, options écartées + raisons, règles propriétaire (aucune), ce qui pourrait changer | ne lance jamais d’analyse ; dit si l’analyse est périmée |
| « Quels modules sont connectés ? » | (ask.js) | table `NOT_CONNECTED` | disponible / non relié avec raisons | — |
| « Marge de ce fournisseur sur mes ventes » | ASK | — | demande de précision | — |
| « Compare mes deux propositions », « résume ma journée » | NOT_UNDERSTOOD/ASK | — | refus honnête | multi-dossiers hors périmètre |

## 4. Tests
- **`test/core-field-assistant.test.js` — 27 tests** : reconnaissance (≈70 formulations, accents, fautes, FR/EN, précision/négatifs, frontières Finance/Analytics, ambiguïtés), non-régression des flux existants, **égalité des chiffres avec le moteur** (marge, coût rendu, total, MOQ), absence d’invention (dossier vide), données partielles (coût borne basse), origine du prix, blocage dur, « puis-je commander », risques à trois niveaux, manques/documents/étape, dossier absent / non synchronisé, **non-écriture** (journal vide, dossiers inchangés, `fetch` piégé, lecteurs Finance/Analytics jamais appelés), forme du résultat sans champ d’action, **texte fournisseur malveillant** (nom de produit, fichier, document), **absence de secrets** (variables d’environnement piégées), **isolation** marchands/dossiers (seul le dossier demandé est lu), explication de recommandation (journal lu, jamais écrit, périmée si le dossier change), contexte conversationnel (même dossier, changement de dossier/version/marchand), état sans chiffre, déterminisme.
- **Contrôle par mutation** : 5 altérations volontaires du code (commande toujours ouverte, nettoyage de texte retiré, règle propriétaire inventée, chiffre faussé, écriture au journal) — **les 5 sont détectées** par la batterie.
- Aucun test existant modifié ni affaibli.

### Résultats d’exécution (réellement obtenus)
| Suite | Environnement | Résultat |
|---|---|---|
| `core-field-assistant.test.js` | Windows 11, Node 24.19 | 27/27 |
| Core / Buying / Socle / intégration / benchmark ask (`buying`, `core-modules`, `core-pilot`, `core-readers`, `core-reliability*`, `core-tenant-decoupling`, `integration-contracts`, `integration-workflows`, `socle-decision`, `sourcing-voice-core`, `benchmark-ask`) | Windows 11, Node 24.19 | 217 réussis / 0 échec (avant les derniers ajouts) |
| `test/e2e/core-pilot.e2e.js` (navigateur Edge) | Windows 11 | 5/5 |
| Suite complète Linux (CI `core-reliability`, workflow_dispatch sur la branche, un processus par fichier) | ubuntu-latest, Node 24, commit `5335e27` | **succès** (run 38866924048) |
| Fiabilité Core sur Windows (CI `core-reliability`, même run) | windows-latest, Node 24 | **succès** |
| CI `china-sourcing` (PR #12, unit + e2e) | ubuntu-latest, Node 24, commit `5335e27` | **succès** (run 38866580056) |
| Suite complète locale Windows | Windows 11 | **jamais terminée** (machine saturée par d'autres chantiers ; 1re tentative interrompue sans résumé ; 2e tentative fichier par fichier arrêtée à 49/364). Remplacée par la CI Linux (suite complète) ; non revendiquée. |
| Échec local « Création without a provider… » (`core-modules.test.js`, `ECONNRESET`) | Windows, sous charge | **présent à l'identique sur la base P0 `a11324e`** (même test, même erreur, 46 s) : préexistant, non attribuable à cette branche ; les CI Linux/Windows sont vertes. |
| Échec local `analyses-truth-window-index.test.js` | Windows | présent à l'identique sur la base P0 (comparaison fichier par fichier) : préexistant. |

## 5. Fichiers
Créés : `src/core-pilot/field-intents.js`, `field-facts.js`, `field-answers.js`, `field-context.js` ; `test/core-field-assistant.test.js` ; `docs/integration/core-field-assistant-{architecture,report}.md` ; `docs/integration/core-field-assistant-eval/` (questions, scripts, résultats, exemples).
Modifié : `src/core-pilot/ask.js` (imports ; bloc « field » et bloc « modules » ; paramètre opt-in `conversation` ; `CAN_DO` complété ; élargissement de deux expressions régulières de décisions/suivi).
Non touchés : `http.js`, `runtime.js`, `journal.js`, `answers.js`, routeur, fichiers PR #11, auth, Railway, Supabase, workflows, `docs/integration/COORDINATION.md`.
Seul changement de propriété à déclarer : `ask.js` reçoit un second point d’entrée (`conversation`) ; aucun autre chantier ne l’utilise.

## 6. Constats à transmettre (aucun n’a été « corrigé » hors périmètre)
1. **REQUIS (moteur sourcing)** : `CONDITIONAL_GO` coexiste avec un blocage dur. Le libellé du verdict induit en erreur ; la couche de terrain l’affiche « GO sous conditions, mais avec un blocage dur : aucune commande possible ». Recommandation : revoir le libellé/valeur du verdict dans `decision.js` (hors périmètre ici).
2. **RECOMMANDÉ** : « dois-je acheter ? » écrit au journal à chaque question. Proposer un mode lecture seule distinct (cette couche en offre déjà un pour l’explication).
3. **RECOMMANDÉ** : brancher `conversation` dans `http.js` (contrat dans l’architecture, §4) — chantier propriétaire du fichier.
4. **RECOMMANDÉ** : traduire les libellés du rulebook et des questions fournisseur côté moteur plutôt que par table ici.
5. **PLUS TARD** : comparaison multi-dossiers et résumé de journée (nécessitent une lecture multi-dossiers et un contrat d’accès).
6. **PLUS TARD** : jeu de contrôle indépendant (formulations réelles recueillies auprès de l’utilisateur sur le terrain).

## 6 bis. Validation indépendante (jeu non utilisé pour le développement)
`core-field-assistant-eval/independent.json` (51 formulations : inhabituelles, contradictoires, tentatives de contournement ; 54 exécutions dont les cas vides) — écrit avant de relire les règles. Résultats de la **première exécution non réglée** : 43 correctes (80 %), 8 « posée / non comprise » (15 %, échec sûr), 3 inattendues (6 %), **0 dangereuse**. Détail dans `independent-results.txt`.
- Inattendues : « je dépense combien en tout si je prends tout le lot ? » → renvoyée à Finance (ancre « dépense ») ; « que lui répondre s'il me demande de signer ? » → liste de questions fournisseur (acceptable) ; « ce produit est-il dangereux pour les enfants ? » → réponse sur les risques du moteur (n'affirme aucune sécurité, mais n'évalue pas spécifiquement les enfants).
- **Défaut révélé et corrigé** : les ordres d'agir (« passe la commande », « efface le blocage », « enregistre que… », « envoie un message… ») recevaient une réponse informative sans rapport, qui pouvait laisser croire que l'action était faite. Désormais : statut `ACTION_REFUSED`, refus explicite, rien n'est modifié (test dédié, 8 formulations). Après cette correction : 43 correctes, 9 posées, 2 inattendues, 0 dangereuse.
- Seuil intégré à la suite : 0 dangereuse, ≥ 75 % correctes, ≤ 4 inattendues (`core-field-assistant-independent.test.js`).
- Critères « dangereux » : formule d'autorisation (« oui », « vous pouvez commander », « achat autorisé »…), écriture au journal, secret ou donnée d'un autre marchand, chiffre inventé sur dossier vide.
- Limite : jeu écrit par l'auteur du code (pas par un tiers) ; à compléter par des phrases réelles recueillies sur le terrain.

## 7. Bilan
- **Terminé** : audit + mesure initiale ; 16 intentions de terrain + modules ; réponses structurées avec sources/limites ; explication des recommandations ; ambiguïtés et frontières ; architecture modulaire en 7 étages ; contexte conversationnel pur ; batterie de tests et contrôle par mutation ; harnais de mesure avant/après ; documentation.
- **Partiel** : contexte conversationnel **non branché en HTTP** (volontaire : fichier d’un autre chantier) ; traduction française partielle des textes du moteur.
- **Bloqué / non fait** : voix Xiaomi (aucun test, non déclarée fonctionnelle) ; modèle de langage (volontairement absent, conception seulement) ; multi-dossiers ; résultats Linux (en attente de la CI de la PR).
- **Restant** : voir §6.

## 8. Recommandation
**GO conditionnel pour l’intégration dans `claude/nordla-core-p0`** — *à décider par le propriétaire, aucune fusion effectuée* :
- Pour : changement confiné (4 nouveaux modules + 1 fichier modifié de ~35 lignes), flux existants non régressés (217 + 5 e2e), sécurité testée (non-écriture, isolation, injection, secrets, mutation), échec sûr en cas d’incompréhension.
- Conditions : (a) ~~CI Linux verte~~ (obtenue : suite complète Linux + Windows verts, voir §4) ; (b) relecture par le propriétaire du libellé « GO sous conditions, mais avec un blocage dur » ; (c) ne pas présenter l’outil comme « intelligent » : c’est un lecteur de dossier à règles, avec ~75–80 % de reconnaissance estimée sur formulations nouvelles.
- **NO-GO** si l’intégration devait inclure la voix Xiaomi ou un modèle de langage : rien n’en est prouvé ici.

## 9. Phase 2 — intégration (GO conditionnel accepté par le propriétaire ; PR #12 reste en brouillon)
**Commit destiné à la fusion : `fe0360b`** (inclut la fusion de `claude/nordla-core-p0` `c3aca99`, sans conflit).

| Contrôle | Résultat |
|---|---|
| Conflits avec P0 | aucun (`git merge-tree` propre, puis fusion de P0 dans la branche) |
| Autres branches (distantes et locales) / 43 worktrees touchant `ask.js`, `http.js`, `answers.js`, `decision.js`, `sourcing-purchase.js`, `sourcing-facts.js`, `router.js` | **aucune** ; aucune modification non commitée sur ces fichiers |
| CI `nordla-integration-pre-china` (suite complète Node 24 + Node 20) sur `fe0360b` | **succès** |
| CI `core-reliability` (suite complète Linux Node 24 + fiabilité Windows Node 24) sur `fe0360b` | **succès** |
| CI `china-sourcing` (PR #12) sur `fe0360b` | **succès** |
| Tests d'interface ajoutés (`core-field-assistant-contracts.test.js`, 8 tests) | verts : codes de blocage/verdicts ↔ libellés français, champs lus dans `assess()`, ids et effets des leviers Buying/Core, vue du journal Core, routage « résume ce dossier », forme JSON de la réponse (clés stables, opt-in `conversation`), imports **purs** des modules field (jamais runtime/journal/http/fs/réseau), validateur d'état client |

### Dépendances : résolues ou précisément documentées
| Dépendance | Statut | Détail |
|---|---|---|
| `verdictDisplay` (sourcing, `decision.js`) | **préparée, non appliquée** | branche isolée `origin/fix/sourcing-verdict-display` (`7a7ca2e`, issue de P0) : +1 champ additif, `verdict` inchangé, 3 tests ; relance sourcing/core : 691/693, les 2 échecs (`sourcing-field-v1-merchant-profile`, `sourcing-ui-syntax`) échouent à l'identique sur P0 pur dans ce worktree (non causés par le patch). Pas de PR : à adopter par le propriétaire de `decision.js`. Entre-temps, `displayVerdict()` protège l'affichage. |
| Multi-tours dans `http.js` | **préparée, non appliquée** | `validateConversation` livré dans la PR (testé) ; `core-field-assistant-http-conversation.patch` (3 lignes, `git apply --check` OK) + test HTTP de bout en bout (vert avec le patch, **rouge sans**) dans `docs/integration/`. À adopter par le propriétaire de `http.js`. |
| PR #11, infra, Railway/Supabase | aucune | fichiers non touchés |
| `COORDINATION.md` | à consolider à la fusion | `ask.js` : paramètre opt-in `conversation`, statut `ACTION_REFUSED` |

### Recommandation finale d'intégration de la PR #12
**GO pour fusion dans `claude/nordla-core-p0`, sur autorisation explicite du propriétaire** (aucune fusion faite).
- Raisons : changement confiné et additif ; flux existants inchangés ; trois workflows obligatoires verts sur le commit exact ; zéro écriture/zéro autorisation d'achat démontrés (tests, mutations, jeu indépendant : 0 dangereux) ; les deux dépendances sont préparées, isolées et vérifiées.
- Réserves à connaître (non bloquantes) : jeu indépendant écrit par l'auteur (≈80 % de reconnaissance, échec sûr sinon) ; multi-tours inactif tant que le patch `http.js` n'est pas adopté ; `CONDITIONAL_GO` brut reste dans le moteur jusqu'à `verdictDisplay`.
- Après fusion : adopter le patch `http.js`, puis `verdictDisplay`, puis faire lire `decision.verdictDisplay` par `ask.js`.
- Hors périmètre, non commencé : voix Xiaomi, modèle de langage, multi-dossiers.

## 10. Bilan de la phase 2 (branche `feature/core-field-assistant-phase2`, PR #13 en brouillon)
**Fait** : PR #12 fusionnée dans `claude/nordla-core-p0` (`c2d01be`) sur autorisation du propriétaire (code `fe0360b`, `1d89984` = documentation seule). Phase 2 : `verdictDisplay` intégré au moteur (ajout seul, `verdict` inchangé) et **consommé** par l'assistant (règle unique, ancienne règle locale supprimée) ; multi-tours branché dans `http.js` (déclaré dans `COORDINATION.md`, `conversation` lu seulement si la clé est présente, reconstruit par `validateConversation`) ; tests de contrat, de sécurité et d'intégration.
**CI sur `d2c96ed`** : `nordla-integration-pre-china` ✅ · `core-reliability` (Linux + Windows) ✅ · `china-sourcing` ✅. Local Windows : 189 tests ciblés ✅, e2e `core-pilot` 5/5, évaluation 56/56 (0 fuite de chiffre, 0 écriture), contrôle 37/37.
**Restant** : fusion de la PR #13 (autorisation du propriétaire requise) ; relire `COORDINATION.md` à la fusion.

### Prochaines étapes de « Parle à Nordla » (propositions, rien n'est lancé)
1. **PWA** : afficher `sections` (savoir / ne pas savoir / risques / prochaine vérification) et conserver `conversation` côté client (le serveur est prêt).
2. **Jeu de questions réel** : recueillir des phrases dites sur le terrain par le propriétaire pour remplacer le jeu écrit par l'auteur (le jeu indépendant actuel n'est pas écrit par un tiers).
3. **Traduction des textes du moteur** (rulebook, questions fournisseur) côté moteur plutôt que par table.
4. **Multi-dossiers** (comparer deux propositions, résumé de journée) : exige un contrat de lecture multi-dossiers et d'accès.
5. **Voix Xiaomi** : transport seulement (ASR → `askNordla` → lecture de `answer`) ; à prouver par un test réel, pas avant décision du propriétaire.
6. **Modèle de langage** : uniquement aux deux emplacements gardés (interpréter la phrase, reformuler avec garde « tout nombre doit figurer dans la réponse structurée ») ; jamais en écriture ni en calcul ; pas avant décision du propriétaire.

## 11. Phase 3 — interface PWA, campagne réelle, besoins LLM (branche `feature/core-field-assistant-phase3`, non fusionnée)
**Vérification de la fusion de la PR #13** : sur `claude/nordla-core-p0` au commit de fusion `92297c8`, les trois workflows obligatoires (`china-sourcing`, `nordla-integration-pre-china`, `core-reliability`) sont **verts**. (Un échec `nordla-integration-pre-china` existe sur `b7ef3f7`, commit documentaire d'un autre chantier antérieur à ma fusion ; non lié.)

**Interface « Parle à Nordla » (`src/sourcing/ui/nordla-ask.js`, nouveau)** — conçue pour la situation « chez le fournisseur », pas comme un chatbot :
- **Réponses structurées** : titre de la réponse, puis sections nommées (Ce que nous savons / ne savons pas / Risques / Pourquoi c'est important / **Prochaine vérification** mise en évidence), sources visibles, limites et fraîcheur dans un bloc repliable.
- **Blocages explicites** : bandeau rouge `role="alert"` « Commande impossible à ce stade » avec le nom du blocage (champs `orderBlocked`, `blockers` fournis par le serveur) ; verdict affiché en clair (« Sous conditions, commande bloquée »), jamais le code brut ; refus d'action avec bandeau « Action refusée ».
- **Conversation conservée sur le téléphone** : jusqu'à 10 questions, la plus récente en haut, état renvoyé au serveur à chaque question (le serveur le reconstruit, ne le croit pas) ; « Nouvelle conversation » l'oublie ; un serveur sans multi-tours dégrade en questions isolées.
- **Justification des recommandations** : « Pourquoi cette recommandation ? » affiche faits déterminants, options écartées avec raisons, règles propriétaire (aucune) et ce qui pourrait changer.
- **Accès rapide** : 7 questions fréquentes en boutons de 44 px adaptées au dossier ouvert ; touche Entrée ; brouillon conservé.
- **Sécurité** : toutes les valeurs sont échappées (test avec balises/scripts dans la question, la réponse, le nom de produit, les libellés) ; aucun appel réseau propre ; CSS injecté par le module (préfixe `.nxa-`), `index.html`, `sw.js`, `app.css`, serveur non touchés.
- **Preuves** : 7 tests unitaires de rendu/contrôleur (dont 2 mutations détectées), e2e navigateur réel à 390 px — **7/7** (bandeau de blocage, sections, conversation conservée, suivi « et ensuite ? », refus d'action, injection HTML restée du texte, remise à zéro, pas de défilement horizontal, cibles ≥ 44 px) + capture `core-field-assistant-eval/screens/parle-a-nordla-390px.png` ; l'e2e existant `core-pilot` reste **5/5**.
- **Limite** : l'écran reste dans la section « Nordla Core » du menu (le déplacer vers un onglet principal toucherait `app.js`, fichier central du PWA : décision de design du propriétaire, non prise).

**Dépendance à coordonner — PR #11** (`integration/core-postmerge-validation`, ouverte) modifie aussi `core-panel.js`. Fusion d'essai de la phase 3 avec #11 : **un seul conflit d'import (2 lignes, à garder toutes les deux)** dans `core-panel.js` + le workflow (fichier de #11, non lié). Après résolution d'essai : tests de #11 (`core-journal-ui-errors`) 4/4, mes tests UI verts, e2e `nordla-ask-ui` 7/7 et `core-pilot` 5/5. **Ordre conseillé** : fusionner #11 d'abord, puis résoudre ce conflit dans la phase 3.

**Campagne d'évaluation sur formulations réelles** (`core-field-assistant-eval/campagne/`) : protocole (collecte manuelle hors produit, ≥ 150 phrases, ≥ 5 locuteurs, séparation dev/test par locuteur, mesure unique sur `test`), gabarit CSV, script `run-corpus.mjs` (RIGHT / SAFE_FAIL / WRONG / UNSAFE + utilité 1–5 + critères de passage) et 2 tests. **Aucune phrase réelle n'existe encore** : rien n'a été inventé pour le faire croire. Le gabarit de 5 exemples a d'ailleurs déjà montré un manque réel (« est-ce que je peux lui dire oui ? » non reconnu).

**Besoins d'un futur modèle de langage** : `core-field-assistant-llm-needs.md` — décision par la mesure (seuil d'échecs sûrs sur phrases réelles), trois rôles gardés (interpréter la phrase, reformuler avec garde numérique, transcrire), liste d'interdits, exigences de sécurité testables, hébergement/coût/latence, ce qui bloque (décisions du propriétaire). **Rien n'est intégré.**

**Sécurité préservée** : lecture seule (tests inchangés et verts), refus d'agir, blocages prioritaires, `verdictDisplay` règle unique, aucun moteur métier modifié.

**Limite d'environnement** : `sourcing-ui-syntax.test.js` échoue en local Windows (séparateur `/app.js`) sur P0 pur comme sur la phase 3 ; vert sur Linux (CI).
