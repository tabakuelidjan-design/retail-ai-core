# Nordla — classement des icônes : validées, à corriger, manquantes

Source : `INVENTORY.json` (fichiers réels) + `src/shared/assets/nordla/library/catalog.json`. Décisions déjà actées (2026-10-17) : la famille Finance V1 reste la référence ; accents **cuivre** conservés ; rien n'est remplacé sans validation graphique.

## 1. Validées — 46 icônes (pack officiel V1, en production)

Seules icônes affichées par les écrans. Registre : `src/shared/nordla-icon.js` (une fonction = une clé = un fichier).

`aFaire`, `achats`, `afterSales`, `approval`, `banqueEtCaisse`, `buyingSuppliers`, `ceQuiAChange`, `clients`, `commandCenter`, `compliance`, `contacts`, `decisionLedger`, `explorer`, `governance`, `growth`, `parleANordla`, `produits`, `resume`, `security`, `tresorerie`, `ventes`, `baisse`, `chiffreAffaires`, `commandes`, `croissance`, `margeBrute`, `panierMoyen`, `clientARisque`, `clientDormant`, `clientFidele`, `cohorte`, `nouveauClient`, `segmentClient`, `fournisseur`, `meilleurProduit`, `prix`, `produitEnBaisse`, `produitEnHausse`, `stock`, `accueil`, `packComptable`, `parametres`, `calendrier`, `dataHealth`, `recherche`, `synchronisation`

## 2. Candidates V2 techniquement conformes — 34 (validation graphique en attente)

Copies octet pour octet du lot 1, **non branchées** dans les écrans. Pour 14 fonctions elles côtoient une V1 déjà en production (arbitrage V1/V2 à faire dans la galerie).

`module-branding`, `module-centre-de-pilotage`, `module-conformite`, `module-creation`, `module-fournisseurs`, `module-journal-des-decisions`, `module-marketing`, `module-parle-a-nordla`, `module-produits`, `module-service-apres-vente`, `module-stock-achats`, `module-developpement-des-ventes`, `parametres`, `tous-les-modules`, `export`, `facture`, `import`, `paiement`, `retard`, `ajouter`, `recherche`, `securite`, `stock`, `detection-opportunites`, `information`, `risque-alerte`, `validation`, `notifications`, `donnees`, `rapport`, `sauvegarde`, `synchronisation`, `automatisation`, `planning`

## 3. À corriger — 186 fichiers

- Pack V1 défectueux : **18** fichiers (déclarés DEFECTIVE dans le registre : jamais affichés).
- V2 reçus à corriger : **168** fichiers, par nature du défaut :

  - 68 × `FIX_BACKGROUND_LOWRES` : fond blanc/résidus + basse résolution → fond nettoyable, mais résolution native ≤ 112 px (usage ≤ 48 px CSS seulement)
  - 54 × `NEEDS_REDRAW_CLIPPED` : trait coupé → **à redessiner** (le trait manquant n'existe plus dans le fichier)
  - 23 × `NEEDS_REDRAW_COLOUR` : accent brun / hors famille → à redessiner dans la palette cuivre (aucune recoloration automatique)
  - 12 × `NO_PICTOGRAM` : texte seul, aucun pictogramme → à créer
  - 7 × `FIX_MARGIN` : marge nulle seule → correction technique possible (marge transparente ajoutée, dessin intact)
  - 4 × `NEEDS_REDRAW_CAPTION` : légende intégrée → à redessiner ou à re-exporter

## 4. Manquantes — 101 fonctions sans aucune icône utilisable

- **P0** (3) : Menu « Plus » (`menu-plus`), Photo (`photo`), Assistant IA (`assistant-ia`)
- **P1** (37) : Devis (`devis`), Avoir / note de crédit (`avoir`), TVA (`tva`), Justificatifs (`justificatifs`), Documents reçus (`documents-recus`), Reçu (`recu`), Ticket de caisse (`ticket`), Bon de commande (`bon-de-commande`), Échéance (`echeance`), Paiement reçu (`paiement-recu`), Retour (`retour`), Fermer (`fermer`), Modifier (`modifier`), Filtrer (`filtre`), Variation (`variation`), Déconnexion (`deconnexion`), Nouveau fournisseur (`nouveau-fournisseur`), Demande d'achat (`demande-achat`), Réception de marchandise (`reception-marchandise`), Comparer (`comparer`), Visite fournisseur (`visite-fournisseur`), Dossier fournisseur (`dossier-fournisseur`), Produit (`produit`), Inventaire (`inventaire`), Mouvement de stock (`mouvement-stock`), Emplacement (`emplacement`), Insight (`insight`), Recommandation (`recommandation`), Décision (`decision`), Opportunité (`opportunite`), Priorité (`priorite`), Explication (`explication`), Approbation du propriétaire (`approbation-proprietaire`), Micro / dictée (`micro-dictee`), Données à jour (`donnees-a-jour`), Données partielles (`donnees-partielles`), Noter (`noter`)
- **P2** (61) : Assistants et automatisations (`module-assistants-automatisations`), Centre des connexions (`module-centre-des-connexions`), Documents envoyés (`documents-envoyes`), Réception de document (`reception-document`), Remboursement (`remboursement`), Budget (`budget`), Rentabilité (`rentabilite`), Facturation (`facturation`), Dupliquer (`dupliquer`), Supprimer (`supprimer`), Trier (`tri`), Télécharger (`telecharger`), Partager (`partager`), Utilisateur (`utilisateur`), Session utilisateur (`session`), Équipe / groupe (`groupe-utilisateurs`), Profil (`profil`), Rôles et accès (`roles`), Accès (clé) (`acces`), Permission (`permission`), Confidentialité (`confidentialite`), Verrouiller (`verrouiller`), Historique (`historique`), CRM (`crm`), Prospect (`prospect`), Panier (`panier`), Suivi de commande (`suivi-commande`), Devis client (`devis-client`), Retour client (`retour-client`), Satisfaction (`satisfaction`), Pipeline commercial (`pipeline`), Livraison client (`livraison-client`), Livraison (`livraison`), Négociation (`negociation`), Catalogue (`catalogue`), Contrat (`contrat`), Catégories (`categories`), Variantes (`variantes`), Entrée de stock (`entree-stock`), Sortie de stock (`sortie-stock`), Stock faible (`stock-faible`), Code-barres (`code-barres`), Scanner (`scan`), Action recommandée (`action-recommandee`), Nous contacter (`nous-contacter`), Envoyé (`envoye`), E-mail (`email`), Message (`message`), Commentaire (`commentaire`), Pièce jointe (`piece-jointe`), Support (`support`), Aide (`aide`), Centre d'aide (`centre-aide`), Tutoriel (`tutoriel`), Avis / feedback (`feedback`), Signalement (`signalement`), Analyse (`analyse`), Liste de contrôle (`checklist`), Archiver (`archive`), Imprimer (`impression`), Aperçu (`apercu`)

## 5. Collection Growth — 31 icônes, hors famille Finance (à arbitrer)

Style volumétrique (dégradés, volumes) différent de la famille Finance (traits bleu nuit et accent cuivre à plat). Utilisées par l'écran Développement des ventes. Une icône (`collection-autumn`) montre une **feuille** : à confirmer. Le catalogue V2 ne les couvre pas.

`ai-insights`, `approvals`, `audience`, `bundle`, `business`, `campaigns`, `clicks`, `collection-autumn`, `confidence`, `content`, `effort`, `experiments`, `gifts`, `goal-awareness`, `goal-recruitment`, `growth-overview`, `impact-effort`, `local`, `loyalty`, `needs-attention`, `new-arrivals`, `opportunities`, `pipeline-status`, `priority-high`, `retargeting`, `returning-customers`, `revenue-by-source`, `settings`, `store-growth`, `students`, `tutorial`

