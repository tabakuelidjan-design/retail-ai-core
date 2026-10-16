# Stock / Achats ↔ Shopify — contrat de synchronisation (V1, À VALIDER — rien n'est implémenté)

Statut : **contrat de conception**. Aucune ligne de code de synchronisation n'existe, rien n'est écrit dans Shopify, aucune migration n'est préparée pour ce sujet. Ce document fixe ce que la synchronisation devra garantir avant d'être codée, et ce qui manque pour la coder. Il s'appuie sur le code actuel de la convergence (`2c8871d`), pas sur des comptes rendus.

## 0. Principes (décision du propriétaire, 2026-10)
1. **Shopify est la référence commerciale** des produits vendus par HABB (catalogue, prix, ventes, remboursements). Stock / Achats est la référence de la **réalité physique et des achats** (réceptions, emplacements, coût moyen pondéré, quarantaine, écarts d'inventaire).
2. **Lecture seule vers Shopify** tant que le raccordement n'est pas approuvé : aucune écriture (ni `inventorySetQuantities`, ni prix, ni produit). Toute future écriture = une proposition, avec approbation humaine nommée, désactivable.
3. **Aucune correction automatique du stock** : un écart détecté devient une **demande déposée** (`requestStockChange`, déjà livrée), décidée par une personne habilitée ; jamais un ajustement silencieux.
4. Les produits **non vendus sur Shopify** restent gérés seuls, sans réconciliation (§6).

## 1. Ce qui existe déjà (vérifié dans le code)
| Élément | Où | Utilité pour ce contrat |
|---|---|---|
| Tables synchronisées depuis Shopify : `products`, `variants`, `locations`, `inventory_snapshots`, `orders`, `order_lines`, `refunds`, `refund_lines` (clé `source_system` + `source_id`) | `supabase/migrations/20260920132005_phase1_schema.sql`, `src/sync/*` | **Aucun nouveau connecteur à écrire** : Stock / Achats lit ces tables (lecture seule), il n'interroge pas Shopify. |
| Instantané de stock Shopify par (variante, emplacement), au plus un par jour local | `src/sync/inventory.js` | Base de la réconciliation (§5). Un instantané est une **observation datée**, pas un mouvement. |
| `orders.is_test` | migration `20260921090000` | Les commandes de test sont exclues. |
| Registre de mouvements de Stock / Achats : clé d'idempotence **unique par commerçant**, ajout seul | `proc_stock_movements` | Garantit « aucun double mouvement » (§3). |
| `proc_items.variant_ref` (texte, libre aujourd'hui) | schéma `…090000…` | Emplacement du lien produit ↔ variante Shopify (§2). |
| Demandes d'ajustement / d'inventaire avec décision humaine, journalisées | `requestStockChange` / `decideStockChange` | Voie unique de correction des écarts (§5). |

## 2. Correspondance fiable des produits et variantes
- **L'identité est la variante Shopify**, jamais le SKU : le code de synchronisation indique que le SKU est *« nullable, and confirmed duplicated across unrelated variants in real HABB data »* (`src/sync/normalize.js`). Une correspondance par SKU seul est donc **interdite**.
- Lien : `proc_items.variant_ref = "shopify:variant:<variants.source_id>"`. Un produit Stock / Achats peut porter **un seul** lien ; une variante Shopify ne peut être liée qu'à **un seul** produit (contrainte d'unicité à ajouter avec le lien, voir §8).
- Création du lien : **action humaine** (proposition de rapprochement par nom/code-barres affichée, jamais appliquée seule). Un produit sans lien reste « interne » ; une vente d'une variante sans lien est mise en file `NON_RAPPROCHÉ` (comptée, visible, **sans effet sur le stock**).
- Emplacements : chaque emplacement Shopify utilisé pour la vente est lié à **un** emplacement Stock / Achats de type vendable (magasin de Namur → `STORE`). Une vente sur un emplacement non lié → `NON_RAPPROCHÉ`.
- Une variante archivée ou supprimée côté Shopify garde son lien et son historique ; elle n'est jamais « recréée ».

## 3. Mouvements de vente, sans double comptage
**Événement générateur** : la **sortie physique**, pas la prise de commande. Un nouveau type de mouvement est nécessaire (le registre n'en a aucun aujourd'hui : `RECEIPT, ADJUSTMENT, TRANSFER_*, DEFECT_*, COUNT_ADJUST, RESERVE, RELEASE`) : `SALE_OUT` (sortie ON_HAND) et `RETURN_IN` (entrée, §4). Ajout = migration additive de la contrainte `kind` + `MOVEMENT_KINDS` (non préparée).
- **Clé d'idempotence déterministe**, une par ligne et par nature d'événement :
  `shopify:<shop>:order:<order.source_id>:line:<order_line.source_id>:<NATURE>` avec `NATURE ∈ { SALE, CANCEL, REFUND:<refund.source_id> }`.
  Le même événement relu (webhook rejoué, relance de synchronisation, redémarrage) retombe sur la même clé : le registre le refuse comme **déjà vu**, pas comme une erreur. C'est la garantie « aucun double mouvement », et elle ne dépend d'aucun état en mémoire.
- **Réservation (optionnelle, à décider)** : à la création d'une commande payée, `RESERVE` avec référence `order:<id>` ; libérée (`RELEASE`) à l'expédition ou à l'annulation. Sans réservation, le stock « disponible » ne baisse qu'à l'expédition.
- Une ligne d'une commande `is_test` ne produit **jamais** de mouvement.
- Une sortie qui rendrait le solde négatif **n'est pas refusée en silence** : elle est mise en file `À_VÉRIFIER` (le registre garde sa contrainte « jamais négatif »), car une vente réelle ne peut pas être « annulée » côté physique ; l'écart sera traité par inventaire.

## 4. Annulations et remboursements
Constat dans le code : `refund_lines` ne porte **ni** l'indicateur de remise en stock (`restock_type` de Shopify) **ni** l'état d'expédition ; `orders.status` est un texte libre. Le contrat tient compte de ce manque :
| Cas | Effet sur le stock | Décision |
|---|---|---|
| Commande annulée **avant** expédition | `RELEASE` de la réservation (si elle existe) ; aucun mouvement ON_HAND | automatique, tracé |
| Commande annulée **après** expédition | aucun mouvement tant que la marchandise n'est pas revenue | humain |
| Remboursement **sans retour** de marchandise | **aucun** mouvement | automatique (constaté, tracé) |
| Remboursement **avec retour** | `RETURN_IN` vers **QUARANTAINE** (jamais directement vendable) ; transfert vers le stock vendable seulement après contrôle | humain (réception du retour) |
| Remboursement dont on ignore si la marchandise est revenue | mis en file `RETOUR_À_CONFIRMER` : **aucun mouvement** avant confirmation | humain |
Un remboursement n'est jamais interprété comme un retour physique par défaut.

## 5. Réconciliation des écarts
- Périodique (quotidienne, après l'instantané Shopify) et à la demande. Pour chaque variante liée et chaque emplacement lié : `Δ = quantité Shopify (instantané) − solde vendable Stock / Achats (+ réservations non expédiées si Shopify les décompte)`.
- Classes : `ÉGAL`, `SHOPIFY_PLUS`, `STOCK_PLUS`, `NON_RAPPROCHÉ`, `OBSOLÈTE` (instantané trop ancien : aucune conclusion).
- Un écart **n'est jamais corrigé tout seul** : il produit un rapport (preuves : dernier mouvement, dernier instantané, événements en file) et, si la personne le décide, une **demande d'inventaire/ajustement** à son nom, décidée comme toute demande (séparation des tâches respectée).
- Une tolérance dans le temps est nécessaire : une vente entre l'instantané et le calcul crée un écart transitoire ; l'écart n'est signalé qu'après deux observations consécutives ou un délai à fixer.

## 6. Produits non commercialisés sur Shopify
Tout produit **sans lien** reste entièrement géré par Stock / Achats (réceptions, transferts, inventaires, valorisation). Il n'entre jamais dans la réconciliation, n'est jamais modifié par un événement Shopify et ne génère aucune file `NON_RAPPROCHÉ`. Passer un produit de « interne » à « vendu sur Shopify » = créer le lien (§2), puis une **réconciliation initiale** décidée par une personne (le stock de départ de Shopify n'est jamais « importé » aveuglément).

## 7. Garde-fous
- Droits Shopify **en lecture seule** (produits, stocks, commandes, emplacements). Aucun secret dans le dépôt ; aucune écriture.
- Une panne de la synchronisation ne bloque ni les réceptions, ni les ajustements, ni l'interface (module isolé, comme le montage Stock / Achats).
- Chaque mouvement issu de Shopify porte sa référence (`order`, `line`, `refund`) et l'identité du processus (`shopify-sync`, rôle sans approbation) ; ce processus **ne peut jamais approuver** (aucune approbation nommée ne lui est attribuée).
- Tout est rejouable : relancer la synchronisation n'ajoute rien.

## 8. Ce qui manque pour l'implémenter (non fait)
1. **Décisions du propriétaire** : mouvement à l'expédition ou à la commande ? réservation oui/non ? emplacement(s) de vente ? tolérance de réconciliation ?
2. **Données côté Core** (propriétaire : chantier de la synchronisation Shopify) : état d'expédition par ligne, date d'annulation, indicateur de remise en stock des remboursements (aujourd'hui absents de `orders` / `refund_lines`).
3. **Migration additive Stock / Achats** (non préparée) : types `SALE_OUT` / `RETURN_IN`, unicité du lien variante, lien d'emplacement, files `NON_RAPPROCHÉ` / `À_VÉRIFIER` / `RETOUR_À_CONFIRMER`.
4. **Accès** : lecture des tables synchronisées avec un rôle de service dédié (jamais le rôle navigateur) ; aucune clé Shopify supplémentaire pour la lecture, puisque Core synchronise déjà.
5. Recouvrement à arbitrer avec Finance : `finance_stock_movements` et `inventory_snapshots` décrivent déjà « du stock » ; **un seul** ledger doit faire autorité pour le physique (ce contrat désigne celui de Stock / Achats).

## 9. Critères d'acceptation (à transformer en tests avant tout code de synchronisation)
Relecture du même événement = 0 mouvement ; vente d'une variante non liée = 0 mouvement + 1 entrée en file ; commande `is_test` = 0 mouvement ; remboursement sans retour = 0 mouvement ; retour confirmé = entrée en quarantaine uniquement ; sortie > solde = file `À_VÉRIFIER`, solde inchangé ; écart de réconciliation = rapport + demande à nom humain, jamais d'ajustement direct ; produit sans lien jamais touché ; coupure réseau au milieu d'une synchronisation = reprise sans doublon ni perte.
