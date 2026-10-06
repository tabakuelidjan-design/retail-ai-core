# China Sourcing - Voice First : résultats mesurés du banc d'essai V1 (LAB/CONTROLLED)

- **Date** : 2026-10-06. Banc isolé dans `tools/voice-bench/` ; données, modèles et résultats bruts dans `data/local/voice-bench/` (ignoré par Git). Aucun changement dans l'application Nordla, ses serveurs ni sa configuration.
- **Appareil** : Xiaomi 17 Ultra, Firefox 157, Android 16 (mesures de latence et de stabilité) ; Edge et Firefox 157 de bureau (transcriptions de comparaison).
- **PORTÉE : `LAB/CONTROLLED` UNIQUEMENT.** Le corpus est lu par les voix de synthèse de Windows (Microsoft David = propriétaire, Microsoft Zira = fournisseur), en anglais américain, sans accent. **Il n'y a eu ni `REAL SPEAKER`, ni `FIELD`, ni mandarin.** Aucun résultat ci-dessous ne valide l'anglais accentué du fournisseur chinois, le mandarin ou le bruit réel de salon ou d'usine. Le bruit est synthétique (brouhaha fait de phrases superposées, bruit de machine fabriqué), pas enregistré.
- **Chaîne mesurée** : `audio → transcription → normalisation des nombres → extraction → sujet → ASK NEXT`. Le module d'extraction, le sujet courant et le moteur de contexte sont les **vrais** modules de Nordla, lus sans modification. Les mesures de transcription (WER) sont données à titre d'information ; la décision se prend sur l'utilité pour Nordla.

## 1. Fonctionnement de chaque moteur autorisé

| Moteur | Résultat | Cause / détail |
|---|---|---|
| Moteur Moonshine WebAssembly 0.1.5 + `tiny-streaming-en` | **FONCTIONNE sous Firefox Android** (isolation COOP/COEP, SIMD et fils d'exécution OK) | chargement 2,5 à 2,9 s ; il a fallu télécharger en plus `frontend.ort` (8 324 920 o) car ce moteur attend l'ancien format du modèle (catalogue `quantized_26_07_30`) |
| Moteur Moonshine 0.1.5 + `tiny-streaming-zh` (mandarin) | **ÉCHEC, candidat arrêté** | cause précise : le catalogue embarqué dans `moonshine.wasm` ne contient **pas** `tiny-streaming-zh` (pour le chinois il ne connaît que `base-zh`, modèle hérité **non commercial**, que je n'ai donc pas utilisé) et son chargeur refuse les fichiers `frontend.model.ort` / `frontend.weights.ort` du modèle mandarin récent. Ce n'est **pas** un problème de Firefox ni du téléphone : le moteur publié (npm 0.1.5, 24 août 2026) est plus ancien que le modèle. Un moteur plus récent n'est pas publié ; en compiler un exigerait une chaîne d'outils non autorisée. **Je n'ai pas contourné.** |
| Whisper tiny int8 + Transformers.js 4.3.0 + ONNX Runtime Web (pinned) | **FONCTIONNE sous Firefox Android** | chargement 5,9 à 6,6 s sur les premiers essais, 5,18 s sur le run d'endurance du 2026-10-06 16:27 ; il a fallu indiquer à ONNX Runtime les fichiers WebAssembly locaux (`wasmPaths`) car sa version de développement réclame par défaut un build « asyncify » de 26,9 Mo, non téléchargé |
| Zipformer (A) | non exécuté | statut `UNKNOWN`, exclu comme décidé |

Téléchargements réels : 53 fichiers, **157 809 161 octets (157,81 Mo)**, tailles toutes conformes aux tailles publiées, SHA-256 de chacun dans `data/local/voice-bench/logs/download-manifest.json` (extrait : `moonshine.wasm` d0e783f6…, `encoder.ort` anglais a8414e1a…, `decoder_kv.ort` anglais 8852553f…, `frontend.ort` 271a5632…, Whisper encodeur 03ff3c99…, décodeur 25e807a9…). Les fichiers du modèle mandarin sont téléchargés mais **inutilisables** avec ce moteur.

## 2. Latence mesurée sur le téléphone (voix de synthèse, fichiers propres, rejeu en temps réel)

| Mesure | Moonshine tiny-streaming-en | Whisper tiny int8 |
|---|---|---|
| Premier résultat partiel après le début de la phrase (médiane) | **342 ms** | sans objet (pas de flux) |
| Texte final après la fin de la phrase du fournisseur (médiane / p90) | **707 ms / 912 ms** | 2 060 ms / 3 043 ms |
| Facteur de vitesse (temps de calcul / durée du son) | 0,25 | 0,31 |
| ASK NEXT affiché (texte final + 1,5 s de silence du présentateur, médiane) | **≈ 2,2 s** | ≈ 3,6 s |
Le seuil proposé (suggestion affichée ≤ 3,5 s) est respecté par Moonshine ; Whisper est à la limite. La mesure d'extraction et de contexte (code pur) est négligeable devant ces délais.

## 3. Stabilité sur 10 minutes (téléphone)

- **Moonshine : 10 minutes complètes (593 s), sans plantage.** 18 échantillons, facteur de vitesse stable entre 0,21 et 0,27 **sans dérive**, texte final entre 588 et 670 ms de moyenne, mémoire WebAssembly **constante à 275,4 Mo** pendant toute la durée.
- **Whisper : 10 minutes complètes sur le second run, sans erreur.**
  - **Premier run (2026-10-06, suite complète) : arrêté à 253 s** sur `NetworkError when attempting to fetch resource`. `MEASURED` : la page n'a pas pu télécharger le fichier audio suivant. `INFERRED` : coupure du tunnel ou du réseau du téléphone, **pas une panne du moteur** (le moteur tournait régulièrement jusque-là, aucune erreur de calcul). Ce premier arrêt ne doit pas être lu comme un plantage de Whisper.
  - **Second run, `tag=xiaomi-whisper`, `mode=endurance`, 10 minutes demandées, écran maintenu allumé (Screen Wake Lock tenu), page au premier plan** : `MEASURED` (fichier `xiaomi-whisper.json`) début 16:27:34, fin 16:37:40 (606 s), **0 erreur**, 7 passes du scénario, 101 énoncés, 18 échantillons ; facteur de vitesse 0,27 à 0,47, moyenne 0,354, **première moitié 0,353 contre seconde moitié 0,355 (aucune dérive)** ; texte final de 1 936 à 2 589 ms selon l'échantillon, moyenne 2 177 ms (première moitié 2 173, seconde 2 181) ; chargement du moteur **5 178 ms** sur ce run. `OBSERVED` (rapporté par le propriétaire) : la page est allée jusqu'à « DONE ». Les fichiers audio sont désormais mis en mémoire avant l'essai, ce qui supprime la dépendance réseau pendant la durée du test.
  - **Ce que cela prouve** : Whisper tiny int8 en WebAssembly tient 10 minutes en continu sur le Xiaomi 17 Ultra / Firefox 157, avec ce corpus de synthèse (LAB/CONTROLLED), sans dérive de vitesse. **Ce que cela ne prouve pas** : la stabilité sur le terrain, avec un vrai micro, du bruit réel, un vrai locuteur, plus de 10 minutes, la température ou la batterie (`NOT TESTED / UNKNOWN`). Les autres mesures de Whisper (latence, ASK NEXT, transcription, CE / RoHS, FOB Shenzhen, extraction, bruit, biais de mots-clés) **ne sont pas modifiées** par ce test.
- **Mémoire de Whisper, chauffe et batterie : non mesurables** dans cette configuration. Firefox Android n'expose ni la mémoire, ni la température, ni l'API batterie, et `adb` n'est pas installé sur le PC ; le télécharger n'était pas autorisé. La dérive de vitesse sert d'indice de chauffe : aucune dérive observée sur Moonshine.

## 4. Utilité pour Nordla (`LAB/CONTROLLED`, 17 énoncés par condition)

« Énoncé utile » = tous les faits attendus compris sans valeur fausse **et** sujet correct. Les chiffres sont ceux du téléphone ; les transcriptions du PC sont identiques pour 192 des 204 énoncés (les 12 écarts viennent du bruit fort).

| Condition | Moonshine : énoncés utiles | Whisper : énoncés utiles | Moonshine : sujet | Whisper : sujet |
|---|---|---|---|---|
| propre | **80 %** | 70 % | 100 % | 100 % |
| brouhaha à 20 dB | 80 % | 70 % | 100 % | 100 % |
| brouhaha à 10 dB | 50 % | 50 % | 82 % | 94 % |
| brouhaha à 5 dB | 30 % | 10 % | 71 % | 71 % |
| machine à 10 dB | 40 % | **70 %** | 94 % | 100 % |
| machine à 5 dB | 30 % | 50 % | 94 % | 100 % |

### Ce que Nordla a compris, en conditions propres (faits trouvés / attendus)
| Fait | Moonshine | Whisper |
|---|---|---|
| MOQ | 2/2 | 2/2 |
| Prix et paliers (`8/50, 7,20/100, 6,80/300`) | **2/2** | 2/2 |
| Devise | 2/2 | 2/2 |
| Incoterm (FOB) et port | 1/2 (port manqué) | 0/2 |
| Délai | 1/1 | 1/1 |
| Paiement (30 % / 70 %) | 2/2 | 2/2 |
| Couleurs et mélange | 3/3 | 2/3 |
| Référence produit | 1/1 | 1/1 |
| **Déclarations CE / RoHS** | **0/2** | 1/2 |
| Contradiction (MOQ 50 puis 100) détectée | **oui** | oui |
| Réponse spontanée (mélange des couleurs) : la suggestion disparaît | **oui** | oui |
**Les nombres, prix, MOQ, délais et pourcentages sont compris à 100 % par les deux moteurs en conditions propres**, y compris les formats « 7 20 » dits à voix haute (Whisper) grâce à la normalisation.

### ASK NEXT (propre, brouhaha 20 dB)
- **Moonshine** : après la liste de couleurs, propose bien « mélange des couleurs » ; ne repose pas le modèle, le palier de prix ni le mélange une fois la réponse donnée ; propose les autres paliers quand un seul prix est donné : **toutes les vérifications passent**.
- **Whisper** : même résultat **sauf** après la liste de couleurs, où la suggestion attendue manque (« manufacturer » à la place) parce que l'extracteur n'a pas lu « black white blue and pink » sans virgules.
- En machine à 10 dB, la suggestion « mélange des couleurs » manque pour les deux moteurs (couleurs mal comprises).

### Exemples de transcriptions propres (téléphone)
| Dit | Moonshine | Whisper |
|---|---|---|
| FOB Shenzhen | « Fobshensen » | « Fob Shinson » |
| CE and RoHS | « sea and rose » | « CE and rows » |
| black, white, blue and pink | « black. White, Blue and pink, » | « black white blue and pink. » |
| twenty five pieces per colour | « twenty-five pieces per color » | « 25 pieces per color. » |

### Transcription ou utilité ?
Sur les énoncés du fournisseur (120 par moteur et par balayage, 6 conditions, téléphone) :
- **15 énoncés** avec un WER supérieur à 20 % **réussissent** quand même sur l'utilité Nordla ;
- **23 énoncés** avec un WER inférieur ou égal à 20 % **échouent** (c'est le cas important : « sea and rose » pour CE et RoHS, « Fobshensen » pour le port, les couleurs sans virgules).

## 5. Ce que les mesures nous apprennent d'autre

1. **Les mots du métier sont le point faible des deux petits modèles** : « CE » et « RoHS » ne sont presque jamais reconnus, « Shenzhen » est déformé. Moonshine propose un **biais de mots-clés** (`keyterm_boost`). Balayage LAB (propre, brouhaha 20 dB, machine 10 dB) : le réglage par défaut n'a pas d'effet ; **à 5 ou 6** CE et RoHS sont reconnus mais « deposit » et « balance » sont **perdus** (paiement 0/2) et les faits parasites augmentent ; **à 7 et plus** le modèle s'effondre (« DDP DDP DDP… »). Ce n'est pas un réglage sûr ; je ne le recommande pas.
2. **Une partie des échecs vient du code de Nordla, pas de la reconnaissance** : l'extracteur actuel ne lit pas une liste de couleurs sans virgules ; il propose aussi des faits à partir de **questions du propriétaire** (« Is it FOB Shenzhen or EXW? » produit un Incoterm). Ces deux points sont à corriger **dans l'extraction**, séparément, avant de juger les moteurs.
3. **Une normalisation minimale est nécessaire** : nombres en lettres (« fifty », « twenty five », « thirty eight point three »), prix dits (« seven dollars twenty »), lettres épelées (« P B X two hundred »), points parasites dans une liste de couleurs, Incoterm collé au port (« Fobshensen »). Elle est écrite dans `tools/voice-bench/normalize.mjs` (hors de l'application).
4. **La reconnaissance du locuteur n'a pas été nécessaire** pour comprendre les faits et proposer ASK NEXT dans ce test ; les énoncés du propriétaire n'ont perturbé ni le sujet ni la suggestion, mais ils ont produit des faits parasites (voir 2). Ce résultat vaut pour une voix de synthèse et un scénario de 15 phrases.
5. **Le bruit fort casse les deux moteurs** : à 5 dB de rapport signal/bruit, 30 % (Moonshine) et 10 % (Whisper) des énoncés restent utiles. À 10 dB de bruit de machine, Whisper tient mieux (70 %) que Moonshine (40 %).

## 6. Limites de ce banc (à ne pas oublier)
- Voix de synthèse non accentuées ; **aucune** mesure du fournisseur chinois parlant anglais, du mandarin, d'un vrai locuteur ou du terrain.
- Bruit synthétique, fabriqué ; 15 phrases + 1 ; une seule exécution par condition (pas d'intervalle de confiance).
- Mandarin : **non mesuré** (moteur incompatible avec le modèle).
- Mémoire de Whisper, température, batterie : non mesurées.
- Le biais de mots-clés a été étudié sur le même corpus (analyse de sensibilité, pas un réglage validé).
- Le succès technique du probe ne vaut pas validation terrain.

## 7. Niveaux de preuve (mise à jour : endurance Whisper close)

| Énoncé | Niveau |
|---|---|
| Moonshine anglais et Whisper tiny chargent et transcrivent sur Xiaomi 17 Ultra / Firefox 157 / Android 16 | `MEASURED` (probe, suite complète) |
| Moonshine anglais : 10 minutes complètes, vitesse stable, mémoire WebAssembly 275,4 Mo | `MEASURED` |
| Whisper tiny : 10 minutes complètes (second run), 0 erreur, aucune dérive de vitesse | `MEASURED` + `OBSERVED` (« DONE » rapporté par le propriétaire) |
| Premier arrêt de Whisper à 253 s : erreur réseau, pas panne du moteur | `MEASURED` (message d'erreur) + `INFERRED` (cause : coupure de liaison) |
| Latence finale : Moonshine 707 ms médiane ; Whisper 2 060 ms médiane ; ASK NEXT ≈ 2,2 s contre ≈ 3,6 s | `MEASURED` (voix de synthèse, fichiers propres) |
| Nombres, prix, MOQ, délais, pourcentages compris à 100 % en propre par les deux moteurs | `MEASURED` (15 phrases de synthèse, une exécution) |
| CE / RoHS mal reconnus, « FOB Shenzhen » déformé, biais de mots-clés instable | `MEASURED` (LAB) |
| Moonshine mandarin bloqué par incompatibilité moteur 0.1.5 / modèle récent | `MEASURED` (message du chargeur, catalogue du moteur) ; **non résolu** |
| Moonshine « meilleur candidat » à ce stade | `INFERRED` (latence et qualité LAB) ; **le passage de l'endurance par Whisper ne change pas cette recommandation** |
| Comportement avec un vrai fournisseur chinois, l'anglais accentué, le mandarin, le bruit de salon ou d'usine, la mémoire de Whisper, la chauffe, la batterie | `NOT TESTED / UNKNOWN` |
