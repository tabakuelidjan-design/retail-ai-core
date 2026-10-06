# China Sourcing - Voice First : licences résolues, tableau définitif A/B/C et manifeste de téléchargement

- **Date** : 2026-10-06 - **Statut** : à valider par le propriétaire. **Rien n'a été téléchargé** : seules des pages web, des métadonnées et des listes de fichiers (taille en octets) ont été lues. Aucun code d'audio, de reconnaissance ou de traduction.
- **Téléphone de test** : Xiaomi 17 Ultra, Firefox Android. Le téléphone reste l'appareil terrain principal ; le PC n'est qu'un outil de banc d'essai, de renfort facultatif ou de retranscription.
- **Langues du banc V1** : anglais du propriétaire, anglais de fournisseur chinois, mandarin standard. Ni dialectes, ni reconnaissance du locuteur.
- **Conclusions possibles** : `COMMERCIAL USE CLEARED`, `NOT CLEARED`, `UNKNOWN`. Je ne suis pas juriste : « CLEARED » veut dire que les textes de licence, lus dans les fichiers officiels, autorisent l'usage commercial ; il ne couvre pas un risque juridique que les licences ne traitent pas (voir section 6).

## 1. Résolution des licences (fichier par fichier)

### 1.1 Moonshine : la divergence est résolue
- **Fichier faisant foi** : `LICENSE` à la racine du dépôt `moonshine-ai/moonshine` (lu en entier, copyright Useful Sensors, Inc. dba Moonshine AI, 2025). Il dit : le code est MIT ; « les modèles Moonshine sont publiés sous licence MIT par défaut, dans toutes les langues et à toutes les tailles, ce qui inclut tous les modèles de reconnaissance en flux et tous les modèles anglais ». Les **seules** exceptions, liste déclarée exhaustive, sont les modèles **hérités, non en flux**, hors anglais, sous la « Moonshine Community License » non commerciale (au-delà de 1 M$ de chiffre d'affaires annuel, licence entreprise à demander) : arabe, japonais, coréen, **mandarin Base et Tiny (hérités)**, espagnol Base, ukrainien, vietnamien.
- **Confirmé** par la fiche Hugging Face `moonshine-ai/moonshine-streaming-tiny-zh` (métadonnée `license: mit`, carte « MIT », 27 M de paramètres, non protégée par accès restreint), par `moonshine-ai/moonshine-streaming-tiny` et `-small` (MIT, anglais), et par le paquet npm `@moonshine-ai/moonshine-wasm` 0.1.5 (`license: MIT`).
- **La divergence venait d'un texte périmé** : le README du dépôt `moonshine-v2` dit que les modèles non anglais sont non commerciaux ; le fichier `LICENSE` du dépôt principal le contredit et il est plus récent et plus précis (il nomme les exceptions).
- **Piège de nom à éviter** : le mandarin **hérité** (Base, Tiny non streaming) est non commercial. Le modèle à utiliser est **`tiny-streaming-zh`** (jamais un `tiny-zh` ou `base-zh` hérité). Je vérifierai le chemin exact et les empreintes avant et après le téléchargement.
- Une lecture automatique intermédiaire avait signalé « Apache 2.0 » pour le fichier `LICENSE` : c'était une erreur de lecture ; le contenu réel est MIT + licence communautaire pour les exceptions.

### 1.2 Zipformer bilingue (A) : reste `UNKNOWN`
- Fiches Hugging Face `csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20` et `pfluo/k2fsa-zipformer-chinese-english-mixed` : `license: apache-2.0` (métadonnée), mais **c'est le dépôt d'un contributeur, pas du projet** ; la documentation sherpa-onnx dit « modèle de la communauté, entraîné sur des données internes, aucune licence mentionnée ».
- **Données d'entraînement** : « sous-ensemble 12k_hour », jeu interne, **jamais décrit** ; la fiche ne nomme aucun jeu de données. Je n'ai trouvé aucune preuve que ces données soient commerciales.
- **Indice de risque** : un modèle dérivé de la même base (`lmcu000/zipformer-streaming-zh-en-vi-2e`) est publié en CC BY-NC-SA 4.0 parce que **ses propres** données d'ajustement (WenetSpeech, Bud500) sont non commerciales. Cela ne prouve rien sur la base, mais montre que cette famille mêle des données non commerciales ; la licence de WenetSpeech elle-même n'a pas pu être lue (la page du dépôt renvoie au site officiel).
- **Conclusion : `UNKNOWN`.** Conformément à votre règle, **aucun téléchargement**, ni pour le banc ni pour une intégration.

### 1.3 Whisper tiny (C)
- Poids : fiche `openai/whisper-tiny` : `license: apache-2.0` ; le dépôt GitHub `openai/whisper` : MIT (OpenAI, 2022). Deux licences permissives, toutes deux commerciales. La conversion `onnx-community/whisper-tiny` n'a pas de champ licence (elle renvoie à `openai/whisper-tiny`).
- Données : 680 000 h de son collecté sur Internet (438 000 h anglais, 126 000 h non anglais vers anglais, 117 000 h non anglais) ; les droits sur ces données ne sont pas précisés. Mise en garde du fournisseur : hallucinations, performances inégales selon les accents.
- Exécution : Transformers.js 4.3.0 (Apache-2.0), ONNX Runtime Web (MIT, version 1.22.0 vérifiée ; la version exacte qu'exige Transformers.js 4.3.0 est une préversion `1.31.0-dev` : **à épingler et revérifier**).

### 1.4 Autres candidats lus
- **SenseVoice-Small** (FunAudioLLM) : fiche `license: other`, `model-license` = « FunASR Model Open Source License » ; autorise l'usage, la copie, la modification et le partage ; **exige attribution et conservation du nom du modèle** ; retire automatiquement tous les droits en cas de manquement (y compris des règles de « communauté ») ; ne dit pas explicitement « usage commercial autorisé ». Non streaming ; environ 226 à 228 Mo en int8 ; données « plus de 400 000 h » non décrites. **`UNKNOWN`** tant que vous n'avez pas lu et accepté ce texte.

## 2. Tableau définitif A / B / C

| Champ | **A. Zipformer bilingue** | **B. Moonshine Voice v2 en flux** | **C (contrôle). Whisper tiny** |
|---|---|---|---|
| Modèle exact | `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20` | `tiny-streaming-zh` (catalogue `quantized_26_08_24`), `tiny-streaming-en` et `small-streaming-en` (`quantized_26_08_21`) | `onnx-community/whisper-tiny` : `onnx/encoder_model_int8.onnx` + `onnx/decoder_model_merged_int8.onnx` |
| Source officielle | HF `csukuangfj/…` (contributeur) ← `pfluo/…` | `https://download.moonshine.ai/model/<modèle>/<version>/…` (CDN du projet, chemins issus du catalogue `core/moonshine-model-file-metadata.generated.cpp` du dépôt officiel) ; miroirs HF `moonshine-ai/moonshine-streaming-*` | HF `onnx-community/whisper-tiny` ← `openai/whisper-tiny` |
| Licence du runtime | sherpa-onnx Apache-2.0 | `@moonshine-ai/moonshine-wasm` 0.1.5 MIT | Transformers.js 4.3.0 Apache-2.0 ; ONNX Runtime Web MIT |
| Licence des poids | Apache-2.0 déclarée par un contributeur ; **non confirmée par le projet** | **MIT** (fichier `LICENSE` officiel, fiches HF, npm) | Apache-2.0 (fiche HF) / MIT (GitHub) |
| Données d'entraînement | « 12k_hour » interne, non décrit | anglais : environ 300 000 h (200 000 h de données web publiques et jeux ouverts + 100 000 h internes), jeux non nommés ; mandarin : crawl de podcasts (≈ 91 700 h) et de YouTube (≈ 13 200 h) **pseudo-étiquetés par un modèle de la famille Whisper** | 680 000 h collectées sur Internet |
| Obligations | n/a (non téléchargé) | MIT : conserver le texte de licence et la mention « Useful Sensors, Inc. (dba Moonshine AI), 2025 » en cas de redistribution ; pas de redistribution dans le banc | licence et mention OpenAI ; Apache-2.0 : conserver la licence et l'avis ; pas de redistribution dans le banc |
| Langues | chinois + anglais | EN ; ZH (modèles séparés) ; pas de français | ~99 dont FR, ZH, EN |
| Streaming | oui | **oui** | non |
| WebAssembly | démo officielle | port officiel `moonshine.wasm` ; **COOP/COEP exigés pour la version multi-fils**, version SIMD mono-fil disponible | ONNX Runtime Web, WASM CPU ; WebGPU absent sous Firefox Android |
| **Conclusion** | **`UNKNOWN`** | **`COMMERCIAL USE CLEARED`** sur les textes de licence (poids et runtime) ; **réserve** : données web non licenciées explicitement (section 6) | **`COMMERCIAL USE CLEARED`** sur les textes de licence ; même réserve sur les données |

## 3. Éliminés ou en attente, avec raison

| Candidat | Statut | Raison |
|---|---|---|
| A. Zipformer bilingue 2023-02-20 | **UNKNOWN, non téléchargé** | données internes non décrites ; licence « Apache-2.0 » posée par un contributeur ; famille mêlée à des données non commerciales |
| Moonshine mandarin hérité (Base, Tiny non streaming) | **NOT CLEARED** | « Moonshine Community License » non commerciale ; **à ne jamais utiliser** (piège de nom) |
| SenseVoice-Small | **UNKNOWN, non proposé** | licence FunASR personnalisée (attribution, retrait des droits) ; non streaming ; 226 à 228 Mo ; à relire par vous avant tout |
| Paraformer en flux bilingue | écarté | même famille de licence FunASR, plus lourd |
| Moonshine English Medium | écarté du premier banc | 252 Mo environ ; le Small suffit pour mesurer l'effet de la taille |
| Whisper base / small, Vosk, faster-whisper | hors banc V1 | mémoire / qualité / PC : étapes suivantes éventuelles |
| Qwen3-ASR et autres nouveautés | non retenus | licence, taille et compatibilité navigateur non vérifiées |

Conséquence : **le banc ne compare plus « deux candidats réellement crédibles » mais un candidat propre (B, avec deux tailles d'anglais) et un contrôle (C).** Je ne remplace pas A par un autre modèle sans votre décision. Si B échoue sur le mandarin ou l'anglais accentué, le suivi logique est SenseVoice-Small (après votre lecture de sa licence) ou le renfort sur PC.

## 4. Artefacts qui méritent réellement un téléchargement

| # | Artefact (exact) | Fichiers et tailles exactes (octets) | Sous-total |
|---|---|---|---|
| 1 | Moteur `@moonshine-ai/moonshine-wasm@0.1.5` | `moonshine.wasm` 13 155 937 ; `moonshine.mjs` 156 457 ; scripts JS ≈ 138 000 (le paquet complet, avec cartes et typages : 13,64 Mo) | ≈ 13,45 Mo |
| 2 | `tiny-streaming-zh` (chemin `…/model/tiny-streaming-zh/quantized_26_08_24/`) | `adapter.ort` 1 318 472 ; `cross_kv.ort` 1 288 120 ; `decoder_kv.ort` 19 717 336 ; `encoder.ort` 7 772 792 ; `frontend.model.ort` 27 608 ; `frontend.weights.ort` 2 090 728 ; `streaming_config.json` 509 ; `tokenizer.bin` 74 587 | **32 290 152 o = 32,29 Mo** |
| 3 | `tiny-streaming-en` (`…/model/tiny-streaming-en/quantized_26_08_21/`) | `adapter.ort` 1 319 664 ; `cross_kv.ort` 1 287 544 ; `decoder_kv.ort` 32 583 720 ; `encoder.ort` 7 675 440 ; `frontend.model.ort` 23 344 ; `frontend.weights.ort` 2 093 464 ; `streaming_config.json` 509 ; `tokenizer.bin` 249 974 (sans l'option « horodatage des mots » de 32,5 Mo) | **45 233 659 o = 45,23 Mo** |
| 4 | `small-streaming-en` (**optionnel**) | `adapter.ort` 2 870 368 ; `cross_kv.ort` 5 356 536 ; `decoder_kv.ort` 81 878 600 ; `encoder.ort` 44 148 576 ; `frontend.model.ort` 26 944 ; `frontend.weights.ort` 7 769 464 ; `streaming_config.json` 512 ; `tokenizer.bin` 249 974 | **142 300 974 o = 142,30 Mo** |
| 5 | Whisper tiny ONNX int8 (contrôle) | `encoder_model_int8.onnx` 10 124 977 ; `decoder_model_merged_int8.onnx` 30 719 241 ; `tokenizer.json` 2 480 466 ; `tokenizer_config.json` 282 683 ; `config.json` 2 243 ; `generation_config.json` 3 772 ; `preprocessor_config.json` 339 | **43 613 721 o = 43,61 Mo** |
| 6 | Moteur du contrôle : `@huggingface/transformers@4.3.0` (`transformers.min.js` 581 935) + ONNX Runtime Web (`ort-wasm-simd-threaded.wasm` 11 210 254 ; `.mjs` 20 856, **tailles de la version 1.22.0, à revérifier sur la version épinglée**) | | ≈ 11,81 Mo |

**Total exact des modèles (obligatoires : 2 + 3 + 5) : 121 137 532 o = 121,14 Mo.** Avec l'option 4 : 263,44 Mo.
**Total prévu avec moteurs : ≈ 146,4 Mo sans l'option 4 ; ≈ 288,7 Mo avec elle** (les moteurs sont approximatifs tant que les versions ne sont pas épinglées).

Mesures de contrôle prévues au téléchargement : somme de contrôle de chaque fichier (le catalogue Moonshine publie un CRC32C par fichier), journal des URL, vérification que le chemin est bien `…-streaming-…`. Les fichiers sont rangés dans `data/local/voice-bench/` (ignoré par Git) ; **les moteurs sont chargés depuis ce dossier, pas depuis un CDN, pendant les essais** (le port Moonshine télécharge sinon ses modèles sur `download.moonshine.ai` à la première utilisation : à bloquer).

## 5. Ce que chaque téléchargement nous apprend

| Téléchargement | Ce que nous apprenons |
|---|---|
| Moteur Moonshine (13,45 Mo) | le moteur WebAssembly démarre-t-il sous Firefox Android sur le Xiaomi 17 Ultra, en version SIMD mono-fil seule ou multi-fils (COOP/COEP du banc) ; temps d'initialisation ; mémoire à vide |
| `tiny-streaming-zh` (32,29 Mo) | précision du mandarin standard sur nombres, prix, MOQ, Incoterms, couleurs ; latence incrémentale ; effet du bruit ; si un modèle mandarin seul tient face à un fournisseur qui mélange chinois et anglais |
| `tiny-streaming-en` (45,23 Mo) | anglais du propriétaire et anglais accentué du fournisseur : nombres, `USD 8 for 50, 7.20 for 100, 6.80 for 300`, FOB / EXW / DDP, références produit ; référence de vitesse et de chauffe |
| `small-streaming-en` (142,30 Mo, optionnel) | la taille supérieure vaut-elle son coût (mémoire, chaleur, latence) pour l'anglais accentué ; sans ce fichier nous ne le saurons pas |
| Whisper tiny int8 + Transformers.js (≈ 55 Mo) | un modèle multilingue léger (français compris) suffit-il pour le sujet et ASK NEXT malgré un mauvais taux d'erreur ; comportement hors flux par fenêtres ; hallucinations ; fonctionne-t-il tout court sous Firefox Android |

Ce que nous n'apprendrons pas : A (non téléchargé), le comportement d'un modèle unique chinois-anglais en flux, la reconnaissance du locuteur, le français parlé.

## 6. Réserve juridique que la lecture des licences ne résout pas
Tous les modèles de cette liste (B comme C) sont entraînés sur des données collectées sur le web (podcasts, YouTube, jeux ouverts ou internes) dont les droits ne sont pas précisés, et Moonshine pseudo-étiquette le mandarin avec un modèle de la famille Whisper. Les licences des **poids** sont permissives et explicites ; elles ne garantissent pas les droits sur les données d'origine. C'est le risque commun à presque tous les modèles de reconnaissance vocale ouverts. Je vous le signale pour que vous décidiez en connaissance de cause (avis juridique si le produit est commercialisé) ; il n'est pas résolu par ce document.
Autres points à garder : Moonshine précise que ses modèles ne sont **pas destinés à la surveillance non consentie, à l'identification de locuteur ni aux décisions à enjeu élevé** ; Whisper met en garde contre les usages à haut risque. L'enregistrement de la voix d'un fournisseur reste soumis au consentement (RGPD, loi chinoise sur la protection des informations personnelles, usages de salon), à vérifier par vous.

## 7. Ce que j'attends de vous
1. Accepter ou refuser le statut `UNKNOWN` d'A (aucun téléchargement) et le fait que le banc compare B (deux tailles anglaises) et C.
2. Accepter la réserve de la section 6, ou demander un avis juridique avant de télécharger.
3. Choisir : avec ou sans `small-streaming-en` (+ 142,30 Mo) ; avec ou sans le contrôle Whisper tiny (≈ 55 Mo).
4. Décider si SenseVoice-Small doit être étudié plus tard (je ne le télécharge pas et vous lisez d'abord le texte de la licence FunASR).
5. Le débogage USB est autorisé pour le banc ; dites-moi quand le téléphone est prêt et qui lira le corpus d'anglais accentué et de mandarin.
Après votre réponse : téléchargement des seuls artefacts validés, avec le journal de licences et d'empreintes, puis écriture du banc isolé (aucune modification de l'application ni des serveurs Nordla).
