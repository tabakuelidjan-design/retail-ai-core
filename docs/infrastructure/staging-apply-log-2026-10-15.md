# Supabase STAGING (`fvhiammdskpcnfodsnrc`, nordla-finance-staging, PostgreSQL 17.6) — journal d'application du 2026-10-15

Autorisation du propriétaire : migrations d'identité, marchand HABB de test, bucket `nordla-backups` — staging uniquement.

## État avant (instantané, lecture seule)
- 23 migrations (dernière `product_image`) ; 27 tables `public`, toutes RLS, 0 policy ; 8 fonctions `public` ; 0 compte Auth ;
  1 bucket (`finance-inbox`, privé) ; empreinte de schéma `7679cc37764d3203a0c4cc43cbbb64c9` (451 objets).
- Données (nombre de lignes : début du md5 du contenu trié) : data_quality_flags=0 fin_bank_balances=0 fin_bank_connections=0
  fin_bank_transactions=420:c4bf019147d2 fin_cash_counts=1:7898ac2330c1 fin_cash_movements=12:0d6cf5a7d3df fin_companies=0
  fin_documents=66:dd661d09e68f fin_events=278:c11de6bdc1ce fin_number_sequences=4:11b697816590 fin_payments=40:cb546808605f
  fin_stock_movements=0 fin_supplier_invoices=320:6f735dcf7f61 inventory_snapshots=2034:80acf3368b23 locations=1:9ee19e9335c8
  merchant_connectors=1:240e82e143ab merchants=1:5b6e22ffd5c2 order_attribution=0 order_lines=110:aa9ebb816a3d orders=90:b862faae4f4a
  product_collections=0 product_costs=294:338d5d80eeb3 products=175:d5dd8eadbc4d refund_lines=5:72d756e5c980 refunds=5:57ed6f642677
  sync_runs=2:6a80364a7f4e variants=339:84dbabe5e14f
- Pas de sauvegarde restaurable prise depuis cette session (aucun accès `pg_dump` à la base) : l'instantané prouve l'absence de
  modification ; le retour arrière des objets ajoutés est `supabase/rollback/2026-10-sourcing-identity.rollback.sql`.

## Appliqué
| # | Migration | Résultat |
|---|---|---|
| 1 | `identity_sessions_events` (version `20261015114757`) | **appliquée**. Vérifiée : 2 tables, RLS, anon/authenticated sans accès, service_role sans DELETE sur le journal ; corps des 2 fonctions identiques au fichier du dépôt (md5 `c589cd14…`, `19694e22…`). Commentaires d'en-tête omis, instructions identiques. |
| 2 | `identity_rate_limits` | **NON appliquée** : deux tentatives, l'outil Supabase a expiré après 60 s ; la requête n'a atteint ni la base ni ses journaux ; aucun objet partiel (transaction atomique), aucun verrou. |
| 3–5 | `identity_members`, `identity_modules_sessions`, `identity_module_sourcing` | non tentées (arrêt sur anomalie). |

Marchand HABB de test et bucket : **non exécutés** (arrêt sur anomalie, en attente de la décision du propriétaire).

## État après
- Données existantes : identiques à l'instantané (vérifié). Tables d'identité : 0 ligne.
- Retour arrière possible à tout moment : le fichier de retour arrière supprime aussi bien la seule migration 1 (`drop … if exists`).
