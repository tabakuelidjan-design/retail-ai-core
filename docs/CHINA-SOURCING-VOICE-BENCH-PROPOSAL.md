# China Sourcing - Voice First : fiche des modèles exacts et proposition de banc d'essai V1

- **Date** : 2026-10-06
- **Statut** : PROPOSITION pour validation. **Rien n'a été téléchargé** (seules des pages web et des listes de fichiers ont été lues). Aucun code d'audio, de reconnaissance ou de traduction n'est écrit.
- **Principe validé** : `audio terrain → transcription / indices rapides → extraction Nordla → contexte → ASK NEXT` ; ASK NEXT n'exige pas une transcription parfaite. sherpa-onnx / Zipformer **n'est pas** retenu comme architecture V1 : il n'est qu'un candidat.
- **Codes de preuve** : [V] vérifié dans la source citée ; [D] divergence entre deux sources ; [?] non indiqué dans les sources consultées, donc **à vérifier avant téléchargement** (aucune valeur inventée).

## 1. Fiche des modèles (trois fiches : deux candidats et un contrôle)

### 1.1 Les trois fiches côte à côte

| Champ | **A. Zipformer bilingue en flux** | **B. Moonshine Voice v2, modèles en flux** | **C (contrôle). Whisper tiny** |
|---|---|---|---|
| **Nom / référence exacte** | `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20` [V]. Point de départ : `pfluo/k2fsa-zipformer-chinese-english-mixed` (recette `icefall`, `pruned_transducer_stateless7_streaming`) [V] | « Mandarin Tiny Streaming » (34 M de paramètres), « English Tiny Streaming » (34 M), « English Small Streaming » (123 M) [V, noms d'architecture de la doc ; **noms de fichiers exacts [?]**]. Il faut deux modèles : un par langue | `openai/whisper-tiny` (39 M de paramètres) [V] ; conversion navigateur `onnx-community/whisper-tiny` [V] |
| **Source officielle** | [csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20 (Hugging Face)](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20) ; [documentation sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html) | [dépôt moonshine-ai](https://github.com/moonshine-ai/moonshine) ; [liste des modèles](https://moonshine-voice.readthedocs.io/en/stable/models/available-models/) ; paquet WebAssembly `@moonshine-ai/moonshine-wasm` (page npm illisible : **[?]**) | [openai/whisper-tiny](https://huggingface.co/openai/whisper-tiny) ; [onnx-community/whisper-tiny](https://huggingface.co/onnx-community/whisper-tiny) |
| **Licence du runtime** | sherpa-onnx : **Apache-2.0** [V, dépôt]. ONNX Runtime embarqué : MIT [?] | code Moonshine : **MIT** [V, README]. ONNX Runtime Web : MIT [?] | Whisper (code) : MIT [?]. Transformers.js / ONNX Runtime Web : Apache-2.0 / MIT [?] |
| **Licence exacte des poids** | **Apache-2.0** d'après la fiche Hugging Face [V]. **[D]** la documentation sherpa-onnx le décrit comme « modèle de la communauté, entraîné sur des données internes, aucune licence mentionnée » | **MIT** pour « tous les modèles en flux actuels » d'après la documentation [V] ; **[D]** le README du dépôt `moonshine-v2` dit que les modèles non anglais sont sous « Moonshine Community License » non commerciale, et la doc de `moonshine-js` donne l'espagnol sous licence communautaire réservée aux entités de moins de 1 M$ de chiffre d'affaires. **À trancher dans le fichier de licence du modèle lui-même avant tout téléchargement** | **Apache-2.0** d'après la fiche Hugging Face [V] (le dépôt GitHub d'OpenAI est annoncé MIT [?]) |
| **Données d'entraînement et licence** | non documentées (« jeu interne », sous-ensemble « 12k_hour » cité) [V]. Résultats publiés : CER 3,04 (AIShell-1), 8,97 (WenetSpeech test net) [V]. Licence des données : **[?]** | « entraîné de zéro », composition non publiée [V] ; licence des données **[?]** | 680 000 h de son collecté sur Internet (438 000 h anglais ; 126 000 h non anglais vers anglais ; 117 000 h non anglais, 98 langues) [V]. Licence des données : non précisée [V] |
| **Langues réellement couvertes** | chinois + anglais, mélange dans une même phrase [V]. **Pas de français** | modèles séparés : anglais ; mandarin (« Tiny Streaming » seulement) [V] ; autres langues listées : espagnol, japonais, coréen, vietnamien, ukrainien, arabe. **Pas de français** ; pas de mélange chinois-anglais dans un modèle [V] | environ 99 langues dont **français, chinois, anglais** [V] ; qualité inégale selon les langues, hallucinations possibles [V] |
| **Précision publiée** | CER 3,04 % AIShell-1 ; 8,97 % WenetSpeech [V] (chinois lu ou semi-spontané, **pas de l'anglais accentué**) | anglais : WER 12,00 % (tiny), 7,84 % (small), 6,65 % (medium) ; mandarin tiny : CER 16,1 % « sans espaces » [V]. Jeux de test : [?] | non publiée dans les pages consultées [?] ; tiny est le plus faible de la famille [V] |
| **Taille téléchargée** | int8 : encodeur 173,45 Mo + décodeur 12,49 Mo + joint 3,08 Mo + vocabulaire 0,3 Mo ≈ **189 Mo** [V, listing Hugging Face]. (fp32 : encodeur 314,78 Mo : écarté) | « Tiny Streaming : 26 Mo » d'après un README [D/?] ; tailles des fichiers **[?]** ; format ONNX converti en `.ort` (chargement par projection mémoire) [V] | ONNX int8 : encodeur 10,1 Mo + décodeur 30,5 Mo (+ « decoder_with_past » 29,2 Mo) ≈ **41 à 70 Mo** [V, listing Hugging Face] |
| **Taille en mémoire** | non indiquée [?] ; à mesurer | non indiquée [?] ; à mesurer | non indiquée [?] ; des sources secondaires disent que tiny passe sur mobile mais chauffe |
| **Compatibilité WebAssembly / Firefox Android** | sherpa-onnx propose une démo WebAssembly « reconnaissance en temps réel chinois + anglais, Zipformer », plus VAD et diarisation [V]. Firefox Android : **[?]** à tester | port WebAssembly (Emscripten) existant, API `MicTranscriber`, annoncé en août 2026 [V, blog de P. Warden]. Le mandarin dans le navigateur et Firefox Android : **[?]** à tester ; l'ancienne version JS est « en bêta » [V] | via Transformers.js (ONNX Runtime Web) : WebAssembly oui ; WebGPU **absent sous Firefox Android** [V, recherche précédente] ; Firefox Android : **[?]** à tester |
| **SIMD / fils d'exécution / COOP-COEP** | **[?]** non indiqué dans les pages consultées ; à lire dans les notes de version des artefacts WebAssembly | **[?]** non indiqué | **[?]** : les fils d'ONNX Runtime Web exigent en général COOP/COEP ; un mode mono-fil existe (à confirmer) |
| **Streaming réel** | **oui**, transducteur en flux [V] | **oui**, conçu pour le flux (résultats incrémentaux ; latence « sub-200 ms » et « 50 ms » : **annonces du fournisseur, non mesurées**) [V] | **non** (fenêtres de 30 s) : à simuler par détection d'activité et découpage ; le délai = durée de la phrase + calcul |
| **Contraintes commerciales** | pas d'interdiction connue ; licence des données inconnue ; modèle de 2023, non maintenu | à lever : divergence de licence ci-dessus ; sinon MIT | pas d'interdiction ; mise en garde du fournisseur contre les usages à haut risque ; hallucinations |

### 1.2 Écartés pour ce premier banc d'essai (avec raison)
| Modèle | Raison |
|---|---|
| SenseVoice-Small (FunAudioLLM), int8 ≈ 226 à 228 Mo | **pas en flux** (par phrase) ; licence « FunASR Model Open Source License » : usage commercial non interdit expressément, mais attribution et conservation du nom exigées, retrait automatique des droits en cas de manquement [V] ; **candidat de suivi** seulement si A et B échouent en mandarin |
| Paraformer en flux bilingue (≈ 226 Mo) | même famille de licence FunASR, plus lourd |
| Vosk (petits modèles chinois et anglais) | qualité attendue plus faible, deux modèles ; n'apporte pas d'information nouvelle |
| Whisper base / small | mémoire et chaleur sur téléphone ; sans streaming |
| faster-whisper / whisper.cpp sur votre PC | c'est le **renfort** et la ré-transcription, pas un candidat temps réel ; mesuré dans une étape suivante, pas dans ce premier banc |
| Qwen3-ASR, Fun-ASR-Nano et autres | licence, taille et compatibilité navigateur **non vérifiées** ; non retenus faute de preuves |

## 2. Pourquoi ces deux candidats (A et B) et ce contrôle (C)

- **A, Zipformer bilingue** : le seul modèle **vérifié** qui gère le chinois, l'anglais et leur mélange dans un même flux, avec démonstration WebAssembly et licence Apache-2.0 sur la fiche. Faiblesses connues : environ 190 Mo, aucun français, anglais accentué non démontré, données d'entraînement non documentées.
- **B, Moonshine Voice v2 en flux** : le plus récent (février 2026), conçu pour des appareils modestes et pour le flux, anglais très bien noté (WER 6,65 % à 12 %), mandarin disponible, licence MIT annoncée, port WebAssembly annoncé. Faiblesses : un modèle par langue (pas de mélange), mandarin tiny à 16,1 % de CER, pas de français, divergence de licence, support navigateur mobile et Firefox Android **non documentés**.
- **C, Whisper tiny, contrôle seulement** : utile pour **une** information que A et B ne donnent pas : un modèle multilingue léger (français compris) suffit-il pour le sujet et ASK NEXT malgré un mauvais taux d'erreur ? Il ne sera pas un candidat principal ; si A et B satisfont les critères, il est abandonné.

## 3. Banc d'essai V1 (périmètre réduit)

### 3.1 Ce qui est mesuré (critère principal : l'utilité pour Nordla)
| # | Mesure | Définition |
|---|---|---|
| 1 | Transcription | CER (chinois) / WER (anglais) sur les énoncés du corpus, **donné à titre d'information** |
| 2 | Nombres, prix, MOQ | part des valeurs attendues retrouvées exactement (paliers `8/50, 7,20/100, 6,80/300`, MOQ, délais en jours, pourcentages 30 % / 70 %), séparée pour : anglais du propriétaire, anglais accentué, mandarin |
| 3 | Faits extraits | l'extracteur Nordla **existant** appliqué à la sortie de chaque moteur : précision et rappel des couples (clé, valeur) face à la vérité terrain ; Incoterms (FOB, EXW, DDP), couleurs, références produit, CE / RoHS / UN38.3 (comme déclarations) |
| 4 | Sujet courant | `topics.js` existant : sujet trouvé par énoncé contre sujet attendu |
| 5 | ASK NEXT | rejeu du scénario dans `planContext` + présentateur : suggestion correcte (celle attendue), **redondante** (déjà répondue), manquante |
| 6 | Délai | de la **fin de la phrase du fournisseur** (marqueur dans l'audio de référence) : (a) au texte final, (b) à l'affichage d'ASK NEXT avec le présentateur réel (silence 1,5 s) |
| 7 | Stabilité sur 10 minutes en direct | facteur temps réel et sa dérive, trames perdues, plantages, taille du tas WebAssembly ; batterie et température **si vous branchez le téléphone en débogage USB** (sinon uniquement la dérive de vitesse, qui sert d'indice de chauffe) |

Variante sur le point 5 : le même scénario est rejoué **sans** attribution des tours (flux unique) et avec attribution « idéale » (étiquettes de la vérité terrain). L'écart mesure ce que la reconnaissance du locuteur apporterait, **sans la construire** (ni empreinte vocale ni diarisation dans ce banc).

### 3.2 Corpus (représentatif du terrain)
Chaque énoncé est enregistré une fois dans le téléphone, puis **rejoué à l'identique** pour chaque moteur (comparaison équitable) ; du bruit est mélangé à des niveaux connus.
- **Anglais du propriétaire** (vous) : « What is your MOQ for this power bank? » ; « Can you give me the price for 50, 100 and 300 pieces? » ; « Is the price FOB Shenzhen or EXW? » ; « What is the lead time? » ; « Do you have CE, RoHS and UN38.3 for this model? » ; « Can we mix colours in one carton? »
- **Anglais accentué de fournisseur chinois** (lu par une personne chinoise ; je n'en fabrique pas) : « This model is PB-X200, ten thousand milliamp. » ; « MOQ is fifty pieces. USD 8 for 50, 7.20 for 100, 6.80 for 300. » ; « We can do FOB Shenzhen, EXW also possible, DDP is more expensive. » ; « Lead time is fifteen days after deposit. » ; « 30 percent deposit, seventy percent balance before shipment. » ; « We have black, white, blue and pink. » ; « You can mix colours, minimum twenty-five pieces per colour. » ; « We have CE and RoHS. UN38.3 we are testing now. » ; « Sorry, the MOQ is one hundred pieces for this price. »
- **Mandarin** (lu par un locuteur natif) : 我们有黑色、白色、蓝色和粉色。 ; 起订量五十个，五十个八美元，一百个七块二，三百个六块八。 ; 离岸价深圳，十五天交货。 ; 付款方式是百分之三十定金，百分之七十发货前付清。 ; 我们有CE和RoHS认证，UN38.3正在测试。 ; 不好意思，起订量是一百个。
- **Bruit** : silence ; bruit de salon (brouhaha) ; bruit d'usine (machines) ; mélangés à environ 20, 10 et 5 dB de rapport signal/bruit ; enregistrés sur place si possible.
- **Scénario de 10 minutes** (mêmes énoncés enchaînés en dialogue) pour les mesures 5, 6 et 7, avec une contradiction (MOQ 50 puis 100) et une réponse spontanée qui doit faire disparaître une suggestion.
- **Vérité terrain** : fichier JSON écrit par moi (texte, faits attendus, sujet, suggestions attendues, marqueurs de fin de phrase). Vous le relisez avant le test.

### 3.3 Critères de réussite proposés (utilité d'abord)
| Mesure | Seuil |
|---|---|
| nombres / prix / MOQ | ≥ 90 % anglais du propriétaire ; ≥ 80 % anglais accentué ; ≥ 80 % mandarin |
| sujet courant | ≥ 90 % |
| ASK NEXT correct / redondant | ≥ 80 % / ≤ 10 % |
| délai : texte final / suggestion affichée | ≤ 1,5 s / ≤ 3,5 s |
| 10 minutes en direct | sans plantage ; dérive de vitesse < 20 % |
Un WER élevé ne disqualifie pas un moteur si ces seuils sont atteints. À l'inverse, un bon WER qui échoue sur les nombres ou ASK NEXT est refusé.

### 3.4 Environnement isolé (aucune configuration Nordla modifiée)
- Dossier `tools/voice-bench/` (hors application, non livré) ; modèles et moteurs dans `data/local/voice-bench/` (déjà ignoré par Git) ; **aucune dépendance ajoutée à `package.json`**.
- Serveur statique **propre au banc d'essai**, sur son port et son tunnel, avec les en-têtes COOP/COEP **uniquement là** (si les fils d'exécution sont nécessaires) ; aucun jeton, aucun dossier réel.
- La page importe en lecture seule les modules purs déjà écrits (extracteur, topics, contexte, présentateur) ; elle ne modifie pas l'application.
- Les enregistrements restent dans le téléphone ; les résultats sortent en un fichier JSON que vous me remettez.
- **Provenance** : tout fait issu d'un moteur est un candidat de confiance plafonnée à moyenne, jamais groupé, jamais confirmé ; le banc ne promeut rien.

### 3.4 bis. Ce qui n'est pas dans ce banc
Empreinte vocale, diarisation, traduction, transcription sur PC, cloud, lecture à voix haute, branchement à l'application, modification de serveur.

## 4. Manifeste de téléchargement à approuver (rien n'est téléchargé)
| Élément | Taille | Source | Condition avant téléchargement |
|---|---|---|---|
| A : encodeur, décodeur, joint int8 + vocabulaire | ≈ 189 Mo [V] | page Hugging Face ci-dessus | licence des poids et des données confirmée par vous |
| Artefact WebAssembly sherpa-onnx (reconnaissance chinois-anglais) + Silero VAD | à confirmer [?] (quelques Mo à quelques dizaines de Mo) | version publiée par k2-fsa | taille et exigences SIMD/fils lues dans la note de version |
| B : « Mandarin Tiny Streaming », « English Tiny Streaming », éventuellement « English Small Streaming » | à confirmer [?] (annoncé ≈ 26 Mo pour tiny) | dépôt moonshine-ai | **licence MIT confirmée sur chaque fichier de modèle** (divergence ci-dessus) |
| Moteur WebAssembly Moonshine (paquet npm épinglé) | à confirmer [?] | npm officiel | version épinglée, sources vérifiées |
| C : Whisper tiny ONNX int8 + Transformers.js | ≈ 41 à 70 Mo [V] + moteur [?] | Hugging Face / npm | aucune condition particulière |
Total attendu : de l'ordre de 300 à 500 Mo, **à confirmer** une fois les tailles [?] lues. Je vous renvoie le tableau complété avant le moindre téléchargement.

## 5. Points non résolus à connaître
- **Divergence de licence Moonshine** : trancher dans les fichiers du modèle ; si le mandarin n'est pas MIT, B est écarté pour un usage commercial.
- **Anglais accentué** : aucune donnée publiée pour A ni B ; c'est exactement ce que le banc mesurera.
- **Mélange chinois-anglais** : A le gère dans un modèle ; B demande de choisir ou de faire tourner deux modèles et de décider quelle langue écouter ; le banc mesure aussi ce coût.
- **Mémoire et chaleur** : aucune donnée fiable avant mesure ; sans débogage USB, seule la dérive de vitesse est observable.
- **Support Firefox Android** : non documenté pour A, B et C ; premier critère éliminatoire du banc.

## 6. Ce que j'attends de vous
1. Valider (ou modifier) le choix A + B, avec C en contrôle (ou le retirer).
2. Valider les seuils de la section 3.3.
3. Dire qui lira le corpus d'anglais accentué et de mandarin (une personne chinoise de votre entourage ?), et si vous pouvez enregistrer un bruit de salon ou d'usine sur place.
4. M'autoriser à lire les licences par fichier (Moonshine surtout) et à vous renvoyer le tableau de téléchargement **complété**, avant tout téléchargement.
5. Donner le modèle de votre téléphone et, si vous acceptez le débogage USB, de quoi lire batterie et température.
