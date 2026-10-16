# Convergence — rapport technique de la vague 1 (2026-10-16)

Branche `integration/nordla-convergence-v1` (poussée, non fusionnée). Base core-p0 `92297c8` + chantier C `c4d2e3f` + raccordement (`9ac820e`).
Aucune branche A/B/C modifiée ; aucun déploiement, migration, secret, DNS, publication.

## Critères de validation
| # | Critère | Résultat | Preuve |
|---|---|---|---|
| 1 | Le serveur expose les routes Achats | OUI | `/api/procurement/*` montées sur le serveur Sourcing/Core (`src/sourcing/server/app.js`, `src/procurement/server/hosted.js`) ; test de parcours |
| 2 | Parle consulte commande + stock depuis la même source persistante | OUI (commandes, stock, entrant, retards, réappro ; lecture seule) | `src/core-pilot/procurement-answers.js` ; parcours : la commande créée par l'API est retrouvée par Parle, y compris après redémarrage. « Stock » : réponse prouvée pour la vue d'ensemble ; le détail par article est couvert par les tests Achats, pas par le parcours |
| 3 | China Sourcing → Buying sans doublons | OUI | import répété ×2 : 1 article ; brouillon répété : 1 commande |
| 4 | Identité et autorisations | OUI | sans session 401 ; jeton de dev refusé ; changement sans CSRF 403 ; collaborateur ne peut pas soumettre ; acheteur ne peut pas approuver ; approbation nommée du propriétaire, non rejouable |
| 5 | Non-régression | OUI avec réserves | rejeu local fichier par fichier : 366 fichiers, 363 verts. 3 rouges, tous sans lien avec le raccordement : 2 chemins Windows (`sourcing-field-v1-merchant-profile`, `sourcing-ui-syntax`, même famille que `C:\C:\`), 1 délai dépassé sous charge (`creative-layered-runtime`, exit 124) |
| 6 | CI de la branche | PARTIEL | verts sur `9ac820e` : `nordla-integration-pre-china` (Node 20 + 24, par fichier), Activation, Creative Intelligence, Marketing. ROUGE : « Provider Provisioning », étape `npm test` (suite monolithique). Logs illisibles sans authentification ; cause non établie. Cet `npm test` était déjà rouge sur un ancien commit de core-p0 (`f7b2b16`) puis vert, et mon rejeu par fichier ne reproduit aucun échec lié au raccordement. À relancer / lire avec accès authentifié |
| 7 | Rapport exact | ce document | |

## Ce qui reste bloqué ou à décider
- Écran téléphone d'Achats : l'API est montée, pas l'interface (reste une application séparée).
- Séparation des tâches : le propriétaire ne peut pas approuver une commande qu'il a créée seul ; il faut un acheteur (ADMIN) ou activer l'option « propriétaire seul » du module (décision).
- Un brouillon de commande depuis un dossier exige une date d'arrivée prévue (refus explicite sinon).
- Moteur de coût rendu faisant autorité : non tranché.
- Migrations de A (`integration_purchase_plans`, `integration_incoming_expectations`) : ne pas appliquer ; PurchaseOrder du chantier C est canonique.
- Phase 3 UI de A : non fusionnée (en cours chez A).
- Railway : dossier prêt (`docs/infrastructure/dossier-activation-staging-xiaomi-18-10.md`), non activé. Recommandation du dossier : commit `ab02b77` pour le 18, Achats hors test. À valider.
- Réseau : Parle, connexion, synchronisation et sauvegarde hors serveur exigent Internet ; la saisie Sourcing et la file d'envoi fonctionnent hors ligne.

## Retour arrière
Supprimer la branche `integration/nordla-convergence-v1` (aucune source modifiée). Le montage Achats est isolé : s'il échoue au démarrage, Nordla tourne sans.
