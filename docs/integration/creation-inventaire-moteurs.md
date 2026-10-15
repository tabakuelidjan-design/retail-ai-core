# Création — inventaire des moteurs réellement présents (2026-10-15)

Aucun abonnement n'a été pris, aucun appel payant n'a été fait. Ce document dit ce qui existe dans le code, ce dont chaque moteur a
besoin pour produire réellement, et ce qui fonctionne sans fournisseur.

| Moteur (code) | Rôle | Fonctionne sans fournisseur ? | Besoin pour produire réellement |
|---|---|---|---|
| `runCreativeEndToEnd` — `src/creative-e2e/e2e.js` | Chaîne complète : requête → segmentation → plan → couches → composition → contrôles → résultat `READY` / `NEEDS_OWNER_REVIEW` / `BLOCKED` / `PROVIDER_NOT_CONNECTED` / `BUDGET_EXCEEDED` ; `owner_approval: PENDING` | Oui, mais seulement jusqu'au plan : sans « brain » ni générateur de couches → `BLOCKED NO_BRAIN_PORT` ou `PROVIDER_NOT_CONNECTED` (statut honnête, rien de produit) | Un fournisseur texte (brain/director) et image (couches) |
| Ports Alibaba Model Studio — `src/marketing-creative/alibaba/` (`qwen-brain-port`, `qwen-director-port`, `qwen-environment`, `qwen-image-edit`, `qwen-vision`) | Fournisseur prévu pour V0 | Non | `ALIBABA_MODEL_STUDIO_API_KEY`, `ALIBABA_MODEL_STUDIO_WORKSPACE_ID` (région `eu-central-1` par défaut), modèles `qwen3.8-max` / `qwen-image-3.0-pro`, budget plafonné (`ceiling_eur`) ; un seul appel réel à la fois (`runSingleLiveCall`) |
| Composition locale, rendu PNG (`@resvg/resvg-js`), polices | Assemblage et aperçu | Oui (dépendance déjà installée) | — |
| Segmentation / masque produit — `src/creative-intelligence/product-mask.js` | Détourage du produit | Oui | **Défaut connu PM-6** : masque parfois différent sous charge CPU (2/28 exécutions) ; contournement prouvé `--max-opt=2` (0/28) ; correction = session Création. Tant qu'il n'est pas corrigé, l'empreinte d'un rendu peut varier entre deux exécutions. |
| Contrôles de fidélité produit — `src/creative-fidelity/` | Vérifier que le produit n'est pas altéré | Oui | — |
| Gardien de marque — `src/branding/guardian.js` | Vérifier textes / couleurs / affirmations contre les règles approuvées | Oui | Règles de marque **approuvées** par le propriétaire (proposition HABB prête : `config/merchants/habb/brand-proposal.json`) |
| Benchmarks Gemini / MiniMax (`creative-brain-benchmark`) | Outils de comparaison | Non | Clés propres ; pas un chemin de production |

Outils déjà payés par le propriétaire (principe 7 de HABB) : Canva, ChatGPT, CapCut, Kling, Claude. **Aucun n'est raccordé** au moteur
de Création de Nordla ; les raccorder serait un nouveau développement (non fait).

Dans Nordla aujourd'hui (`/api/core/modules`) : Création = **BLOQUÉ — aucun fournisseur de génération connecté**, avec les clés
manquantes nommées. La chaîne campagne s'arrête honnêtement à cette étape ; rien n'est produit ni simulé.

Décision nécessaire du propriétaire pour débloquer : choisir un fournisseur (Alibaba Model Studio prévu par le code) et un budget
plafonné ; ensuite, un premier appel réel unique, vérifié, avant toute présentation comme « disponible ».
