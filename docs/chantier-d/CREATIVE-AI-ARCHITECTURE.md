# Creative AI pour HABB : architecture indépendante du fournisseur

Date : 2026-10-17. **Aucune API payante n'a été appelée, aucune clé n'existe dans ce travail, aucun fournisseur n'est choisi.** Ce document décrit les points d'intégration ; le code livré (`src/studio-compose/ai-layer.js`, 9 tests) prouve les règles avec un fournisseur *factice* de test, pas la qualité d'une image.

## 1. Ce qui existe déjà (à réutiliser, rien à reconstruire)

| Besoin | Existant | Où |
|---|---|---|
| Ports par capacité (jamais par fournisseur) | `ports.layers.generate`, `segmenter`, `brainComplete`, `directorComplete`, `critic`, `maskedEdit` | `src/creative-e2e/e2e.js`, `src/creative-runtime/layered-runtime.js` |
| Un port payant est enveloppé : identifiant d'opération + réservation avant appel | `createRunContext` | `src/creative-e2e/run-context.js` |
| Plafond de budget dur, jamais coupé en silence | `createCampaignBudget` | `src/creative-campaign/budget.js` |
| Registre des décisions | ledger Creative | `src/creative-runtime/ledger.js` |
| Réparation locale d'un défaut sans tout refaire | `refineCreative` | `src/creative-refine/` |
| Coffre de connexions des fournisseurs (OAuth, secrets) | provider-connections | `src/provider-connections/` (non activé) |
| Bancs d'essai de fournisseurs d'images et de vidéo, avec réservation de dépense | Alibaba / Gemini / MiniMax | `src/marketing-creative/` (scripts de benchmark, jamais servis) |
| Portes de fidélité du produit | portes finales E2E | `src/creative-e2e/` |

Constats de l'inventaire Creative (`creative-final/provider-gap-matrix.md`) : le générateur de calques (`ports.layers`) **n'a aucune implémentation réelle** ; les ports Qwen (cerveau, directeur, critique visuelle, environnement) existent mais ne tournent que depuis des scripts.

## 2. Doctrine « éléments verrouillés »

1. **Ce que l'IA a le droit de produire pour HABB** : un fond plein cadre (plaque), exactement à la taille du canevas ; plus tard des accessoires sur fond uni. **Jamais** : le produit, un visage, un texte, un prix, un logo.
2. **Les pixels verrouillés ne quittent pas la machine.** La requête ne contient qu'une intention écrite, une taille, des contraintes en mots, et la *géométrie* des zones réservées au produit (jamais ses pixels, jamais la copie verrouillée). Un fournisseur qui exige une image de référence est refusé tant que le propriétaire n'a pas activé l'envoi de référence pour ce fournisseur (par défaut : non). Cela protège les visages des clients.
3. **La plaque va sous les couches verrouillées.** Le compositeur déterministe dessine ensuite produit et texte par-dessus puis **mesure** : pixels du produit identiques (≤ 2 niveaux), copie exacte, marges de sécurité, contraste mesuré sur la plaque réelle, fond « chargé » refusé sous un texte.
4. Un asset dont une partie vient d'un modèle porte `ai_generated: true` (E le transmet à Meta). Le contrat D → E exige maintenant ce champ renseigné dans les deux sens.

## 3. Chaîne cible

```
BRIEF (propriétaire / réserve éditoriale)
  → [optionnel] Cerveau créatif (port brainComplete)  : concept, intention du fond
  → SPEC D (gabarit HABB, copie verrouillée)           : déterministe, aucune IA
  → REQUÊTE DE PLAQUE  (buildPlateRequest)             : intention + taille + contraintes + géométrie
  → ESTIMATION (provider.estimate)  → RÉSERVATION (plafond dur) → refus sans appel si dépassement
  → GÉNÉRATION (provider.generate)  → plaque PNG exactement à la taille
  → COMPOSITION + PORTES (composeCreative)             : mesures
  → [optionnel] CRITIQUE VISUELLE (port critic)        : avis, jamais décision
  → VERSION « PROPOSED » dans le journal               : parent, fournisseur, empreintes, coût, portes échouées
  → VALIDATION HUMAINE nommée (approval://…)           : seul un humain nommé fait passer à APPROVED
  → asset JPEG versionné → social-post-proposal.v1 → E (approbation de la version exacte, publication)
```

## 4. Coûts
- Estimation **avant** tout appel, fournie par le fournisseur (`estimate`), jamais devinée dans `generate`.
- Réservation contre un plafond dur (le budget de campagne existant) ; si l'estimation dépasse, **aucun appel** n'est fait (test AI-3).
- Le coût réel est enregistré par version ; un dépassement de l'estimation est signalé (`over_estimate`) et jamais masqué (AI-9).
- Les tarifs ne sont pas codés en dur ici : ils viennent de l'adaptateur du fournisseur choisi.
- Le fournisseur par défaut est `NOT_CONNECTED` : l'estimation et la génération lèvent `PROVIDER_NOT_CONNECTED`, rien n'est réservé (AI-1).

## 5. Validation humaine et historique
- Journal de versions en ajout seul (`createVersionLog`) : version, parent, type, fournisseur, modèle, empreinte de l'intention et de la requête, estimation, coût, empreintes (spec, plaque, PNG, JPEG), portes échouées, avis du critique, statut `PROPOSED` / `APPROVED` / `REJECTED`, auteur de la décision.
- La décision exige une référence `approval://` ou `owner-decision://` ; le journal contrôle la **forme** de la référence, pas l'identité : **qui** peut approuver reste décidé par E (rôle propriétaire, approbation de la version exacte).
- Une retouche = une nouvelle version d'asset ; chez E, toute approbation est alors annulée.

## 6. Points d'intégration à réaliser pour passer au réel (aucun n'est fait)

| # | Travail | Décision / ressource nécessaire |
|---|---|---|
| 1 | **Adaptateur fournisseur** : 4 membres (`id`, `capabilities`, `estimate`, `generate`) pour le fournisseur retenu | choix du fournisseur par le propriétaire ; passer d'abord le banc d'essai du `BENCHMARK_RUNBOOK` sur de vrais produits |
| 2 | Identifiants via le coffre `provider-connections` (pas de variable d'environnement) | activation du coffre |
| 3 | Politique de budget : plafond par version, par campagne, par mois ; table de prix de l'adaptateur | propriétaire |
| 4 | Contrôle de localisation et conditions du fournisseur (UE, usage commercial, conservation des données) | propriétaire |
| 5 | Brancher le port `critic` (critique visuelle) comme avis, pas comme décision | fournisseur de vision |
| 6 | Persistance du journal de versions (il est en mémoire) | tâche séparée (tables) |
| 7 | Demande à E : champ `alternative_to` dans la proposition | E |
| 8 | Si le Cerveau créatif est utilisé : brancher `brainComplete` / `directorComplete` (existants, Qwen) au point d'entrée | fournisseur de langage |

## 7. Capacités manquantes (honnêtes)

- **Aucune vérification automatique que la plaque ne contient ni texte, ni personne, ni produit** : ces interdictions sont envoyées en mots au fournisseur mais **non contrôlées** par les portes. Tant qu'un critique visuel ou un OCR n'est pas branché, la **revue humaine est obligatoire** pour chaque plaque générée.
- Aucun contrôle de visage dans une plaque (les visages ne figurent que dans les images produits verrouillées, jamais envoyées).
- Pas de segmentation générale de photographies réelles (le segmenteur local gère les fonds unis opaques).
- Pas de retouche masquée, pas d'agrandissement, pas de vidéo, pas de multi-références.
- Aucun garde-fou de tarif fournisseur réel (il dépend de l'adaptateur).
- Qualité artistique des plaques inconnue : rien n'a été généré.

## 8. Ce qui est prouvé aujourd'hui (tests `test/studio-ai-layer.test.js`)
AI-1 fournisseur par défaut non connecté, rien de réservé ou journalisé · AI-2 la plaque passe sous le produit, pixels du produit identiques à la composition sans plaque · AI-3 refus avant appel si plafond dépassé · AI-4 la requête ne contient ni copie ni pixel ni empreinte de produit · AI-5 référence image refusée par défaut · AI-6 plaque inutilisable refusée (taille, coût absent, non PNG) · AI-7 plaque chargée ou qui tue le contraste : version marquée non livrable · AI-8 journal en ajout seul, décision par référence humaine · AI-9 dépassement d'estimation enregistré.
Ce sont des tests avec un **fournisseur factice local** : ils démontrent les règles d'intégration, pas la qualité de génération.
