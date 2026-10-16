# Nordla — Stock / Achats / Fournisseurs (Chantier C) — audit, architecture, limites

Branche : `feature/stock-achat-v1` (base : `integration/nordla-pre-china` @ f7197d5). Module : `src/procurement/`.
Rien ici n'est appliqué sur une base réelle, rien n'est déployé, rien n'est fusionné dans `main`.

## 1. Audit de l'existant (étape A) — matrice

Légende : **RÉEL** = opérationnel et testé · **PUR** = fonction pure, ne persiste rien · **DÉCLARÉ** = décrit mais non implémenté.

| Capacité | Où | État | Décision |
|---|---|---|---|
| Instantané de stock Shopify (1 chiffre « disponible » par variante × emplacement) | `src/sync/inventory.js`, table `inventory_snapshots` | RÉEL | **Réutilisable** comme référence externe (lecture). Jamais écrasé. |
| Historique de coût par variante | `src/sync/cost.js`, `product_costs` (source `vendor_invoice` prévue, jamais écrite) | RÉEL | **Réutilisable** : cible possible pour le coût rendu confirmé (étape suivante). |
| Registre append-only des mouvements de **vente** (SALE_DECREMENT / RETURN_RESTOCK) vers Shopify | `src/finance/stock.js`, `fin_stock_movements` | RÉEL | **Patron réutilisé** (clé d'idempotence déterministe, machine à états, triggers anti-modification). Pas étendu : il pousse vers Shopify. |
| Factures fournisseur (AP), allocations de paiement, numérotation atomique | `fin_supplier_invoices`, `fin_payment_*`, `fin_next_number()` | RÉEL (migration `20260926160000` marquée « NOT APPLIED » : état en base non vérifié) | **Réutilisable** : lien `order_reference` → bon de commande ; paiements restent à Finance. |
| Contacts / fournisseur « léger » | `fin_companies` (`declared_supplier`, TVA, IBAN) | RÉEL | **Propriétaire de l'identité fournisseur** (`ownership.js`). Le module ajoute un profil *commercial* lié par `finance_company_id`. |
| Évaluateur d'achat (TEST CANDIDATE / NEED MORE DATA / AVOID) | `src/buying/*` | RÉEL, consultatif | Réutilisable tel quel ; ne persiste rien. |
| Calcul de coût rendu | `finance/purchase-analysis.js`, `sourcing/core/landed.js`, `buying/economics.js` | RÉEL ×3 (doublon déjà noté `DUP-LANDED-COST`) | **Aucun 4ᵉ moteur.** Le module consomme `analyzePurchase` (autorité Finance). |
| Dossier China Sourcing (offres, paliers, MOQ, négociation, PWA mobile hors-ligne) | `src/sourcing/**` | RÉEL, magasin fichier, **sans tenant**, **Node 24 seulement** | Réutilisé via la poignée `integration/handoffs.js`. Le module n'importe pas `src/sourcing` (compatibilité Node 20). |
| Passage Sourcing → BUY_CANDIDATE → plan d'achat → attente d'arrivage | `src/integration/handoffs.js` | RÉEL mais **en mémoire (NOT_PERSISTED)** | **Remplacé côté persistance** par ce module ; mêmes noms d'actions d'approbation. |
| Politique d'approbation par défaut « refuser » | `src/integration/approval.js` | RÉEL | **Réutilisée telle quelle** (`BUYING.place_order`, `STOCK_SALES.receive_goods`, `STOCK_SALES.adjust_on_hand`, `FINANCE.pay_supplier`, `STOCK_SALES.write_shopify` = BLOQUÉ). |
| Fournisseur : produits proposés, conditions, incoterms, délais, MOQ, documents, incidents | — | **ABSENT** | À construire |
| Demande d'achat, devis, bon de commande, acompte/solde, réception partielle, annulation | — | **ABSENT** | À construire |
| Emplacements multiples, mouvements génériques, inventaires, ajustements, défauts, réservé/entrant/physique | — | **ABSENT** (un seul chiffre Shopify) | À construire |
| Prix négociés (historique) | `sourcing` : révisions d'offre par dossier (fichier) | PARTIEL | À construire (devis versionnés, persistants) |
| `expectIncoming` | `module-map.js` le liste | **DÉCLARÉ** ; le plan en mémoire est dans `integration/index.js` | Remplacé par l'« entrant » dérivé des bons de commande ouverts |
| Évaluation de fiabilité fournisseur | — | ABSENT | À construire, **uniquement dérivée de données tracées** |
| Interface smartphone | `src/sourcing/ui` | RÉEL (PWA Sourcing) | Pas de nouvelle UI dans cette tranche (voir §6) |

**Doublons à ne pas créer** : moteur de coût rendu (4ᵉ), maître fournisseur (Finance le possède), magasin d'offres Sourcing.
**Conflit avec une décision FROZEN** : aucun. NDR-012 (Shopify temporaire, Stock/Inventaire = domaine cible) est respecté ; NDR-008/009/011 (calcul déterministe, approbation hors LLM, capacités bornées) structurent la conception.

## 2. Architecture (étape B)

### 2.1 Périmètre et propriété
Le module remplit le côté **persistant** de deux entités dont `ownership.js` désigne déjà le propriétaire :
`PURCHASE` (Buying) et `STOCK` (Stock/Ventes). Il n'édite pas `src/integration/` ni les branches A/B (c'est un changement partagé : voir §7, proposition à valider).
`SUPPLIER` : l'identité reste chez Finance (`fin_companies`) ; le module tient le **profil commercial** (conditions, produits, incidents) lié par `finance_company_id`.

### 2.2 Entités (préfixe SQL `proc_`, toutes avec `merchant_id`)
- `items` — catalogue central : SKU, code-barres, nom, `variant_ref` (lien nullable vers `variants`), statut `PROSPECT | ACTIVE | ARCHIVED`. Un produit vu en visite fournisseur existe avant le catalogue Shopify.
- `locations` — emplacements propres à Nordla : `STORE | BACKROOM | WAREHOUSE | TRANSIT | QUARANTINE`. Distincts du miroir Shopify.
- `suppliers` — profil commercial (pays, devise, incoterm par défaut, conditions de paiement, délai).
- `supplier_items` — ce que le fournisseur propose (référence fournisseur, MOQ, délai).
- `quotes` — devis versionnés : paliers `{minQty, unitPriceMinor}`, MOQ, incoterm, validité, statut, provenance par champ. Chaque révision est conservée → **historique des prix négociés**.
- `purchase_orders` + `po_lines` + `po_payment_schedule` (acompte / solde).
- `receipts` + `receipt_lines` (accepté / défectueux).
- `stock_movements` — **registre append-only**, seule source des soldes.
- `events` — journal d'audit append-only (qui, quoi, quand, sur quel objet, avec quelle approbation).

### 2.3 Stock : tout est dérivé du registre
Types de mouvement : `RECEIPT`, `ADJUSTMENT` (justification obligatoire + approbation), `TRANSFER_OUT/TRANSFER_IN` (paire atomique), `DEFECT_QUARANTINE`, `RESERVE/RELEASE`, `COUNT_ADJUST` (écart d'inventaire).
Soldes par `(item, emplacement)` calculés depuis le registre, jamais saisis :
- **physique** = somme des emplacements `STORE/BACKROOM/WAREHOUSE/QUARANTINE`
- **disponible à la vente** = emplacements vendables − réservé (jamais négatif)
- **en transit** = emplacement `TRANSIT`
- **entrant** = quantité commandée non reçue sur les bons de commande `ORDERED/CONFIRMED/PARTIALLY_RECEIVED` (dérivé, ne compte **jamais** comme disponible)
- **valorisation** = coût unitaire du dernier lot reçu confirmé, présenté avec son statut (`CONFIRMED | ESTIMATED | UNKNOWN`) ; moyenne pondérée sur réceptions confirmées. Un coût inconnu reste `UNKNOWN`, jamais 0.
Invariants : solde jamais négatif (refus `INSUFFICIENT_STOCK`), quantités entières strictement positives, chaque mouvement a une clé d'idempotence unique par marchand, aucun mouvement n'est modifié ni supprimé.

### 2.4 Achats : machine à états explicite
`DRAFT → PENDING_APPROVAL → APPROVED → ORDERED → CONFIRMED? → PARTIALLY_RECEIVED → RECEIVED → CLOSED`, plus `CANCELLED` (avant toute réception) et `CLOSED` « short » (reliquat abandonné, motif obligatoire). Le retard est un **indicateur dérivé** (date attendue dépassée), pas un état.
Validations avant tout engagement : `APPROVED` exige `BUYING.approve_purchase_plan` ; `ORDERED` exige `BUYING.place_order` — approbations humaines nommées, sujet = ce bon de commande. **Le module n'envoie rien au fournisseur et ne paie rien** : `ORDERED` consigne qu'un humain a passé la commande ; les acomptes sont un échéancier lié à un `payment_ref` Finance (`FINANCE.pay_supplier` reste dans Finance).
Réception : exige `STOCK_SALES.receive_goods`. Surlivraison refusée (`OVER_RECEIPT`). Une réception partielle est un cas normal.

### 2.5 Argent
Montants en unités mineures entières, devise ISO, taux explicite `{rate (chaîne décimale), date, source}` jamais présumé. Équivalent EUR uniquement si le taux est fourni, marqué `ESTIMATED`. Aucun montant fiscal présenté comme définitif ; TVA/droits viennent de `analyzePurchase`.

### 2.6 Transactions, idempotence, concurrence
Chaque commande mutante reçoit une `idempotencyKey` ; le magasin garde `(clé → empreinte du payload, résultat)` : même clé + même payload = même résultat sans effet ; même clé + payload différent = `IDEMPOTENCY_KEY_REUSED`. Mises à jour par comparaison de version (`expectedVersion`). Les écritures multi-lignes (réception = mouvements + lignes + statut + journal) sont **atomiques** : `store.transaction()` (retour arrière complet en mémoire ; en SQL, fonction `proc_post_receipt` dans une seule transaction).

### 2.7 Sécurité
Validation stricte des entrées (types, bornes, énumérations), `merchant_id` obligatoire sur chaque lecture/écriture, rôles d'acteur (`OWNER | BUYER | WAREHOUSE | VIEWER`), RLS activé sans politique (accès service uniquement, comme `fin_*`). Aucune donnée de production dans les tests (magasin mémoire + base jetable).

### 2.8 Contrat d'intégration Finance / Parle à Nordla
`src/procurement/assistant.js` n'expose que des **lectures** (`supplierBestLandedCost`, `inTransit`, `plannedMargin`, `openPurchaseOrders`, `stockPosition`) et des **propositions** (`proposePurchaseOrder`, `proposeAdjustment`) qui renvoient `{executed:false, requires_approval:<action>}`. L'outil est construit sans accès aux commandes d'écriture ; une demande ambiguë produit une proposition ou `NEED_CLARIFICATION`, jamais un effet. Ne modifie rien du chantier A.

## 3. Première tranche verticale (étape C)
Fournisseur → article → devis → bon de commande (approuvé puis commandé par des humains nommés) → réception partielle puis solde → mouvements de stock → soldes. Tests unitaires, intégration, invariants (propriétés aléatoires), idempotence, retour arrière, tenants.

## 4. Persistance
`supabase/migrations/20261016090000_procurement_stock.sql` (**NON APPLIQUÉE** : jamais exécutée sur une base réelle) + `supabase/rollback/…down.sql`. Prouvée sur une base PostgreSQL 17 **jetable** : `node test/postgres/procurement.pg-smoke.mjs` (50 vérifications). L'adaptateur `supabase-store` n'est pas écrit : voir le bilan.

## 5. Compatibilité Node
Pas d'import de `src/sourcing` (exige Node 24). Code ESM sans dépendance, API standard uniquement. Exécuté sur **Node 24.19 et Node 20.20.2** (image Docker `node:20`) : 37/37 sur les deux.

## 6. Mobile / connexions instables
Aucune promesse hors-ligne. Le module garantit seulement ce qui est testable côté serveur : toute commande est idempotente (rejouer après coupure est sans danger) et les conflits de version sont explicites. L'interface smartphone d'achat n'est pas construite ici ; la PWA Sourcing existante couvre la visite fournisseur.

## 7. Décisions à valider (hors périmètre autonome)
1. Ajouter ce module à `src/integration/module-map.js` / `ownership.js` (fichiers partagés, nécessaires pour le routage Parle à Nordla).
2. Retirer le plan d'achat en mémoire de `integration/index.js` au profit de ce module.
3. Appliquer la migration sur une base réelle (staging d'abord).
4. Politique de coût de valorisation (dernier lot vs moyenne pondérée) — par défaut moyenne pondérée sur réceptions confirmées.
5. Lien `fin_supplier_invoices.order_reference` ↔ numéro de bon de commande (rapprochement 3 voies).
