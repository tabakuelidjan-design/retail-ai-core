# China Sourcing - Voice : controlled real-microphone comparison (Moonshine vs Whisper) and product-reference resolution

- **Date** : 2026-10-07 - **Statut** : banc d'évaluation (LAB). **Rien n'est branché dans le mode Field.** Moonshine reste *candidat*, pas moteur de production.
- **Pourquoi** : le test physique sur le Xiaomi a montré (1) que les finals de Moonshine sont trop petits pour devenir des messages, (2) que les références produit (`RB-980HB`...) sont mal reconnues. Le banc de décembre (voix de synthèse, latence) ne validait ni l'accent réel, ni le bruit, ni les références alphanumériques.

## 1. Le banc (`tools/voice-bench/web/compare.html`)
- **Un seul chemin micro** (getUserMedia + AudioWorklet, 16 kHz, mêmes contraintes que l'application ; case à décocher pour tester sans traitement navigateur) alimente **le même audio** aux deux moteurs en même temps.
- **A. Moonshine tiny-streaming-en** (moonshine-wasm 0.1.5, modèle quantized_26_08_21), en Worker, flux continu. **B. Whisper tiny int8** (transformers.js 4.3.0 + onnxruntime-web), en Worker : l'audio est découpé en énoncés par détection d'énergie (silence de fin 0,7 s, 20 s maximum), chaque énoncé est transcrit en une passe. Mêmes fichiers que le benchmark.
- **Jeu de test** (`tools/voice-bench/corpus/field-prompts.json`) : phrases de sourcing normales, sept références produit dites de plusieurs façons, deux phrases mixtes, et un passage continu libre de 30 à 60 s. Le propriétaire parle naturellement.
- **Rien n'est envoyé hors du serveur LAB.** L'audio n'est gardé que si la case est cochée (`data/local/voice-bench/field-audio/`, sur ce PC), pour rejouer d'autres moteurs plus tard.
- **Attribution à un énoncé par l'horloge audio** (pas par l'heure d'arrivée des résultats). Latence mesurée depuis la fin de parole détectée dans l'audio.
- **Auto-test** (`?selftest=1`) : voix de synthèse à travers le même pipeline, **pour vérifier la plomberie seulement** (jamais un résultat terrain).
- **Évaluateur** (`tools/voice-bench/compare-eval.mjs`) : transcriptions exactes, exactitude des identifiants (via le prototype ci-dessous), exactitude des faits (extracteur réel de Nordla), segmentation, latence, backlog, parole continue. **Il ne choisit pas de gagnant.**
- **Limites connues** : les deux moteurs tournent en même temps sur le même téléphone : leurs latences sont plus élevées qu'en solo (à refaire seul si la décision en dépend). Mémoire WASM/worker, batterie, température : non observables depuis la page.
- **Non testé** : anglais accentué d'un fournisseur chinois : **UNKNOWN**. Mandarin : non supporté, non testé.

## 2. Niveaux explicites (à respecter quel que soit le moteur)
```
AUDIO SESSION                  (une conversation de stand ; l'audio n'est jamais conservé par défaut)
  -> ASR EVENTS / SEGMENTS     (immuables : texte, horloge du moteur, moteur+version ; un final ASR n'est NI un message NI un tour)
  -> SEMANTIC SPEAKER TURNS    (qui parle, d'une traite ; le locuteur reste INCONNU tant que le propriétaire ne l'établit pas)
  -> BUSINESS FACTS            (propositions MACHINE_DERIVED, jamais confirmées d'office)
```
Principe d'interface : Nordla écoute **une seule conversation en cours**. On montre : la transcription vivante et le dernier contexte compris, les faits compris, les contradictions, **une** question ASK NEXT, et la transcription complète à la demande. **Pas une bulle par final ASR.** Les segments restent tous conservés pour la provenance. (Réécriture du Field Voice : après la décision sur le moteur.)

## 3. Résolution des références produit (concept, prototype LAB `tools/voice-bench/identifiers.mjs`)
Le moteur vocal ne produit pas `RB-980HB` : il produit ce qu'il a entendu (« R B nine eight zero H B », « RB980 HB », « are be nine eighty age be »). Une couche **déterministe, séparée** transforme des *candidats de parole* en *candidats d'identifiant* avec leurs preuves :

```
candidats de parole (plusieurs transcriptions possibles, dont celles de plusieurs moteurs)
 + nom / photo / contexte du produit        + texte visible (OCR, plus tard)
 + documents fournisseur (plus tard)        + candidats de recherche marché (plus tard)
   -> CANDIDATS D'IDENTIFIANT { forme canonique, preuves, confiance, needsConfirmation }
```
- Générique : lettres + groupes de chiffres + lettres ; chiffres dits un à un (« nine eight zero ») ou par paires (« nine eighty », « zero twenty four ») ; aucun dictionnaire de références produit.
- **Jamais de correction silencieuse.** Un candidat reste « à confirmer » tant qu'une source indépendante ne le confirme pas (un identifiant connu ailleurs peut seulement le *relever* ou être proposé s'il est à une seule édition de ce qui a été entendu). Un identifiant connu ne remplace jamais ce qui a été entendu.
- Confirmation **peu coûteuse et exceptionnelle** : « J'ai entendu RB-980HB. Est-ce bien ça ? » ; ou résolution par preuve visuelle / documentaire.
- Les quantités et les phrases ordinaires ne sont pas des références ; les mots courants ne sont pas des lettres de référence (tests : `test/sourcing-voice-identifiers.test.js`).
- Si le prototype se montre utile sur le terrain, il serait promu dans `src/sourcing/core/identifiers.js`, relié au contexte produit, au marché et aux documents, et alimenterait les besoins d'information (« quel est le modèle exact ? ») et la recherche de marché.

## 4. Décision à venir
La décision (Moonshine, Whisper, une autre architecture ou un hybride) pèsera : **exactitude terrain, exactitude des identifiants, comportement en conversation continue, latence temps réel, stabilité de l'appareil, confidentialité/hors-ligne**. La latence n'est qu'un critère sur six.
