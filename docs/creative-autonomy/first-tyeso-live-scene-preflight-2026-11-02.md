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
- **Décision recommandée** : choisir une photo originale prise par HABB de la gourde noire **750 ml**, physiquement vérifiée, sans visage ni données personnelles, montrant le produit entier, sans obstruction.
- Ne pas envoyer automatiquement la photo fournisseur / Shopify à Alibaba. La présence sur Shopify ne prouve pas le droit d'utilisation par un modèle externe.
- Après sélection de la véritable photo et vérification des droits, figer ses octets et son SHA-256. Ne pas modifier la photo entre le plan et l'essai.
- Source de comparaison produit : https://sg.theplanettraveller.com/products/tyeso-wander-lockable-one-press-straw-flip-lid-s-s-vacuum-insulated-bottle-with-handle-750ml-white (750 ml / 25 oz).

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
- **NON VÉRIFIÉ** : droits exacts de la photo du test, concordance du média Shopify « 20oz » avec le produit 750 ml, clé/espace de travail image GLOBAL, qualité et coût effectifs d'une image réellement générée.
- **NO-GO** pour `--execute` à ce stade. Aucune modification Shopify, aucun appel fournisseur ni facturation.
