# Arbitrage des modèles chantier A / chantier C — objets d'achat et de stock

Statut : **recommandation + adaptateurs de compatibilité côté C**. Aucun fichier du chantier A n'est modifié. Sources lues (lecture seule) : `origin/feature/core-field-assistant` (`1d89984`) et `…-phase2` (`b826c09`) — `supabase/migrations-pending/20261015090000_integration_objects_and_sourcing_cases.sql`, `test/postgres/core-p0-pending.pg-smoke.mjs`, `src/core-pilot/*` ; et, côté base commune, `src/integration/handoffs.js` (`f7197d5`).

## 0. Constat
- Chez A, BUY_CANDIDATE / PurchasePlan / IncomingExpectation existent comme objets **en mémoire** dans `src/integration` (« NOT_PERSISTED ») et comme **SQL préparé non appliqué** (`integration_buy_candidates`, `integration_purchase_plans`, `integration_incoming_expectations`) avec un test de fumée. **Aucun code de A ne les écrit en base.** Le pilote (`src/core-pilot/ask.js`) déclare : « le stock n'est pas relié au Core ».
- Chez C, les entités sont persistantes, testées sur 3 magasins, et couvrent la suite du cycle (commande, réception, stock) que le plan de A s'interdit explicitement (`order_placed = false`, `received_qty = 0`).
⇒ Si les deux étaient appliqués tels quels, le même achat existerait **deux fois** (un plan chez A, une commande chez C) avec deux statuts à synchroniser.

## 1. Matrice de responsabilités
| Objet / capacité | Chantier A (aujourd'hui) | Chantier C (aujourd'hui) | Recouvrement | Propriétaire canonique proposé |
|---|---|---|---|---|
| Verdict « peut être acheté » (GO / CONDITIONAL_GO) + approbation nommée | `BUY_CANDIDATE` : écrit une fois, `integration_buy_candidates` | — (le pont lit un dossier, ne crée pas de verdict) | aucun | **A / Sourcing** (décision de sourcing) ; C ne le recopie pas : il en garde la **référence** (`sourcing_case_ref`) |
| Dossier China Sourcing (état, révisions) | `sourcing_cases` (SQL préparé) ou fichiers | lecture seule du JSON (`sourcing-bridge`) | non (C ne stocke pas le dossier) | **Sourcing** ; C consomme via une interface de lecture (§3) |
| Intention d'achat avant commande | `PurchasePlan` PLANNED → APPROVED_TO_ORDER | `PurchaseOrder` DRAFT → PENDING_APPROVAL → APPROVED | **oui, même chose** | **C : `PurchaseOrder`** ; le plan est une **vue** |
| Approbation de l'achat | `BUYING.approve_purchase_plan`, sujet = `purchase_ref` | **même action, même sujet** (`nordla:purchase:<id>`), usage unique, séparation des tâches | déjà alignés | **C** (journal + usage unique) ; la politique reste celle de `approval.js` |
| Commande passée / fournisseur confirmé | interdit (« a plan never says an order was placed ») | `ORDERED`, `CONFIRMED` | non (A s'arrête avant) | **C** |
| Attendu en entrée | `IncomingExpectation` (créée à l'approbation du plan) | « entrant » **dérivé** des lignes de commandes passées | **oui, sémantique différente** | **C** (dérivé, jamais stocké) ; A en reçoit une **vue** |
| Réception, écarts, défauts | absent (`received_qty = 0`) | `receiveGoods`, mouvements, quarantaine | non | **C** |
| Stock (quantités, emplacements, valorisation) | absent / Shopify temporaire | registre de mouvements | non | **C** (NDR-012 : Inventory domaine cible) |
| Journal des appels inter-modules | `integration_trace_ledger` (chaîné) | — | **non** (autre portée) | **A** (hub) ; C garde son journal **métier** `proc_events` |
| Journal métier des opérations d'achat/stock | — | `proc_events` (append-only) | non | **C** |
| Coût rendu / besoin de trésorerie d'un plan | porté dans le corps du plan (`finance_analysis`) | calculé à la demande (moteur Finance) | partiel | **Finance** (calcul), rien de stocké en double |

## 2. Doublons identifiés
1. **PurchasePlan ≡ PurchaseOrder en préparation** (même cycle, même approbation, même sujet). Dupliquer = deux sources de vérité.
2. **IncomingExpectation ≡ quantités restantes des lignes de commandes passées.** Divergence de fond : A la crée dès que le plan est *approuvé* (avant toute commande) ; C n'attend que ce qui a été *réellement commandé*. Le modèle de C est plus honnête (un plan approuvé n'est pas une marchandise attendue) ; A impose en plus `received_qty = 0`, ce qui ne représente pas une livraison partielle.
3. **Identifiants** : `purchase_ref` est déjà commun (C réutilise `nordla:purchase:<id>` comme sujet d'approbation) ; `expectation_id` suit la formule de `handoffs.js` ; `product_ref` des prospects Sourcing = `nordla:product:prospect-<case>` des deux côtés.
Pas de doublon sur : BUY_CANDIDATE, dossiers Sourcing, journal de traçabilité inter-modules, réceptions, stock.

## 3. Modèle canonique proposé
```
Sourcing case ──(verdict + approbation nommée)──▶ BUY_CANDIDATE     [A, écrit une fois]
      │                                                  │ (référence seulement)
      ▼ lecture (CaseSource)                             ▼
Fournisseur / Article PROSPECT / Devis (révisions)  ──▶ PurchaseOrder  [C, SEULE source de vérité]
                                                         DRAFT → PENDING_APPROVAL → APPROVED → ORDERED → … → RECEIVED
                                  vues en lecture seule (adaptateurs) :
                                    PurchasePlan          = PurchaseOrder en DRAFT | PENDING_APPROVAL | APPROVED
                                    IncomingExpectation   = lignes restantes de PurchaseOrder ORDERED | CONFIRMED | PARTIALLY_RECEIVED
                                    on-hand / available   = registre de stock (C) ; l'entrant n'y est JAMAIS compté
```
Correspondance d'états : `DRAFT, PENDING_APPROVAL → PLANNED` ; `APPROVED → APPROVED_TO_ORDER` ; `ORDERED…` → **n'est plus un plan** (c'est une commande, hors du modèle de A qui s'arrête avant) ; `CANCELLED` → aucun des deux.

## 4. Adaptateurs de compatibilité (livrés, côté C)
`src/integration/procurement-compat.js` — lecteurs **purs, sans écriture** :
- `purchasePlanView(po)` → objet conforme aux contraintes de `integration_purchase_plans` (statuts, `order_placed = false`, approbation obligatoire si APPROVED_TO_ORDER, `qty > 0`, `eta`).
- `incomingExpectationViews(po)` → conforme à `integration_incoming_expectations` (`EXPECTED`, `counted_in_available = false`, `received_qty = 0` ; la quantité restante est `qty`, ce qui est déjà arrivé est exposé à part dans `procurement_received_qty`).
- `createPlanReader({ queries })` + commandes de hub **lecture seule** `BUYING.proc_purchase_plans` et `STOCK_SALES.proc_incoming_expectations` (niveau READ_ONLY, tracées par le ledger du hub).
Preuves (`test/integration-procurement-compat.test.js`, 6/6) : les contraintes SQL de A écrites en prédicats sont satisfaites ; l'approbation enregistrée par C est acceptée par `validateApproval` de A ; **le vrai `buildIncomingExpectation` de A donne le même `expectation_id`** pour un ordre mono-ligne ; un PROSPECT importé garde les références de A ; les vues ne modifient rien.

## 5. Ce que cela implique pour A (recommandation, rien n'est modifié ici)
1. **Ne pas appliquer** `integration_purchase_plans` et `integration_incoming_expectations` tant que ce modèle n'est pas tranché : C les rend inutiles (vues). Garder `integration_buy_candidates`, `integration_trace_ledger`, `sourcing_cases` (aucun doublon).
2. Si A veut malgré tout persister un plan : l'écrire **depuis** la vue de C (clé = `purchase_ref`), jamais en parallèle.
3. Une `CaseSource` commune : C lit aujourd'hui un dossier de fichiers (`SOURCING_CASES_DIR`) ; quand `sourcing_cases` existera, une source SQL implémentera la même interface `{ list(), get(id) }` (C l'accepte par injection, voir `src/procurement/server/case-source.js`).
4. Aligner `received_qty = 0` / « EXPECTED dès l'approbation » sur la définition de C (entrant = commandé), ou accepter que la vue de C soit la référence.

## 6. Décisions qui vous reviennent
- Valider **PurchaseOrder (C) = modèle canonique** et les deux objets de A comme **vues**.
- Autoriser (ou non) A à retirer ces deux tables de sa migration préparée — décision du propriétaire du chantier A ; je n'y touche pas.
- Confirmer que « attendu en entrée » = **commandé et non reçu** (et non « plan approuvé »).
