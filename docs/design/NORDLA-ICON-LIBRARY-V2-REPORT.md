# Nordla — bibliothèque d’icônes V2 : fusion, contrôle technique et centralisation

Date : 2026-10-17 · branche `claude/nordla-icon-library-v2` (issue de `0b32cde`, tête de la PR #22, CI vérifiée) · **rien n’est poussé**.
Aucune icône n’a été dessinée, retouchée, recolorée, recadrée ni convertie : les fichiers retenus sont des **copies octet pour octet** (empreintes vérifiées par test).

## Réponses directes

| # | Question | Réponse |
|---|---|---|
| 1 | Fichiers reçus, lot 1 | **162** = 76 icônes × 2 tailles (256 et 64 px) + 9 planches d’aperçu + 1 README |
| 2 | Fichiers reçus, lot 2 | **142** = 130 icônes (32 « D à G » + 98 « séries 2 à 9 ») + 12 planches d’aperçu |
| 3 | Icônes uniques après dédoublonnage | **206 pictogrammes reçus** (les 76 PNG 64 px du lot 1 sont des réductions exactes des 256 px : écart mesuré 0) ; **0 doublon strict** ; **4 quasi-doublons** (même dessin, autre nom) ; **151 fonctions canoniques** ; **52 fonctions reçues en plusieurs variantes** |
| 4 | Icônes réutilisées de l’ancienne bibliothèque | **46 / 46** icônes officielles V1 conservées, inchangées, toujours seules en production ; 29 fonctions V2 ont déjà une V1 |
| 5 | Icônes graphiquement conformes (contrôle technique) | **38** fichiers, tous du lot 1 → **34 fichiers retenus** (4 quasi-doublons écartés) couvrant **36 fonctions**. Validation graphique : **en attente** |
| 6 | Icônes à corriger | **168** (38 du lot 1, 130 du lot 2 = la totalité du lot 2) |
| 7 | Icônes encore manquantes | **101 fonctions** sans aucune icône utilisable (ni V2 conforme ni V1) ; sur les 44 icônes manquantes recensées le 2026-10-17, **13 sont couvertes** par une V2 conforme, **31 n’existent qu’en version à corriger** |
| 8 | Fichiers ajoutés / modifiés | voir § 8 |
| 9 | Tests | voir § 9 |

## 1. Contrôle technique (inspection individuelle des 206 pictogrammes)

Méthode : mesures automatiques (transparence, coins, pixels blancs opaques, résidus pâles de carte, pixels au bord, marges, centrage, couleurs, empreintes) **puis inspection visuelle de chaque icône** dans Chromium : sur damier (transparence), cadre du fichier visible, rendu 64 / 48 / 32 / 24 / 16 px et sur bleu nuit. Les drapeaux automatiques ne suffisent jamais à déclarer une icône conforme.

| Livraison | Fichiers | Conformes | À corriger | Défauts constatés |
|---|---|---|---|---|
| Lot 1 · dossiers 01–06 | 48 | **38** | 10 | traits coupés : finance, assistants, centre des connexions, Parle Pro, validation, photo, achat, livraison ; fragments de légende : approbation, dossier fournisseur |
| Lot 1 · « manquantes » A, B, C | 28 | 0 | 28 | **légende intégrée** au pictogramme (souvent tronquée) ; **accent brun** différent du cuivre des dossiers 01–06 ; 6 traits coupés |
| Lot 2 · D à G | 32 | 0 | 32 | recadrés **au ras** (marge nulle) ; 25 traits coupés (souvent en bas) ; traits plus épais, cuivre granuleux |
| Lot 2 · séries 2 à 8 | 86 | 0 | 86 | **basse résolution** (50–112 px, flou à 48–64 px) ; **résidus de carte et fond blanc opaque** ; 14 traits coupés ; légendes dans 3 fichiers |
| Lot 2 · série 9 | 12 | 0 | 12 | **texte seul** (« Email », « SAV », « Aide »…) : aucun pictogramme |

Couleurs mesurées : bleu nuit conforme ; accent médian ≈ `#C45828` (cuivre / terracotta, comme le pack V1), **pas le bronze `#95652F` de la palette V1** ; les « manquantes » du lot 1 ont un accent brun distinct. Aucun changement de couleur n’a été fait.

## 2. Doublons, variantes et noms

- **Doublons stricts** : aucun (empreintes octets et pixels). Les 76 PNG 64 px du lot 1 sont des copies réduites des 256 px : **non conservées** (une seule taille source).
- **Quasi-doublons** (mesurés, distance de hachage ≤ 12/256) : `01_tableau_de_bord` = `01_ventes_et_crm` = `07_developpement_des_ventes` ; `03_china_sourcing` = `02_produits` ; `06_analyses` = `06_rapport` ; `08_validations` ≈ `04_validation`.
- **Variantes d’une même fonction** : 52 fonctions reçues en 2 ou 3 dessins (lot 1, lot 1 « manquantes », lot 2). Règle appliquée : variante conforme au style Finance du lot 1 retenue ; aucune V1 remplacée.
- **Nom ≠ symbole** :
  - `01_tableau_de_bord.png` (lot1) : NOM ≠ SYMBOLE : courbe de croissance identique à 01_ventes_et_crm (doublon)
  - `03_china_sourcing.png` (lot1) : NOM ≠ SYMBOLE : cube identique à 02_produits (doublon)
  - `10_import.png` (lot2) : NOM ≠ SYMBOLE : flèche montante (sens « exporter / envoyer »), opposé à 01_import du lot 1
  - `12_recu.png` (lot2) : NOM ≠ SYMBOLE : document + flèche montante (identique à 13_reception), pas un reçu
  - les 12 fichiers de la série 9 : le fichier ne contient que le mot.

## 3. Bibliothèque unique (architecture existante réutilisée)

- Registre de production inchangé : `src/shared/nordla-icon.js` (46 icônes V1 + `DEFECTIVE`). **Aucun écran n’utilise une icône V2** avant validation (test).
- **Catalogue unique** : `src/shared/assets/nordla/library/catalog.json` — pour chaque fonction : identifiant canonique, nom français, catégorie (1–11), fichier, lot d’origine, statut technique, statut de validation graphique, modules, icône V1 existante, et chaque fichier reçu avec son verdict, ses défauts et sa note.
- **Fichiers V2 conformes** (34) : `src/shared/assets/nordla/library/<catégorie>/<identifiant>.png` (servis comme les autres assets Nordla, mais référencés nulle part).
- **Fichiers à corriger** (168) : conservés comme référence dans `docs/design/nordla-icon-library-v2/reference/` (hors des assets servis), avec leur nom d’origine.
- **Galerie locale** : `docs/design/nordla-icon-library-v2/galerie.html` (générée par `build-gallery.mjs`, sans réseau) — par catégorie, avec V2 retenue, V1 en production, variantes reçues, verdicts et filtres.

### Répartition par catégorie

| Catégorie | Fonctions | V2 conforme | V1 existante | Sans icône utilisable |
|---|---|---|---|---|
| 1. Modules principaux | 21 | 16 | 12 | 2 |
| 2. Finance et documents | 22 | 5 | 1 | 16 |
| 3. Navigation et actions | 14 | 2 | 1 | 12 |
| 4. Utilisateurs et sécurité | 12 | 1 | 1 | 11 |
| 5. Ventes et clients | 14 | 0 | 5 | 9 |
| 6. Fournisseurs et achats | 13 | 0 | 3 | 10 |
| 7. Stock et produits | 12 | 1 | 1 | 11 |
| 8. Intelligence et décisions | 13 | 4 | 1 | 9 |
| 9. Communication et support | 14 | 1 | 0 | 13 |
| 10. Données et système | 8 | 4 | 2 | 3 |
| 11. Organisation et automatisations | 8 | 2 | 2 | 5 |
| **Total** | **151** | **36** | **29** | **101** |

+ 17 icônes V1 sans équivalent V2 (indicateurs, clients, produits : `chiffreAffaires`, `cohorte`, `meilleurProduit`…), conservées telles quelles.

## 4. V2 conformes retenues

| Identifiant | Nom | Catégorie | Source | V1 déjà en production |
|---|---|---|---|---|
| `module-parle-a-nordla` | Parle à Nordla | Modules principaux | lot1 · 01_icones_officielles/png_256/02_parle_a_nordla.png | parleANordla |
| `module-stock-achats` | Stock et achats | Modules principaux | lot1 · 01_icones_officielles/png_256/05_stock_et_achats.png | — |
| `module-analyses` | Analyses | Modules principaux | lot1 · 05_donnees_et_systeme/png_256/06_rapport.png (réutilisée) | explorer |
| `module-fournisseurs` | Fournisseurs | Modules principaux | lot1 · 01_icones_officielles/png_256/07_fournisseurs.png | — |
| `parametres` | Paramètres | Modules principaux | lot1 · 01_icones_officielles/png_256/08_parametres.png | parametres |
| `module-ventes-crm` | Ventes et CRM | Modules principaux | lot1 · 02_modules_commerciaux/png_256/01_ventes_et_crm.png | — |
| `module-produits` | Produits | Modules principaux | lot1 · 02_modules_commerciaux/png_256/02_produits.png | produits |
| `module-conformite` | Conformité | Modules principaux | lot1 · 02_modules_commerciaux/png_256/03_conformite.png | compliance |
| `tous-les-modules` | Tous les modules | Modules principaux | lot1 · 02_modules_commerciaux/png_256/04_tous_les_modules.png | — |
| `module-branding` | Branding | Modules principaux | lot1 · 02_modules_commerciaux/png_256/05_branding.png | — |
| `module-marketing` | Marketing | Modules principaux | lot1 · 02_modules_commerciaux/png_256/06_marketing.png | growth |
| `module-creation` | Création | Modules principaux | lot1 · 02_modules_commerciaux/png_256/07_creation.png | — |
| `module-service-apres-vente` | Service après-vente | Modules principaux | lot1 · 03_modules_avances/png_256/01_service_apres_vente.png | afterSales |
| `module-journal-des-decisions` | Journal des décisions | Modules principaux | lot1 · 03_modules_avances/png_256/02_journal_des_decisions.png | decisionLedger |
| `module-centre-de-pilotage` | Centre de pilotage | Modules principaux | lot1 · 03_modules_avances/png_256/05_centre_de_pilotage.png | commandCenter |
| `module-developpement-des-ventes` | Développement des ventes | Modules principaux | lot1 · 02_modules_commerciaux/png_256/01_ventes_et_crm.png (réutilisée) | — |
| `facture` | Facture | Finance et documents | lot1 · 04_actions_et_statuts/png_256/01_facture.png | — |
| `paiement` | Paiement | Finance et documents | lot1 · 04_actions_et_statuts/png_256/02_paiement.png | — |
| `retard` | Retard | Finance et documents | lot1 · 04_actions_et_statuts/png_256/03_retard.png | — |
| `import` | Importer | Finance et documents | lot1 · 06_operations_et_support/png_256/01_import.png | — |
| `export` | Exporter | Finance et documents | lot1 · 06_operations_et_support/png_256/02_export.png | — |
| `ajouter` | Ajouter | Navigation et actions | lot1 · 04_actions_et_statuts/png_256/07_ajouter.png | — |
| `recherche` | Rechercher | Navigation et actions | lot1 · 05_donnees_et_systeme/png_256/01_recherche.png | recherche |
| `securite` | Sécurité | Utilisateurs et sécurité | lot1 · 05_donnees_et_systeme/png_256/04_securite.png | security |
| `stock` | Stock | Stock et produits | lot1 · 06_operations_et_support/png_256/03_stock.png | stock |
| `validation` | Validation | Intelligence et décisions | lot1 · 02_modules_commerciaux/png_256/08_validations.png | approval |
| `detection-opportunites` | Détection des opportunités | Intelligence et décisions | lot1 · 03_modules_avances/png_256/06_detection_des_opportunites.png | — |
| `risque-alerte` | Risque / alerte | Intelligence et décisions | lot1 · 04_actions_et_statuts/png_256/05_risque_alerte.png | — |
| `information` | Information | Intelligence et décisions | lot1 · 04_actions_et_statuts/png_256/06_information.png | — |
| `notifications` | Notifications | Communication et support | lot1 · 05_donnees_et_systeme/png_256/07_notifications.png | — |
| `synchronisation` | Synchronisation | Données et système | lot1 · 05_donnees_et_systeme/png_256/02_synchronisation.png | synchronisation |
| `sauvegarde` | Sauvegarde | Données et système | lot1 · 05_donnees_et_systeme/png_256/03_sauvegarde.png | — |
| `donnees` | Données | Données et système | lot1 · 05_donnees_et_systeme/png_256/05_donnees.png | — |
| `rapport` | Rapport | Données et système | lot1 · 05_donnees_et_systeme/png_256/06_rapport.png | — |
| `planning` | Planning | Organisation et automatisations | lot1 · 05_donnees_et_systeme/png_256/08_planning.png | calendrier |
| `automatisation` | Automatisation | Organisation et automatisations | lot1 · 06_operations_et_support/png_256/07_automatisation.png | — |

**15 fonctions ont déjà une V1 en production** : la V2 ne la remplace pas. Arbitrage à faire sur la galerie (V1 et V2 côte à côte).
**21 fonctions** sont couvertes pour la première fois par une V2 conforme (après validation graphique).

## 5. Correspondances prêtes pour les modules (non appliquées)

| Module | V2 conformes utilisables après validation |
|---|---|
| Nordla Core | 29 : `module-parle-a-nordla`, `module-stock-achats`, `module-analyses`, `module-fournisseurs`, `parametres`, `module-ventes-crm`, `module-produits`, `module-conformite`, `tous-les-modules`, `module-branding`, `module-marketing`, `module-creation`, `module-service-apres-vente`, `module-journal-des-decisions`, `module-centre-de-pilotage`, `module-developpement-des-ventes`, `ajouter`, `recherche`, `securite`, `validation`, `risque-alerte`, `information`, `notifications`, `synchronisation`, `sauvegarde`, `donnees`, `rapport`, `planning`, `automatisation` |
| Finance | 13 : `module-parle-a-nordla`, `parametres`, `facture`, `paiement`, `retard`, `import`, `export`, `ajouter`, `recherche`, `validation`, `risque-alerte`, `information`, `rapport` |
| Analyses | 14 : `module-parle-a-nordla`, `module-analyses`, `parametres`, `module-produits`, `import`, `export`, `ajouter`, `recherche`, `stock`, `detection-opportunites`, `risque-alerte`, `information`, `donnees`, `rapport` |
| Développement des ventes | 10 : `module-parle-a-nordla`, `parametres`, `module-ventes-crm`, `module-marketing`, `module-developpement-des-ventes`, `ajouter`, `recherche`, `detection-opportunites`, `risque-alerte`, `information` |
| Stock / Achats | 15 : `module-stock-achats`, `module-fournisseurs`, `parametres`, `module-produits`, `facture`, `retard`, `import`, `export`, `ajouter`, `recherche`, `stock`, `validation`, `risque-alerte`, `information`, `planning` |
| China Sourcing | 9 : `module-fournisseurs`, `parametres`, `ajouter`, `recherche`, `risque-alerte`, `information`, `notifications`, `synchronisation`, `planning` |
| Parle à Nordla | 1 : `module-parle-a-nordla` |
| Ventes / CRM | 1 : `module-ventes-crm` |
| Marketing | 1 : `module-marketing` |
| Branding | 1 : `module-branding` |
| Création | 1 : `module-creation` |
| Fournisseurs | 1 : `module-fournisseurs` |
| Conformité | 2 : `module-conformite`, `securite` |
| Service après-vente | 1 : `module-service-apres-vente` |
| Centre des connexions | 2 : `synchronisation`, `donnees` |
| Journal des décisions | 2 : `module-journal-des-decisions`, `validation` |
| Assistants et automatisations | 1 : `automatisation` |
| Paramètres | 0 : — |
| Produits | 2 : `module-produits`, `stock` |

Aucun remplacement automatique n’a été fait dans les interfaces (consigne). Le déploiement graphique global sera fait après votre validation.

## 6. Icônes encore manquantes

Sur la liste des 44 du 2026-10-17 : **couvertes par une V2 conforme (13)** : R1 Facture, R2 Paiement, R3 Retard, R4 Validation, R5 Risque / alerte, R6 Information, N1 Branding, N2 Création, N3 Modules, N5 Ajouter, N15 Exporter, N25 Sauvegarde, N27 Notifications.

**Uniquement en version à corriger (31)** : R7 Assistant, R8 Priorité, R9 Opportunité, R10 Insight, R11 Explication, R12 Recommandation, R13 Décision, R14 Données à jour, R15 Données partielles, R16 Fiabilité des données, R17 Action recommandée, N4 Plus / menu, N6 Photo, N7 Fermer, N8 Chevron / retour, N9 Micro / dictée, N10 Devis, N11 Avoir, N12 TVA, N13 Justificatifs, N14 Documents reçus, N16 Déconnexion, N17 Visite fournisseur, N18 Comparer, N19 Modifier, N20 Variation, N21 Noter, N22 Centre des connexions, N23 Nous contacter, N24 Utilisateur / session, N26 Envoyé.

Toutes catégories : **101 fonctions** n’ont aucune icône utilisable ; chacune a au moins un fichier reçu à corriger (rien n’est entièrement absent). Liste complète et défauts : galerie, filtre « Sans icône ».

### Priorités des 101 fonctions sans icône utilisable (champ `priority` du catalogue)

**P0 — bloquant pour les écrans actuels (3)** : Menu « Plus » (`menu-plus`), Photo (`photo`), Assistant IA (`assistant-ia`).

**P1 — fonctions des modules déjà construits (37)** : Devis (`devis`), Avoir / note de crédit (`avoir`), TVA (`tva`), Justificatifs (`justificatifs`), Documents reçus (`documents-recus`), Reçu (`recu`), Ticket de caisse (`ticket`), Bon de commande (`bon-de-commande`), Échéance (`echeance`), Paiement reçu (`paiement-recu`), Retour (`retour`), Fermer (`fermer`), Modifier (`modifier`), Filtrer (`filtre`), Variation (`variation`), Déconnexion (`deconnexion`), Nouveau fournisseur (`nouveau-fournisseur`), Demande d'achat (`demande-achat`), Réception de marchandise (`reception-marchandise`), Comparer (`comparer`), Visite fournisseur (`visite-fournisseur`), Dossier fournisseur (`dossier-fournisseur`), Produit (`produit`), Inventaire (`inventaire`), Mouvement de stock (`mouvement-stock`), Emplacement (`emplacement`), Insight (`insight`), Recommandation (`recommandation`), Décision (`decision`), Opportunité (`opportunite`), Priorité (`priorite`), Explication (`explication`), Approbation du propriétaire (`approbation-proprietaire`), Micro / dictée (`micro-dictee`), Données à jour (`donnees-a-jour`), Données partielles (`donnees-partielles`), Noter (`noter`).

**P2 — modules à venir / confort (61)** : Assistants et automatisations (`module-assistants-automatisations`), Centre des connexions (`module-centre-des-connexions`), Documents envoyés (`documents-envoyes`), Réception de document (`reception-document`), Remboursement (`remboursement`), Budget (`budget`), Rentabilité (`rentabilite`), Facturation (`facturation`), Dupliquer (`dupliquer`), Supprimer (`supprimer`), Trier (`tri`), Télécharger (`telecharger`), Partager (`partager`), Utilisateur (`utilisateur`), Session utilisateur (`session`), Équipe / groupe (`groupe-utilisateurs`), Profil (`profil`), Rôles et accès (`roles`), Accès (clé) (`acces`), Permission (`permission`), Confidentialité (`confidentialite`), Verrouiller (`verrouiller`), Historique (`historique`), CRM (`crm`), Prospect (`prospect`), Panier (`panier`), Suivi de commande (`suivi-commande`), Devis client (`devis-client`), Retour client (`retour-client`), Satisfaction (`satisfaction`), Pipeline commercial (`pipeline`), Livraison client (`livraison-client`), Livraison (`livraison`), Négociation (`negociation`), Catalogue (`catalogue`), Contrat (`contrat`), Catégories (`categories`), Variantes (`variantes`), Entrée de stock (`entree-stock`), Sortie de stock (`sortie-stock`), Stock faible (`stock-faible`), Code-barres (`code-barres`), Scanner (`scan`), Action recommandée (`action-recommandee`), Nous contacter (`nous-contacter`), Envoyé (`envoye`), E-mail (`email`), Message (`message`), Commentaire (`commentaire`), Pièce jointe (`piece-jointe`), Support (`support`), Aide (`aide`), Centre d'aide (`centre-aide`), Tutoriel (`tutoriel`), Avis / feedback (`feedback`), Signalement (`signalement`), Analyse (`analyse`), Liste de contrôle (`checklist`), Archiver (`archive`), Imprimer (`impression`), Aperçu (`apercu`).


## 7. Décisions prises (2026-10-17) et suite

1. La famille **Finance V1 officielle** reste la référence graphique.
2. Les accents **cuivre** sont conservés : aucune recoloration automatique en bronze.
3. Les **34 fichiers V2 conformes** sont des candidats techniques, **pas encore validés graphiquement** (`graphic_validation: en-attente`).
4. Les fichiers défectueux restent des **références uniquement** (hors du dossier servi).
5. Aucun PNG basse résolution n’est agrandi ni présenté comme SVG.
6. Les icônes manquantes seront **créées en SVG par l’équipe créative**, dans une seule famille visuelle ; aucune création graphique ni modification d’écran côté code en attendant cette livraison.

Restent ouverts : le choix V1 ou V2 pour les 15 fonctions qui ont les deux, et les noms à corriger (Tableau de bord, China Sourcing, série 9, `10_import` et `12_recu` de la série 2).

## 8. Fichiers ajoutés ou modifiés (217, tous des ajouts sauf 1)

| Fichier(s) | Nombre | Nature |
|---|---|---|
| `src/shared/assets/nordla/library/catalog.json` | 1 | catalogue unique (V1 + V2) |
| `src/shared/assets/nordla/library/<catégorie>/<identifiant>.png` | 34 | V2 conformes, copies octet pour octet du lot 1 (256 px) |
| `docs/design/nordla-icon-library-v2/reference/lot1/…`, `…/reference/lot2/…` | 38 + 130 | fichiers À CORRIGER conservés comme référence (noms d'origine) |
| `docs/design/nordla-icon-library-v2/galerie.html`, `build-gallery.mjs` | 2 | galerie locale et son générateur |
| `docs/design/nordla-icon-library-v2/captures/*.png` | 8 | captures Chromium de la galerie (desktop 1440, mobile 390) |
| `docs/design/NORDLA-ICON-LIBRARY-V2-REPORT.md` | 1 | ce rapport |
| `test/nordla-icon-library-v2.test.js` | 1 | contrôles du catalogue |
| `docs/integration/COORDINATION.md` | 1 (modifié) | déclaration du chantier |

**Inchangés** (vérifié par `git diff` contre `0b32cde`) : `src/shared/nordla-icon.js`, pack V1 `official-icons/`, logo `brand/`, China Sourcing (`src/sourcing`), Stock / Achats, Finance, Analyses, Croissance, serveurs, `deploy/`, Railway, workflows.

## 9. Tests

- `test/nordla-icon-library-v2.test.js` : 3 contrôles. Catalogue (11 catégories, identifiants uniques, statuts). Fichiers (copies intactes, 256 px RGBA, rien d'À CORRIGER dans les assets servis, les 206 pictogrammes comptés). Production (registre V1 inchangé, aucun écran n'utilise une icône V2).
- Suite complète : **4211 tests, 0 échec** (22 ignorés par la suite).
- E2E navigateur : Design 7/7, entrée Nordla 7/7, PWA 18/18, terrain v1 13/13, répétition Xiaomi 10/10, Core 5/5.
- Galerie dans Chromium : 302 images, **0 cassée**, **0 débordement horizontal** en 1440 et 390 px, 168 cartes.
