# China Sourcing - Voice First : architecture temps réel recommandée (avant tout code STT / traduction)

- **Date** : 2026-10-06 - **HEAD** : branche `feature/china-sourcing-field-mode`
- **Statut** : RECOMMANDATION TECHNIQUE pour validation. Aucun modèle téléchargé, aucune API, aucune dépendance ajoutée, aucun code d'audio, de STT ou de traduction.
- **Objectif** : `conversation fournisseur → transcription suffisamment rapide → compréhension Nordla → extraction → suggestion ASK NEXT pendant la conversation`.
- **Contrainte respectée** : une transcription différée sur PC n'est **pas** la solution principale. Elle n'est qu'une amélioration, car elle empêcherait ASK NEXT de fonctionner pendant la conversation.

## 0. Ce que j'ai vérifié (sources) et ce qui reste non vérifié

| Point | Résultat | Statut |
|---|---|---|
| `SpeechRecognition` (dictée du navigateur) sous Firefox Android 157 | non supporté (désactivé par défaut chez Mozilla) | [vérifié, MDN / Mozilla](https://caniuse.com/speech-recognition) |
| Reconnaissance **sur l'appareil** de Chrome (`processLocally`) | existe, mais lancée sur Windows, Mac, Linux ; **Android pas disponible** au lancement | [vérifié (explainer WebAudio)](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md) ; état actuel sur Android à revérifier. **Écarté** (autre navigateur, pas de chinois garanti) |
| Screen Wake Lock sous Firefox Android 157 | supporté | [vérifié (caniuse)](https://caniuse.com/wake-lock) |
| AudioWorklet sous Firefox Android | supporté | [vérifié (caniuse)](https://caniuse.com/mdn-api_audioworklet) |
| MediaRecorder sous Firefox Android | **fonctionne sur votre téléphone** (sonde du 2026-10-05 : Firefox 157, Android 16, `audio/ogg;codecs=opus`, ≈ 950 Ko/min, hors-ligne OK). Une page de compatibilité consultée l'annonce « non supporté » : **elle est contredite par votre appareil** ; la mesure physique fait foi | [vérifié sur appareil] |
| sherpa-onnx (k2-fsa) | licence **Apache-2.0** pour le code ; démos **WebAssembly** pour reconnaissance en temps réel chinois + anglais (Zipformer), détection d'activité vocale (Silero VAD) et diarisation | [vérifié (dépôt)](https://github.com/k2-fsa/sherpa-onnx) |
| Modèles de streaming bilingues chinois-anglais | `streaming-zipformer-bilingual-zh-en-2023-02-20` (≈ 80 Mo selon une source secondaire) et `…small-bilingual-zh-en-2023-02-16`, en fp32 et int8 ; **tailles exactes et licences des modèles non indiquées** dans la documentation consultée | [vérifié partiellement](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/index.html) ; **licence par modèle à vérifier avant tout téléchargement** |
| Whisper dans le navigateur (WASM) | tiny (39 M de paramètres) tourne sur mobile ; base et small peuvent ne pas se charger (mémoire) et chauffent ; débit mesuré sur un processeur récent de 2 à 3 fois le temps réel pour tiny/base | [vérifié (sources secondaires)](https://www.assemblyai.com/blog/offline-speech-recognition-whisper-browser-node-js) ; sur **votre** téléphone : non mesuré |
| Mots-clés dirigés (hotwords) pour les modèles transducer de sherpa-onnx | à ma connaissance documenté, **non confirmé** dans les pages consultées | non vérifié |
| Qualité réelle en chinois et en anglais accentué, en salon ou en usine | aucune mesure | **non mesuré : c'est le but du banc d'essai de la section 8** |

## 1. Pourquoi le temps réel exige l'appareil lui-même

Un fournisseur parle devant vous, parfois dans un hall sans bon réseau. Tout ce qui dépend d'un aller-retour réseau (PC derrière un tunnel, cloud) disparaît quand le réseau faiblit. Pour qu'ASK NEXT marche **pendant** la conversation et **hors-ligne**, la transcription de premier niveau doit tourner **sur le téléphone**. Ce qui vient d'ailleurs (PC, cloud) ne peut être qu'un renfort.

Autre point décisif : ASK NEXT a surtout besoin du **sujet** (couleurs, prix, délai, paiement, documents) et de quelques nombres, pas d'une transcription parfaite. Un brouillon rapide et imparfait suffit pour choisir la prochaine question ; l'exactitude vient après, avec confirmation.

## 2. Architecture recommandée en quatre niveaux

```
 micro ──► CAPTURE (toujours) ──┬─► original : audio Opus en morceaux de 10 s, stocké sur le téléphone
                                └─► PCM 16 kHz ──► NIVEAU 1 (sur le téléphone, temps réel, hors-ligne)
                                                     VAD ► ASR en flux ► normalisation ► texte brouillon
                                                                   │
        NIVEAU 2 (renfort, optionnel, si réseau + PC) ◄── PCM ─────┤  texte amélioré 3 à 8 s plus tard
        NIVEAU 3 (dégradé)  : si le niveau 1 ne suit pas ► capture seule + indices tapés
        NIVEAU 4 (après la conversation) : ré-transcription complète, écarts → confirmations ciblées
                                                                   │
        texte ► extracteur déterministe (existant) ► candidats (MEDIUM, jamais groupés) ► topics ► contexte ► présentateur ► ASK NEXT
```

### Niveau 0 : capture (toujours, quel que soit le moteur)
- `getUserMedia` avec suppression d'écho, de bruit et gain automatique ; **un seul flux, deux usages** : (a) `MediaRecorder` écrit l'**original** en morceaux de 10 s dans IndexedDB (récupérable après un plantage) ; (b) un AudioWorklet fournit du PCM 16 kHz au moteur.
- Verrou d'écran (Wake Lock) : la capture exige l'écran allumé et l'application au premier plan (un navigateur n'a pas de service d'arrière-plan : à confirmer en test, **non vérifié** écran verrouillé).
- Indicateur permanent « Écoute en cours », pause, arrêt ; stockage local par défaut (vos décisions Q2/Q3 : aucune copie ni synchronisation automatique).

### Niveau 1 : temps réel sur le téléphone (solution principale)
- **VAD** (Silero, via sherpa-onnx WASM) pour couper en énoncés et détecter la fin de parole (≈ 0,5 à 0,8 s de silence).
- **Reconnaissance en flux** par un modèle Zipformer bilingue chinois-anglais (sherpa-onnx WASM, version int8). Résultats partiels (toutes les 200 à 500 ms) et finaux.
- **Mots-clés dirigés** à partir du phrasebook de Nordla (FOB, CIF, MOQ, USD, RMB, UN38.3, CE, RoHS, lithium, power bank, couleurs…) pour améliorer ce qui compte, si le modèle le permet (à vérifier).
- **Normalisation des nombres** (nouveau code déterministe) : « fifty », « 五十 », « eight point two » vers des chiffres ; sans cela l'extracteur actuel (qui lit des chiffres) rate les nombres dictés.
- **Tours de parole sans bascule manuelle** : (1) langue détectée (le fournisseur parle chinois, vous français/anglais) ; (2) si les langues se confondent, **empreinte vocale du propriétaire** apprise une seule fois (10 s de votre voix, modèle d'empreinte de sherpa-onnx, à évaluer) : tout ce qui n'est pas vous est « fournisseur » ; (3) à défaut, un flux unique « conversation » sans attribution (les faits restent des déclarations à confirmer).
- **Latence visée** : fin de phrase du fournisseur → texte final ≈ 0,3 à 1 s ; extraction et sujet < 50 ms (code pur existant) ; attente anti-interruption du présentateur (1,5 s aujourd'hui, à ramener vers 0,8 s en mode voix) ; **ASK NEXT affiché ≈ 2 à 3,5 s après que le fournisseur s'est tu**. Les hypothèses partielles servent à préparer le sujet avant l'affichage.
- Coût 0 €, tout reste sur le téléphone.

### Niveau 2 : renfort en quasi temps réel (optionnel, activé par vous)
- Si le PC est joignable (tunnel déjà utilisé), le téléphone envoie le PCM par morceaux de 3 à 5 s à un moteur plus fort (faster-whisper ou whisper.cpp, MIT) ; le texte amélioré arrive **3 à 8 s plus tard** et remplace le brouillon du même segment. ASK NEXT ne dépend **pas** de ce niveau.
- Le cloud en flux (Azure, Google, etc.) n'est **pas** prévu : coût récurrent et audio du fournisseur envoyé à un tiers. Possible seulement sur décision explicite, par conversation, avec plafond de coût.

### Niveau 3 : réseau dégradé ou hors-ligne
- Le niveau 1 fonctionne sans réseau : c'est le comportement normal, pas un mode secours.
- Si le niveau 1 ne suit pas (appareil trop lent, chaleur) : le dock affiche « transcription limitée », la capture continue, la transcription passe en lots courts ; ASK NEXT repose alors sur les indices (« Écrire », photo) et sur le dernier sujet connu.
- Si aucun modèle n'est installé : capture seule + saisie (le produit reste utilisable, rien n'est simulé).

### Niveau 4 : amélioration après la conversation
- Ré-transcription complète de l'enregistrement avec le meilleur moteur disponible (PC : medium ou large-v3-turbo ; ou téléphone au repos) ; comparaison avec le brouillon : un fait qui change devient un « avant / maintenant » ciblé. Aucune valeur n'est promue automatiquement ; l'original audio reste l'autorité.

## 3. Candidats de transcription (comparatif)

Chiffres de qualité : **aucune mesure sur votre téléphone**. Les colonnes « vérifié » reprennent la section 0.

| Candidat | Firefox Android | Temps réel | Hors-ligne | Chinois / anglais / français | Taille et licence | Rôle proposé |
|---|---|---|---|---|---|---|
| Dictée du navigateur | non | n/a | n/a | n/a | n/a | écarté |
| **sherpa-onnx WASM, Zipformer bilingue** | oui (WASM ; fils d'exécution : en-têtes COOP/COEP à ajouter à nos serveurs) | **oui, en flux** | **oui** | ZH + EN ; FR faible | ≈ 80 Mo (source secondaire) ; code Apache-2.0 vérifié ; **licence du modèle à vérifier** | **niveau 1 (principal)**, sous réserve du banc d'essai |
| Vosk (petits modèles) | oui | oui | oui | ZH, EN, FR séparés | ≈ 40 à 50 Mo par langue ; Apache-2.0 (à confirmer) | repli du niveau 1 (qualité plus faible attendue) |
| Whisper tiny en WASM | oui | non (fenêtres de 5 à 10 s) | oui | multilingue, faible en chinois bruité | ≈ 75 Mo ; MIT (à confirmer) | contrôle de comparaison, pas principal |
| Whisper base / small en WASM | risque (mémoire, chaleur) | non | oui | meilleur | 145 à 470 Mo | écarté sur téléphone |
| faster-whisper / whisper.cpp sur votre PC | oui (via tunnel) | **quasi** (3 à 8 s) | non (PC + réseau requis) | ZH/EN/FR bons (medium, large-v3-turbo) | 0,5 à 3 Go ; MIT | **niveau 2 et 4** (jamais principal) |
| Cloud en flux | oui | oui | non | bon | coût récurrent ; données chez un tiers | non prévu (V1 à 0 €) |

## 4. Traduction et lecture à voix haute (hors chemin critique d'ASK NEXT)
- **ASK NEXT n'a pas besoin de traduction machine** : la phrase anglaise vient du moteur de questions existant (`text.en`), le français aussi.
- Fournisseur chinois : le texte chinois du brouillon est conservé tel quel ; une traduction EN dérivée est un confort de lecture (niveau 2 ou 4 : Opus-MT ou modèle de langue sur le PC), **jamais requise pour extraire** (l'extracteur lit déjà le chinois).
- Jouer une phrase en chinois : synthèse vocale du système, seulement pour des phrases relues par un locuteur natif.

## 5. Ce qui est déjà construit et ce qui manque

| Existant (pur, testé) | À construire (après validation) |
|---|---|
| extracteur EN/ZH, provenance, règles « machine plafonnée à moyenne, jamais groupée », frontière de providers, topics, contexte, présentateur, journal de questions | module de capture et d'enregistrement par morceaux ; Web Worker du niveau 1 ; adaptateur provider « sherpa » ; normalisation des nombres EN/ZH ; extension de `topics.js` pour lire le texte dérivé quand l'original est un audio ; état « écoute / limitée / hors service » du dock ; adaptateur « PC » (niveau 2) ; réconciliation du niveau 4 ; en-têtes COOP/COEP sur les serveurs ; tests avec enregistrements synthétiques |

## 6. Risques
- **Anglais accentué et chinois dialectal** : les modèles bilingues sont entraînés sur du chinois standard et de l'anglais de livre ; la reconnaissance de l'anglais d'un fournisseur chinois peut être mauvaise (risque principal, à mesurer).
- **Chaleur et batterie** (10 à 20 minutes de reconnaissance continue) ; **mémoire** (4 Go de RAM typiques) ; **écran allumé obligatoire** (non vérifié verrouillé).
- **Nombres et références produit** (« PB-X200 ») mal dictés : tout fait dérivé de l'audio reste de confiance moyenne et confirmé individuellement ; l'extrait audio sert de preuve.
- **Écho de l'application** (vous prononcez ASK NEXT, le micro l'entend) : traité comme un tour « moi », sans effet sur les faits du fournisseur.
- **Aspects juridiques** : enregistrer la voix de quelqu'un (RGPD, loi chinoise sur les informations personnelles, usages de salon) : à vérifier par vous ; l'indicateur et l'arrêt sont toujours visibles.
- **Dérive de périmètre** : aucun routeur de modèles, aucune décision, aucune lecture de documents, aucun cloud.

## 7. Plan de décision selon le résultat du banc d'essai
1. **Si le niveau 1 réussit** : c'est la solution principale ; le niveau 2 reste un renfort facultatif.
2. **Si le niveau 1 réussit en chinois mais pas en anglais accentué** (ou l'inverse) : on garde le niveau 1 pour les sujets et nombres, et le niveau 2 devient le renfort recommandé quand votre PC est joignable.
3. **Si aucun modèle sur téléphone n'est assez bon** : le temps réel dépendra du réseau (niveau 2 en flux vers votre PC) ; ASK NEXT fonctionnera alors avec un délai de 5 à 10 s et pas hors-ligne. Je vous le présenterai tel quel, sans l'appeler « principal sans réserve ».

## 8. Banc d'essai proposé (le seul « code » avant branchement) : à valider
Page de test **non branchée** à l'application, lancée sur votre Firefox Android, avec des enregistrements courts que **vous** faites sur place (ou que vous passez à haut-parleur) : 12 énoncés en anglais, chinois et mélangés, avec nombres, Incoterms, couleurs, références produit, et du bruit de salon. Elle mesure, pour chaque moteur : délai du premier résultat partiel, délai de fin d'énoncé, facteur temps réel, **exactitude des faits clés** (nombres, unités, FOB, couleurs, codes), mémoire, chaleur et batterie sur 10 minutes.
Critères de réussite proposés : nombres corrects ≥ 90 % en anglais et ≥ 80 % en chinois ; délai final ≤ 1,5 s ; facteur temps réel ≤ 0,5 ; 10 minutes continues sans arrêt.
**Moteurs comparés** : sherpa-onnx Zipformer bilingue (int8), Vosk (chinois + anglais), Whisper tiny en contrôle. Puis, côté PC, faster-whisper small et medium sur le tunnel pour mesurer le délai du niveau 2.
**Téléchargements à approuver** (tailles indicatives, licences à vérifier une par une avant tout téléchargement) : modèle Zipformer bilingue ≈ 80 Mo, Silero VAD ≈ 2 Mo, Vosk chinois et anglais ≈ 90 Mo, Whisper tiny ≈ 75 Mo ; sur le PC : faster-whisper (paquet Python) + modèle small ≈ 0,5 Go, éventuellement medium ≈ 1,5 Go. **Rien n'est téléchargé sans votre accord explicite.**

## 9. Ce que j'ai besoin que vous décidiez ou me disiez
1. Le modèle et la mémoire de votre téléphone (le logiciel est connu : Firefox 157, Android 16).
2. Dans quelle langue vos fournisseurs vous parlent-ils vraiment (mandarin standard, anglais accentué, dialecte), et dans quel bruit (salon, usine) ?
3. Votre PC est-il avec vous sur place (ou un partage de connexion) ? Cela décide de l'utilité du niveau 2.
4. Accord pour le banc d'essai et pour la liste de téléchargements de la section 8 (ou une liste réduite).
5. Accord pour ajouter les en-têtes COOP/COEP à nos serveurs (changement de configuration limité, nécessaire aux fils d'exécution WASM) au moment du banc d'essai.
6. Valider que le brouillon temps réel crée des candidats de confiance moyenne confirmés individuellement, et que le renfort et la ré-transcription ne font que **proposer** des corrections.

## 10. Compatibilité Constitution Nordla
Providers adaptables choisis par le propriétaire, sans routage automatique (L3-001) ; aucun agent déclenché en arrière-plan (L3-009) ; aucune lecture de documents avancée (L3-011) ; provenance machine inchangée (confiance moyenne, jamais groupée, confirmation individuelle) ; calcul déterministe (NDR-008) ; aucun objet Sujet / Levier / Règle / Décision ajouté dans China Sourcing ; aucune intégration avec `socle-decision`.
