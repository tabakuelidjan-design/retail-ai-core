# Parle à Nordla — assistant de terrain : architecture et limites

Périmètre : lot « assistant conversationnel métier, phase 1 ». Branche `feature/core-field-assistant`, base `claude/nordla-core-p0`.
Principe fondateur : **Nordla ne devine rien**. Il rassemble les faits que le moteur du dossier a déjà calculés, dit ce qui manque et propose la prochaine vérification. Aucun modèle de langage n’est connecté ; rien dans ce chantier ne prétend le contraire.

## 1. Pipeline en 7 étages (un module, un contrat)

| # | Étage | Module | Entrée → sortie | Pur ? |
|---|-------|--------|-----------------|-------|
| 1 | Reconnaissance des intentions | `src/core-pilot/field-intents.js` | phrase → `{status: RECOGNISED/AMBIGUOUS/DEFERRED/UNKNOWN, intent?, candidates?}` | oui |
| 2 | Sélection du contexte métier | `ask.js` (bloc « field ») + `field-context.js` | intention + `caseId` (+ état de conversation) → dossier visé | oui (sauf lecture du dossier via `getCase`) |
| 3 | Lecture des données autorisées | `getCase`, `runtime.overview/forCase` | lecture seule | lecture |
| 4 | Construction des faits vérifiés | `src/core-pilot/field-facts.js` | état du dossier → *snapshot* (verdict, blocages, conditions, documents, coûts, fraîcheurs) | oui |
| 5 | Application des règles métier | moteurs existants : `assess` (sourcing), `sourcingPurchaseFacts`, `buildSourcingPurchaseSubject` + `sourcingPurchaseLevers` (Core) | aucun calcul nouveau | — |
| 6 | Élaboration des réponses | `src/core-pilot/field-answers.js` | snapshot + intention → `{status, intent, answer, sections, sources, limits}` | oui |
| 7 | Sources et limites | `field-answers.js` (`sourceLine`, `limitsOf`) | id/version du dossier, version des règles, fraîcheur de chaque source | oui |

`ask.js` reste le seul point d’entrée (`askNordla`). Les flux existants (décisions en attente, suivi, Finance, Analytics, « résume ce dossier », « dois-je acheter ») sont **inchangés** ; le bloc « field » s’insère avant eux et s’efface (`DEFERRED`) dès qu’une phrase leur appartient.

### Aucun second calculateur
Chaque chiffre vient de `assess()` (coût rendu, marge, prix maximum, bornes) ou des *leviers* du Core (effet d’une commande à la quantité du devis / au MOQ). Le seul calcul propre à la couche est de la mise en forme. Le coût rendu **partiel** (borne basse) est lu dans `assess().landed.totals`, toujours étiqueté « au moins ».

## 2. Intentions prises en charge (16)
`KNOWLEDGE`, `MISSING`, `DOCUMENTS`, `RISKS`, `MARGIN`, `LANDED_COST`, `ORDER_TOTAL`, `PRICE_GAP`, `PRICE_BASIS`, `UNCOUNTED_COSTS`, `MOQ_SCENARIO`, `CAN_ORDER`, `NEXT_STEP`, `SUPPLIER_QUESTIONS`, `PRICE_JUDGEMENT`, `EXPLAIN_RECOMMENDATION`. Plus : « quels modules sont connectés ? » (bloc dans `ask.js`) et un élargissement de la formulation des listes de décisions existantes.
Exemples réels de réponses : `docs/integration/core-field-assistant-eval/examples.md` (généré par `examples.mjs`).

## 3. Règles de comportement (testées)
- **Lecture seule absolue** : aucune question de terrain n’écrit dans le journal, ne modifie le dossier, n’appelle le réseau (test avec `fetch` piégé), n’appelle Finance/Analytics.
- **Rien n’est une autorisation d’achat** : « puis-je commander ? » répond « Pas à ce stade » ou « le moteur ne voit pas de blocage, mais ne vous autorise pas à payer ; Nordla ne commande ni ne paie ». Un blocage dur retire l’option « commander ».
- **Inconnu reste inconnu** : un dossier sans devis/coûts ne produit aucun montant (test `HAS_FIGURE`). Les manques sont nommés (prix fournisseur, transport, droits, prix de vente…).
- **Origine du prix de vente** : `OBSERVED` / `TARGET` / `ASSUMED` jamais fondus ; toute marge est accompagnée de l’origine de son prix.
- **Règles propriétaire** : `ownerRules` est vide pour HABB ; les réponses le disent (« aucune règle de budget / marge minimale… n’est définie ») au lieu d’en supposer une.
- **Texte fournisseur = donnée** : tout texte issu du dossier passe par `safeText` (une ligne, sans caractère de contrôle, borné) et n’est jamais interprété.
- **Frontières** : une phrase avec des ancres Finance/Analytics et sans ancre dossier → `DEFERRED` ; avec les deux → `AMBIGUOUS` → Nordla pose une question.
- **Moteur en anglais** : les blocages, conditions courantes et statuts sont traduits par table ; ce qui n’est pas reconnu est cité tel quel, marqué « (texte du moteur, en anglais) ». Les questions fournisseur restent en anglais **et** en chinois (texte du moteur).

## 4. Contexte conversationnel (phase F) — contrat proposé, non branché en HTTP
`field-context.js` : `stepConversation(prev, turn)` et `followUpIntent(text, conversation, scope)`, purs. L’état ne contient que **ids, versions et intentions** (jamais un chiffre ni un contenu de dossier), au plus 10 tours.
- Même marchand + même dossier requis ; sinon l’état est ignoré (changement de dossier : notice, pas de reprise ; autre marchand : reset silencieux).
- Version du dossier modifiée : notice « le dossier a changé… tout est recalculé ».
- Phrases elliptiques gérées : « et ensuite ? », « pourquoi ? », « et le reste ? ». Sans état : `NOT_UNDERSTOOD` (pas de devinette).
- `askNordla(q, { …, conversation })` : opt-in. Si `conversation !== undefined`, la réponse porte `conversation` (nouvel état) et éventuellement `notice`.

**Contrat HTTP proposé (à valider avec le chantier qui possède `src/core-pilot/http.js`, non modifié ici)** : le client (PWA) conserve l’état renvoyé et le joint à la question suivante ; aucune persistance côté serveur, aucune mémoire partagée entre utilisateurs. Le serveur doit : (1) ne l’accepter que d’une session authentifiée ; (2) le valider (forme, taille ≤ 4 Ko) ; (3) ne jamais le croire pour le marchand — `merchantId` du serveur fait foi (l’état d’un autre marchand est écarté, testé).

## 5. Points d’extension pour un futur modèle de langage (conception uniquement)
Rien n’est connecté. L’architecture réserve trois emplacements, chacun avec un garde-fou vérifiable :
1. **Interpréter la phrase** : remplacer l’étage 1 par un `intentProvider(text) → {intent, confidence}`. La sortie est validée contre l’énumération `FIELD_INTENT` ; toute valeur hors liste ou confiance basse → `AMBIGUOUS` (question à l’utilisateur). Le modèle ne reçoit jamais le dossier.
2. **Reformuler la réponse** : un `narrator(structuredAnswer) → text` optionnel. Garde-fou obligatoire : *tout nombre, date, identifiant du texte reformulé doit figurer dans la réponse structurée* ; sinon on renvoie la réponse déterministe. Le modèle ne peut pas ajouter un chiffre Finance.
3. **Jamais** : accès en écriture au journal, calcul de montant, levée d’un blocage, validation d’une décision. Ces chemins n’existent pas dans la couche de réponse et ne doivent pas y être ajoutés.

## 6. Voix (Xiaomi) — conception uniquement
La voix est un transport : transcription (ASR) → `askNordla({text, caseId})` → lecture de `answer` (synthèse vocale). Aucun traitement métier propre. **Rien n’a été testé sur Xiaomi dans ce chantier ; la voix n’est pas déclarée fonctionnelle.** Points à prévoir : transcription sans accents/ponctuation (le reconnaisseur les tolère), confirmation orale des réponses `ASK`, et lecture raccourcie de `sections` (savoir / ne pas savoir / prochaine vérification) plutôt que du texte complet.

## 7. Limites connues
- Un dossier à la fois. « Compare les deux propositions », « résume ma journée de sourcing », comparer plusieurs fournisseurs : **non pris en charge** (réponse honnête, pas de chiffre inventé).
- Reconnaissance par règles déterministes : une formulation très éloignée tombe en `NOT_UNDERSTOOD` ou `ASK` (échec sûr). Jeu de contrôle : voir le rapport.
- Pas de prix de marché ni de concurrents : « ce prix est bon ? » signifie seulement « sous le prix maximum de rentabilité calculé par le moteur ».
- « Pourquoi cette recommandation ? » lit la dernière analyse journalisée du dossier ; si le dossier a changé depuis, elle le dit et propose de relancer « dois-je acheter ? » — elle ne lance jamais l’analyse elle-même.
- Le flux existant « dois-je acheter ce produit ? » journalise toujours une analyse à chaque question (comportement préexistant, non modifié).
- Libellés de documents et détails de blocage du moteur : en anglais (rulebook) ; traduction partielle par table.
- Testé sur Windows (Node 24) ; Linux : voir CI de la PR.
