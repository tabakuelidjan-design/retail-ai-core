-- Rollback of 20261120110000_fin_issuer_narrow_role.sql. Removes only what the pilot created.
-- RLS enablement on the three tables is kept (it is already on in the hosted project; disabling it would widen access).
begin;

drop policy if exists nordla_fin_pilot_events on public.fin_events;
drop policy if exists nordla_fin_pilot_sequences on public.fin_number_sequences;
drop policy if exists nordla_fin_pilot_documents on public.fin_documents;

revoke execute on function extensions.digest(text, text) from nordla_fin_issuer_pilot;
revoke execute on function public.fin_next_number(uuid, text, integer) from nordla_fin_issuer_pilot;
revoke execute on function public.fin_issue_document(uuid, uuid, integer, text, text, integer, text, integer, text, text, timestamptz, jsonb) from nordla_fin_issuer_pilot;
revoke insert on public.fin_events from nordla_fin_issuer_pilot;
revoke select, insert, update on public.fin_number_sequences from nordla_fin_issuer_pilot;
revoke select, update on public.fin_documents from nordla_fin_issuer_pilot;
revoke usage on schema extensions from nordla_fin_issuer_pilot;
revoke usage on schema public from nordla_fin_issuer_pilot;

revoke execute on function public.nordla_fin_pilot_merchant() from nordla_fin_issuer_pilot;
drop function if exists public.nordla_fin_pilot_merchant();

-- Role drop: the role is cluster-wide. DROP ROLE fails while any database in the cluster still holds its grants
-- (for example a template database). Run this statement only after the same rollback has been applied to every database
-- that received the migration, and after removing any login membership.
drop role if exists nordla_fin_issuer_pilot;

commit;
