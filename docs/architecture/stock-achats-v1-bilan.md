# Chantier C — Stock / Achats / Fournisseurs : bilan de la session autonome (2026-10-16)

Branche `feature/stock-achat-v1` (base `integration/nordla-pre-china` @ f7197d5). Worktree : `retail-ai-core-stock-achat-wt`.
Audit + architecture : [stock-achats-v1.md](stock-achats-v1.md). Ce document rend compte de ce qui est **réellement** fait et prouvé.

## 1. Ce qui a été construit (`src/procurement/`)
| Fichier | Rôle |
|---|---|
| `service.js` | 24 commandes d'écriture : catalogue, emplacements, fournisseurs, devis, bons de commande (machine à états), réception, ajustement, transfert, quarantaine, inventaire, réservation, incidents, documents fournisseur |
| `queries.js` | Lectures dérivées : positions de stock, entrant, transit, retards, alertes de réapprovisionnement, historique de prix, fiabilité tracée, comparaison de fournisseurs (moteur Finance), marge prévue, prix cible, documents expirants |
| `stock.js` | Règles pures du registre : soldes dérivés, invariants, valorisation |
| `memory-store.js` | Magasin de référence (contraintes d'unicité, versions, registre append-only, approbations à usage unique, transaction avec retour arrière) |
| `assistant.js` | Contrat d'outils pour « Parle à Nordla » : 14 lectures + 2 propositions, **aucun** outil d'exécution |
| `supabase/migrations/20261016090000_procurement_stock.sql` + rollback | 16 tables `proc_*`, **non appliquée** à une base réelle |

## 2. Preuves (exécutées, pas supposées)
| Vérification | Résultat |
|---|---|
| Suites `test/procurement-*.test.js` (5 fichiers, 37 tests) sous **Node 24.19** | 37/37 |
| Mêmes suites sous **Node 20.20.2** (image Docker `node:20`) | 37/37 |
| Suites voisines : `integration-contracts`, `integration-workflows`, `buying`, `finance-stock` + procurement (136 tests, Node 24) | 136/136 |
| Test SQL sur **PostgreSQL 17 réel jetable** (`test/postgres/procurement.pg-smoke.mjs`) : migration, rollback, ré-application, RLS, solde jamais négatif, réservé ≤ physique, registre immuable (UPDATE/DELETE/TRUNCATE), clés d'idempotence, clés composites par marchand, transitions de BC, course à 2 sessions (un seul gagnant), numéros de BC simultanés distincts | 50/50 |
| Balayage de mutations manuel (27 mutations ciblées : contrôle de sur-réception, approbation non consommée, invariant de stock, empreinte d'idempotence, rôles, MOQ, périmètre marchand, etc.) | tous tués après ajout de 3 tests ; 0 survivant non équivalent |
| Test d'invariants aléatoires (graine fixe, 400 opérations valides et invalides) | 0 violation |

Défauts réels trouvés **par ces tests** et corrigés : (1) `postMovement` vérifiait les invariants avant d'appliquer le bucket par défaut → les sorties de stock passaient sans contrôle ; (2) le trigger SQL en `INSERT … ON CONFLICT DO UPDATE` refusait des réservations légitimes (contraintes évaluées sur la ligne proposée) → remplacé par création à zéro + `UPDATE` verrouillé.

Non exécuté : la **suite complète du dépôt** (386 fichiers, plusieurs heures) — la CI d'intégration s'en charge ; seules les suites voisines ci-dessus ont été lancées.

## 3. Invariants garantis
- Le registre de mouvements est la seule source des soldes ; il est append-only (code **et** base).
- Aucun solde négatif ; réservé ≤ physique ; l'entrant n'est jamais disponible ; une unité en transit n'est pas vendable.
- Toute commande est idempotente (clé + empreinte) et atomique (tout ou rien, approbation non brûlée en cas d'échec).
- Une approbation humaine nommée, portant l'action et le sujet, est exigée pour : approuver un BC, passer commande, réceptionner, ajuster le stock, valider un inventaire avec écart. Chaque approbation est à **usage unique**.
- Le module n'envoie rien au fournisseur, ne paie rien, n'écrit pas dans Shopify (`STOCK_SALES.write_shopify` reste BLOQUÉ).
- Coût inconnu = `UNKNOWN`, jamais 0. Taux de change toujours explicite, daté, sourcé. Montants en entiers, prix en micro-unités.
- Fiabilité fournisseur : ratios avec numérateur, dénominateur et identifiants ; `NOT_MEASURABLE` sous 3 réceptions ; pas de score composite.
- Comparaison fournisseurs : classe sur le **coût rendu** (moteur Finance) si les coûts sont fournis, sinon sur le prix marchandises en le disant ; ne sélectionne ni ne commande jamais.

## 4. Limites connues (honnêtes)
1. **Pas d'adaptateur Supabase** : le module tourne sur le magasin mémoire. Le schéma SQL est prouvé mais aucun code ne l'utilise encore. C'est le prochain chantier technique.
2. **Rôles passés par l'appelant** (`actor.role`) : non branchés sur le module Identity.
3. **Valorisation** = moyenne pondérée de toutes les réceptions (pas FIFO/lots) ; `ESTIMATED` = prix marchandises seul, sans transport ni douane. Un coût confirmé s'obtient en passant `landedUnitCostEurMicro` à la réception ; pas d'allocation automatique des factures de transport/douane.
4. **Pas de demande d'achat ni de RFQ comme entités** : un BC en `DRAFT` en tient lieu ; la consultation de plusieurs fournisseurs passe par les devis + `compareSuppliers`.
5. **Pas de rapprochement 3 voies** avec `fin_supplier_invoices` (le lien `order_reference` ↔ numéro de BC reste à faire).
6. **Pas de synchronisation / réconciliation Shopify** (volontairement bloquée par la politique).
7. **Pas d'interface smartphone** ni de mode hors-ligne : seul l'ensemble idempotent/versionné côté serveur est livré ; le rejeu après coupure est sûr, c'est tout ce qui est affirmé.
8. **Photos / documents = références** (chemin, hash), aucun fichier stocké.
9. **Perf** : la transaction mémoire copie l'état entier (O(n)) ; sans importance en test, à ne pas reproduire en SQL.
10. **Branchement dans `src/integration`** (module-map, ownership, hub, routeur) non fait : fichiers partagés, décision demandée (voir §6).
11. **Le texte chinois / la voix** ne concernent pas ce module.

## 5. Risques et blocages
- Docker Desktop a été très lent par moments (>30 s par commande) ; aucun impact sur les résultats mais les tests SQL peuvent être lents en local.
- La migration `20260926160000` (Finance, « NOT APPLIED ») : l'état réel en base n'a pas été vérifié ; ce module n'en dépend pas.
- Le doublon de moteurs de coût rendu (`DUP-LANDED-COST`) reste ouvert côté Finance/Sourcing ; ce module consomme Finance et n'en ajoute pas.
- `src/sourcing` exige Node 24 : ce module ne l'importe pas, et l'échange passe par `integration/handoffs.js` (BUY_CANDIDATE → plan d'achat), pas encore relié à la création d'un BC persistant.

## 6. Décisions demandées au propriétaire
1. Autoriser le branchement dans `src/integration` (module-map, ownership, hub) et le remplacement du plan d'achat en mémoire.
2. Autoriser l'écriture de l'adaptateur Supabase et l'application de la migration sur un **staging** (jamais directement en production).
3. Choix de valorisation (moyenne pondérée actuelle vs FIFO).
4. Qui peut approuver : seuls `OWNER` / `AUTHORIZED_REVIEWER` (règle déjà en place) — confirmer que cela convient à HABB.

## 7. Plan de continuation avant le voyage en Chine (priorisé)
1. **Adaptateur Supabase + test d'équivalence avec le magasin mémoire** (mêmes scénarios sur les deux) — REQUIS pour toute donnée durable.
2. **Pont Sourcing → module** : transformer un `BUY_CANDIDATE` approuvé en article PROSPECT + devis + BC brouillon (via `integration/handoffs.js`), idempotent — REQUIS pour que la visite fournisseur alimente les achats.
3. **Écran smartphone minimal** de saisie de visite (article, photo, devis, quantités), s'appuyant sur la PWA Sourcing — RECOMMANDÉ ; tester sur le vrai téléphone avant d'affirmer quoi que ce soit hors-ligne.
4. Branchement `src/integration` + routage « Parle à Nordla » vers `assistant.js` — RECOMMANDÉ.
5. Rapprochement 3 voies avec les factures fournisseur et allocation des frais d'approche pour confirmer le coût rendu — PLUS TARD (après le voyage si besoin).
6. Rapport de réconciliation Shopify en lecture seule — PLUS TARD.
