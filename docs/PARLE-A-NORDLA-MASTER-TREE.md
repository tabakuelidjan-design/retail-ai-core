# Parle à Nordla — Arbre maître

_Date de référence : 2026-10-13_

Ce document est la référence maître pour suivre ce qui est déjà construit, ce qui doit être terminé avant le voyage en Chine, et ce qui restera pour après le retour.

## Arbre maître

```text
PARLE À NORDLA
│
├── 0. OBJECTIF
│   ├── Une seule porte d’entrée conversationnelle pour tout Nordla
│   ├── Texte + voix
│   ├── Comprendre l’intention
│   ├── Comprendre les entités et références
│   ├── Router vers le bon module
│   ├── Vérifier les faits critiques
│   ├── Exécuter ou préparer l’action
│   └── Garder preuve, contexte et historique
│
├── 1. INPUT LAYER
│   ├── Texte
│   │   └── À brancher transversalement
│   ├── Voix
│   │   ├── ASR provider abstraction
│   │   ├── Streaming transcription
│   │   ├── Language detection
│   │   ├── Code-switching FR / EN / ZH
│   │   ├── Speaker diarization
│   │   ├── Word/token confidence
│   │   └── Timestamps
│   ├── Images / fichiers
│   │   └── Boundary à prévoir, pas prioritaire Travel V1
│   └── STATUS
│       ├── Voix déjà expérimentée dans China Sourcing
│       ├── Plusieurs ASR déjà benchmarkés
│       └── Aucun moteur définitivement choisi
│
├── 2. TRANSCRIPTION RELIABILITY ENGINE
│   ├── Dynamic Context Pack
│   │   ├── vocabulaire Nordla commun
│   │   ├── vocabulaire par module
│   │   ├── noms fournisseurs
│   │   ├── produits / références
│   │   ├── devises
│   │   ├── Incoterms
│   │   └── contexte actif
│   ├── Critical Entity Detector
│   │   ├── NORMAL
│   │   ├── BUSINESS_RELEVANT
│   │   ├── DECISION_CRITICAL
│   │   └── SAFETY_COMPLIANCE_CRITICAL
│   ├── Confidence Fusion
│   │   ├── confiance ASR
│   │   ├── type d’information
│   │   ├── contradiction avec état connu
│   │   ├── impact économique
│   │   └── qualité audio
│   ├── Adaptive Verification
│   │   ├── 1 ASR par défaut
│   │   ├── 2e ASR seulement si nécessaire
│   │   ├── confirmation utilisateur si désaccord
│   │   └── pas de double coût systématique
│   ├── Replay Evidence
│   │   ├── audio snippet
│   │   ├── timestamp
│   │   ├── speaker
│   │   ├── provider
│   │   ├── confidence
│   │   └── lien avec le fait extrait
│   ├── Live vs Final Transcript
│   │   ├── LIVE = provisional
│   │   └── FINAL = refined transcript
│   └── STATUS
│       └── À construire comme composant générique Nordla
│
├── 3. UNIVERSAL VOCABULARY SYSTEM
│   ├── Core vocabulary
│   │   ├── client
│   │   ├── fournisseur
│   │   ├── produit
│   │   ├── commande
│   │   ├── facture
│   │   ├── paiement
│   │   ├── stock
│   │   ├── marge
│   │   ├── dossier
│   │   ├── campagne
│   │   └── décision
│   ├── Finance pack
│   │   ├── facture
│   │   ├── avoir
│   │   ├── TVA
│   │   ├── échéance
│   │   ├── Peppol
│   │   ├── virement
│   │   ├── paiement
│   │   └── trésorerie
│   ├── China Sourcing pack
│   │   ├── MOQ
│   │   ├── FOB
│   │   ├── EXW
│   │   ├── Incoterm
│   │   ├── sample
│   │   ├── material
│   │   ├── certification
│   │   ├── packaging
│   │   └── lead time
│   ├── Stock / Sales pack
│   │   ├── SKU
│   │   ├── variante
│   │   ├── stock
│   │   ├── rupture
│   │   ├── vente
│   │   ├── quantité
│   │   └── prix
│   ├── Marketing / Creative pack
│   │   └── Après retour / V2
│   └── Dynamic vocabulary
│       ├── contexte actif
│       ├── noms propres
│       ├── fournisseurs ouverts
│       ├── produits vus récemment
│       └── documents actifs
│
├── 4. INTENT ROUTER
│   ├── SEARCH / FIND
│   ├── SHOW / OPEN
│   ├── SUMMARIZE
│   ├── COMPARE
│   ├── EXPLAIN
│   ├── CALCULATE
│   ├── CREATE
│   ├── UPDATE
│   ├── ASK / CLARIFY
│   ├── DECIDE / RECOMMEND
│   └── EXECUTE
│
│   Modules Travel V1
│   ├── China Sourcing
│   ├── Finance
│   └── Stock / Sales
│
│   Modules après retour
│   ├── Marketing
│   ├── Creative
│   ├── Analytics
│   ├── Compliance
│   ├── SAV
│   ├── Buying
│   └── Automations
│
├── 5. ENTITY + REFERENCE RESOLVER
│   ├── fournisseurs
│   ├── clients
│   ├── produits
│   ├── SKU
│   ├── factures
│   ├── commandes
│   ├── dates
│   ├── montants
│   ├── devises
│   ├── documents
│   └── références contextuelles
│       ├── “ce fournisseur”
│       ├── “cette facture”
│       ├── “le précédent”
│       ├── “celui-là”
│       └── “ça”
│
├── 6. CONTEXT / WORKING MEMORY
│   ├── module actif
│   ├── entité active
│   ├── dossier actif
│   ├── dernier document consulté
│   ├── dernière action
│   ├── dernière comparaison
│   ├── conversation active
│   └── contexte court terme
│
├── 7. ACTION ORCHESTRATOR
│   ├── comprend l’action demandée
│   ├── vérifie les données requises
│   ├── choisit le bon module
│   ├── choisit l’outil / capacité
│   ├── exécute si autorisé
│   ├── demande validation si nécessaire
│   ├── explique le résultat
│   └── journalise l’action
│
├── 8. SAFETY / APPROVAL
│   ├── AUTO
│   │   └── lecture / recherche / résumé / analyse
│   ├── APPROVAL_REQUIRED
│   │   ├── modification sensible
│   │   ├── publication
│   │   ├── achat
│   │   ├── paiement
│   │   └── action fournisseur
│   └── NEVER_AUTONOMOUS
│       ├── engagement financier critique
│       ├── conformité critique
│       ├── suppression destructive
│       └── décision irréversible
│
├── 9. CHINA SOURCING — PILOT MODULE
│   ├── FIELD V1 construit
│   │   ├── capture
│   │   ├── offer import
│   │   ├── Supplier Truth Card
│   │   ├── Merchant/HABB Fit
│   │   ├── Deal Intelligence
│   │   ├── comparison 2–5
│   │   ├── Negotiation Coach
│   │   ├── ASK NEXT
│   │   ├── What Changed
│   │   ├── Supplier Memory
│   │   ├── evidence completeness
│   │   ├── persistence/resume
│   │   └── offline field mode
│   ├── À finir avant Chine
│   │   ├── vrai test téléphone
│   │   ├── profil HABB réel
│   │   ├── validation terrain
│   │   └── éventuels correctifs UX
│   └── Après retour
│       ├── ImportYeti
│       ├── QIMA
│       ├── freight/customs live
│       ├── Alibaba/1688
│       ├── WeChat
│       ├── OCR provider
│       └── autonomous negotiation
│
├── 10. FINANCE — PILOT MODULE
│   ├── exemple
│   │   └── “Fais-moi sortir la facture de ce fournisseur”
│   ├── Travel V1
│   │   ├── rechercher facture
│   │   ├── ouvrir facture
│   │   ├── résumé fournisseur
│   │   ├── paiements
│   │   ├── échéances
│   │   └── trésorerie simple
│   └── Après retour
│       └── actions plus avancées
│
├── 11. STOCK / SALES — PILOT MODULE
│   ├── exemple
│   │   └── “Combien il me reste de ces gourdes ?”
│   ├── Travel V1
│   │   ├── stock produit
│   │   ├── ventes récentes
│   │   ├── rupture
│   │   ├── variante
│   │   └── résumé produit
│   └── Après retour
│       └── actions / automatisations avancées
│
├── 12. TRAVEL V1 — À TERMINER AVANT DÉPART
│   ├── Provider-independent Voice Port
│   ├── benchmark ASR réel
│   │   ├── Soniox
│   │   ├── OpenAI transcription
│   │   ├── Gemini
│   │   └── éventuellement Speechmatics / Deepgram
│   ├── corpus réel FR / EN / ZH
│   ├── bruit salon
│   ├── chiffres / MOQ / prix
│   ├── Dynamic Context Pack
│   ├── Critical Entity Detector
│   ├── Adaptive Verification
│   ├── Replay Evidence
│   ├── Intent Router
│   ├── Entity Resolver
│   ├── Context Memory
│   ├── China Sourcing routing
│   ├── Finance routing
│   ├── Stock/Sales routing
│   └── vrai test téléphone
│
├── 13. POST-TRIP V2
│   ├── Marketing
│   ├── Creative
│   ├── Analytics
│   ├── Compliance
│   ├── SAV
│   ├── Buying
│   ├── Automations
│   ├── richer multimodal input
│   ├── advanced OCR
│   ├── translation providers
│   ├── richer speaker memory
│   ├── proactive assistant
│   └── cross-module workflows
│
└── 14. FINAL TARGET
    └── “PARLE À NORDLA”
        ├── Tu parles naturellement
        ├── Nordla comprend le contexte
        ├── Nordla sait de quel module tu parles
        ├── Nordla retrouve l’objet concerné
        ├── Nordla vérifie les faits critiques
        ├── Nordla agit ou demande validation
        ├── Nordla explique ce qu’il a fait
        └── Nordla conserve la preuve et l’historique
```

## État synthétique

### Déjà construit ou très avancé
- China Sourcing Field V1
- Finance
- Stock/Ventes de base
- Core Resilience
- plusieurs briques conversationnelles déjà présentes ailleurs

### À construire avant le voyage
- moteur transversal Parle à Nordla
- transcription fiable
- Intent Router
- Entity / Reference Resolver
- vocabulaire commun + packs
- Reliability Layer
- branchement Travel V1 sur China Sourcing + Finance + Stock/Ventes
- vrai test téléphone

### Après le voyage
- branchement des autres modules
- providers externes avancés
- automatisations plus autonomes
- workflows inter-modules enrichis

## Règle de suivi

À chaque chantier Parle à Nordla :
1. mettre à jour ce fichier ;
2. marquer chaque bloc comme BUILT / PARTIAL / DEFERRED ;
3. ajouter le commit / branche de référence si utile ;
4. ne jamais supprimer les capacités différées — les déplacer vers POST-TRIP V2.

