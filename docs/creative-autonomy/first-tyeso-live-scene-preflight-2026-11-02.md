# Nordla Creative Production V1 — premier essai TYESO : préparation vérifiée
Mis à jour : 2026-11-02. Périmètre : PR #36 et correctifs en brouillon PR #37. **Pas de test réel autorisé par ce document.**

## Produit confirmé (Shopify, lecture seule du 2 novembre 2026)
- Product ID : `gid://shopify/Product/15514012254556`
- Titre : **Gourde Tyeso TS-8771C à paille – 750 ml**
- Variante **Noir** : `gid://shopify/ProductVariant/57246326784348`
- Prix : **29,90 EUR** ; stock au contrôle : **7** ; statut produit : ACTIVE.
- Les données texte/prix/variantes dans `test/fixtures/creative-autonomy/shopify-gourde-tyeso.json` concordent avec la lecture Shopify du 2 novembre (titre, description, type, tags, variantes, prix, stock).
- Objectif déjà prévu dans `scripts/creative-autonomy-trial.mjs` : « Donner envie aux habitants de Namur de découvrir la gourde TYESO noire chez HABB ». Ne pas inventer d'autre prix ni caractéristique.

## Point de vigilance sur la photo — BLOQUANT pour autorisation
Le média noir trouvé dans Shopify est une image WEBP de **2000 × 2000 px**, dont le nom de fichier finit par `Black_20oz.webp`. La référence produit TS-8771C est **750 ml / environ 25 oz**. Le nom du fichier ne prouve pas que l'image présente la mauvaise taille ; sa correspondance visuelle avec la variante HABB est **NON VÉRIFIÉE**.
- **Photo candidate identifiée le 2 novembre 2026** : vue entière du flacon noir sur le site officiel TYESO, alt **« WANDER Lockable Straw Bottle in Black, 25 oz – straw detail »**, sur la fiche produit qui confirme « 25 oz / 750 mL ».
- Photo exacte (URL externe, **ne pas commiter le binaire**) : https://tyeso.com/cdn/shop/files/tyeso-wander-lockseal-stainless-steel-sports-bottle-with-straw-black-25-oz-straw-detail-30.jpg?v=1784195930&width=2000
- Fiche officielle : https://tyeso.com/products/wander-lockseal-stainless-steel-sports-bottle-with-straw
- La photo est **visuellement identifiée**, mais son fichier original n'a **pas encore été récupéré localement** ; dimension binaire, empreinte SHA-256 et essai `--plan` sur cette photo **NON EFFECTUÉS**. Le téléchargement direct depuis l'environnement de travail a échoué (connexion réseau), ne pas inventer de hash.
- **Droits encore NON CONFIRMÉS** : demander au contact TYESO une permission écrite d'utiliser cette photo précise pour des créations marketing HABB réalisées au moyen d'outils d'IA externes, comprenant envoi de la photo/plaque dérivée à Alibaba Cloud (périmètre Global, traitement potentiellement hors de l'UE) et analyse du rendu par le modèle EU. La présence sur un site public n'est pas une licence pour cet usage.
- Si TYESO n'accorde pas cette permission, utiliser une photo originale prise par HABB du produit noir 750 ml, ou une photo dont les droits pour cet usage sont établis. Contrôler l'absence de visage et de données personnelles.
- Après sélection du fichier et preuve des droits, figer ses octets, calculer SHA-256 et utiliser exactement ce fichier pour `--plan` puis, si autorisé, `--execute`. Ne pas changer les pixels entre plan et essai.
- **NO-GO** pour l'appel image en attendant la photo locale et l'autorisation.

## Exécution prévue — PAS ENCORE LANCÉE
1. Fournir la photo correcte et son autorisation explicite pour l'édition externe d'une **plaque dérivée** par Alibaba en périmètre **GLOBAL** (traitement potentiellement hors UE).
2. Vérifier localement Node, Python (Pillow/numpy/scipy), le dépôt et le commit exact. Conserver les identifiants hors Git.
3. Préparer un espace de travail texte `EU` servant `qwen3-vl-plus` et un espace image `GLOBAL` servant `qwen-image-3.0-pro` à Francfort. Le script doit vérifier gratuitement la liste des modèles avant le verrou de tentative.
4. Lancer **uniquement** le plan local sans réseau / sans coût :
   ```powershell
   node scripts/creative-autonomy-trial.mjs --plan --scene --out "$env:USERPROFILE\nordla-trials\tyeso-first-plan" --product gourde-noire --photo "C:\CHEMIN\photo-habb-tyeso-noir-750ml.png"
   ```
   Adapter le chemin de la photo avant exécution. `--plan` ne donne pas d'autorisation ; il crée les modèles de consentement **révoqués par défaut**.
5. Lire la sortie du plan : `plan_id`, `code_sha256`, SHA-256 de la photo, périmètres, limites, coût attendu et maximum. Si des checks ne passent pas, **STOP**.
6. Deux consentements séparés sont requis avant tout `--execute` :
   - `NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE` : **IMAGE_EDIT** (image/plaque dérivée, traitement `GLOBAL`, rétention reconnue).
   - `NORDLA_MEDIA_AUTHORIZATION_FILE` : **VISION_CRITIQUE** (rendu dérivé, modèle `EU`).
   Les deux fichiers modèles ont `authorization.revoked: true`. Seul le propriétaire peut accepter leur utilisation. Les deux autorisations doivent couvrir le SHA de la même photo et le bon usage.
7. Exiger le `GO` explicite du propriétaire **pour ce plan précis et son plafond** avant de configurer `NORDLA_TRIAL_AUTHORIZATION` et d'exécuter le test payant. Jamais d'essai réel automatique.
8. Une seule édition avec **3 variantes** pour le concept choisi, format **1080 × 1350**, restauration RGB du produit, contrôles techniques, **une critique visuelle EU**, puis validation humaine. Plafond applicatif prévu : **0,50 EUR**, montant de facture réel à vérifier sur Alibaba.

## Ce qui est vérifié / ne l'est pas
- PR #37, à la date de rédaction : le workflow spécifique « Nordla creative production — offline verification » a réussi au commit `774e7dcb4086d1364e8dd1205ebae46de23649f5`. PR #36 reste inchangée, les deux PR restent en brouillon.
- L'API Qwen Image 3.0 Pro prend en charge `n=3`, `negative_prompt`, `prompt_extend: false` et le format 1080 × 1350 ; voir https://www.alibabacloud.com/help/en/model-studio/qwen-image-edit-guide
- **NON VÉRIFIÉ** : autorisation commerciale/IA pour l'image TYESO officielle ; fichier local, empreinte et plan ; concordance du média Shopify « 20oz » avec le produit 750 ml ; clé/espace de travail image GLOBAL ; qualité et coût effectifs d'une image réellement générée.
- **NO-GO** pour `--execute` à ce stade. Aucune modification Shopify, aucun appel fournisseur ni facturation.
