-- Security hardening (2026-11-20): remove EXECUTE from PUBLIC, anon and authenticated on the three
-- non-trigger public.fin_* functions that were callable by signed-in or anonymous API users:
-- fin_issue_document (numbered, locked document issuance), fin_next_number (invoice numbering) and
-- fin_payable_cents (amount helper). The Finance server calls every fin_* RPC with the service_role key
-- (src/supabase/client.js), which keeps EXECUTE, so Finance behaviour is unchanged.
-- Trigger functions are not changed: they are not reachable through the API (return type trigger).
-- Rollback: supabase/rollback/20261120085527_fin_function_execute_scope.down.sql
begin;

revoke execute on function public.fin_issue_document(uuid, uuid, integer, text, text, integer, text, integer, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke execute on function public.fin_next_number(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.fin_payable_cents(public.fin_documents) from public, anon, authenticated;

commit;
