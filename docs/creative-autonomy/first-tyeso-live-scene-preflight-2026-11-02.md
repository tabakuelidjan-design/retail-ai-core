# Nordla Creative Production V1 — premier essai TYESO : préparation vérifiée
Mis à jour : 2026-11-02. Périmètre : PR #36 et correctifs en brouillon PR #37. **Pas de test réel autorisé par ce document.**

## Produit confirmé (Shopify, lecture seule du 2 novembre 2026)
- Product ID : `gid://shopify/Product/15514012254556`
- Titre : **Gourde Tyeso TS-8771C à paille – 750 ml**
- Variante **Noir** : `gid://shopify/ProductVariant/57246326784348`
- Prix : **29,90 EUR** ; stock au contrôle : **7** ; statut produit : ACTIVE.
- Les données texte/prix/variantes dans `test/fixtures/creative-autonomy/shopify-gourde-tyeso.json` concordent avec la lecture Shopify du 2 novembre (titre, description, type, tags, variantes, prix, stock).
- Objectif déjà prévu dans `scripts/creative-autonomy-trial.mjs` : « Donner envie aux habitants de Namur de découvrir la gourde TYESO noire chez HABB ». Ne pas inventer d'autre prix ni caractéristique.

## Photo officielle TYESO candidate — validation technique interne
Le média noir trouvé dans Shopify est une image WEBP de **2000 × 2000 px**, dont le nom de fichier finit par `Black_20oz.webp`. La référence produit TS-8771C est **750 ml / environ 25 oz**. Le nom du fichier ne prouve pas que l'image présente la mauvaise taille ; sa correspondance visuelle avec la variante HABB est **NON VÉRIFIÉE**.
- **Photo candidate identifiée le 2 novembre 2026** : vue entière du flacon noir sur le site officiel TYESO, alt **« WANDER Lockable Straw Bottle in Black, 25 oz – straw detail »**, sur la fiche produit qui confirme « 25 oz / 750 mL ».
- Photo exacte (URL externe, **ne pas commiter le binaire**) : https://tyeso.com/cdn/shop/files/tyeso-wander-lockseal-stainless-steel-sports-bottle-with-straw-black-25-oz-straw-detail-30.jpg?v=1784195930&width=2000
- Fiche officielle : https://tyeso.com/products/wander-lockseal-stainless-steel-sports-bottle-with-straw
- La photo est **visuellement identifiée**, mais son fichier original n'a **pas encore été récupéré localement** ; dimension binaire, empreinte SHA-256 et essai `--plan` sur cette photo **NON EFFECTUÉS**. Le téléchargement direct depuis l'environnement de travail a échoué (connexion réseau), ne pas inventer de hash.
- **Relation fournisseur confirmée par le propriétaire HABB** : HABB est en contact commercial direct avec TYESO et ne demande PAS de nouvelle permission fournisseur pour cet essai. Supprimer la demande WeChat ; ne pas la transformer en obligation. Le contrôle interne de transmission à un fournisseur d'IA demeure distinct et non visible par le client. Le périmètre contractuel précis n'a pas été examiné ici.
- Si la photo choisie est inutilisable ou ne correspond pas au vrai produit noir 750 ml, rechercher une autre photo vérifiée du même modèle et de la même variante, sans demander au client de confirmer l'image. Contrôler l'absence de visage et de données personnelles.
- Une fois la source choisie et son usage déclaré par l'opérateur HABB, figer ses octets, calculer SHA-256 et utiliser exactement ce fichier pour `--plan` puis, si autorisé, `--execute`. Aucune étape de confirmation de la photo par le client.
- **NO-GO technique** pour l'appel payant tant que le fichier local, l'espace image Global et les contrôles de budget et de transmission externes ne sont pas prêts. Pas de confirmation préalable du média par le client.

## Exécution prévue — PAS ENCORE LANCÉE
1. Le système choisit et vérifie la photo du produit noir 750 ml. L'opérateur prépare les droits/paramètres internes pour l'envoi d'une **plaque dérivée** à Alibaba en périmètre **GLOBAL** (traitement potentiellement hors UE). **Aucune validation du média source demandée au client avant génération.**
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
- **NON VÉRIFIÉ** : périmètre juridique exact de l'usage des médias TYESO ; fichier local, empreinte et plan ; concordance du média Shopify « 20oz » avec le produit 750 ml ; clé/espace de travail image GLOBAL ; qualité et coût effectifs d'une image réellement générée. La connexion directe HABB–TYESO est confirmée par le propriétaire ; ne pas redemander d'autorisation fournisseur comme étape automatique.
- **NO-GO** pour `--execute` à ce stade. Aucune modification Shopify, aucun appel fournisseur ni facturation.

## Règle client — décision explicite du propriétaire, 2026-11-02

**Nordla ne demande jamais au client de confirmer ou valider la photo du produit avant de commencer la création.** L'image est sélectionnée et validée en interne. Si elle est inutilisable, le système tente une autre image de la même variante ou signale un problème de source média aux opérateurs. Le client valide seulement le résultat créé (si le parcours prévoit une validation), et non les sources en amont. Les contrôles internes d'usage d'API, de confidentialité et de dépense ne doivent pas devenir une demande de confirmation de photo au client. L'automatisation complète de la sélection d'image Shopify reste à implémenter dans l'intégration média ; l'actuel essai CLI attend toujours un `--photo` interne.
