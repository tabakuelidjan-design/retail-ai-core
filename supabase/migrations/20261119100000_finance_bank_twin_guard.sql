-- Finance bank: SQL guard against unresolved identical movements ("jumeaux"), option B.
-- Mirrors bank-service.js assertNoUnresolvedTwin and bank-identity.js movementKey / reliable references, so a direct database call
-- cannot confirm a second identical movement that the service would refuse.
--  * Scope: the file pseudo-account 'csv-import' only (the service scope). Provider accounts keep their own rules.
--  * A twin is another transaction of the same merchant and account with the same date, signed amount, currency, normalised reference
--    and normalised counterparty, UNLESS both carry a reliable bank reference and those references differ (two real movements).
--  * A twin blocks while it is not set aside (derived status IGNORED). Setting one aside is the existing 'ignore' action.
--  * Enforced on every reconciliation row that books money IN (kind MATCH, amount > 0): reconcile, reconcile-and-pay, any future path.
--    Unreconcile rows and IGNORE rows are not blocked (they release or set aside).
--  * Concurrency: an advisory lock on the movement identity serialises two reconciliations of identical movements; the check runs after
--    the lock, so the second one sees the first one committed.
-- No column is added, no existing row is changed, no constraint forbids two genuinely distinct movements.
-- Normalisation: upper case, Latin accents removed (common Western European letters), other characters become spaces, trimmed.
-- Characters outside that Latin set are not folded in SQL: the service folds them with Unicode NFD. Known, documented difference.

-- Same explicit rule as bank-identity.js norm(): NFD, drop combining marks, every other non-ASCII character becomes a space (no Unicode
-- case folding), ASCII upper case, runs of non [A-Z0-9] become one space, trimmed.
create or replace function fin_bank_norm(p text) returns text language sql immutable as $$
  select btrim(regexp_replace(
           upper(regexp_replace(regexp_replace(normalize(coalesce(p, ''), NFD), '[̀-ͯ]', '', 'g'), '[^ -~]', ' ', 'g')),
           '[^A-Z0-9]+', ' ', 'g'))
$$;

create or replace function fin_bank_twin_guard() returns trigger language plpgsql as $$
declare tx fin_bank_transactions%rowtype; tw fin_bank_transactions%rowtype;
begin
  select * into tx from fin_bank_transactions where id = new.bank_transaction_id and merchant_id = new.merchant_id;
  if not found or tx.account_id <> 'csv-import' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('fin_bank_twin:' || tx.merchant_id::text || ':' || tx.date::text || ':' || tx.amount_cents::text || ':' || tx.currency, 0));
  select * into tw from fin_bank_transactions t
   where t.merchant_id = tx.merchant_id and t.account_id = tx.account_id and t.id <> tx.id
     and t.date = tx.date and t.amount_cents = tx.amount_cents and t.currency = tx.currency
     and fin_bank_norm(t.reference) = fin_bank_norm(tx.reference)
     and fin_bank_norm(t.counterparty_name) = fin_bank_norm(tx.counterparty_name)
     and not (t.bank_reference is not null and tx.bank_reference is not null and t.bank_reference <> tx.bank_reference)
     and coalesce(fin_bank_tx_amounts(t.merchant_id, t.id) ->> 'status', 'UNRECONCILED') <> 'IGNORED'
   limit 1;
  if found then
    raise exception 'FIN_BANK_POSSIBLE_DUPLICATE: identical movement % is unresolved: set one of them aside (IGNORED) first', tw.provider_tx_id;
  end if;
  return new;
end $$;

drop trigger if exists fin_bank_twin_guard_trg on fin_bank_reconciliations;
create trigger fin_bank_twin_guard_trg before insert on fin_bank_reconciliations
  for each row when (new.kind = 'MATCH' and new.amount_cents > 0) execute function fin_bank_twin_guard();

revoke all on function fin_bank_norm(text) from public, anon, authenticated;
revoke all on function fin_bank_twin_guard() from public, anon, authenticated;
