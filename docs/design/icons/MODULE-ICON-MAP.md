# Nordla — pictogramme de chaque module : ce que les écrans utilisent aujourd’hui et ce qui existe

Généré par `tools/nordla-icon-tools.py modulemap` (écran Core : `MODULE_META` de `src/sourcing/nordla-ui/nordla-view.js` ; catalogue : `src/shared/assets/nordla/library/catalog.json`). **Rien n’est appliqué** : une V2 n’est proposée qu’après validation graphique.

| Module | Aujourd’hui (écran Core) | Icône V1 validée existante | Proposition / reste à faire | Priorité |
|---|---|---|---|---|
| Nordla Core | V1 `commandCenter` | V1 validée `accueil` | — |  |
| Centre de pilotage | pas d’entrée dans l’écran Core (module non listé comme tel) | V1 validée `commandCenter` | V2 `module-centre-de-pilotage` (techniquement conforme, validation graphique en attente) |  |
| Finance | V1 `tresorerie` | V1 validée `tresorerie` | — |  |
| Analyses | V1 `explorer` | V1 validée `explorer` | V2 `module-analyses` (techniquement conforme, validation graphique en attente) |  |
| China Sourcing | V1 `buyingSuppliers` | V1 validée `buyingSuppliers` | — |  |
| Stock & Achats | V1 `stock` | aucune V1 | V2 `module-stock-achats` (techniquement conforme, validation graphique en attente) |  |
| Développement des ventes | V1 `growth` | aucune V1 | V2 `module-developpement-des-ventes` (techniquement conforme, validation graphique en attente) |  |
| Branding | lettre « B » (aucune icône officielle utilisable) | aucune V1 | V2 `module-branding` (techniquement conforme, validation graphique en attente) |  |
| Marketing | V1 `growth` | V1 validée `growth` | V2 `module-marketing` (techniquement conforme, validation graphique en attente) |  |
| Création | lettre « C » (aucune icône officielle utilisable) | aucune V1 | V2 `module-creation` (techniquement conforme, validation graphique en attente) |  |
| Social Publishing | lettre « S » (aucune icône officielle utilisable) | aucune V1 | à créer (aucun fichier utilisable) |  |
| Parle à Nordla | V1 `parleANordla` | V1 validée `parleANordla` | V2 `module-parle-a-nordla` (techniquement conforme, validation graphique en attente) |  |
| Validations | V1 `approval` | V1 validée `approval` | V2 `validation` (techniquement conforme, validation graphique en attente) |  |
| Conformité | pas d’entrée dans l’écran Core (module non listé comme tel) | V1 validée `compliance` | V2 `module-conformite` (techniquement conforme, validation graphique en attente) |  |
| Service après-vente | pas d’entrée dans l’écran Core (module non listé comme tel) | V1 validée `afterSales` | V2 `module-service-apres-vente` (techniquement conforme, validation graphique en attente) |  |
| Journal des décisions | pas d’entrée dans l’écran Core (module non listé comme tel) | V1 validée `decisionLedger` | V2 `module-journal-des-decisions` (techniquement conforme, validation graphique en attente) |  |
| Centre des connexions | V1 `synchronisation` | aucune V1 | à créer (aucun fichier utilisable) | P2 |
| Assistants et automatisations | pas d’entrée dans l’écran Core (module non listé comme tel) | aucune V1 | à créer (aucun fichier utilisable) | P2 |
| Détection des opportunités | pas d’entrée dans l’écran Core (module non listé comme tel) | aucune V1 | V2 `detection-opportunites` (techniquement conforme, validation graphique en attente) |  |
| Fournisseurs | pas d’entrée dans l’écran Core (module non listé comme tel) | aucune V1 | V2 `module-fournisseurs` (techniquement conforme, validation graphique en attente) |  |
| Ventes et CRM | pas d’entrée dans l’écran Core (module non listé comme tel) | aucune V1 | V2 `module-ventes-crm` (techniquement conforme, validation graphique en attente) |  |
| Produits | pas d’entrée dans l’écran Core (module non listé comme tel) | V1 validée `produits` | V2 `module-produits` (techniquement conforme, validation graphique en attente) |  |

## Une fonction = un pictogramme

- **Même pictogramme pour plusieurs modules** : `growth` → Développement des ventes, Marketing. À arbitrer (le catalogue donne `growth` à Marketing, tandis que « Développement des ventes » n’a pas de V1 propre).
- **Même pictogramme pour deux sens** : `tresorerie` est à la fois l’icône du module Finance (écran Core) et celle de la vue « Trésorerie » dans Finance. À arbitrer avec la validation de `module-finance` (le fichier Finance du lot 1 est coupé : à redessiner).
- **Stand-in** : « Centre des connexions » utilise provisoirement `synchronisation` (aucune icône dédiée) ; Social Publishing n’a aucune fonction dans le catalogue V2 (« Publication sociale » est à ajouter).

