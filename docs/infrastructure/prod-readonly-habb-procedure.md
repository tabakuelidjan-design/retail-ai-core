# Accès en lecture seule aux données réelles HABB (Supabase PRODUCTION) — procédure PRÉPARÉE, NON EXÉCUTÉE

Statut : **en attente de votre autorisation distincte** (création d'un rôle et de 3 vues en production = changement de production).
Projet : `xbtzjabbseclmqfozjeo`. Marchand : `NORDLA_MERCHANT_ID` de HABB (`36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5`).

## 1. Pourquoi aucune lecture n'a été faite (15 octobre)

Vérification des permissions effectives du connecteur Supabase disponible dans la session (une seule requête de métadonnées, aucune
table métier lue) :

| Contrôle | Résultat | Conforme à votre autorisation ? |
|---|---|---|
| rôle utilisé | `postgres` | non |
| contourne la RLS (`rolbypassrls`) | oui | non |
| peut créer des rôles / objets | oui / oui | non |
| transaction en lecture seule | non | non |

Conditions 1 et 3 non remplies → **arrêt à la préparation de l'accès**, comme demandé.

## 2. Ce qui serait créé (après votre accord)

Un rôle de connexion **sans aucun droit d'écriture** et trois **vues** limitées à HABB, sans données personnelles ni bancaires sensibles.
Les vues donnent des lignes minimales ; les totaux sont calculés par le **code officiel** Finance / Analytics (pas par une seconde
définition SQL), puis seuls les **agrégats** sortent du traitement.

| Vue | Colonnes exposées | Exclu volontairement |
|---|---|---|
| `nordla_ro.habb_supplier_invoices` | id (opaque), statut, type de document, devise, montant TTC, dates d'émission et d'échéance, montant déjà affecté aux paiements | nom et TVA du fournisseur, n° de facture, pièce jointe, notes |
| `nordla_ro.habb_bank_balances` | devise, solde, date du solde, nombre de comptes (agrégé par devise) | IBAN, identifiant de compte, transactions et contreparties |
| `nordla_ro.habb_sales_lines` | jour (Europe/Brussels), canal, devise, quantité, prix unitaire, remise, taxe, remboursements de la ligne, titre produit | client (`customer_key`), adresse, n° de commande, commandes de test |

```sql
-- À exécuter UNIQUEMENT après accord, dans l'éditeur SQL Supabase (production), en une transaction.
begin;
create schema nordla_ro;
revoke all on schema nordla_ro from public;

create view nordla_ro.habb_supplier_invoices with (security_barrier) as
  select encode(digest(i.id::text, 'sha256'), 'hex') as ref, i.status, i.document_type, i.currency, i.gross_cents, i.issue_date, i.due_date,
         coalesce((select sum(a.amount_cents) from fin_payment_allocations a where a.supplier_invoice_id = i.id and a.merchant_id = i.merchant_id), 0) as allocated_cents
  from fin_supplier_invoices i where i.merchant_id = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5';

create view nordla_ro.habb_bank_balances with (security_barrier) as
  select currency, sum(balance_cents) as balance_cents, max(as_of) as as_of, count(*) as accounts
  from fin_bank_balances where merchant_id = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5' group by currency;

create view nordla_ro.habb_sales_lines with (security_barrier) as
  select (o.ordered_at at time zone 'Europe/Brussels')::date as day, coalesce(o.channel_name, o.source_name, 'inconnu') as channel, o.currency, o.status,
         l.title_snapshot as product, l.quantity, l.unit_price, l.discount_amount, l.tax_amount,
         coalesce((select sum(rl.amount) from refund_lines rl where rl.order_line_id = l.id), 0) as refunded_amount
  from orders o join order_lines l on l.order_id = o.id
  where o.merchant_id = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5' and o.is_test = false;

-- Le mot de passe n'est JAMAIS écrit ici ni dans le chat : remplacez <MOT_DE_PASSE> dans l'éditeur, puis effacez-le.
create role nordla_ro_habb login password '<MOT_DE_PASSE>' noinherit nocreatedb nocreaterole nobypassrls connection limit 2 valid until '2026-10-31';
alter role nordla_ro_habb set default_transaction_read_only = on;
alter role nordla_ro_habb set statement_timeout = '15s';
grant usage on schema nordla_ro to nordla_ro_habb;
grant select on nordla_ro.habb_supplier_invoices, nordla_ro.habb_bank_balances, nordla_ro.habb_sales_lines to nordla_ro_habb;
commit;
```

`default_transaction_read_only` n'est qu'une protection de plus (une session peut la désactiver) : **la garantie réelle est l'absence
de privilège d'écriture**, vérifiée au point 3.

## 3. Vérification des permissions effectives AVANT toute lecture (bloquante)

Exécutée en se connectant **avec le rôle `nordla_ro_habb`**. Chaque ligne doit donner le résultat attendu, sinon arrêt :

```sql
select current_user = 'nordla_ro_habb' as is_ro_role,
  not (select rolbypassrls or rolsuper or rolcreaterole or rolcreatedb from pg_roles where rolname = current_user) as no_power,
  (select count(*) from information_schema.table_privileges where grantee in (current_user, 'PUBLIC') and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')) = 0 as no_write_grant,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','v','m','p') and n.nspname not in ('pg_catalog','information_schema')
     and has_table_privilege(c.oid, 'SELECT')) = 3 as reads_only_the_3_views,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.prosecdef and n.nspname not in ('pg_catalog','information_schema')
     and has_function_privilege(p.oid, 'EXECUTE')) as secdef_functions_executable; -- attendu : 0
```

Si `secdef_functions_executable` > 0 (fonctions `SECURITY DEFINER` exécutables par `PUBLIC`), le rôle pourrait écrire à travers
elles : **arrêt**, et je vous présente la liste et le `revoke execute ... from public` correspondant, pour une autorisation séparée.

## 4. Canal de lecture

La session n'a pas d'accès PostgreSQL direct. Canal prévu, sur le modèle du canal staging : un workflow GitHub Actions dans un
environnement protégé `supabase-prod-readonly` (relecteur obligatoire : vous), secret `PROD_RO_DATABASE_URL` (Session pooler,
utilisateur `nordla_ro_habb.xbtzjabbseclmqfozjeo`), `run: false` par défaut. Il exécute la vérification du point 3, lit les 3 vues,
fait calculer les totaux par le code Finance / Analytics existant, et ne publie que les agrégats (pas de lignes, pas de titres
produit). **Pas encore codé** : prochaine étape après votre accord sur les points 2 et 3.

## 5. Révocation (à tout moment, sans effet sur les données)

```sql
revoke all on all tables in schema nordla_ro from nordla_ro_habb; revoke usage on schema nordla_ro from nordla_ro_habb;
drop role nordla_ro_habb; drop schema nordla_ro cascade; -- ne supprime que les 3 vues : aucune table métier
```
Le rôle expire de lui-même le 31 octobre 2026.

## 6. Risques

- Lecture de chiffres d'affaires et de dettes fournisseurs réels : confidentiels, jamais copiés dans le dépôt ni dans les rapports
  autrement qu'en totaux.
- `digest()` requiert l'extension `pgcrypto` (présente sur Supabase, schéma `extensions` : préfixer `extensions.digest` si besoin).
- Les vues supposent les migrations du dépôt appliquées en production ; si une colonne manque, la création échoue et **rien n'est
  créé** (transaction unique).
