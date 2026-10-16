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
| Suite complète `test/*.test.js` | Windows 11, Node 24.19 | **non terminée au moment de la PR** (>1000 lignes de résultats, 1 échec observé : test « Création without a provider… » du module creative, sans lien avec `core-pilot` ; non investigué, non vérifié sur la base). À relancer / lire dans la CI. |
| Linux (CI GitHub, ubuntu-latest) | — | **non exécuté localement** ; dépend de la CI de la PR (voir description de la PR) |

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

## 7. Bilan
- **Terminé** : audit + mesure initiale ; 16 intentions de terrain + modules ; réponses structurées avec sources/limites ; explication des recommandations ; ambiguïtés et frontières ; architecture modulaire en 7 étages ; contexte conversationnel pur ; batterie de tests et contrôle par mutation ; harnais de mesure avant/après ; documentation.
- **Partiel** : contexte conversationnel **non branché en HTTP** (volontaire : fichier d’un autre chantier) ; traduction française partielle des textes du moteur.
- **Bloqué / non fait** : voix Xiaomi (aucun test, non déclarée fonctionnelle) ; modèle de langage (volontairement absent, conception seulement) ; multi-dossiers ; résultats Linux (en attente de la CI de la PR).
- **Restant** : voir §6.

## 8. Recommandation
**GO conditionnel pour l’intégration dans `claude/nordla-core-p0`** — *à décider par le propriétaire, aucune fusion effectuée* :
- Pour : changement confiné (4 nouveaux modules + 1 fichier modifié de ~35 lignes), flux existants non régressés (217 + 5 e2e), sécurité testée (non-écriture, isolation, injection, secrets, mutation), échec sûr en cas d’incompréhension.
- Conditions : (a) CI Linux verte sur la PR ; (b) relecture par le propriétaire du libellé « GO sous conditions, mais avec un blocage dur » ; (c) ne pas présenter l’outil comme « intelligent » : c’est un lecteur de dossier à règles, avec ~75–80 % de reconnaissance estimée sur formulations nouvelles.
- **NO-GO** si l’intégration devait inclure la voix Xiaomi ou un modèle de langage : rien n’en est prouvé ici.
