# China Sourcing — Benchmark ASR physique (LAB)

Statut : **infrastructure et runbook prêts. Rien n'a été envoyé à un fournisseur, rien n'a été acheté ni téléchargé.** Aucun fournisseur n'est intégré à Nordla, le mode Field n'est pas modifié, Moonshine reste en place, rien n'est commité ni poussé.

Candidats : A Alibaba Fun-ASR-Realtime · B Speechmatics · C Soniox V5 temps réel · D AssemblyAI Universal-3.6 Pro Streaming · E Qwen3-ASR-1.7B (local). Moonshine et Whisper Tiny : références de comparaison uniquement.

## A. Architecture

```
Xiaomi / Firefox ──canon.html──▶ UN enregistrement canonique (WAV 16 bits, fréquence native, immuable, SHA-256)
                                   data/local/voice-bench/canonical/<session>/   (hors git : data/local/ est ignoré)
                                          │ dérivation déterministe (mono → 16 kHz → PCM16), transformation + SHA enregistrés
                                          ▼
        ASRProvider.transcribe(audio, {pass A|B, context, language, pace, windows})
        ├ providers/soniox | assemblyai | speechmatics | alibaba   (WebSocket temps réel, cadencé comme un vrai micro)
        ├ providers/qwen3                                           (local, fenêtre par fenêtre)
        └ providers/fake                                            (double de test, jamais un candidat)
                                          ▼
        data/local/voice-bench/asr-results/<session>/<provider>-pass<A|B>-<date>.json   (transcription brute, segments, contexte réellement envoyé)
                                          ▼
        score.mjs + resolve.mjs ──▶ report.mjs ──▶ report.md / scored.json   (verdicts, gates fixés avant le premier run)
```

Principe produit conservé : AUDIO SESSION → ASR EVENTS → SEMANTIC TURNS → FACTS → CONTRADICTIONS/MANQUES → ASK NEXT. Un final ASR n'est pas une bulle de chat. Ce banc ne touche que la première flèche.

Code : `tools/asr-bench/` (audio, corpus, context, provider, ws, canonical, resolve, score, run, report, providers/*), `tools/voice-bench/web/{canon,ref}.{html,js}`, `tools/voice-bench/server.mjs`. Aucune dépendance ajoutée (WebSocket natif de Node 24).

## B. Page d'enregistrement canonique

`canon.html` : START RECORDING → l'écran liste chaque étape ; « Suivant » ne fait que poser un marqueur (l'audio n'est jamais coupé) → STOP RECORDING → écoute → **Refaire** (rien n'est gardé) ou **Accepter**. À l'acceptation : SHA-256 calculé par le navigateur, recalculé par le serveur, fichiers écrits en lecture seule (`canonical-native.wav`, `meta.json`, `markers.json`, `script.json`, `SHA256SUMS`). Un deuxième enregistrement sous le même nom est refusé (409). Toute modification d'un fichier est détectée avant chaque run (hash vérifié). Sont enregistrés : format, fréquence, canaux, durée, appareil, navigateur, réglages audio du navigateur (réduction de bruit / écho / gain, par défaut ON comme dans l'application), horodatage. On n'enregistre **jamais** un nouvel échantillon pour un fournisseur.

`ref.html` : après l'enregistrement, tu corriges le texte de référence de la conversation naturelle (segments rejouables). Sans référence, la parole naturelle n'est pas notée.

## C. Corpus / script (73 étapes, ≈ 12 min)

Déterministe (graine 20261007). Silence · A faits sourcing (MOQ 100/500, 6 dollars, FOB Shenzhen, EXW Yiwu, 20 jours, 30 % acompte, 70 % avant expédition, 4 couleurs, carton 24, USB-C, PD 65 W, CE, RoHS, REACH, UN38.3) · B références RB-980HB, ZF-024, ZF-041, 8755C, 8709C dans plusieurs formes parlées + **30 références synthétiques** (6 motifs × 5, sans I/O) · C six phrases mixtes · bruit · D huit sujets de conversation naturelle (30–40 s) · silence. Les 30 références synthétiques ne figurent **jamais** dans un contexte fournisseur (elles mesurent la généralisation).

## D. Notation

- **Identifiant exact** : aucune note partielle (RB-9808B, RB-98HB, RB-9800HB ≠ RB-980HB). Espaces, tirets et formes épelées (« R B nine eight zero H B ») sont lus, pas pénalisés.
- **Faits critiques** (MOQ, prix, devise, Incoterm, port, délai, % acompte/solde, quantité carton, capacité, puissance, certifications, modèle) lus via l'extracteur de Nordla.
- **Gain de contexte** = PASS B − PASS A (+ débordement sur les références synthétiques).
- **Parole naturelle** : WER/CER contre ta référence ; erreurs de sens classées à la main dans le rapport.
- **Hallucination** : tout mot reconnu dans les fenêtres silence/bruit.
- **Stabilité** : boucles, répétitions, fragmentation, erreurs, crash. **Latence** : mesurée, non primaire.
- **Résolution d'identifiants (métrique séparée)** : exactitude ASR brute vs candidat résolu sur un jeu connu. Le résolveur étiquette les candidats (`KNOWN_NEAR`, à confirmer), ne réécrit **jamais** le texte ASR, compte les propositions fausses assurées.
- **Verdicts** : REJECT / PROMISING / STRONG CANDIDATE seulement. STRONG exige : références clés exactes PASS B ≥ 95 %, faits critiques ≥ 95 %, pas d'hallucination systématique (≤ 2 événements, ≤ 5 mots), 0 boucle, 0 erreur, WER naturel ≤ 20 %. Seuils fixés avant tout run, non abaissables. « NO WINNER » est un résultat acceptable. Jamais « prêt pour la production ».

## E. Adaptateurs

| Candidat | Protocole | État |
|---|---|---|
| Soniox | `wss://stt-rt.soniox.com/transcribe-websocket`, modèle `stt-rt-v5`, `context{general,text,terms}` | écrit d'après la doc, **non exécuté** |
| AssemblyAI | v3 `streaming.eu`, `universal-3-6-pro`, `keyterms_prompt` + `prompt` | écrit d'après la doc, **non exécuté** |
| Speechmatics | `eu.rt.speechmatics.com/v2`, `cmn_en`, `additional_vocab` avec `sounds_like` | écrit d'après la doc, **non exécuté** |
| Alibaba Fun-ASR | WebSocket DashScope run-task/finish-task, vocabulaire créé puis supprimé | **JSON exact NON VÉRIFIÉ** tant qu'aucun run réel n'a eu lieu (marqué `protocolStatus: UNVERIFIED`) |
| Qwen3-ASR-1.7B | CLI `antirez/qwen-asr` (Linux/macOS/WSL2), fenêtre par fenêtre | écrit ; condition favorable (hors ligne, fenêtres), à indiquer dans le verdict |

Contexte PASS B uniquement par le mécanisme documenté de chaque fournisseur, jamais de correction a posteriori ; le contexte réellement envoyé est enregistré dans chaque résultat et recopié dans le rapport. Un premier run réel peut révéler un écart de protocole : il sera corrigé dans l'adaptateur, sans nouvel enregistrement.

## F. Exigences exactes par fournisseur (`node tools/asr-bench/run.mjs requirements`)

| Candidat | Variable(s) d'environnement | Compte / téléchargement |
|---|---|---|
| Alibaba | `ALIBABA_API_KEY`, `ALIBABA_WORKSPACE_ID` (ou `ALIBABA_WS_URL`), `ALIBABA_HTTP_BASE` | compte Alibaba Cloud International, Model Studio activé à Singapour (vérification d'identité) |
| Speechmatics | `SPEECHMATICS_API_KEY` | compte portail Speechmatics |
| Soniox | `SONIOX_API_KEY` | compte console Soniox |
| AssemblyAI | `ASSEMBLYAI_API_KEY` | compte AssemblyAI (plan payant pour désactiver rétention/entraînement) |
| Qwen3 | `QWEN_ASR_BIN`, `QWEN_ASR_MODEL_DIR` (option `QWEN_ASR_PREFIX=wsl`) | poids ≈ 4,4 Gio + compilation de `antirez/qwen-asr` sous WSL2/Linux/macOS |

Les clés ne sont lues que depuis l'environnement ; elles ne sont jamais écrites ni affichées.

## G. Comptes, clés, téléchargements nécessaires

Voir section « OWNER ACTION REQUIRED » ci-dessous.

## H. Coût estimé (indicatif, tarifs documentés à re-vérifier à l'inscription)

Durée ≈ 12–14 min × 2 passes ≈ 0,45 h par fournisseur.

| Candidat | Tarif documenté | Estimation 2 passes |
|---|---|---|
| Soniox | ≈ 0,12 $/h | ≈ 0,06 $ |
| AssemblyAI | ≈ 0,45 $/h (WebSocket inactif facturé) | ≈ 0,20–0,25 $ |
| Speechmatics Enhanced | ≈ 0,80 $/h | ≈ 0,40 $ |
| Alibaba Fun-ASR | quota gratuit ou ≈ 0,16 $ | ≈ 0,16 $ |
| Qwen3 local | 0 $ (disque + CPU) | 0 $ |
| **Total** | | **< 1 $**, **< 3 $** avec relances |

## I. Confidentialité et flux de données

Uniquement **ton** audio, jamais celui d'un fournisseur réel. Tableau complet (exécution, destination, région, rétention, entraînement, DPA, endpoint UE, accès Chine, compte, prix, streaming, mécanisme de contexte, auto-hébergement), chaque case étiquetée VERIFIED / DOCUMENTED CLAIM / UNKNOWN, dans `tools/asr-bench/provider.mjs` (`PROVIDER_META`) et recopié dans chaque rapport. Aucune case UNKNOWN n'est complétée par supposition (par ex. l'accessibilité depuis la Chine continentale de Soniox reste UNKNOWN).

## J. Runbook

1. **Serveur du banc** (Claude le lance et fournit le lien tunnel) puis ouvrir `canon.html` sur le Xiaomi, Firefox.
2. Enregistrer **une seule fois** le script complet, parler naturellement, ne pas s'arrêter aux erreurs. Écouter, Accepter.
3. `ref.html` : corriger les textes de référence des 8 sujets naturels.
4. `node tools/asr-bench/run.mjs plan --session <S>` : voir exactement ce qui serait envoyé (aucun réseau).
5. Pour chaque fournisseur, après réception de la clé : `node tools/asr-bench/run.mjs run --provider <P> --pass A --session <S> --approve-send <P>` puis `--pass B`. Sans `--approve-send=<P>` rien n'est envoyé (code 3) ; sans clé : code 4.
6. `node tools/asr-bench/report.mjs <S>` → `report.md` : verdicts, brut vs résolu, gain de contexte, hallucination, stabilité, latence, tableau de flux de données.
7. Classer à la main les erreurs de sens de la parole naturelle.

Tests : `node --test test/sourcing-asr-bench.test.js` (méthode, notation, immutabilité, garde « rien n'est envoyé sans approbation »), `npm run asr:e2e` (page canonique sur navigateur à micro simulé).

## OWNER ACTION REQUIRED

Seulement ce qui ne peut pas être fait sans toi :

1. **Enregistrer la session canonique** sur le Xiaomi (≈ 15 min, une fois) et corriger les 8 références naturelles.
2. **Créer des comptes et obtenir une clé API** (à me donner via variable d'environnement locale, pas dans le chat) : Soniox, AssemblyAI, Speechmatics, Alibaba Cloud International (région Singapour, + identifiant de workspace). Tu peux commencer par Soniox, AssemblyAI et Speechmatics (inscription simple).
3. **Approuver le coût estimé** : < 1 $ au total, < 3 $ avec relances, sinon rien n'est lancé.
4. **Approuver le téléchargement de Qwen3-ASR-1.7B (≈ 4,4 Gio)** et l'environnement WSL2/Linux pour le compiler.
5. Facultatif : `nordla-context.json` (marque, fournisseur, produit, modèles connus) pour enrichir le contexte PASS B.
6. **Approuver explicitement l'envoi de ton audio** à chaque fournisseur (une approbation par fournisseur).
