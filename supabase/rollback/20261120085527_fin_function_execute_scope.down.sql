-- Rollback of 20261120085527_fin_function_execute_scope.sql: restores the previous EXECUTE grants
-- (PUBLIC, anon and authenticated) on the three functions. Use only to recover an integration that
-- calls these functions with a user key; the Finance server does not need it.
begin;

grant execute on function public.fin_issue_document(uuid, uuid, integer, text, text, integer, text, integer, text, text, timestamptz, jsonb) to public, anon, authenticated;
grant execute on function public.fin_next_number(uuid, text, integer) to public, anon, authenticated;
grant execute on function public.fin_payable_cents(public.fin_documents) to public, anon, authenticated;

commit;
