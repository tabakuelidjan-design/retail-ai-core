# Nordla — Arbre de construction Branding + Marketing + Creative

- **Status:** WORKING BUILD TREE
- **Date:** 2026-10-07
- **Scope:** chantier expérimental / benchmark avant activation production
- **Constraint:** Creative Intelligence et le routage multi-modèles restent différés au niveau Constitution tant que ce chantier n'a pas produit de preuves suffisantes.

# 0. Objectif

Construire une capacité Nordla capable de :

> comprendre la marque → comprendre ce qu'il faut pousser → préparer une campagne → créer les assets → contrôler fidélité/brand → publier/adapter → mesurer → apprendre.

Principe d'infrastructure :

> BUILD/OWN Nordla → open source/open weights → self-host si rentable → API premium uniquement si elle apporte une qualité réellement supérieure.

Objectif stratégique long terme : **99 % Nordla**, sans sacrifier qualité, sécurité ou économie.

---

# 1. Fondation commune du chantier

## 1.1 Model & Capability Registry
Créer un registre unique des moteurs/capacités avec :
- nom/version ;
- tâche supportée ;
- licence code ;
- licence poids ;
- usage commercial ;
- restriction UE ;
- VRAM minimale/recommandée ;
- self-host/API ;
- coût ;
- latence ;
- qualité benchmark ;
- fidélité produit ;
- statut APPROVED / BENCHMARK / REJECT / WATCH.

## 1.2 Provenance / audit
Pour chaque génération :
- moteur exact ;
- version/hash ;
- prompt/brief ;
- assets source ;
- date ;
- coût ;
- durée ;
- modifications ;
- résultat accepté/rejeté ;
- raison du rejet ;
- C2PA/provenance lorsque applicable.

## 1.3 Mesure économique
Mesurer :
- coût par appel ;
- coût GPU ;
- retries ;
- coût par résultat accepté ;
- temps de calcul ;
- stockage temporaire/final.

Aucun moteur n'est retenu uniquement sur son prix par génération.

---

# 2. Brand Foundation

## 2.1 Brand Memory
Construire dans Nordla :
- Brand Core ;
- positionnement ;
- promesse ;
- vocabulaire ;
- ton ;
- interdictions ;
- couleurs ;
- typographies ;
- logos ;
- distinctive assets ;
- règles photo ;
- règles vidéo ;
- règles print ;
- règles magasin ;
- règles campagne ;
- versions ;
- provenance.

Base envisagée :
- PostgreSQL ;
- JSON Schema / pg_jsonschema ;
- pgvector ;
- design tokens.

## 2.2 Brand Guardian
### Contrôles déterministes
- format ;
- dimensions ;
- couleurs ;
- typo ;
- logo ;
- prix ;
- texte obligatoire ;
- bleed/crop ;
- résolution.

### Contrôles vision/OCR
- produit fidèle ;
- logo déformé ;
- texte erroné ;
- prix erroné ;
- artefacts ;
- cohérence visuelle.

### Contrôle qualitatif
- cohérence avec Brand Memory ;
- AI look ;
- composition ;
- ton ;
- pertinence canal.

Humain garde la validation finale pour création premium/publication.

---

# 3. Product Marketing / Poussée

## 3.1 Inputs temporaires
En V0 HABB :
- ventes Shopify ;
- stock Shopify ;
- marges si disponibles ;
- saisonnalité ;
- capacité ;
- événements ;
- produits ;
- marque.

À terme :
- données Nordla Stock ;
- Nordla Ventes ;
- Nordla Finance ;
- Nordla Analyses.

## 3.2 Diagnostic
Déterminer :
- quoi pousser ;
- pourquoi ;
- maintenant ou plus tard ;
- problème ou opportunité ;
- données manquantes.

## 3.3 Leviers possibles
Toujours inclure :
- DO_NOTHING ;
- TEST_SMALL.

Puis selon conditions :
- vitrine ;
- merchandising ;
- bundle ;
- cross-sell ;
- clients existants ;
- B2B ;
- partenariat ;
- organic ;
- paid ;
- Google/local ;
- pricing ;
- non-réassort ;
- arrêt produit.

Le Socle reste responsable de l'arbitrage final.

## 3.4 Objet visible : POUSSÉE
Une Poussée contient :
- produit / offre ;
- raison ;
- cible ;
- canal ;
- budget ;
- contrainte ;
- créations ;
- validation ;
- métriques ;
- règle d'arrêt ;
- résultats.

---

# 4. Creative Fidelity Benchmark — PREMIER CHANTIER EXPÉRIMENTAL

## 4.1 Dataset initial
Commencer par 10 vrais produits HABB difficiles.

Puis étendre à 30 produits si utile.

Catégories :
- gourde brillante ;
- coque avec photo ;
- produit transparent ;
- packaging ;
- bois/céramique ;
- produit avec logo ;
- produit avec petit texte ;
- produit sombre/tech ;
- objet avec visage personnalisé ;
- forme complexe.

## 4.2 Tâches standard image
Pour chaque produit :
1. changer uniquement le fond ;
2. créer une publicité premium ;
3. mettre le produit en situation/main ;
4. modifier un élément externe sans toucher au produit ;
5. produire 3 images cohérentes de campagne.

## 4.3 Moteurs image à benchmarker
### FREE / SELF-HOST
- HiDream-O1 ;
- Qwen-Image / Qwen-Image-Edit ;
- FLUX.2 Klein 4B ;
- SANA ;
- Z-Image-Turbo ;
- autres candidats validés par licence.

### PREMIUM REFERENCE
- GPT Image.

### NORDLA REFERENCE
- Sandwich Compositing.

## 4.4 Fidelity Gates
FAIL immédiat si :
- texte/prénom faux ;
- logo modifié ;
- visage modifié ;
- produit inventé ;
- géométrie commerciale changée ;
- nombre de pièces faux ;
- couleur identitaire franchement incorrecte.

Puis évaluer :
- forme ;
- proportions ;
- matériau ;
- couleur ;
- texture ;
- réalisme ;
- AI look ;
- qualité créative ;
- retries ;
- coût par résultat accepté.

---

# 5. Pipeline produit réel — NORDLA SANDWICH

Objectif : ne pas demander au modèle de redessiner le produit quand ce n'est pas nécessaire.

Pipeline :
1. photo réelle produit ;
2. détourage/matting ;
3. conservation des pixels produit ;
4. génération du décor ;
5. ré-éclairage/harmonisation ;
6. ombres/reflets ;
7. texte/prix/logo en code ;
8. OCR + Brand Guardian ;
9. export.

Candidats :
- BiRefNet ;
- SAM2 / Grounded-SAM-2 ;
- IC-Light ;
- OpenCV ;
- PaddleOCR ;
- moteur image gagnant du benchmark.

---

# 6. Image Studio

Après benchmark :
- choisir 1 moteur local principal ;
- choisir 1 moteur local économique/rapide ;
- garder 1 premium fallback ;
- ne pas figer un fournisseur pour toujours.

Fonctions :
- background generation ;
- inpainting ;
- multi-reference ;
- product compositing ;
- text overlay ;
- resizing ;
- export multicanal ;
- Brand Guardian.

---

# 7. Mini-Studio Smartphone — BUILD NORDLA

Pipeline local/open :
1. upload vidéo ;
2. nettoyage audio ;
3. transcription ;
4. alignement mot à mot ;
5. détection plans ;
6. suppression silences ;
7. auto-framing ;
8. sous-titres Brand Memory ;
9. correction basique ;
10. export multi-format.

Candidats :
- DeepFilterNet ;
- WhisperX ;
- PySceneDetect ;
- MediaPipe / OpenCV ;
- FFmpeg ;
- ASS subtitles.

But : couvrir la majorité du contenu social réel sans CapCut/Adobe.

---

# 8. Video Benchmark — APRÈS IMAGE

## 8.1 Produits tests
5 à 8 produits difficiles.

## 8.2 Scénarios
- rotation / mouvement caméra ;
- main qui prend le produit ;
- personne utilisant le produit ;
- mini-pub multi-plan.

## 8.3 FREE candidates
- Wan 2.2 ;
- LTX-2.5 ;
- Kandinsky 6 Lite ;
- LongCat-Video ;
- MimicMotion ;
- autres si licence validée.

## 8.4 Premium references
- Wan 3.x ;
- Kling ;
- Seedance ;
- Vidu ;
- Runway selon accès.

Comparer également :
- vidéo générative ;
- vidéo réelle assistée Nordla.

---

# 9. Store Experience — APRÈS PIPELINE CRÉATIF DE BASE

Inputs :
- photos smartphone ;
- courte vidéo ;
- dimensions ;
- plan facultatif ;
- stock ;
- ventes ;
- marge ;
- objectif de la Poussée.

Capacités :
- audit vitrine ;
- lisibilité ;
- merchandising ;
- zones visibles ;
- placement produit ;
- planogramme léger ;
- PLV ;
- simulation avant/après.

Candidats :
- Qwen-VL / Gemma multimodal ;
- GroundingDINO ;
- SAM ;
- Depth Anything ;
- moteur image gagnant pour visualisation.

Pas de caméra permanente en V0.

---

# 10. Print / PLV — BUILD

Construire :
- posters ;
- affiches vitrines ;
- flyers ;
- étiquettes ;
- chevalets ;
- PLV ;
- SVG ;
- PDF ;
- dimensions exactes ;
- bleed ;
- crop marks ;
- CMYK/ICC.

Candidats :
- Typst ;
- SVG ;
- LittleCMS ;
- PDFKit si besoin ;
- validation PDF/X à confirmer/tester.

Routine print = pas d'API payante.

---

# 11. Publication / Marketing Ops

Après création :
- préparation posts ;
- adaptation par canal ;
- publication/planification ;
- suivi.

Candidats FREE à comparer :
- Postiz ;
- Mixpost Lite ;
- intégration directe APIs sociales.

Analytics :
- Umami ;
- GrowthBook pour expérimentation lorsque le volume le permet.

Attention licences AGPL avant intégration.

---

# 12. Serving / Routing technique

Pas de grand agent routeur.

## Local serving
Benchmark :
- SGLang ;
- vLLM ;
- moteur léger selon modèle.

## External gateway
LiteLLM seulement si cela simplifie réellement les APIs/fallbacks.

Le routage multi-modèles de production reste différé jusqu'à preuve.

---

# 13. Storage

## V0
Cloud européen peu cher.

## Sauvegarde
Copie chiffrée hors site chez un second fournisseur.

## Plus tard
Benchmark stockage Nordla :
- SeaweedFS ;
- Garage ;
- autre candidat permissif.

Ne pas utiliser une solution comme sauvegarde immuable tant que Object Lock/WORM n'est pas réellement vérifié.

---

# 14. Ce qui reste PAYANT par design

Seulement si le benchmark montre une valeur supérieure :
- hero image difficile ;
- édition premium exceptionnelle ;
- vidéo cinématique premium ;
- SVG/vectoriel très complexe ;
- autre workload externe irremplaçable.

Pay-as-you-go.
Jamais abonnement SaaS par client par défaut.

---

# 15. Ordre de construction immédiat

## NOW — Phase A
1. Model & Capability Registry
2. Provenance / audit / coût
3. Dataset HABB 10 produits
4. Fidelity Benchmark harness
5. BiRefNet / product matte
6. Sandwich Compositing V0
7. Brancher 2 premiers moteurs FREE
8. Brancher GPT Image comme référence
9. Exécuter benchmark image
10. Choisir les finalistes

## NEXT — Phase B
11. Brand Memory
12. Brand Guardian
13. Image Studio
14. Print/PLV
15. Mini-Studio Smartphone
16. Product Marketing / Poussée branché au Socle

## AFTER — Phase C
17. Video Benchmark
18. Store Experience
19. Publication/Analytics
20. Routing optimisé / self-host scaling

---

# 16. Règles anti-dérive

- Ne pas figer un moteur avant benchmark.
- Ne pas choisir "le plus récent" par défaut.
- Ne pas croire un badge de licence sans lire le fichier LICENSE exact.
- Ne pas générer le produit si on peut préserver ses pixels.
- Ne pas appeler une API premium pour une tâche déterministe.
- Ne pas acheter de GPU avant mesure d'utilisation.
- Ne pas self-host uniquement pour économiser quelques euros.
- Ne pas présenter un score créatif opaque comme une vérité.
- Ne pas activer Creative Intelligence en production avant validation Constitution/benchmark.
- Toute nouvelle technologie doit battre la stack actuelle sur qualité, coût, liberté ou simplicité.

