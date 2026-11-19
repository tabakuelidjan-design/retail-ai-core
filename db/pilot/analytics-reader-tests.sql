-- Phase 3 PILOT tests - run as the REAL login role analytics_reader (no SET ROLE, not a superuser), on a disposable database only.
-- The results are recorded in a temporary table and compared at the end.
create temp table r (name text, expected text, actual text);

-- P1 : the connection is a real non-privileged login role
select rolsuper::text as p1a, rolbypassrls::text as p1b, rolcreatedb::text as p1c from pg_roles where rolname = current_user \gset
select ((select tableowner from pg_tables where schemaname = 'analytics_pilot' and tablename = 'sync_runs') = current_user)::text as p1d \gset
insert into r values ('P1 connexion = analytics_reader', 'analytics_reader', current_user),
  ('P1 superutilisateur', 'false', :'p1a'), ('P1 contourne RLS (BYPASSRLS)', 'false', :'p1b'), ('P1 pouvoir de créer des bases', 'false', :'p1c'),
  ('P1 propriétaire de la table sync_runs', 'false', :'p1d');

-- P2 : no merchant in context -> nothing visible
select count(*) as p2a from analytics_pilot.merchants \gset
select count(*) as p2b from analytics_pilot.merchant_connectors \gset
select count(*) as p2c from analytics_pilot.sync_runs \gset
insert into r values ('P2 sans contexte : merchants', '0', :'p2a'), ('P2 sans contexte : merchant_connectors', '0', :'p2b'), ('P2 sans contexte : sync_runs', '0', :'p2c');

-- P3 : merchant A in context (one transaction)
begin;
select set_config('app.merchant_id', 'aaaaaaaa-0000-4000-8000-00000000000a', true) \gset
select count(*) as p3a from analytics_pilot.merchants \gset
select count(*) as p3b from analytics_pilot.merchant_connectors \gset
select count(*) as p3c from analytics_pilot.sync_runs \gset
select count(*) as p3d from analytics_pilot.sync_runs where status = 'FAILED' \gset
commit;
insert into r values ('P3 contexte A : merchants', '1', :'p3a'), ('P3 contexte A : connecteurs de ventes', '0', :'p3b'), ('P3 contexte A : sync_runs', '1', :'p3c'), ('P3 contexte A : sync FAILED de B invisible', '0', :'p3d');

-- P4 : merchant B in context (next transaction, same connection) sees B's connector and failed sync, not A's
begin;
select set_config('app.merchant_id', 'bbbbbbbb-0000-4000-8000-00000000000b', true) \gset
select count(*) as p4a from analytics_pilot.merchant_connectors \gset
select count(*) as p4b from analytics_pilot.sync_runs where status = 'SUCCESS' \gset
commit;
insert into r values ('P4 contexte B : connecteur shopify visible', '1', :'p4a'), ('P4 contexte B : sync OK de A invisible', '0', :'p4b');

-- P5 : cross read by explicit filter (A in context asks for B's sync rows)
begin;
select set_config('app.merchant_id', 'aaaaaaaa-0000-4000-8000-00000000000a', true) \gset
select count(*) as p5a from analytics_pilot.sync_runs where merchant_id = 'bbbbbbbb-0000-4000-8000-00000000000b' \gset
commit;
insert into r values ('P5 lecture croisée par filtre explicite', '0', :'p5a');

-- P6 : the reader cannot write at all (no privilege, so refused before the policy). One transaction, so the result survives the block.
begin;
do $$ begin
  insert into analytics_pilot.sync_runs (merchant_id, status) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'X');
  perform set_config('analytics_pilot.p6', 'ÉCRITURE ACCEPTÉE', true);
exception when insufficient_privilege then
  perform set_config('analytics_pilot.p6', 'refusée', true);
end $$;
select coalesce(nullif(current_setting('analytics_pilot.p6', true), ''), 'NON-REFUSÉE') as p6a \gset
commit;
insert into r values ('P6 écriture sync_runs par le lecteur', 'refusée', :'p6a');
select has_table_privilege('analytics_reader', 'analytics_pilot.sync_runs', 'INSERT')::text as p6b,
       has_table_privilege('analytics_reader', 'analytics_pilot.merchants', 'UPDATE')::text as p6c \gset
insert into r values ('P6 privilège INSERT sur sync_runs', 'false', :'p6b'), ('P6 privilège UPDATE sur merchants', 'false', :'p6c');

-- P7 : rollback leaves no trace; the next transaction sees no merchant until it sets one
begin;
select set_config('app.merchant_id', 'aaaaaaaa-0000-4000-8000-00000000000a', true) \gset
select count(*) as p7a from analytics_pilot.sync_runs \gset
rollback;
select count(*) as p7b from analytics_pilot.sync_runs \gset
insert into r values ('P7 après rollback : sans contexte, aucune ligne', '0', :'p7b');

-- P8 : connection reuse - each transaction sets its own merchant; nothing carries over from the previous one
begin;
select set_config('app.merchant_id', 'bbbbbbbb-0000-4000-8000-00000000000b', true) \gset
commit;
begin;
select count(*) as p8a from analytics_pilot.sync_runs \gset
commit;
begin;
select set_config('app.merchant_id', 'aaaaaaaa-0000-4000-8000-00000000000a', true) \gset
select count(*) as p8b from analytics_pilot.sync_runs \gset
commit;
insert into r values ('P8 transaction suivante sans contexte : sync_runs', '0', :'p8a'), ('P8 transaction A après B : sync_runs', '1', :'p8b');

-- Summary
select name, expected, actual, case when expected = actual then 'OK' else 'ÉCHEC' end as resultat from r order by name;
select count(*) filter (where expected = actual) as conformes, count(*) as total from r;
