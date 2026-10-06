# China Sourcing - Conversation First : document de conception (Phase A)

- **Date** : 2026-10-06 - **Branche** : `feature/china-sourcing-field-mode` - **HEAD analysé** : `be1d845`
- **Statut** : PROPOSITION pour validation propriétaire. Aucun code écrit, rien de mergé, poussé ou déployé.
- **Sources lues** : `NORDLA_CHINA_SOURCING_CONVERSATION_FIRST_SPEC.md` (spec), Constitution Nordla (branche `docs/nordla-constitution-v1`, `53e3efb`) : Architecture canonique, Decision Register (NDR), Deferred, ADR 0004, principes de décision, et le code à HEAD (`core/conversation-engine.js`, `core/understanding.js`, `core/conversation.js`, `core/phrases.js`, `ui/screens/fieldhome.js`, `ui/app.js`, `adapters/ai-provider.js`, `ui/storage.js`).
- **Lecture de la spec** : elle remplace la **direction UX** du Field Mode, pas l'architecture Nordla. La Constitution prévaut. Les points de la spec à requalifier sont marqués **[REQUALIFIÉ]** et regroupés en section 15.

---

## 1. Constat : ce que le Field Mode actuel montre (HEAD)

`talkScreen` (`fieldhome.js`) peut afficher en même temps, sur un écran de téléphone : (1) une bande de progression avec 4 compteurs, (2) la carte Produit, (3) la suggestion de catégorie, (4) l'historique de bulles, (5) « NORDLA A COMPRIS » (lignes + 3 boutons), (6) des cartes d'attention (une par fait), (7) la carte « Documents annoncés », (8) des cartes de contradiction, (9) « PROCHAINE QUESTION » (texte, raison, état de relecture du chinois, « Ensuite : … », 2 boutons), (10) la zone de saisie (textarea, sélecteur « De qui », Envoyer, 📎). Jusqu'à une dizaine de blocs et une vingtaine de contrôles. C'est exactement le « questionnaire » que la spec décrit.

**Cause racine** : tout ce que les moteurs savent est rendu, au même moment, avec le même poids. L'écran n'a ni « sujet courant », ni notion de moment opportun, ni hiérarchie : il présente le **dossier**, alors que l'utilisateur est dans une **conversation**.

**Ce qui est sain et ne change pas** : la logique (P5, groupement, provenance, événements) est déjà indépendante de l'écran, recalculée à chaque rendu, hors-ligne, testée. Le problème est dans la **présentation** et dans deux manques dans le cœur : le sujet courant et le moment.

## 2. Principe d'architecture : le plus petit changement

> Ne rien réécrire. Ajouter **une couche pure au-dessus de P5** (sujet courant + suggestion + moment), **une frontière providers**, et **un nouvel écran Field** qui ne montre qu'une fraction de ce que la couche calcule.

```
 capture (texte | photo | doc | audio plus tard)          [UI / recorder, hors cœur]
   -> original            CONVERSATION_ITEM (+ source{kind,ref,segments} optionnels)      [existe]
   -> transcription       CONVERSATION_DERIVE kind=TRANSCRIPTION  (provider ou humain)    [existe]
   -> traduction          CONVERSATION_DERIVE kind=TRANSLATION                            [existe]
   -> extraction          extractFacts(original)  -> candidats                            [existe]
   -> facts/provenance    confirmation -> événements existants + ledger                   [existe]
   -> contradictions      conflicts.js                                                    [existe]
   -> questions résolues  P5 planConversation                                             [existe]
   -> TOPIC / CONTEXTE    core/topics.js                                                  [NOUVEAU, pur]
   -> besoins adjacents + ranking par sujet   core/context-engine.js                      [NOUVEAU, pur]
   -> suggestion au bon moment   core/suggestion-presenter.js                             [NOUVEAU, pur, horloge injectée]
   -> écran Field Conversation First   ui/screens/fieldfirst.js                           [NOUVEAU, remplace l'écran, pas le cœur]
```

Séparation device-independent (spec 12) : les trois nouveaux modules du cœur sont des fonctions pures sans DOM, sans réseau, sans horloge globale ; le téléphone n'est qu'un client (`fieldfirst.js`). Un autre client (desktop, futur) appelle les mêmes fonctions. Aucun client « lunettes » n'est construit ; rien ne l'interdit.

## 3. Réutilisation / modification

| Élément | Verdict |
|---|---|
| Case + reducer, ledger, états de provenance, candidats, conflits, tiers, evidence hierarchy, Safety Gate, rulebook, coûts, verdict, PWA/offline/sync | **Inchangé** |
| `conversation-engine.js` (P5), `understanding.js`, `phrases.js`, `candidate-view.js` | **Réutilisés tels quels** ; `phrases.js` reçoit un champ additif `topic` sur `SUGGESTED` et sur les questions V0 |
| `QUESTION_SHOWN`, `QUESTION_SKIP`, `CANDIDATES_CONFIRM_BATCH`, `CONVERSATION_DERIVE`, `questionLog`, `confirmBatches` | **Réutilisés** (aucun nouvel événement obligatoire, voir section 7) |
| `fieldhome.js` | **Conservé** : ses fonctions de carte (résumé, attention, groupe) deviennent le contenu des « feuilles » Résumé et Détails du nouvel écran |
| Mode Expert, 9 onglets | **Inchangé** |
| `ui/app.js` | **Modifié** : rendu Field → nouvel écran, nouveaux gestionnaires (démarrer, « que demander ? », feuilles) |
| `ui/app.css` | **Inchangé** ; nouveau `ui/field.css`, sélecteurs préfixés `.fm-` |
| `ui/sw.js` | Version du cache incrémentée (`v0-8`) |
| `adapters/ai-provider.js` | Réutilisé tel quel pour la politique de données (voir 11) |

## 4. Moteur contextuel (`contextual conversation engine`)

Trois fonctions pures, composées, sans état caché.

### 4.1 `core/topics.js` : le sujet courant (current topic)

Taxonomie fermée et petite, **dérivée des clés de faits déjà existantes** (pas d'IA) :

| Sujet | Clés / indices |
|---|---|
| `IDENTITY` | `identifier.*` |
| `PRICE` | `quote.unitPrice`, `quote.tiers`, `quote.currency`, `quote.samplePrice` |
| `MOQ` | `quote.moq` |
| `COLOURS` | `variant.colours`, `variant.colourCount`, `moq.mixedColours`, `moq.perColour` |
| `LOGISTICS` | `carton.*`, `quote.incoterm`, `quote.port` |
| `PAYMENT` | `payment.*` |
| `LEADTIME` | `quote.leadTime` |
| `CUSTOMISATION` | logo, packaging (questions suggérées) |
| `DOCUMENTS` | `docClaim.*`, documents annoncés/reçus |
| `COMPLIANCE` | batterie/lithium, CE, UN38.3, RoHS (clés `docClaim.*` + catégorie) |
| `OTHER` | rien de reconnu |

Représentation (valeur dérivée, **jamais écrite dans le dossier**) :

```
topic = { id, confidence: 'HIGH'|'LOW', sinceItem, lastItem, evidence: [candidateId|keyword], source: 'FACTS'|'KEYWORDS' }
```

Règle : le sujet courant est celui du **dernier énoncé** (supplier ou moi), pondéré par ses candidats ; à défaut de candidat, repli sur des mots-clés fixes (FR/EN/ZH : « colour/颜色 », « price/价格 », « MOQ », « carton », …). Si les deux échouent : `OTHER`, **pas de suggestion contextuelle** (retour au meilleur question P5). Un changement de sujet est détecté quand le sujet du nouvel énoncé diffère et n'est pas adjacent. Un énoncé multi-sujets donne un **sujet principal** (le plus de candidats) + `also[]`.

Aussi dans `topics.js` : `topicStatus(state, A)` → par sujet, un des quatre états compacts de la spec (voir 4.4).

### 4.2 `core/context-engine.js` : suggestions contextuelles

`planContext(state, A, { signals, now })` appelle `planConversation` (P5, inchangé) puis ajoute :

- **Besoins adjacents** : table déterministe `ADJACENT[topic]` → ids de questions déjà existantes ou ajoutées dans `SUGGESTED` (couleurs → mélange, minimum par couleur, mélange par carton ; un seul palier de prix → paliers 100/300 ; batterie lithium + modèle connu → preuve adaptée au modèle exact).
- **Ranking** : (1) contradiction ouverte, (2) questions adjacentes au **sujet courant**, (3) meilleure question P5 globale. P5 reste l'arbitre de ce qui manque ; le sujet ne fait que **réordonner**, jamais ajouter une exigence qui n'existe pas.
- **Sortie** : `{ topic, suggestion|null, others[] (non affichées), chips[], alerts[], summary }`. `suggestion` = **au plus une**.

**Cycle de vie d'une suggestion** (états dérivés, comme P5) :

| État | Entrée | Sortie |
|---|---|---|
| `CANDIDATE` | produite par le moteur pour le sujet courant | rang 1 et timing OK → `PRESENTED` |
| `PRESENTED` | affichée au propriétaire (éphémère, UI) | « Montrer en 中文 / FR » → `ASKED` ; « Pas maintenant » → `DEFERRED` ; réponse détectée → `RESOLVED` ; sujet changé → `STALE` |
| `ASKED` | `QUESTION_SHOWN` (le fournisseur l'a vue, journalisé) | réponse détectée → `RESOLVED` ; message fournisseur sans réponse → `UNANSWERED` (rejouable) |
| `DEFERRED` | `QUESTION_SKIP` (existant) | prochain message fournisseur ou changement de sujet → redevient `CANDIDATE` |
| `RESOLVED` | un candidat qui la résout apparaît (`ANSWER_PENDING`) ou est confirmé | disparaît **silencieusement**, la suivante est recalculée |
| `STALE` | le sujet courant a changé avant action | supprimée, jamais mise en file |

La disparition d'une suggestion déjà résolue (« You can mix colours, minimum 25 pcs per colour » → les suggestions mélange et minimum partent) est le comportement central : il réutilise `RESOLVES` de P5 ; il suffit d'y ajouter les clés couleurs.

### 4.3 `core/suggestion-presenter.js` : timing / anti-interruption

Machine d'états **pure** : `present(prev, plan, signals, now) -> { shown, hold, prev' }`. L'horloge est injectée (tests déterministes). Aucune minuterie dans le cœur ; l'UI appelle la fonction à chaque rendu et au réveil d'un unique `setTimeout` calculé par `hold.until`.

Règles (valeurs par défaut configurables, à valider au checkpoint) :

1. **Fin d'idée** : pas de suggestion tant que le propriétaire est en train de saisir (`signals.composing`) ou que `now - dernierÉnoncé < QUIET_MS` (texte collé : 0 ; flux de segments futur : 1500 ms de silence).
2. **Une seule** suggestion affichée à la fois.
3. **Stabilité** : une suggestion affichée reste au moins `DWELL_MS` (8 s) sauf si elle est résolue ou périmée ; jamais de remplacement « parce qu'une autre est meilleure ».
4. **Pas de rafale** : après une suggestion, `COOLDOWN_MS` (10 s) avant la suivante, sauf demande explicite.
5. **Contradiction** : seule exception d'urgence, en bandeau ambre non modal, sans remplacer la suggestion en cours.
6. **Jamais de fenêtre modale, de vibration ni de son** déclenchés par Nordla.
7. **« Que dois-je demander maintenant ? »** : action explicite qui ignore les règles 1, 3 et 4 et affiche le meilleur choix immédiatement.
8. **« Pas maintenant »** : `QUESTION_SKIP` ; ne ressort pas avant un nouveau message du fournisseur ou un changement de sujet (comportement P5 existant, pas de nouveau champ).

Ce n'est **pas** un agent événementiel autonome (voir 15, L3-009) : il réagit uniquement aux gestes du propriétaire et à l'affichage, n'agit pas en arrière-plan, n'envoie aucune notification.

### 4.4 États de confiance compacts (spec 10) **[REQUALIFIÉ]**

Les quatre symboles sont dérivés des états de provenance existants, sans les remplacer :

| Symbole | Sens exact | Source |
|---|---|---|
| ✓ | **confirmé par vous** (le fait est dans le dossier) | candidat `CONFIRMED/CORRECTED`, ou `USER_PROVIDED` |
| ◌ | **le fournisseur l'affirme**, pas encore confirmé par vous (ou déclaration de document) | candidat `PROPOSED`, `docClaim.*` |
| ! | **à vérifier** : contradiction, ambigu, faible confiance | conflit ouvert, `needsCorrection`, `LOW` |
| ? | **inconnu** | rien |

Garde-fou : ✓ **ne veut jamais dire « vérifié »**. Un prix confirmé par vous reste `SUPPLIER_CLAIM` dans le dossier et la feuille Détails l'écrit en toutes lettres (« dit par le fournisseur, confirmé par vous »). Sur les documents, ✓ n'apparaît **jamais** avant `ACCEPTED_AS_PROOF` : ◌ = annoncé, ✓ = preuve acceptée (états existants de `documentStatusOf`).

## 5. Wireflow mobile minimal

Trois entrées, toujours visibles en bas : **Conversation · Scanner/Ajouter · Écrire**. Le reste est derrière « ⋯ Détails ».

```
F0  PRODUIT                      F1  PRÊT                         F2  CONVERSATION EN COURS
┌────────────────────┐           ┌────────────────────┐           ┌────────────────────────┐
│ Nouveau produit    │           │ [photo]  Power bank│           │ Power bank      ● 3 ?  │
│ [📷 Photographier] │  nom ou   │ 10000 mAh          │ Démarrer  │────────────────────────│
│ ou écrivez le nom  │ ───────▶  │                    │ ───────▶  │ Fournisseur:           │
│ [_______________]  │  photo    │ [ Démarrer la      │           │ « We have black, white,│
└────────────────────┘           │   conversation ]   │           │  blue and pink »       │
                                 │ photo/document ·   │           │                        │
                                 │ écrire / coller    │           │ 💡 À demander maintenant│
                                 └────────────────────┘           │ Mélanger les couleurs  │
                                                                  │ dans un carton ?       │
                                                                  │ [中文] [Pas maintenant]│
                                                                  │ Prix✓ MOQ✓ Couleurs◐ Doc?│
                                                                  ├────────────────────────┤
                                                                  │ Conversation│Ajouter│Écrire│
                                                                  └────────────────────────┘
F3  FEUILLES (ouvertes par un tap, jamais automatiquement)
   « 4 infos à confirmer ›»  → feuille « Nordla a compris » (groupe explicite, mêmes garde-fous)
   « Prix✓ MOQ✓ … » (tap)   → feuille Résumé (progression, ce qui manque, évaluation Achats)
   bandeau ambre contradiction → feuille « Avant / Maintenant » (choix + Demander)
   ⋯ Détails                 → mode Expert (retour par le bandeau, comportement actuel)
```

Détails des écrans :

- **F0** : une seule tâche (nommer ou photographier). La catégorie suggérée devient une ligne discrète ; plus de carte.
- **F1** : produit en haut (photo plus grande), **une action dominante** « Démarrer la conversation », deux accès secondaires. Rien d'autre.
- **F2** : fil de conversation (originaux du fournisseur toujours intacts, notes « moi » distinctes), **zéro ou une** suggestion, une ligne d'états ✓◌!?, la barre à trois entrées. Chaque contrôle fait au moins 48 px.
- **Écrire** : feuille du bas (zone de texte, bascule « Fournisseur / Ma note », Envoyer). Le brouillon reste préservé (`S.captureDraft`, existant).
- **Scanner/Ajouter** : feuille avec photo produit, photo de document, coller du texte. La lecture automatique des offres n'existe pas (P6 non commencé) : l'image est conservée comme pièce, comme aujourd'hui.
- **Démarrer la conversation** sans audio : **[REQUALIFIÉ, question ouverte Q1]** ouvre le fil et la zone d'écriture au premier plan (le propriétaire tape ou colle ce qui est dit). Aucun micro « simulé » ni bouton de dictée tant qu'aucun provider n'existe.

## 6. Composants (écran `fieldfirst.js`)

`FmHeader` (produit, état hors-ligne discret) · `FmThread` (bulles, originaux intacts) · `FmSuggestion` (unique, 2 boutons) · `FmStatusLine` (chips ✓◌!?) · `FmBar` (3 entrées) · `FmSheet` (feuille générique) · `FmUnderstoodSheet` (réutilise `groupUnderstanding`) · `FmSummarySheet` (réutilise la logique de `summaryScreen`) · `FmConflictBanner` · `FmZhFullscreen` (existant, texte chinois plein écran avec état de relecture). Tous en HTML/CSS sans dépendance. Les fonctions de carte actuelles de `fieldhome.js` sont déplacées/réutilisées, pas réécrites.

## 7. Événements et données

**Aucun nouvel événement de reducer n'est nécessaire pour la première livraison** : 
- énoncé : `CONVERSATION_ITEM` (existant) ; démarrage : `CONVERSATION_START` ; question montrée / mise de côté : `QUESTION_SHOWN` / `QUESTION_SKIP` ; confirmation : `CANDIDATES_CONFIRM_BATCH` et confirmations unitaires ; dérivés : `CONVERSATION_DERIVE`.
- Le **sujet courant** et l'état d'une suggestion sont **dérivés** (donc rejouables, jamais en conflit entre appareils).

**Champs additifs optionnels** (pas de migration, `upgradeCase` les tolère absents) :

| Où | Champ | Usage |
|---|---|---|
| item de conversation | `source: { kind: 'TEXT'\|'AUDIO'\|'IMAGE'\|'DOCUMENT', ref, hash, durationMs? }` | pointe l'original (blob local) ; absent = texte tapé |
| item | `segments: [{ id, startMs, endMs, text? }]` | rattachement des faits aux segments, uniquement quand une transcription existe |
| candidat | `segmentId?`, `basis: 'ORIGINAL'\|'TRANSCRIPTION'\|'TRANSLATION'` | traçabilité de l'origine du fait |
| dérivé (`derived[]`) | déjà `provider`, `review`, `kind`, `lang` ; ajout `version?` | reproductibilité |

**Règle de provenance ajoutée [nouveau garde-fou]** : un candidat extrait d'une **transcription ou d'une traduction machine** est plafonné à confiance `MEDIUM` et ne peut **jamais** entrer dans la confirmation groupée ; il se confirme individuellement. Une traduction n'est jamais présentée comme l'original ; l'original (audio ou texte) reste l'unique source d'autorité. Les corrections du propriétaire sont déjà conservées (`CORRECTED`, `correctedValue`).

**Plus tard, selon décision** : un événement `CAPTURE_ADD` pour l'audio/photo comme source ; `TOPIC_SET` seulement si le propriétaire doit pouvoir forcer un sujet (non prévu en V1).

## 8. Analyse continue

Inchangée dans son principe : à chaque rendu, `assess()`, règles, coût rendu, économie et verdict sont recalculés ; `planContext` suit. Le nouvel écran **ne montre qu'un message court** (par exemple « Documents annoncés, mais pas encore reçus. ») ; le détail est dans la feuille Résumé. Seuls les moteurs existants sont recalculés : Money (P7) et Market (P10) n'existent pas et ne sont pas ajoutés. `UNKNOWN` reste `UNKNOWN`.

## 9. Provider boundary (audio / STT / traduction), sans choisir de provider

Contrat, nouveau `core/providers.js` (types et registre purs) :

```
Provider = {
  id, kind: 'STT'|'TRANSLATE'|'OCR', version,
  capabilities: { langs: ['zh','en','fr'], offline: bool, recurringCostEur: number, license, dataClass: 'LOCAL'|'REMOTE', region },
  status(): 'OK'|'UNKNOWN'|'UNAVAILABLE'   // + raison lisible
  run(input, { signal }): Promise<{ status, text?, lang?, segments?, confidence?, provider, version } | { status:'UNKNOWN'|'UNAVAILABLE', reason }>
}
```

Règles :
- **Registre vide par défaut** ; en V1 aucun provider n'est livré. Chaque étage de la chaîne est optionnel et absent = étage ignoré, **état explicite** « non disponible » (jamais simulé, jamais déguisé).
- Sortie d'un provider = **uniquement** `CONVERSATION_DERIVE` (provider, version, `review: MACHINE`) ; elle ne crée aucun fait, ne remplace pas l'original, ne confirme rien.
- **Politique avant tout appel** : réutilise `ai-provider.js` (classes de données, `minimizePayload`, `ProviderPolicyError`, refus `CONFIDENTIAL/PERSONAL` vers région `CN` sans autorisation explicite) ; consentement du propriétaire par provider ; **coût récurrent > 0 interdit par défaut** (V1 = 0 €/mois obligatoire) ; licence commerciale déclarée.
- **Interchangeables, pas routés [REQUALIFIÉ]** : un provider explicite par type, choisi par le propriétaire. Pas de choix automatique par coût/qualité/disponibilité (ce serait le routeur multi-modèles L3-001, différé).
- Doubles de test uniquement dans les tests. Le produit reste utilisable avec **tous** les providers indisponibles : texte/coller, phrasebook fixe, capture locale, extraction déterministe, correction humaine.
- Capture audio locale (enregistrer l'original sans transcrire) : voir Q2 ; non incluse tant que non approuvée.

## 10. Offline

- Tout le cœur ajouté (topics, context-engine, presenter) est pur et local ; il fonctionne serveur arrêté.
- Fichiers audio/images : IndexedDB (`ui/storage.js`, `putBlob`), stockage persistant demandé ; **local par défaut**, la copie sur le PC n'a lieu que selon une politique explicite du propriétaire (Q3). Aucun envoi automatique.
- Le brouillon, le mode, la position (`fview`) et le « Pas maintenant » survivent au rechargement (journal de questions dans le dossier).
- Reprise après reconnexion : mécanisme actuel de synchronisation par événements ; `questionLog` est en ajout seul ; les nouveaux champs optionnels se fusionnent sans conflit.
- Un provider distant (futur) est `UNAVAILABLE` hors-ligne ; un item sans dérivé reste valide (original conservé, « à transcrire » seulement si un provider existe).

## 11. Confidentialité

Aucune télémétrie, aucun provider caché, aucun cloud automatique. L'audio fournisseur est une donnée confidentielle (jamais envoyée sans consentement par provider et par région). Le texte du fournisseur reste sur l'appareil et, par synchronisation, sur le serveur personnel du propriétaire comme aujourd'hui.

## 12. UX visuelle : design system « Field Nordla »

Fichier `ui/field.css`, variables sur `:root`, clair **et** sombre ; sélecteurs `.fm-*`.

- **Fond ivoire/clair** (`#f7f5f0` environ), surface blanche, **bleu nuit Nordla** en signature (en-tête du produit, bouton principal, titres), jamais en contour généralisé. Les jetons officiels `src/shared/nordla-*.css` (branche Constitution) servent de référence ; si leur fusion n'est pas faite, les valeurs sont dupliquées une fois dans les variables du Field, puis alignées.
- Typographie système, 17 px minimum pour le texte de conversation, 15 px secondaire ; interlignes généreux ; **un seul bouton principal** par écran.
- Peu de bordures : espace et fond plutôt que cadres ; pas d'ombres lourdes ; **cartes seulement** pour la suggestion et les feuilles.
- Couleurs de sens : vert = état réellement positif (✓), ambre = attention réelle (!), rouge = blocage ou risque réel, gris = inconnu. Jamais décoratives.
- Cibles tactiles ≥ 48 px, barre du bas avec la zone sûre, une main.
- Photo produit en tête de dossier (plus grande), détails techniques masqués tant qu'ils ne servent pas.
- Texte chinois : plein écran existant, grand, avec la ligne d'état de relecture (« non relue »).
- Vocabulaire : on n'expose pas « candidat », « ledger », « P5 », « verdict » ; on dit « Nordla a compris », « Le fournisseur dit », « À demander maintenant ».
- Accessibilité : lecteur d'écran (zones `aria-live` polies pour la suggestion), contraste AA, pas d'information par la couleur seule (les symboles ✓◌!? l'accompagnent), `prefers-reduced-motion` respecté (aucune animation requise).

## 13. Migration minimale et compatibilité V0/V1/Expert

- Aucun changement de schéma obligatoire ; champs additifs optionnels (7) ; `upgradeCase` inchangé.
- Anciens dossiers V0/V1 : ouvrent sans perte ; sans item ni sujet, l'écran retombe en F0/F1.
- Mode Expert : intact, mêmes 9 onglets ; `fieldhome.js` reste utilisable (écran de résumé/détails) ; commutateur Field/Expert inchangé ; Expert reste le défaut tant que le checkpoint physique n'a pas validé le nouveau Field.
- Cache du service worker : `v0-8`.
- Retour arrière : l'ancien écran Field reste dans le code derrière un drapeau interne jusqu'à validation ; un simple commit revert restaure l'état actuel.

## 14. Tests (écrits avant le code)

**Unitaires purs** : `topics` (12 formulations, énoncé multi-sujets, texte sans candidat, ZH, changement de sujet, adjacences) · `context-engine` (exemples couleurs, prix à 1 palier puis 3 paliers, lithium + modèle, une seule suggestion, suppression silencieuse après réponse spontanée, contradiction prioritaire, hors-sujet = repli P5, aucune exigence ajoutée par le sujet) · `suggestion-presenter` (horloge fausse : pas de suggestion pendant la saisie, silence, dwell, cooldown, remplacement interdit, exception conflit, « que demander ? » immédiat, « pas maintenant ») · `providers` (registre vide, statuts OK/UNKNOWN/UNAVAILABLE, politique CN/consentement/coût > 0 refusés, aucune écriture hors `DERIVE`) · **provenance** (candidat issu de transcription : MEDIUM max, hors groupe ; traduction ≠ original ; supplier claim ≠ preuve ; ✓ jamais « vérifié » ; document ✓ seulement si accepté).
**Non-régression** : toute la suite sourcing actuelle (215) + e2e V0 (18), V1 (13), fieldmode (12, mis à jour), plein `npm test`, PG17 ; tests de rendu : au plus 1 suggestion, au plus 1 bouton principal, ≤ 8 contrôles visibles sur F2 ; aucune carte automatique ouverte ; Expert intact.
**e2e Edge (CDP)** : parcours F0→F2 ; brouillon préservé ; suggestion disparaît après réponse ; hors-ligne et rechargement ; 375/390/430 px sans défilement horizontal.
**Physique** : checkpoint #3 selon la spec 17 (premier réflexe, conversation naturelle, suggestion au bon moment, disparition des suggestions résolues, faible charge, aucune invention, provenance, offline, retour réseau, Expert intact), **sans consigne écran par écran**.
**Prérequis de clôture P5** : élucider le test intermittent `npm test` 1727/1728 avant la fermeture définitive de P5 (tâche séparée, avant C5).

## 15. Commits prévus (locaux, réversibles, tests d'abord)

| # | Commit | Contenu |
|---|---|---|
| C0 | `chore(tests): isolate the intermittent full-suite failure` | diagnostic seul (aucune modification de comportement) |
| C1 | `feat(sourcing): topics (current topic, compact status)` | `core/topics.js` + tests |
| C2 | `feat(sourcing): context engine (adjacent needs, one suggestion)` | `core/context-engine.js`, champ `topic` additif dans `phrases.js` + tests |
| C3 | `feat(sourcing): suggestion presenter (timing, anti-interruption)` | `core/suggestion-presenter.js` + tests horloge injectée |
| C4 | `feat(sourcing): provider boundary (contract, empty registry, policy)` | `core/providers.js`, garde-fous de provenance transcription/traduction + tests |
| C5 | `feat(sourcing): Conversation First field screen` | `ui/screens/fieldfirst.js`, `ui/field.css`, `app.js`, cache `v0-8`, e2e mis à jour |
| C6 | `docs(sourcing): checkpoint #3 plan and design progress` | plan physique, journal |
| (option) C7 | `feat(sourcing): local original audio capture (no transcription)` | seulement si Q2 approuvé |

## 16. Risques

| Risque | Mesure |
|---|---|
| Le sujet courant se trompe (mots-clés pauvres) | repli sur P5 ; « Que dois-je demander maintenant ? » ; le sujet ne fait que réordonner |
| Trop silencieux : l'utilisateur ne sait plus quoi faire | ligne d'états toujours visible, action explicite, suggestion initiale dès F1 |
| ✓ lu comme « vérifié » | libellé exact dans Détails, jamais ✓ sur documents avant acceptation, légende au premier usage |
| Régression Expert / V0 | aucun changement de reducer ni d'écrans Expert ; suites e2e ; drapeau de retour arrière |
| Timing mal réglé (trop tard/trop tôt) | constantes isolées, testées à l'horloge fausse, réglées au checkpoint #3 |
| Régression offline/brouillon | invariant de rendu conservé ; tests de rechargement ; e2e hors-ligne |
| Dérive de périmètre (STT, traduction, marché) | providers vides, rien de P6/P7/P10/L3 ; relecture à chaque commit |
| Chinois non relu présenté comme sûr | états de relecture conservés et visibles |
| Trois entrées vs. faible audience du « Écrire » séparé | testé au checkpoint ; fusion Conversation/Écrire possible sans toucher au cœur |

## 17. Questions ouvertes (pour validation propriétaire)

- **Q1** « Démarrer la conversation » sans audio : ouvre le fil + saisie au premier plan (ma proposition) ou autre comportement ?
- **Q2** Enregistrer l'**audio original localement sans transcription** (téléphone) dans cette phase ? Le test de la sonde montre que c'est faisable (≈ 950 Ko/min, Firefox) ; mais l'audio n'aurait de valeur qu'archivée. Oui / plus tard ?
- **Q3** Politique de copie de l'audio/photos sur le PC : jamais / sur demande / avec la synchro du dossier ?
- **Q4** Symbole ✓ : « confirmé par vous » (proposition) ; ou préférez-vous deux niveaux visibles (✓ vérifié / ✓· confirmé) ?
- **Q5** Le verdict « Conformité et économie » : visible dans la feuille Résumé seulement (proposition), ou aussi une ligne dans la conversation ?
- **Q6** Les cartes propriétaire (transport, droits, taux, prix de vente, marge) : à garder en feuille sur demande (proposition) plutôt qu'en cartes dans la conversation ?
- **Q7** Valeurs initiales du timing (silence 1,5 s, maintien 8 s, pause 10 s) : acceptables comme point de départ ?
- **Q8** Faut-il garder en Field la confirmation groupée sous forme de « 4 infos à confirmer ›» (feuille à la demande), ou l'ouvrir d'elle-même à une pause naturelle (moins sûr du point de vue anti-interruption) ?
- **Q9** Anglais pour l'interface Field : hors périmètre (français seulement) ?
- **Q10** Résoudre l'anomalie 1727/1728 **avant** le C1 (proposition) ou en parallèle ?

---

## Compatibilité Constitution Nordla

### Éléments compatibles
- **NDR-008 / provenance** : le cœur ajouté est déterministe, sans modèle de langage ; rien d'inventé ; `UNKNOWN` reste `UNKNOWN` ; contenu externe (texte fournisseur, transcription) = donnée, jamais instruction.
- **NDR-009 / NDR-003** : aucune exécution, aucun envoi ; le propriétaire montre ou tape lui-même ; les confirmations restent explicites.
- **NDR-011** : un provider reçoit une capacité bornée (une entrée, une sortie) ; il n'a aucun accès au dossier.
- **NDR-012 / NDR-020** : aucun code Shopify ni HABB ; marché d'origine = profil (Chine d'abord, extensible), rien pour l'Inde ni l'Indonésie.
- **NDR-006 / NDR-019** : pas de score opaque ; ni vérité masquée ; états de relecture du chinois visibles.
- **Principes de décision** : vérité sur l'incertitude, responsabilité humaine, rien de trompeur dans les suggestions (pas d'urgence artificielle, aucune notification poussée).
- **Isolation du Socle V0** : aucune importation entre `src/sourcing` et `src/socle-decision` ; maintenue.

### Éléments requalifiés
| Élément de la spec | Requalification | Décision |
|---|---|---|
| « progression vers une décision », « decision state », « next-best-action », « Verdict » (spec 8, 11, 12) | Le verdict `GO/CONDITIONAL_GO/NO_GO/INSUFFICIENT_INFORMATION` est une **évaluation spécialisée Achats & Fournisseurs / Conformité**, libellée « Évaluation d'achat » ; « next-best-action » = prochaine étape **de la conversation** (question fournisseur ou saisie propriétaire), pas un levier d'entreprise ; la carte « Décision d'achat pour votre entreprise » devient « Décision d'entreprise : relève du Socle, pas encore raccordée » | NDR-002, NDR-004 |
| Montants saisis par le propriétaire (prix de vente, marge, transport, droits, taux) | **Hypothèses du dossier**, étiquetées comme telles ; elles ne sont **pas** des règles dures du propriétaire et ne sont pas stockées comme règles globales ; aucun moteur de règles propriétaire n'est ajouté | NDR-005, NDR-010 |
| « Pas maintenant » (spec 3.3, 5) | Report d'une **suggestion d'interface** (`QUESTION_SKIP`) ; ce n'est pas le levier `DO_NOTHING` ; la suggestion « échantillon » reste une question de la conversation, pas le levier `TEST_SMALL` | NDR-007 |
| « providers interchangeables » (spec 7) | Adaptateurs **sélectionnés explicitement** par le propriétaire, un par type ; **pas de routage automatique** par coût/qualité | Deferred L3-001 |
| « suggérer au bon moment » (spec 5) | Réaction aux gestes du propriétaire dans l'interface ; **pas d'agent événementiel**, pas de déclenchement en arrière-plan, pas de notification | Deferred L3-009 |
| Audio, copie PC, politique de confidentialité (spec 13) | Mono-propriétaire, jeton unique, stockage local ; **pas de multi-commerçant** ; l'identité, les rôles et l'isolation relèvent du Socle et restent à raccorder avant tout hébergement | NDR-010 |
| ✓ « confirmé » (spec 10) | Veut dire « confirmé par vous », jamais « vérifié » ni « preuve » | provenance, NDR-010 |
| « Rules, Market, Money recalculés silencieusement » (spec 8) | Seuls les moteurs **existants** (règles, coût rendu, économie, Safety Gate, verdict) ; Money (P7) et Market (P10) n'existent pas et ne sont pas ajoutés | Deferred L3-003, spec 14 |
| Lecture de documents / photos (spec 3, 6) | Photo = pièce conservée ; la lecture automatique reste le point d'accroche optionnel désactivé par défaut ; **aucune extension** de document intelligence | Deferred L3-011 |

### Éléments différés (non commencés, listés pour mémoire)
Multi-model router (L3-001), Creative Intelligence (L3-002), Market Intelligence / Radar et P10 (L3-003), Research Intelligence (L3-004), agents spécialistes (L3-005 à L3-008), automatisations événementielles (L3-009), agents d'exécution contrôlée (L3-010), Document Intelligence au-delà de l'accroche existante (L3-011), prévision (L3-012), A2A (L3-013), P6/P7/P8/P9/P11 à P14 de la spec, client « lunettes », choix d'un provider STT/traduction, audio avec transcription, pricing/tiers commerciaux, intégration avec Socle Decision (à traiter séparément après validation du Field Mode), mapping explicite provenance sourcing ↔ Socle (plus tard, sans créer de double vérité).

### Aucune duplication du Socle Decision
- Aucun objet `Subject`, `Lever`, `Rule`, `Decision` ou `Ledger` de décision n'est créé dans `src/sourcing`.
- **Le « topic » n'est pas un Subject** du Socle : c'est une notion de conversation, dérivée, éphémère, jamais persistée ni arbitrée.
- **La « suggestion » n'est pas un Lever** : c'est une question à poser, sans effet économique ni approbation.
- Aucun `DO_NOTHING`, `TEST_SMALL`, `NOT_MEASURABLE`, aucune règle dure globale du propriétaire, aucun comparateur d'options ni arbitrage transversal ajoutés ; le verdict existant est conservé techniquement, renommé « évaluation », et ne prétend pas être la décision de l'entreprise.
- Aucune table, aucune migration, aucune importation du module `socle-decision`. L'intégration future (Sujet « opportunité d'achat », leviers, mapping de provenance) est un chantier séparé après validation.
