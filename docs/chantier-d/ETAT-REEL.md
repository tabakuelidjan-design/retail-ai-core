# Chantier D — Branding / Marketing / Creative : état réel (2026-10-16)

Branche `feature/chantier-d-branding-creative-pole` (worktree `retail-ai-core-chantier-d-wt`), partie de `integration/nordla-pre-china` @ `f7197d5` (qui contient déjà Branding `e0b86c9`, Marketing M1-M4 `ceec15c`, Creative closure `7c76edb`, Activation, provider-connections). Rien n'est fusionné, rien n'est publié, aucune dépense, aucun secret touché.

## 1. État réel (sans optimisme)

| Pôle | Réel | Simulé / bloqué |
|---|---|---|
| **Branding** | Module complet en code (Gardien de marque, mémoire, contrats) ; paquet HABB de référence `benchmarks/creative-intelligence/habb-brand-canonical-v1.json` (couleurs, polices Playfair Display + Montserrat décidées par le propriétaire, règles interdites) | Aucune charte n'est approuvée au-delà du paquet « benchmark 001 » ; aucune affirmation produit approuvée |
| **Marketing M1→M4** | Propositions, signaux, décision humaine journalisée | Pas de calendrier éditorial alimenté, pas de données réelles HABB lues |
| **Creative** | Chaîne de bout en bout câblée (`runCreativeEndToEnd`, `runCreativeCampaign`) : segmentation → plan → production par calques → refine → portes finales, produit conservé au pixel près, ledger, budget, reprise | **Aucun fournisseur IA branché** : Cerveau, directeur d'assets et générateur de calques sont des doublures scriptées ; pas de critique visuelle ; fonds et accessoires = placeholders dessinés localement |
| **Assets** | Rien n'existait : aucun index, aucune métadonnée de droits | Créé ici (§3) |

## 2. Démonstration de la chaîne (sans fournisseur, 0 €)

`scripts/creative-e2e-real-assets.mjs` sur trois visuels de coques HABB à fond blanc :

| Visuel | Résultat | Lecture |
|---|---|---|
| coque « MILA » | `NEEDS_OWNER_REVIEW`, 10 appels (tous sur doublures), 0,343 € simulé, produit conservé | **La mécanique fonctionne. Le résultat n'est pas publiable** : fond dégradé générique, un ovale brun placeholder, titre de test en police par défaut, textes de test |
| coque « chien » | `BLOCKED SEGMENTATION/MATTE_INVALID (FRINGE_RUN)`, 0 appel | arrêt fermé correct avant toute dépense |
| coque « voyage » | `BLOCKED SEGMENTATION/MATTE_INVALID (STRAY_ALPHA)`, 0 appel | idem |

Conclusion : la chaîne protège le produit et refuse proprement ; **elle ne produit pas encore de création premium** sans fournisseur (décision et budget du propriétaire). Aucune création du lot ci-dessous n'est une sortie du moteur : voir §5.

## 3. Bibliothèque d'assets (`src/asset-library/`, 9 tests verts)

Entrées fermées : identité par hash, référence opaque `private-asset://…` (jamais un chemin), type/taille/alpha lus dans l'en-tête du fichier, origine, droits, approbation, produits, version, filiation. `indexFolder` ne fait qu'observer et proposer une origine d'après le nom/dossier ; **droits = `UNVERIFIED`, approbation = `NOT_REVIEWED` par défaut, aucun script ne peut les changer** (seule une référence `evidence://`/`approval://` humaine). Publiable = origine réelle HABB **et** droits confirmés **et** approbation.

Inventaire local (index `data/private/habb-assets/`, ignoré par git car le dépôt est public) — 395 entrées :

| Origine proposée | Nombre | Publiable |
|---|---|---|
| Images fournisseurs (Alibaba, Shopee, Amazon, marques Tyeso/Remax…, planches de catalogue) | 221 | non (droits non établis) |
| Créations HABB (mockups, vignettes, catalogue des écritures, cartes) | 68 | oui **après** confirmation des droits + approbation |
| Éléments de marque (logo, icônes, favicons) | 10 | idem |
| Captures réseaux sociaux / TikTok | 18 | non |
| Images générées par IA (nanobanana, ChatGPT) | 7 | non |
| Non classées (à voir par une personne) | 71 | non |

**Constat central : aucune photo prise par HABB (boutique, objets personnalisés finis) n'existe sur disque.** Toutes les images produits du catalogue sont des visuels fournisseurs ou générés. Le propriétaire doit dire, par famille, ce qu'il a le droit de republier.

## 4. Propositions éditoriales préparées (14 jours, 2026-10-19 → 2026-11-01)

`data/private/habb-content/editorial-14j.json` + feuille de relecture `PLAN-EDITORIAL-14J.md` : **8 publications, 14 stories, 3 reels**, chacun avec produit réel (clé catalogue Shopify), objectif, concept visuel, accroche, légende, format/canal, assets, statut (tous `PROPOSED`) et liste claire de ce qui manque. Contrôle automatique : prix = prix Shopify lus le 2026-10-16, aucun motif décoratif interdit, aucune affirmation commerciale non vérifiée, comptes 8/14/3.

**Assets prêts : 0 sur 25.** 4 brouillons (cartes typographiques stories 1, 6, 11 ×3, 14), 21 manquants : photos de la boutique et des objets, 3 vidéos tournées par HABB. Les concepts photo/vidéo sont des consignes de prise de vue, pas des visuels.

Revue QA indépendante (agent `habb-qa-guardian`, lecture seule) : **PASS WITH WARNINGS** ; corrections appliquées : délai « 5 minutes » toujours accompagné de « selon le modèle », « chaque fichier » adouci, stories trop « catalogue » réécrites, marges de sécurité et chiffres des cartes, apostrophes et espaces insécables, compte prêts/manquants dans l'en-tête. Restent **à décider par le propriétaire** : (a) « On rouvre la porte » est-il vrai (la boutique a-t-elle fermé ?), (b) approuver ou refuser les affirmations « contrôle du fichier avant impression » et « personnalisation des gourdes », (c) le logotype texte « HABB » du fichier `habb-wordmark-A-navy` est-il acceptable sur les cartes (la marque décrite ailleurs est un H serif avec repères).

## 5. Limite de capacité (dite d'avance)

Les six cartes typographiques sont des **propositions rédigées et mises en page par une session d'assistant** (Playfair Display + Montserrat, crème, marine, une seule règle terracotta, sans photo ni décor). Elles respectent les règles de marque mais je ne peux pas certifier qu'elles sont « premium » : le polish photographique et graphique supérieur n'est pas dans ce que je peux produire de façon fiable. Elles sont marquées `produced_by: ASSISTANT_PROPOSAL` et ne prouvent rien sur Nordla. Pour des visuels photo premium : photos réelles à prendre (consignes dans le plan) puis soit la chaîne Creative avec un fournisseur approuvé, soit un outil de design humain (Canva).

## 6. Blocages nécessitant le propriétaire

1. Droits de republication des visuels fournisseurs (221) : par famille.
2. Photos et vidéos HABB à tourner (liste dans le plan) — c'est le goulot de tout le lot.
3. Fournisseur IA et budget : non choisis (rien n'a été appelé). La documentation de branche mentionne Qwen Image 3.0 Pro comme défaut d'une autre ligne : **non appliqué ici**.
4. Approbation de la marque et des affirmations (délai 5 min, contrôle fichier, gourdes personnalisables, « boutique rouverte »).
5. Définition du chantier E et format attendu (voir `CONTRAT-CHANTIER-E.md`).
6. Fusion : `integration/nordla-pre-china` n'est pas fusionnée ; cette branche est basée dessus.

## 7. Recommandations découvertes pendant le travail

- **REQUIS pour publier** : un jour de prise de vue (boutique, machine, 6 objets finis) ; sans cela le plan reste sur le papier.
- **RECOMMANDÉ** : brancher `src/asset-library` comme adaptateur propriétaire du Socle Resource Resolver (nature ASSET) pour que Creative ne lise que des assets publiables ; persister l'index (table) après approbation d'une tâche dédiée.
- **RECOMMANDÉ** : classer les 71 images « non classées » avec le propriétaire (10 minutes).
- **PLUS TARD** : critique visuelle branchée, fournisseur de segmentation, polices pour variantes.
- Dette signalée, non corrigée : Windows `C:\C:\` dans 7 tests sourcing ; flake PM-6 / RF-2 connu.
