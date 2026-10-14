# Migrations prepared, NOT applied (Nordla Core P0)

These files are deliberately **outside** `supabase/migrations/`, so `supabase db push` and the CI bench do not pick them up.
They wait for the owner's explicit authorization ("Autoriser l'application des migrations").

| File | What it does |
|---|---|
| `20261015090000_integration_objects_and_sourcing_cases.sql` | Tables for BUY_CANDIDATE, PurchasePlan, IncomingExpectation, CampaignContract, TrackingDefinition, the trace ledger (append-only, hash-chained per merchant) and the China Sourcing cases (`merchant_id`, optimistic revision). Service role only. |
| `20261015091000_rls_explicit_policies.sql` | Explicit RESTRICTIVE policies on every RLS table: anon denied, authenticated bounded to its ACTIVE merchants (`nordla_is_active_member`). Opens nothing: there is still no permissive policy. |
| `20261015092000_fin_functions_fixed_search_path.sql` | Fixed `search_path = public, extensions, pg_temp` on every `fin_*` function that has none (33 in the repository's migrations, 6 seen on the live project). |

## Verified (throw-away PostgreSQL 16, Supabase roles stubbed)

All `supabase/migrations/*.sql` then these three files apply in order, one transaction each; afterwards 0 public table without RLS, 0 RLS table
without a policy, 0 `fin_*` function without a search_path. Behaviour: `node test/postgres/core-p0-pending.pg-smoke.mjs` (33 checks, see the file).
Not yet run: the Finance PostgreSQL 17 bench (`test/pg`, needs Docker) with these files in place.

## How to apply, once authorized

1. Back up the project (Supabase dashboard backup or `pg_dump`), and note the restore command.
2. Move the three files into `supabase/migrations/` (keep the names, keep the order) on a branch; let `finance-pg` run on the pull request.
3. Apply to a Supabase **branch / staging** project first; run the smoke test against it (`PG_SMOKE_URL`, database name containing `check`/`smoke`).
4. Apply to production; check the advisors (`rls_enabled_no_policy`, `function_search_path_mutable` should be gone).

Rollback: the tables are new (drop them if empty); the policies are named `nordla_*` (drop them); the search_path is a function setting
(`alter function ... reset search_path`).
