# China Sourcing - Voice First : analyse de dérive et plan de correction (avant tout code)

- **Date** : 2026-10-06 - **Branche** : `feature/china-sourcing-field-mode` - **HEAD analysé** : `9100e56`
- **Statut** : ANALYSE pour validation propriétaire. Aucun code modifié, rien de poussé, mergé ou déployé, aucun modèle, aucune API, aucune dépendance.
- **Référence normative** : le mockup « Nordla — China Sourcing, Conversation First, terrain d'abord » (téléphone + ordinateur). Il avait déjà été joint au message qui précédait la construction. Je ne l'ai pas traité comme une spécification (voir C).
- **Captures du checkpoint #3** : je n'ai reçu que le mockup ; je compare donc avec mes propres captures de `9100e56` (390 px), générées en navigateur de test. Si vous avez des captures du téléphone, elles priment.
- **Règle suivie** : toute exigence textuelle en conflit avec le mockup est listée en section G, sans choix de ma part.

---

## A. La référence visuelle validée

### A1. Téléphone : hiérarchie de haut en bas
1. **En-tête de marque** : « Nordla » en serif marine, sous-titre « China Sourcing », cloche avec point rouge à droite. Rien d'autre : ni compte, ni serveur, ni jeton, ni menu technique.
2. **Carte produit** (carte blanche arrondie) : photo du produit à gauche, nom en gras (« Bouteille isotherme 500 ml »), ligne secondaire (« Accessoires · Inox 304 »), pastille d'état verte « En discussion », chevron à droite (ouvre le dossier).
3. **Conversation** : séparateur de date (« Aujourd'hui 09:14 »), puis de vraies **bulles de messagerie** : propriétaire à droite (bulle grise, avatar, heure, double coche), fournisseur à gauche (bulle blanche, avatar, heure), une **pièce jointe** en carte fichier (icône PDF, nom, taille, téléchargement). Texte grand, lisible, aéré.
4. **Suggestion** : une seule carte beige-orangé, ampoule, étiquette « Suggestion », une phrase, chevron. Pas de bouton à l'intérieur.
5. **Rangée de confirmation** : une barre claire « ☰ 3 éléments à confirmer ›».
6. **Barre du bas** : trois entrées en pastilles arrondies, la première (Conversation) pleine marine : *Conversation · Scanner / Ajouter · Écrire*.

Fond ivoire, cartes blanches très arrondies, aucune bordure marquée, marine pour l'actif, beige-orangé pour « attention », gris très clair pour le neutre. Titres en serif.

### A2. Ordinateur (même composants, trois volets)
Colonne gauche : liste de conversations (une par produit/fournisseur, avec état). Centre : le même fil, la même suggestion, un champ « Écrire un message… » avec pièce jointe et envoi. Colonne droite : **Évaluation d'achat** : pastille « 3 éléments à confirmer », statut en frise (Discussion, Échantillons, Validation, Commande), bloc fournisseur (nom, ville, « Vérifié »), **Informations clés** (prix indicatif, MOQ, délai, certifications), **Informations manquantes** (puces ambre), **Prochaine étape**.

### A3. Comportement attendu (lu dans l'image et dans votre message)
- L'utilisateur **converse** ; Nordla travaille derrière : il ne gère pas Nordla après chaque réponse.
- Une seule suggestion visible ; elle disparaît quand la réponse arrive (votre exemple couleurs).
- Les éléments à confirmer sont **résumés en une ligne**, pas affichés comme des cartes.
- Le détail (évaluation) vit dans un volet / une feuille, pas dans le fil.
- L'action dominante avant la conversation est **🎙️ Démarrer la conversation** (votre correction ; absente du mockup, voir G1).

---

## B. Implémentation actuelle (`9100e56`) contre la référence

| Zone | Référence | Actuel | Verdict |
|---|---|---|---|
| Barre du bas | 3 pastilles, actif plein marine | 3 entrées identiques | **Correspond** |
| Palette / serif / fond ivoire | oui | oui | Correspond |
| Pastille « N éléments à confirmer » | rangée claire avec icône liste et chevron | pastille ambre arrondie | Proche, pas identique |
| Haut de l'écran | marque Nordla + cloche, rien d'autre | **ancien bandeau** : hamburger « Cases », nom de dossier, badge « SERVER VERIFIED », puis barre « SAFETY GATE: NONE ON THIS PHONE – Download now » (environ 210 px sur 844) | **Ne correspond pas : domine l'écran** |
| Carte produit | photo, nom, catégorie, état, chevron | titre texte + ligne « Probablement : … [Oui] » ; pas de carte, photo seulement après import | **Ne correspond pas** |
| Premier écran | produit + action dominante | formulaire « Quel est ce produit ? » (nom, bouton Continuer, photo) puis bouton texte « Démarrer la conversation » | **Ne correspond pas : c'est une étape de questionnaire** |
| Action principale | 🎙️ Démarrer la conversation | bouton texte, sans micro ; la saisie passe par la feuille « Écrire » | **Ne correspond pas : texte = parcours principal** |
| Fil | messagerie : deux côtés, avatars, heures, coches, pièces jointes | cartes « Fournisseur » blanches, une seule colonne, pas d'heure, pas d'avatar, pas de pièce jointe, pas de côté propriétaire | **Ne correspond pas** |
| Suggestion | carte compacte, une phrase, chevron | grande carte avec libellé, phrase en **français**, deux boutons, note de relecture chinoise | **Ne correspond pas, et langue incorrecte** |
| Ajouts hors référence | aucun | ligne de pastilles d'état (Prix ◌ …), phrases « Coût rendu incomplet », « Il reste N points », lien « Que dois-je demander maintenant ? » | **Surcharge** |
| Feuille « Nordla a compris » | rangée → liste | anciennes cartes (NORDLA A COMPRIS, cartes d'attention, documents annoncés) en feuille | Ancien contenu réutilisé |
| Résumé / évaluation | panneau « Évaluation d'achat » (statut, fournisseur, infos clés, manquantes, prochaine étape) | `summaryScreen` de l'ancien Field : tableau de compteurs « OÙ ON EN EST », « ANALYSE », « DÉCISION D'ENTREPRISE », cartes de saisie propriétaire | **Ne correspond pas : gros compteurs, ancien contenu** |
| Voix | action principale (votre correction) | inexistante | **Absent** |
| Ordinateur | trois volets | non fait (aucun écran dédié) | Absent (voir G11) |

Conclusion : il correspond sur la barre du bas, la palette et le principe « une suggestion ». Tout ce qui fait l'expérience (en-tête, produit, fil, action principale, évaluation) vient de l'ancien Field Mode.

---

## C. Cause de la dérive

1. **J'ai traité l'image comme une direction artistique et pas comme une spécification.** Elle était jointe au message de validation de la Phase A. Je ne l'ai ni décomposée composant par composant ni mise dans le document de conception ; j'ai suivi le texte de la spécification (`CONVERSATION_FIRST_SPEC`) et mes propres wireframes ASCII. C'est ma faute, pas un malentendu de votre part.
2. **Le principe « plus petit changement » a été appliqué à l'interface.** Il valait pour le moteur ; pour l'écran il a conduit à assembler des pièces existantes (`bubble()`, `understanding()`, `attentionCard()`, `claimsCard()`, `summaryScreen`) dans une nouvelle coquille. D'où « l'ancien Field Mode réorganisé ».
3. **La coquille globale n'était pas dans mon périmètre mental.** L'en-tête, la barre de statut et le badge serveur appartiennent à l'ancien shell ; je les ai laissés, et ils prennent le haut de l'écran.
4. **Mon critère de réussite était structurel et pas visuel.** Mes tests e2e vérifient « au plus un contrôle, une suggestion, une feuille fermée » : cela garantit le calme, pas la ressemblance. Je n'ai jamais comparé mes captures à l'image.
5. **Une décision précédente a écarté la voix.** Vous aviez répondu NON à l'audio (Q2) ; j'ai donc fait de la saisie le parcours principal, ce qui contredit ce que le test physique vient de montrer. Ce n'est pas une erreur, mais cela explique l'absence du micro.
6. **La langue d'action n'était pas posée.** La spécification parlait de « question à poser » sans dire la langue ; j'ai choisi le français pour votre lecture, alors que l'usage est de la lire au fournisseur.

**Correction de méthode proposée** : (a) une table de conformité « élément du mockup → composant → fichier », (b) un **portail de fidélité visuelle** : avant tout test physique, je produis des captures à 390 px de chaque état du wireflow et vous les validez ; (c) des tests de structure dérivés du mockup (carte produit, micro principal, fil à deux côtés, suggestion compacte, rangée de confirmation, barre à trois pastilles).

---

## D. Nouveau wireflow (téléphone)

Principe : le fil est l'écran. Un seul élément « en direct » (la suggestion). Tout détail est une feuille secondaire.

### D0. Avant la conversation
- **En-tête** : « Nordla / China Sourcing » + cloche (voir G6). Les réglages (dossiers, serveur, jeton, mode Expert, Safety Gate) sont derrière une icône discrète (feuille « Réglages »), et la connexion ne devient visible que si elle pose un problème (un point d'état dans l'en-tête).
- **Carte produit** : photo (ou emplacement « Ajouter une photo »), nom, catégorie, pastille « Nouveau ». Si le produit n'a pas encore de nom : un champ unique dans la carte, pas une étape.
- **Action dominante** : un grand bouton marine **🎙️ Démarrer la conversation**. Deux accès secondaires dans la barre du bas : *Scanner / Ajouter*, *Écrire* (repli).
- Rien d'autre.

### D1. Conversation active
- La carte produit se réduit en bandeau (photo, nom, pastille « En discussion »).
- **Indicateur d'écoute** clair et permanent (point rouge, durée, « Enregistré sur ce téléphone »), avec Pause et Terminer. Aucune écoute silencieuse.
- **Fil de messagerie** : tours du fournisseur à gauche (texte d'origine en gros ; en dessous, en petit, la version dérivée EN/FR, étiquetée « traduction automatique » quand elle vient d'un moteur), vos tours à droite, heures, pièces jointes en cartes fichier. Les originaux ne sont jamais remplacés.
- Aucun champ à remplir, aucun compteur. La barre du bas reste : Conversation (actif) · Scanner / Ajouter · Écrire.

### D2. Suggestion contextuelle
- **Une** carte compacte dans le flux, au bon moment (règles de silence, maintien et pause déjà construites), à la place de la carte actuelle :

  > 💡 **ASK NEXT**
  > **Can we mix different colours in the same carton?**
  > *FR — Peut-on mélanger plusieurs couleurs dans le même carton ?*  (petit, gris)

- Un tap sur la carte ouvre une action simple : **Montrer au fournisseur** (la phrase anglaise plein écran, très grande), **Pas maintenant**. Plus tard, quand une version chinoise fiable existe : **Montrer / jouer en chinois**, avec son état de relecture.
- Elle disparaît d'elle-même quand le fournisseur répond (« Yes, you can mix colours, minimum 25 pieces per colour. »). Elle ne revient pas.
- Au plus une ; jamais plusieurs questions concurrentes.

### D3. Alerte critique
- Bandeau ambre ou rouge en haut du fil, **uniquement** pour : contradiction (« MOQ : avant 50, maintenant 100 »), alerte de sécurité exacte, document qui contredit le dossier. Pas de modale, pas de son. Un tap ouvre la feuille Avant / Maintenant avec les deux choix et « Demander ».

### D4. Rangée « N éléments à confirmer »
- Une rangée discrète sous le fil ; un tap ouvre une **feuille** en liste compacte (une ligne par fait, ✓ / ◌, sans cartes) avec « Tout confirmer » seulement pour le groupe propre ; les cas à part (ambigu, faible confiance, issus d'une transcription automatique, déclarations de documents) sont des lignes séparées, confirmées une par une. Jamais ouverte automatiquement.

### D5. Fin de conversation
- **Terminer** → feuille « Fin de conversation » : « Voici ce que j'ai compris », les 3 points les plus importants encore manquants, la prochaine étape conseillée. Rien d'obligatoire. Les originaux (texte, audio) restent attachés au dossier.

### D6. Résumé = Évaluation d'achat
- Une feuille (et, sur ordinateur, le volet droit) qui reprend la structure du mockup : pastille « N éléments à confirmer » ; statut ; fournisseur ; **Informations clés** (prix, MOQ, délai, certifications annoncées, chacune avec son état ✓ ◌ !) ; **Informations manquantes** (puces ambre, 3 maximum) ; **Prochaine étape**. Les gros compteurs, les cartes de saisie propriétaire et les paramètres Money disparaissent de ce volet : ils vont dans « Réglages du dossier » (feuille secondaire, sur demande).

---

## E. Faisabilité Voice First (étude, aucune installation)

Les chiffres de qualité et de coût sont des **ordres de grandeur issus de connaissances publiques**, non mesurés ici et à revérifier avant décision (l'état des produits change). Rien n'a été téléchargé ni testé.

### E1. La chaîne
`micro → capture → segmentation / tours de parole → transcription FR/EN/ZH → traduction éventuelle → extraction Nordla → provenance → contexte → suggestion`

Ce qui existe déjà : l'extraction déterministe EN/ZH, la provenance (original → transcription → traduction → extraction, confiance plafonnée pour le dérivé), le contexte, le présentateur, la frontière de providers (vide). Ce qui manque : la capture, la segmentation, un moteur de transcription, la lecture des nombres dits à voix haute.

### E2. Capture sur Firefox Android
- `getUserMedia` + `MediaRecorder` : **vérifié sur votre téléphone** (Firefox 157, Android 16) : enregistrement hors-ligne OK, `audio/ogg;codecs=opus` environ 950 Ko/min, re-rendu sans effet, stockage persistant accordé.
- **Non vérifié** : enregistrement écran verrouillé ou appli en arrière-plan. Un navigateur n'a pas de service de premier plan : la capture doit supposer **écran allumé** (API Wake Lock à vérifier sous Firefox Android) et un indicateur visible. C'est la principale contrainte terrain.
- Entrée casque / micro externe : possible via le système, à tester.
- Précautions : indicateur d'enregistrement permanent, pause, stockage local par défaut, aucune copie automatique (votre décision Q3).

### E3. Segmentation et tours de parole
- **Détection d'activité vocale** (VAD) : des modèles légers existent (par exemple Silero VAD, environ 2 Mo, licence permissive à confirmer) pour couper en énoncés ; sans modèle, un seuil d'énergie suffit en V1.
- **Qui parle** : la diarisation automatique de qualité n'est pas réaliste sur téléphone en V1. Options : (1) bascule manuelle « Fournisseur / Moi » d'un tap ; (2) heuristique de langue (le fournisseur parle chinois, vous français/anglais) valable seulement quand les langues diffèrent ; (3) rien : tout est « conversation » et les faits restent des déclarations à confirmer. Je recommande 1 + 2, avec 3 comme repli.

### E4. Transcription : candidats

| # | Candidat | Firefox Android | En ligne / hors-ligne | FR / EN / ZH | Qualité attendue (salon/usine) | Latence | CPU / RAM | Licence commerciale | Confidentialité | Coût | Réseau | Si indisponible |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Web Speech API** (`SpeechRecognition`) | **Non supporté par Firefox** | en ligne (Google côté Chrome) | oui | bonne | faible | nul | n/a | audio envoyé à un tiers | 0 | oui | **écarté** pour Firefox |
| 2 | **Transcription sur votre PC** par le serveur déjà utilisé (whisper.cpp ou faster-whisper ; Whisper small / medium / large-v3-turbo) | oui (le téléphone envoie l'audio au serveur par le tunnel existant) | hors-ligne **pour le PC**, mais le téléphone doit joindre le PC | oui / oui / oui | **la meilleure sans cloud** : chinois correct à bon avec medium/large, sensible au bruit et aux modèles de produits | quasi-direct par morceaux de 5–10 s si le PC est assez rapide (CPU seul : small lent mais utilisable, large lent ; GPU : rapide) ; sinon différé | RAM PC : small ≈ 1 Go, medium ≈ 2–5 Go, large/turbo ≈ 3–6 Go (modèles de 0,5 à 3 Go) | MIT (poids et code Whisper) | **reste chez vous** | 0 € récurrent ; **installation logicielle + téléchargement de modèle = validation requise** | oui (téléphone → PC) | **repli : capture locale et transcription différée** dès que le PC est joignable |
| 3 | **Whisper dans le téléphone** (WebAssembly : whisper.cpp wasm / transformers.js) tiny, base | oui en WASM CPU ; **pas de WebGPU sous Firefox Android** ; fils d'exécution demandent l'isolation inter-origines (en-têtes à ajouter) | hors-ligne après mise en cache du modèle | oui | tiny : faible, base : moyen ; en chinois bruité insuffisant pour des chiffres ; small plus correct mais **plus lent que le temps réel** sur la plupart des téléphones | élevée | CPU fort, 0,3–1,5 Go de RAM, batterie | MIT | **reste sur le téléphone** | 0 € ; **modèle 75 à 470 Mo = validation requise** | non | si trop lent : capture seule |
| 4 | **sherpa-onnx en WASM** (Zipformer / Paraformer en flux, zh-en) | oui (WASM) | hors-ligne | ZH + EN bons, FR faible | meilleur compromis **chinois en flux sur appareil**, mais les modèles chinois les plus performants viennent d'Alibaba (**licence de modèle à vérifier avant usage commercial**) | faible (flux) | moyen | code Apache-2.0 ; **modèles : licence par modèle, à vérifier** | local | 0 € ; modèle ≈ 100–250 Mo = validation requise | non | si indisponible : option 2 ou capture seule |
| 5 | **Vosk** (WASM, petits modèles) | oui | hors-ligne | ZH, EN, FR | médiocre en environnement bruyant, utile pour mots courts et nombres | faible | faible | Apache-2.0 | local | 0 € ; modèle ≈ 40–50 Mo | non | repli léger |
| 6 | **STT cloud** (Google, Azure, Deepgram, OpenAI, iFlytek, Alibaba) | oui | **en ligne uniquement** | oui | la meilleure qualité et la plus faible latence | faible | nul | selon fournisseur | **audio du fournisseur envoyé à un tiers (parfois en Chine)** ; incompatible avec « local par défaut » sans consentement par usage | **payant ou crédit limité** : contraire à « 0 € obligatoire » ; jamais activé par défaut | oui | indisponible dans une usine mal couverte |
| 7 | **Capture seule + transcription différée** | oui | hors-ligne | tous | n/a (le moteur de l'option 2 ou 3 passe ensuite) | différée | faible | n/a | local | 0 € | non | **toujours disponible** (c'est le plancher) |

Lecture : **aucune option sur le téléphone n'est, à ma connaissance, assez fiable en chinois bruité pour du direct sans réserve** ; la voie qui respecte vos contraintes (0 €, local, confidentiel) et donne la meilleure qualité est **PC + capture locale** (2 + 7). Les options 4 et 5 sont des replis sur appareil à évaluer. Le cloud est une option que seul vous pouvez activer, par usage.

### E5. Traduction et lecture à voix haute

| Candidat | Rôle | Remarques |
|---|---|---|
| **Phrasebook existant** (fixe) | questions → anglais (déjà écrit), chinois (non relu) | zéro dépendance ; l'anglais **existe déjà** dans le moteur (`text.en`) : afficher l'anglais en premier ne demande aucune traduction |
| **Opus-MT zh→en / en→zh** (modèles Marian, via ONNX) | traduire des tours complets | licence CC-BY-4.0 (attribution) ; qualité modeste ; peut tourner sur le PC |
| **LLM sur le PC** (par exemple Qwen2.5-7B-Instruct, Apache-2.0, via llama.cpp) | traduction et nettoyage de transcription | bonne qualité zh↔en, 6 à 8 Go de RAM en 4 bits, quelques secondes ; installation = validation requise |
| **NLLB-200** | traduction | **licence non commerciale (CC-BY-NC)** : écarté |
| **Traduction cloud** (DeepL, Google) | traduction | gratuité limitée, données envoyées à un tiers : sur décision seulement |
| **Synthèse vocale du système** (`speechSynthesis`) | jouer la phrase en chinois | utilise les voix installées sur le téléphone (souvent présentes) : gratuit, local ; **réservé aux phrases relues par un locuteur natif** |

### E6. Extraction sur transcription
- Les chiffres dits à voix haute (« fifty pieces », « 五十个 », « USD eight point two ») ne sont pas tous gérés par l'extracteur : **à ajouter** (nombres en toutes lettres EN et ZH).
- Codes produit (« PB-X200 » dicté « P B X two hundred ») : la transcription les déforme ; tout fait dérivé de l'audio reste plafonné à confiance moyenne et confirmé **individuellement** (votre règle), avec l'extrait audio et l'horodatage comme preuve.
- L'audio original et ses segments restent l'autorité ; transcription et traduction sont des dérivés étiquetés.

### E7. Questions juridiques et de terrain (pas des conseils)
Enregistrer la voix d'une personne : exigences de consentement et de protection des données (UE : RGPD ; Chine : loi sur la protection des informations personnelles ; usages de salon). À vérifier par vous avant tout usage réel ; l'application doit au minimum afficher l'enregistrement et permettre de le stopper.

### E8. Recommandation et mesure
- **Plancher garanti (sans validation de modèle)** : capture locale + segments + suggestions anglaises dérivées du contexte (déjà possible sans transcription pour les sujets saisis ou dictés manuellement). Le produit reste utilisable avec tous les providers indisponibles.
- **Cible V1 à valider** : transcription sur votre PC par morceaux, différée si le réseau manque.
- **Mesure avant décision** : 10 enregistrements courts de vos propres phrases (anglais et chinois, nombres, codes produit, bruit de salon simulé), passés sur 2 moteurs candidats ; critère de réussite proposé : prix, MOQ, quantités, délais corrects à au moins 95 %, codes produit corrects à au moins 85 % en conditions calmes. Ce test demande **votre accord pour télécharger au moins un modèle** ; sans accord, je ne le lance pas.

---

## F. Plan de correction (par fichier, sans toucher au moteur)

### Conservé tel quel (derrière l'interface)
`core/*` : `conversation-engine.js` (P5), `topics.js`, `context-engine.js`, `suggestion-presenter.js`, `providers.js`, `understanding.js`, `phrases.js`, `candidate-view.js`, `conversation.js`, `case.js`, reducers, provenance, règles, coûts, verdict ; serveur ; PWA ; sync ; tests unitaires ; mode Expert et ses 9 écrans ; infrastructure e2e.

### Remplacé dans le parcours Field
| Aujourd'hui | Devient |
|---|---|
| `ui/screens/fieldfirst.js` | nouvel écran (même nom ou `fieldvoice.js`) construit **à partir du mockup** : en-tête de marque, carte produit, fil de messagerie, carte de suggestion compacte, rangée de confirmation, barre à trois pastilles, indicateur d'écoute |
| `ui/field.css` | refait selon le mockup (composants `.fm-*` : carte produit, bulles, carte fichier, carte suggestion, rangée) |
| formulaire « Quel est ce produit ? » | champ intégré à la carte produit |
| feuille « Nordla a compris » (cartes) | liste compacte (une ligne par fait) ; mêmes règles et mêmes événements |
| feuille Résumé (`summaryScreen`) | feuille **Évaluation d'achat** à la structure du panneau droit du mockup |
| suggestion en français + 2 boutons | carte « ASK NEXT » : anglais en premier (`text.en`), français discret ; tap → *Montrer au fournisseur / Pas maintenant* |
| en-tête, hamburger, badge SERVER VERIFIED, barre Safety Gate | en mode terrain : en-tête de marque ; connexion et Safety Gate dans « Réglages » (une pastille d'état seulement en cas de problème) |

### Masqué du parcours principal (conservé ailleurs)
Dossiers, serveur, jeton, mode Expert, formulaires techniques, provenance détaillée, confirmations individuelles, paramètres Money, documents et règles : feuille « Réglages » et Expert.

### Supprimé du parcours Field
Pastilles d'état permanentes, messages « Coût rendu incomplet / Il reste N points », lien « Que dois-je demander maintenant ? » (déplacé dans l'action de la suggestion), compteurs « OÙ ON EN EST », cartes de saisie propriétaire dans le résumé. L'ancien `talkScreen` (déjà non branché) est retiré du code mort sur votre accord.

### Ajouté (Voice First), **après validation du design et des conditions de la section E**
1. `core/capture.js` (pur) : modèle de tours et de segments, états d'enregistrement.
2. `ui/capture/recorder.js` : capture du micro, indicateur, Wake Lock, découpe en segments ; stockage local.
3. Provider de transcription enregistré **vide** ; premier provider (PC) seulement après votre accord.
4. Extension de l'extracteur : nombres dits en toutes lettres (EN, ZH).
5. Point d'entrée serveur de transcription (hors-ligne si le PC n'est pas joignable : capture différée).

### Ordre de travail proposé (petits commits locaux, tests d'abord)
1. **Portail de fidélité** : captures à 390 px de chaque écran du wireflow (D0 à D6) rendues avec des données de démonstration, **vous les validez avant tout branchement**.
2. Habillage du shell terrain (en-tête, réglages, suppression des bandeaux).
3. Carte produit, fil de messagerie, carte de suggestion (anglais), rangée de confirmation, feuilles Évaluation d'achat et Confirmation.
4. Tests de structure dérivés du mockup + e2e réécrits.
5. Seulement ensuite : capture audio (si autorisée), puis provider PC (si autorisé).
Le mockup ordinateur (trois volets) est hors lot tant que vous ne le demandez pas (G11).

---

## G. Conflits entre exigences et mockup (à trancher par vous ; je n'ai rien choisi)

| # | Mockup / exigence A | Exigence B | Conflit | Proposition (à valider) |
|---|---|---|---|---|
| G1 | Le mockup n'a **aucun micro** ; l'action est une barre à trois pastilles | Votre correction : action principale **🎙️ Démarrer la conversation** | action dominante différente | garder la composition du mockup, ajouter le bouton micro marine dans la carte produit (avant) et un contrôle d'écoute (pendant) |
| G2 | Suggestion du mockup en **français** (« Demandez si le prix inclut… ») | Votre correction : phrase utilisable en **anglais** | langue de la suggestion | anglais en gros, français discret dessous (comme votre exemple) |
| G3 | Fournisseur « **Vérifié** » (pastille verte) | ✓ = confirmé par vous ; aucune vérification de fournisseur n'existe | affirmation non fondée | retirer la pastille, ou « Déclaré » avec état ◌ |
| G4 | Frise **Discussion / Échantillons / Validation / Commande** | pas de workflow d'achat construit (P8/P9 hors périmètre) | statuts inexistants | n'afficher que « Discussion » (dérivé), les suivants absents ou grisés « pas encore » |
| G5 | Certifications « ISO 9001, BSCI » en information clé | un document annoncé n'est pas une preuve | statut de preuve | afficher « annoncé par le fournisseur » (◌), jamais comme acquis |
| G6 | **Cloche** avec point rouge | pas de notifications ni de déclenchement en arrière-plan | notification | la cloche ouvre les alertes critiques déjà calculées, sans notification poussée ; ou la retirer |
| G7 | Fil **en français des deux côtés** | l'original du fournisseur (chinois/anglais) est conservé et jamais remplacé | langue du fil | original en gros, dérivé EN/FR en petit, étiqueté |
| G8 | Suggestion à **un chevron**, sans bouton | besoin de « Montrer », « Pas maintenant » | actions | le chevron ouvre une petite feuille d'actions |
| G9 | « Inox 304 » dans la carte produit | une matière est un fait à confirmer | fait non confirmé | catégorie seulement, ou « Inox 304 » en ◌ |
| G10 | Messages du propriétaire tapés dans le fil | Voice First : le propriétaire parle | mode de saisie | ses tours viennent de la voix ou de l'action « Montrer » ; la saisie reste un repli |
| G11 | **Trois volets sur ordinateur** | aucun écran ordinateur demandé jusqu'ici | périmètre | phone d'abord ; ordinateur dans un second lot sur les mêmes composants |
| G12 | Décision **Q2 : pas d'audio** dans cette phase ; Q5/Q6 | Voice First | décision antérieure | Q2 levée pour la **conception et la capture locale** uniquement si vous le confirmez ; aucun modèle sans accord |

## Compatibilité Constitution Nordla (rappel)
Le contenu reste conforme : l'évaluation reste une évaluation de domaine (pas la décision d'entreprise), aucun Sujet / Levier / Règle / Décision dans China Sourcing, aucune importation de `socle-decision`, providers adaptables et choisis par vous (pas de routage, L3-001), pas d'agent déclenché en arrière-plan (L3-009), pas de lecture de documents avancée (L3-011). La transcription par PC est un adaptateur borné ; elle n'est pas un routeur de modèles.

## Ce que j'attends de vous
1. Confirmer l'image comme référence unique et trancher G1 à G12 (même par un simple « proposition retenue »).
2. Dire si le portail de fidélité (captures à valider avant tout branchement) vous convient.
3. Dire si je peux mesurer la transcription (section E8), ce qui exigerait de télécharger au moins un modèle.
4. Confirmer si le serveur du checkpoint #3 doit rester allumé : il tourne toujours sur `9100e56`, avec l'écran que vous avez rejeté.
