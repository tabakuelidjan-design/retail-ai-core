-- FINANCE PAYMENTS CUTOVER (legacy fin_payments + supplier "paid_*" fields  ->  fin_payment_registry + fin_payment_allocations).
-- NOT A MIGRATION: it lives outside supabase/migrations so no tool applies it by itself, and it DEFINES session-local functions only (pg_temp.*): running this file changes
-- nothing and leaves nothing in the catalog. The work happens only when you call the functions, in the SAME session:
--
--   begin;                                    -- DRY RUN: nothing is kept
--   \i supabase/cutover/payments-cutover.sql
--   select pg_temp.cutover_plan();            -- read-only: what would be created, and which legacy rows are anomalies
--   select pg_temp.cutover_backfill();        -- does the work inside this transaction, returns a report
--   select pg_temp.cutover_validate();        -- legacy truth == new truth, row by row
--   rollback;                                 -- (or: commit;  after a clean dry run, a backup, and the owner's explicit go)
--
-- PRECONDITIONS: migrations 20261003090000 and 20261004090000 applied; the application of the NEW code NOT yet switched on (or switched on in SHADOW).
-- MAPPING (every new row keeps its legacy identity in idempotency_key / external_reference, source = 'legacy:*'):
--   fin_payments  amount > 0   -> registry IN  (same date, method [unknown -> 'other'], reference, actor, created_at) + ONE allocation to the same invoice
--   fin_payments  amount < 0   -> a correction: negative allocations reversing the most recent standing allocations of that invoice (LIFO), bounded by what was paid
--   supplier PAID (paid_amount = gross, paid_at set) -> registry OUT + ONE allocation (the invoice keeps status PAID; payment_status is derived)
--   anything that does not fit (overpaid beyond ceilings, PAID without amount, amount != gross, correction larger than paid) is LISTED as an exception and NOT guessed.
-- IDEMPOTENT: re-running creates nothing twice (keys legacy:fin_payments:<id> / legacy:supplier:<id>). The legacy tables are READ ONLY here: never updated, never deleted.
-- The allocation guard is disabled for the duration of the transaction ONLY (legacy invoices are already PAID/CREDITED, so "open for payment" cannot hold) and is re-enabled
-- before the function returns; cutover_validate() then checks every ceiling the guard would have checked.

create or replace function pg_temp.cutover_plan() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'legacy_customer_payments_positive', (select count(*) from fin_payments where amount_cents > 0),
    'legacy_customer_payments_negative', (select count(*) from fin_payments where amount_cents < 0),
    'legacy_customer_documents', (select count(distinct document_id) from fin_payments),
    'customer_payments_already_mapped', (select count(*) from fin_payments p where exists (select 1 from fin_payment_registry r where r.merchant_id = p.merchant_id and r.idempotency_key = 'legacy:fin_payments:' || p.id)),
    'supplier_paid_rows', (select count(*) from fin_supplier_invoices where status = 'PAID'),
    'supplier_paid_consistent', (select count(*) from fin_supplier_invoices where status = 'PAID' and paid_amount_cents = gross_cents and paid_at is not null and currency is not null),
    'supplier_paid_anomalies', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'gross_cents', gross_cents, 'paid_amount_cents', paid_amount_cents, 'paid_at', paid_at, 'currency', currency)) from fin_supplier_invoices
        where status = 'PAID' and not (paid_amount_cents = gross_cents and paid_at is not null and currency is not null)), '[]'::jsonb),
    'supplier_payment_status_not_unpaid_but_not_paid', (select count(*) from fin_supplier_invoices where status <> 'PAID' and (paid_amount_cents is not null or paid_at is not null)),
    'registry_rows_now', (select count(*) from fin_payment_registry), 'allocations_now', (select count(*) from fin_payment_allocations),
    'expected_new_registry_rows', (select count(*) from fin_payments p where p.amount_cents > 0 and not exists (select 1 from fin_payment_registry r where r.merchant_id = p.merchant_id and r.idempotency_key = 'legacy:fin_payments:' || p.id))
      + (select count(*) from fin_supplier_invoices s where s.status = 'PAID' and s.paid_amount_cents = s.gross_cents and s.paid_at is not null and s.currency is not null and not exists (select 1 from fin_payment_registry r where r.merchant_id = s.merchant_id and r.idempotency_key = 'legacy:supplier:' || s.id)));
$$;

create or replace function pg_temp.cutover_backfill() returns jsonb language plpgsql as $$
declare r record; a record; v_pay uuid; need bigint; take bigint; ccy text; k text; m text; n_pay int := 0; n_rev int := 0; n_sup int := 0; skipped int := 0; ex jsonb := '[]'::jsonb;
begin
  alter table fin_payment_allocations disable trigger fin_payment_allocation_guard_trg;
  for r in select * from fin_payments order by created_at, id loop
    k := 'legacy:fin_payments:' || r.id;
    if exists (select 1 from fin_payment_registry where merchant_id = r.merchant_id and idempotency_key = k) or exists (select 1 from fin_payment_allocations where merchant_id = r.merchant_id and idempotency_key like k || ':%') then skipped := skipped + 1; continue; end if;
    select currency into ccy from fin_documents where id = r.document_id and merchant_id = r.merchant_id;
    if ccy is null then ex := ex || jsonb_build_object('legacy_payment', r.id, 'code', 'DOCUMENT_WITHOUT_CURRENCY'); continue; end if;
    m := case when r.method in ('cash', 'bank_transfer', 'card', 'bancontact', 'direct_debit', 'other') then r.method else 'other' end;
    if r.amount_cents > 0 then
      insert into fin_payment_registry (merchant_id, direction, amount_cents, currency, paid_on, method, reference, request_hash, idempotency_key, actor, created_at, source, external_reference)
        values (r.merchant_id, 'IN', r.amount_cents, ccy, r.paid_on, m, r.reference, 'legacy', k, r.actor, r.created_at, 'legacy:fin_payments', r.id::text) returning id into v_pay;
      insert into fin_payment_allocations (merchant_id, payment_id, customer_document_id, amount_cents, currency, idempotency_key, actor, created_at)
        values (r.merchant_id, v_pay, r.document_id, r.amount_cents, ccy, k || ':' || r.document_id, r.actor, r.created_at);
      n_pay := n_pay + 1;
    else
      need := -r.amount_cents;
      for a in select x.id, x.payment_id, x.currency, x.amount_cents + coalesce((select sum(y.amount_cents) from fin_payment_allocations y where y.reverses_allocation_id = x.id), 0) as remaining
               from fin_payment_allocations x where x.customer_document_id = r.document_id and x.merchant_id = r.merchant_id and x.amount_cents > 0 order by x.created_at desc, x.id desc loop
        exit when need <= 0;
        continue when a.remaining <= 0;
        take := least(need, a.remaining);
        insert into fin_payment_allocations (merchant_id, payment_id, customer_document_id, amount_cents, currency, reverses_allocation_id, idempotency_key, reason, actor, created_at)
          values (r.merchant_id, a.payment_id, r.document_id, -take, a.currency, a.id, k || ':' || a.id, coalesce(r.reference, 'legacy correction'), r.actor, r.created_at);
        need := need - take; n_rev := n_rev + 1;
      end loop;
      if need > 0 then ex := ex || jsonb_build_object('legacy_payment', r.id, 'code', 'CORRECTION_EXCEEDS_PAID', 'document', r.document_id, 'uncovered_cents', need); end if;
    end if;
  end loop;
  for r in select * from fin_supplier_invoices where status = 'PAID' order by received_at nulls first, id loop
    k := 'legacy:supplier:' || r.id;
    if exists (select 1 from fin_payment_registry where merchant_id = r.merchant_id and idempotency_key = k) then skipped := skipped + 1; continue; end if;
    if not (r.paid_amount_cents = r.gross_cents and r.paid_at is not null and r.currency is not null) then
      ex := ex || jsonb_build_object('supplier_invoice', r.id, 'code', 'SUPPLIER_PAID_INCONSISTENT', 'gross_cents', r.gross_cents, 'paid_amount_cents', r.paid_amount_cents, 'paid_at', r.paid_at); continue;
    end if;
    insert into fin_payment_registry (merchant_id, direction, amount_cents, currency, paid_on, method, reference, request_hash, idempotency_key, created_at, source, external_reference)
      values (r.merchant_id, 'OUT', r.paid_amount_cents, r.currency, r.paid_at, 'unspecified', r.paid_reference, 'legacy', k, coalesce(r.validated_at, r.received_at, now()), 'legacy:supplier', r.id::text) returning id into v_pay;
    insert into fin_payment_allocations (merchant_id, payment_id, supplier_invoice_id, amount_cents, currency, idempotency_key, created_at)
      values (r.merchant_id, v_pay, r.id, r.paid_amount_cents, r.currency, k || ':' || r.id, coalesce(r.validated_at, r.received_at, now()));
    n_sup := n_sup + 1;
  end loop;
  alter table fin_payment_allocations enable trigger fin_payment_allocation_guard_trg;
  return jsonb_build_object('customer_payments_created', n_pay, 'customer_corrections_created', n_rev, 'supplier_payments_created', n_sup, 'already_mapped_skipped', skipped, 'exceptions', ex);
end $$;

-- Row by row: the new truth equals the legacy truth, and every ceiling the guard would have enforced holds. An empty "problems" list = ready to switch.
create or replace function pg_temp.cutover_validate() returns jsonb language plpgsql as $$
declare problems jsonb := '[]'::jsonb; r record;
begin
  for r in select p.document_id, p.merchant_id, sum(p.amount_cents) as legacy_net, coalesce((select sum(a.amount_cents) from fin_payment_allocations a where a.customer_document_id = p.document_id and a.merchant_id = p.merchant_id), 0) as new_net
           from fin_payments p group by p.document_id, p.merchant_id loop
    if r.legacy_net <> r.new_net then problems := problems || jsonb_build_object('code', 'CUSTOMER_NET_DIFFERS', 'document', r.document_id, 'legacy', r.legacy_net, 'new', r.new_net); end if;
  end loop;
  for r in select s.id, s.paid_amount_cents, coalesce((select sum(a.amount_cents) from fin_payment_allocations a where a.supplier_invoice_id = s.id), 0) as new_net from fin_supplier_invoices s where s.status = 'PAID' loop
    if r.paid_amount_cents is distinct from r.new_net then problems := problems || jsonb_build_object('code', 'SUPPLIER_NET_DIFFERS', 'supplier_invoice', r.id, 'legacy', r.paid_amount_cents, 'new', r.new_net); end if;
  end loop;
  for r in select d.id, fin_invoice_amounts(d.merchant_id, d.id) as a from fin_documents d where d.doc_type = 'invoice' and exists (select 1 from fin_payment_allocations x where x.customer_document_id = d.id) loop
    if (r.a ->> 'retained')::bigint < 0 then problems := problems || jsonb_build_object('code', 'RETAINED_NEGATIVE', 'document', r.id); end if;
    if (r.a ->> 'allocated')::bigint > (r.a ->> 'document_total')::bigint then problems := problems || jsonb_build_object('code', 'LEGACY_OVERPAID_BEYOND_TOTAL', 'document', r.id, 'amounts', r.a); end if;
  end loop;
  for r in select p.id, p.amount_cents - coalesce((select sum(x.amount_cents) from fin_payment_allocations x where x.payment_id = p.id), 0) as unallocated from fin_payment_registry p where p.reversal_of_id is null loop
    if r.unallocated < 0 then problems := problems || jsonb_build_object('code', 'PAYMENT_OVER_ALLOCATED', 'payment', r.id); end if;
  end loop;
  return jsonb_build_object('problems', problems, 'ok', jsonb_array_length(problems) = 0,
    'legacy_rows_untouched', jsonb_build_object('fin_payments', (select count(*) from fin_payments), 'fin_payments_sum_cents', (select coalesce(sum(amount_cents), 0) from fin_payments)));
end $$;

select 'cutover functions defined (session-local); nothing was changed' as status;
