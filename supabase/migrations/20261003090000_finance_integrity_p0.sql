-- Finance P0 financial integrity (Phase 1). ADDITIVE ONLY: no column dropped, no row rewritten, fin_payments left as it is (legacy, frozen at cutover).
-- Apply BEFORE deploying the code that writes fin_payment_registry / fin_payment_allocations. Preflight: the guarded tables must hold no row that already violates
-- a rule below (production holds none: 0 payments, 0 validated supplier invoices at the time of writing; re-check at deployment).
--
-- What this closes (every protection lives in PostgreSQL; the service adds the same checks only to give friendlier errors):
--   P0-1 credit ceiling        trigger fin_credit_ceiling_guard (locks the credited invoice FOR UPDATE; credits of one invoice are serialised)
--   P0-2 payment integrity     registry + allocations, ceilings under row locks, explicit idempotency keys, atomic RPCs
--   P0-3 supplier PAID         PAID and payment_status are DERIVED from allocations by triggers; they can never be written directly
--   P0-4 merchant isolation    composite foreign keys (child, merchant_id) -> (parent id, merchant_id) on the critical relations
--   P0-5 reversal integrity    negative allocations / reversal registry rows linked to the original, bounded, idempotent
--   bank claim corruption      matched_* are frozen once a transaction is handled (no silent last-writer-wins)
--
-- LOCKING ORDER (everywhere, always in this order, never reversed): 1 target document (customer invoice or supplier invoice), 2 payment, 3 bank transaction.
-- Several targets are locked in ascending id order. No lock is ever held across a retry: a deadlock aborts the transaction and is reported, never silently retried.

-- ---------- helpers ----------
create function fin_payable_cents(d fin_documents) returns bigint language sql immutable as $$
  select coalesce(d.gross_cents, 0) + coalesce((d.body -> 'totals' ->> 'roundingCents')::bigint, 0)
$$;

-- ---------- P0-4: merchant-consistent references ----------
alter table fin_documents add constraint fin_documents_id_merchant_uq unique (id, merchant_id);
alter table fin_supplier_invoices add constraint fin_supplier_invoices_id_merchant_uq unique (id, merchant_id);
alter table fin_companies add constraint fin_companies_id_merchant_uq unique (id, merchant_id);

alter table fin_documents add constraint fin_documents_related_same_merchant_fk foreign key (related_document_id, merchant_id) references fin_documents (id, merchant_id);
alter table fin_documents add constraint fin_documents_converted_same_merchant_fk foreign key (converted_invoice_id, merchant_id) references fin_documents (id, merchant_id);
alter table fin_documents add constraint fin_documents_customer_same_merchant_fk foreign key (customer_company_id, merchant_id) references fin_companies (id, merchant_id);
alter table fin_supplier_invoices add constraint fin_supplier_invoices_company_same_merchant_fk foreign key (supplier_company_id, merchant_id) references fin_companies (id, merchant_id);
alter table fin_events add constraint fin_events_document_same_merchant_fk foreign key (document_id, merchant_id) references fin_documents (id, merchant_id);
alter table fin_payments add constraint fin_payments_document_same_merchant_fk foreign key (document_id, merchant_id) references fin_documents (id, merchant_id); -- legacy table: isolation only

-- ---------- P0-1: credit ceiling ----------
create function fin_credit_ceiling_guard() returns trigger language plpgsql as $$
declare inv fin_documents%rowtype; credited bigint;
begin
  if new.doc_type <> 'credit_note' or new.locked_at is null then return new; end if;
  if tg_op = 'UPDATE' then
    if old.locked_at is not null then return new; end if; -- already issued: only lifecycle columns can change (fin_documents_guard)
  end if;
  if new.related_document_id is null then raise exception 'FIN_CREDIT_WITHOUT_INVOICE: a credit note must reference its invoice'; end if;
  select * into inv from fin_documents where id = new.related_document_id and merchant_id = new.merchant_id for update; -- serialises every credit of this invoice
  if not found then raise exception 'FIN_CREDIT_INVOICE_NOT_FOUND'; end if;
  if inv.doc_type <> 'invoice' or inv.locked_at is null then raise exception 'FIN_CREDIT_INVOICE_NOT_ISSUED'; end if;
  if inv.currency is distinct from new.currency then raise exception 'FIN_CREDIT_CURRENCY_MISMATCH: % vs %', new.currency, inv.currency; end if;
  select coalesce(sum(fin_payable_cents(c)), 0) into credited from fin_documents c
    where c.doc_type = 'credit_note' and c.related_document_id = inv.id and c.merchant_id = inv.merchant_id and c.locked_at is not null and c.id <> new.id;
  if credited + fin_payable_cents(new) > fin_payable_cents(inv) then
    raise exception 'FIN_CREDIT_EXCEEDS_INVOICE: credit % > creditable % (cents)', fin_payable_cents(new), fin_payable_cents(inv) - credited;
  end if;
  return new;
end $$;
create trigger fin_credit_ceiling_guard_trg before insert or update of locked_at on fin_documents for each row execute function fin_credit_ceiling_guard();

-- ---------- P0-2 / P0-5: the payment registry and its allocations (frozen architecture: IN/OUT, append-only, partial, multiple, unallocated, reversal, idempotency) ----------
create table fin_payment_registry (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  direction text not null check (direction in ('IN', 'OUT')),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  paid_on date not null,
  method text not null default 'unspecified',
  reference text,
  reversal_of_id uuid,
  request_hash text not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  actor jsonb,
  created_at timestamptz not null default now(),
  constraint fin_payment_registry_id_merchant_uq unique (id, merchant_id),
  constraint fin_payment_registry_idempotency_uq unique (merchant_id, idempotency_key),
  constraint fin_payment_registry_reversal_fk foreign key (reversal_of_id, merchant_id) references fin_payment_registry (id, merchant_id),
  constraint fin_payment_registry_not_self_reversal check (reversal_of_id is distinct from id)
);
create index fin_payment_registry_merchant_idx on fin_payment_registry (merchant_id, paid_on);
create index fin_payment_registry_reversal_idx on fin_payment_registry (reversal_of_id) where reversal_of_id is not null;

create table fin_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  payment_id uuid not null,
  customer_document_id uuid,
  supplier_invoice_id uuid,
  amount_cents bigint not null check (amount_cents <> 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reverses_allocation_id uuid,
  idempotency_key text not null check (length(idempotency_key) between 1 and 260),
  reason text,
  actor jsonb,
  created_at timestamptz not null default now(),
  constraint fin_payment_allocations_id_merchant_uq unique (id, merchant_id),
  constraint fin_payment_allocations_idempotency_uq unique (merchant_id, idempotency_key),
  constraint fin_payment_allocations_payment_fk foreign key (payment_id, merchant_id) references fin_payment_registry (id, merchant_id),
  constraint fin_payment_allocations_customer_fk foreign key (customer_document_id, merchant_id) references fin_documents (id, merchant_id),
  constraint fin_payment_allocations_supplier_fk foreign key (supplier_invoice_id, merchant_id) references fin_supplier_invoices (id, merchant_id),
  constraint fin_payment_allocations_reverses_fk foreign key (reverses_allocation_id, merchant_id) references fin_payment_allocations (id, merchant_id),
  constraint fin_payment_allocations_one_target check ((customer_document_id is not null)::int + (supplier_invoice_id is not null)::int = 1),
  constraint fin_payment_allocations_reversal_is_negative check ((amount_cents < 0) = (reverses_allocation_id is not null))
);
create index fin_payment_allocations_payment_idx on fin_payment_allocations (payment_id);
create index fin_payment_allocations_customer_idx on fin_payment_allocations (customer_document_id) where customer_document_id is not null;
create index fin_payment_allocations_supplier_idx on fin_payment_allocations (supplier_invoice_id) where supplier_invoice_id is not null;
create index fin_payment_allocations_reverses_idx on fin_payment_allocations (reverses_allocation_id) where reverses_allocation_id is not null;

create trigger fin_payment_registry_append_only_trg before update or delete on fin_payment_registry for each row execute function fin_append_only();
create trigger fin_payment_allocations_append_only_trg before update or delete on fin_payment_allocations for each row execute function fin_append_only();

-- Payment-level reversal rows: a reversal repeats direction and currency of its original, can never exceed what is left of it, and can never take back money that is still allocated.
create function fin_payment_registry_guard() returns trigger language plpgsql as $$
declare orig fin_payment_registry%rowtype; reversed bigint; allocated bigint;
begin
  if new.reversal_of_id is null then return new; end if;
  select * into orig from fin_payment_registry where id = new.reversal_of_id and merchant_id = new.merchant_id for update; -- lock: payment (step 2 of the order)
  if not found then raise exception 'FIN_PAYMENT_NOT_FOUND'; end if;
  if orig.reversal_of_id is not null then raise exception 'FIN_REVERSAL_OF_REVERSAL: a reversal cannot be reversed'; end if;
  if orig.direction <> new.direction or orig.currency <> new.currency then raise exception 'FIN_REVERSAL_MISMATCH: direction or currency differs from the original'; end if;
  select coalesce(sum(amount_cents), 0) into reversed from fin_payment_registry where reversal_of_id = orig.id and merchant_id = orig.merchant_id;
  if reversed + new.amount_cents > orig.amount_cents then
    raise exception 'FIN_REVERSAL_EXCEEDS_PAYMENT: reversal % > remaining % (cents)', new.amount_cents, orig.amount_cents - reversed;
  end if;
  select coalesce(sum(amount_cents), 0) into allocated from fin_payment_allocations where payment_id = orig.id and merchant_id = orig.merchant_id;
  if orig.amount_cents - reversed - new.amount_cents < allocated then
    raise exception 'FIN_REVERSAL_PAYMENT_ALLOCATED: % cents of this payment are still allocated; reverse the allocations first', allocated;
  end if;
  return new;
end $$;
create trigger fin_payment_registry_guard_trg before insert on fin_payment_registry for each row execute function fin_payment_registry_guard();

-- Every allocation: target locked first, then the payment (locking order), then all ceilings, direction, currency and reversal bounds are verified.
create function fin_payment_allocation_guard() returns trigger language plpgsql as $$
declare doc fin_documents%rowtype; sup fin_supplier_invoices%rowtype; pay fin_payment_registry%rowtype; orig fin_payment_allocations%rowtype;
        target_ccy text; payable bigint; credited bigint; target_net bigint; pay_total bigint; pay_net bigint; orig_left bigint;
begin
  if new.customer_document_id is not null then
    select * into doc from fin_documents where id = new.customer_document_id and merchant_id = new.merchant_id for update;
    if not found then raise exception 'FIN_TARGET_NOT_FOUND'; end if;
    target_ccy := doc.currency;
  else
    select * into sup from fin_supplier_invoices where id = new.supplier_invoice_id and merchant_id = new.merchant_id for update;
    if not found then raise exception 'FIN_TARGET_NOT_FOUND'; end if;
    target_ccy := sup.currency;
  end if;
  select * into pay from fin_payment_registry where id = new.payment_id and merchant_id = new.merchant_id for update;
  if not found then raise exception 'FIN_PAYMENT_NOT_FOUND'; end if;
  if pay.reversal_of_id is not null then raise exception 'FIN_ALLOCATION_ON_REVERSAL: a reversal row carries no allocation'; end if;
  if (new.customer_document_id is not null and pay.direction <> 'IN') or (new.supplier_invoice_id is not null and pay.direction <> 'OUT') then
    raise exception 'FIN_DIRECTION_MISMATCH: % cannot settle this document', pay.direction;
  end if;
  if new.currency <> pay.currency or target_ccy is distinct from new.currency then raise exception 'FIN_CURRENCY_MISMATCH: payment %, allocation %, document %', pay.currency, new.currency, target_ccy; end if;

  if new.amount_cents > 0 then
    if new.customer_document_id is not null then
      if doc.doc_type <> 'invoice' or doc.locked_at is null or doc.status not in ('ISSUED', 'SENT', 'PARTIALLY_PAID') then raise exception 'FIN_TARGET_NOT_OPEN: invoice status %', doc.status; end if;
      select coalesce(sum(fin_payable_cents(c)), 0) into credited from fin_documents c where c.doc_type = 'credit_note' and c.related_document_id = doc.id and c.merchant_id = doc.merchant_id and c.locked_at is not null;
      payable := greatest(0, fin_payable_cents(doc) - credited);
      select coalesce(sum(amount_cents), 0) into target_net from fin_payment_allocations where customer_document_id = doc.id and merchant_id = doc.merchant_id;
    else
      if sup.document_type = 'CREDIT_NOTE' or sup.status not in ('VALIDATED', 'TO_PAY') or sup.gross_cents is null then raise exception 'FIN_TARGET_NOT_OPEN: supplier document % (%)', sup.status, sup.document_type; end if;
      payable := sup.gross_cents;
      select coalesce(sum(amount_cents), 0) into target_net from fin_payment_allocations where supplier_invoice_id = sup.id and merchant_id = sup.merchant_id;
    end if;
    if target_net + new.amount_cents > payable then raise exception 'FIN_ALLOCATION_EXCEEDS_REMAINING: % > % (cents)', new.amount_cents, payable - target_net; end if;
    select coalesce(sum(amount_cents), 0) into pay_total from fin_payment_registry where reversal_of_id = pay.id and merchant_id = pay.merchant_id;
    select coalesce(sum(amount_cents), 0) into pay_net from fin_payment_allocations where payment_id = pay.id and merchant_id = pay.merchant_id;
    if pay_net + new.amount_cents > pay.amount_cents - pay_total then raise exception 'FIN_PAYMENT_OVER_ALLOCATED: % > unallocated % (cents)', new.amount_cents, pay.amount_cents - pay_total - pay_net; end if;
  else
    select * into orig from fin_payment_allocations where id = new.reverses_allocation_id and merchant_id = new.merchant_id;
    if not found or orig.amount_cents <= 0 then raise exception 'FIN_ALLOCATION_NOT_FOUND'; end if;
    if orig.payment_id <> new.payment_id or orig.customer_document_id is distinct from new.customer_document_id or orig.supplier_invoice_id is distinct from new.supplier_invoice_id or orig.currency <> new.currency then
      raise exception 'FIN_REVERSAL_MISMATCH: a reversal must hit the same payment, target and currency as the allocation it reverses';
    end if;
    select orig.amount_cents + coalesce(sum(amount_cents), 0) into orig_left from fin_payment_allocations where reverses_allocation_id = orig.id and merchant_id = orig.merchant_id;
    if orig_left + new.amount_cents < 0 then raise exception 'FIN_REVERSAL_EXCEEDS_ALLOCATION: reversal % > remaining % (cents)', -new.amount_cents, orig_left; end if;
  end if;
  return new;
end $$;
create trigger fin_payment_allocation_guard_trg before insert on fin_payment_allocations for each row execute function fin_payment_allocation_guard();

-- ---------- P0-3: a supplier invoice is PAID only because allocations say so ----------
-- BEFORE: status PAID is refused unless the allocations equal the gross amount; payment_status is always overwritten with the derived value (it is a mirror, never an input).
create function fin_supplier_invoice_truth_guard() returns trigger language plpgsql as $$
declare net bigint;
begin
  select coalesce(sum(amount_cents), 0) into net from fin_payment_allocations where supplier_invoice_id = new.id and merchant_id = new.merchant_id;
  if new.status = 'PAID' and not (coalesce(new.gross_cents, 0) > 0 and net = new.gross_cents) then
    raise exception 'FIN_PAID_REQUIRES_ALLOCATIONS: allocated % of % (cents)', net, coalesce(new.gross_cents, 0);
  end if;
  if tg_op = 'UPDATE' and net <> 0 then
    if new.gross_cents is distinct from old.gross_cents or new.currency is distinct from old.currency or new.status in ('RECEIVED', 'TO_REVIEW', 'REJECTED') then
      raise exception 'FIN_INVOICE_HAS_PAYMENTS: amount, currency and review status are frozen once payments are allocated';
    end if;
  end if;
  new.payment_status := case when net <= 0 then 'unpaid' when coalesce(new.gross_cents, 0) > 0 and net >= new.gross_cents then 'paid' else 'partially_paid' end;
  return new;
end $$;
create trigger fin_supplier_invoice_truth_guard_trg before insert or update on fin_supplier_invoices for each row execute function fin_supplier_invoice_truth_guard();

-- AFTER an allocation: the legacy single-payment fields follow the allocations (PAID <-> net = gross; paid_* only while fully paid).
create function fin_supplier_invoice_mirror() returns trigger language plpgsql as $$
declare sup fin_supplier_invoices%rowtype; net bigint; last_paid date; last_ref text;
begin
  if new.supplier_invoice_id is null then return new; end if;
  select * into sup from fin_supplier_invoices where id = new.supplier_invoice_id and merchant_id = new.merchant_id;
  select coalesce(sum(amount_cents), 0) into net from fin_payment_allocations where supplier_invoice_id = sup.id and merchant_id = sup.merchant_id;
  if coalesce(sup.gross_cents, 0) > 0 and net = sup.gross_cents then
    select r.paid_on, r.reference into last_paid, last_ref from fin_payment_allocations a join fin_payment_registry r on r.id = a.payment_id and r.merchant_id = a.merchant_id
      where a.supplier_invoice_id = sup.id and a.merchant_id = sup.merchant_id group by r.id, r.paid_on, r.reference, r.created_at having sum(a.amount_cents) > 0 order by r.paid_on desc, r.created_at desc limit 1;
    update fin_supplier_invoices set status = 'PAID', paid_at = last_paid, paid_amount_cents = net, paid_reference = last_ref where id = sup.id;
  elsif sup.status = 'PAID' then
    update fin_supplier_invoices set status = 'TO_PAY', paid_at = null, paid_amount_cents = null, paid_reference = null where id = sup.id;
  else
    update fin_supplier_invoices set payment_status = sup.payment_status where id = sup.id; -- fires the truth guard, which recomputes the mirror
  end if;
  return new;
end $$;
create trigger fin_supplier_invoice_mirror_trg after insert on fin_payment_allocations for each row execute function fin_supplier_invoice_mirror();

-- ---------- reconciliation: no silent last-writer-wins on a bank transaction ----------
create or replace function fin_bank_tx_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'bank transactions are append-only'; end if;
  if new.merchant_id is distinct from old.merchant_id or new.account_id is distinct from old.account_id or new.provider_tx_id is distinct from old.provider_tx_id
     or new.date is distinct from old.date or new.amount_cents is distinct from old.amount_cents or new.reference is distinct from old.reference then
    raise exception 'bank transaction content is immutable';
  end if;
  if old.status <> 'NEW' and new.status is distinct from old.status then raise exception 'a handled bank transaction cannot change status'; end if;
  if old.status <> 'NEW' then
    if new.matched_kind is distinct from old.matched_kind or new.matched_document_id is distinct from old.matched_document_id
       or new.matched_amount_cents is distinct from old.matched_amount_cents or new.matched_at is distinct from old.matched_at
       or (old.matched_payment_id is not null and new.matched_payment_id is distinct from old.matched_payment_id) then
      raise exception 'FIN_BANK_TX_ALREADY_CLAIMED: a handled bank transaction cannot be claimed again (matched_* are frozen)';
    end if;
  end if;
  if new.matched_amount_cents is not null and (new.matched_amount_cents < 0 or new.matched_amount_cents > abs(new.amount_cents)) then
    raise exception 'FIN_BANK_MATCH_EXCEEDS_TRANSACTION: matched % outside the transaction amount %', new.matched_amount_cents, abs(new.amount_cents);
  end if;
  if new.matched_document_id is not null and new.matched_document_id is distinct from old.matched_document_id then -- merchant-consistent reference
    if new.matched_kind = 'INVOICE' and not exists (select 1 from fin_documents where id::text = new.matched_document_id and merchant_id = new.merchant_id) then raise exception 'FIN_BANK_MATCH_TARGET_NOT_FOUND'; end if;
    if new.matched_kind = 'SUPPLIER_INVOICE' and not exists (select 1 from fin_supplier_invoices where id::text = new.matched_document_id and merchant_id = new.merchant_id) then raise exception 'FIN_BANK_MATCH_TARGET_NOT_FOUND'; end if;
  end if;
  if new.matched_payment_id is not null and new.matched_payment_id is distinct from old.matched_payment_id then
    if not exists (select 1 from fin_payment_registry where id = new.matched_payment_id and merchant_id = new.merchant_id)
       and not exists (select 1 from fin_payments where id = new.matched_payment_id and merchant_id = new.merchant_id) then raise exception 'FIN_BANK_MATCH_PAYMENT_NOT_FOUND'; end if;
  end if;
  return new;
end $$;

-- ---------- RPCs: one operation = one transaction; no SECURITY DEFINER; callable by the service role only ----------
-- fin_record_payment: records ONE payment and allocates it, atomically and idempotently.
--   p_allocations: [{ "customerDocumentId" | "supplierInvoiceId": uuid, "amountCents": n }, ...] (may be empty = an unallocated payment / advance).
--   Idempotency: the same (merchant, key) with the same request returns the payment already committed ("duplicate": true), whatever the network did;
--   the same key with a DIFFERENT request is refused (FIN_IDEMPOTENCY_KEY_REUSED). A retry is therefore always safe, and never needed after a refusal.
create function fin_record_payment(
  p_merchant uuid, p_key text, p_direction text, p_amount bigint, p_currency text, p_paid_on date, p_method text, p_reference text, p_actor jsonb, p_allocations jsonb, p_at timestamptz default null
) returns jsonb language plpgsql as $$
declare v_hash text; v_id uuid; v_existing fin_payment_registry%rowtype; a record; v_docs uuid[]; v_doc uuid; v_doc_status text; v_result jsonb;
begin
  if p_key is null or length(p_key) = 0 then raise exception 'FIN_IDEMPOTENCY_KEY_REQUIRED'; end if;
  if p_direction not in ('IN', 'OUT') then raise exception 'FIN_DIRECTION_INVALID'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'FIN_AMOUNT_INVALID'; end if;
  v_hash := md5(concat_ws('|', p_direction, p_amount, p_currency, p_paid_on, coalesce(p_method, ''), coalesce(p_reference, ''),
    (select coalesce(string_agg(coalesce(x ->> 'customerDocumentId', '') || ':' || coalesce(x ->> 'supplierInvoiceId', '') || ':' || (x ->> 'amountCents'), ',' order by coalesce(x ->> 'customerDocumentId', x ->> 'supplierInvoiceId')), '')
       from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) x)));
  insert into fin_payment_registry (merchant_id, direction, amount_cents, currency, paid_on, method, reference, request_hash, idempotency_key, actor, created_at)
    values (p_merchant, p_direction, p_amount, p_currency, p_paid_on, coalesce(p_method, 'unspecified'), p_reference, v_hash, p_key, p_actor, coalesce(p_at, now()))
    on conflict (merchant_id, idempotency_key) do nothing returning id into v_id;
  if v_id is null then -- the same operation was already committed (or is committing: the unique index made us wait for its outcome)
    select * into v_existing from fin_payment_registry where merchant_id = p_merchant and idempotency_key = p_key;
    if v_existing.request_hash <> v_hash then raise exception 'FIN_IDEMPOTENCY_KEY_REUSED: key % was used for a different request', p_key; end if;
    return jsonb_build_object('duplicate', true, 'payment', to_jsonb(v_existing),
      'allocations', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from fin_payment_allocations x where x.payment_id = v_existing.id and x.merchant_id = p_merchant), '[]'::jsonb));
  end if;
  for a in select x ->> 'customerDocumentId' as cd, x ->> 'supplierInvoiceId' as si, (x ->> 'amountCents')::bigint as cents
           from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) x order by coalesce(x ->> 'customerDocumentId', x ->> 'supplierInvoiceId') loop -- ascending target id = deterministic lock order
    insert into fin_payment_allocations (merchant_id, payment_id, customer_document_id, supplier_invoice_id, amount_cents, currency, idempotency_key, actor, created_at)
      values (p_merchant, v_id, a.cd::uuid, a.si::uuid, a.cents, p_currency, p_key || ':' || coalesce(a.cd, a.si), p_actor, coalesce(p_at, now()));
  end loop;
  v_docs := array(select (x ->> 'customerDocumentId')::uuid from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) x where x ->> 'customerDocumentId' is not null);
  v_doc := case when cardinality(v_docs) = 1 then v_docs[1] else null end;
  select status into v_doc_status from fin_documents where id = v_doc;
  insert into fin_events (merchant_id, document_id, at, actor, action, from_status, to_status, detail)
    values (p_merchant, v_doc, coalesce(p_at, now()), p_actor, case when p_direction = 'IN' then 'RECORD_PAYMENT' else 'RECORD_SUPPLIER_PAYMENT' end, v_doc_status, v_doc_status,
      jsonb_build_object('paymentId', v_id, 'amountCents', p_amount, 'currency', p_currency, 'method', coalesce(p_method, 'unspecified'), 'paidOn', p_paid_on, 'direction', p_direction, 'allocations', coalesce(p_allocations, '[]'::jsonb)));
  select jsonb_build_object('duplicate', false, 'payment', to_jsonb(r), 'allocations', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from fin_payment_allocations x where x.payment_id = r.id and x.merchant_id = p_merchant), '[]'::jsonb))
    into v_result from fin_payment_registry r where r.id = v_id;
  return v_result;
end $$;

-- fin_reverse_allocations: take back (all or part of) allocations. Never deletes: it appends negative allocations linked to the originals.
--   p_items: [{ "allocationId": uuid, "amountCents": n | null (= everything still standing) }]. Idempotent per (key, allocation).
create function fin_reverse_allocations(p_merchant uuid, p_key text, p_items jsonb, p_reason text, p_actor jsonb, p_at timestamptz default null) returns jsonb language plpgsql as $$
declare it record; orig fin_payment_allocations%rowtype; prior fin_payment_allocations%rowtype; left_cents bigint; amt bigint; rows jsonb := '[]'::jsonb; dup boolean := false; fresh boolean := false; r fin_payment_allocations%rowtype; ev_doc uuid;
begin
  if p_key is null or length(p_key) = 0 then raise exception 'FIN_IDEMPOTENCY_KEY_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fin_reverse:' || p_merchant::text || ':' || p_key, 0)); -- same-key retries wait for the first outcome (lock taken before any row lock)
  for it in select (x ->> 'allocationId')::uuid as id, (x ->> 'amountCents')::bigint as cents from jsonb_array_elements(p_items) x
            order by (select coalesce(a.customer_document_id, a.supplier_invoice_id) from fin_payment_allocations a where a.id = (x ->> 'allocationId')::uuid and a.merchant_id = p_merchant) loop
    select * into orig from fin_payment_allocations where id = it.id and merchant_id = p_merchant;
    if not found or orig.amount_cents <= 0 then raise exception 'FIN_ALLOCATION_NOT_FOUND'; end if;
    select * into prior from fin_payment_allocations where merchant_id = p_merchant and idempotency_key = p_key || ':' || it.id::text;
    if found then
      if it.cents is not null and -prior.amount_cents <> it.cents then raise exception 'FIN_IDEMPOTENCY_KEY_REUSED: key % was used for a different reversal', p_key; end if;
      dup := true; rows := rows || to_jsonb(prior); continue;
    end if;
    select orig.amount_cents + coalesce(sum(amount_cents), 0) into left_cents from fin_payment_allocations where reverses_allocation_id = orig.id and merchant_id = p_merchant;
    amt := coalesce(it.cents, left_cents);
    if amt <= 0 or amt > left_cents then raise exception 'FIN_REVERSAL_EXCEEDS_ALLOCATION: reversal % > remaining % (cents)', amt, left_cents; end if;
    insert into fin_payment_allocations (merchant_id, payment_id, customer_document_id, supplier_invoice_id, amount_cents, currency, reverses_allocation_id, idempotency_key, reason, actor, created_at)
      values (p_merchant, orig.payment_id, orig.customer_document_id, orig.supplier_invoice_id, -amt, orig.currency, orig.id, p_key || ':' || it.id::text, p_reason, p_actor, coalesce(p_at, now())) returning * into r;
    fresh := true; rows := rows || to_jsonb(r); ev_doc := orig.customer_document_id;
    insert into fin_events (merchant_id, document_id, at, actor, action, from_status, to_status, detail)
      values (p_merchant, orig.customer_document_id, coalesce(p_at, now()), p_actor, 'REVERSE_PAYMENT_ALLOCATION', null, null, jsonb_build_object('allocationId', orig.id, 'reversalId', r.id, 'paymentId', orig.payment_id, 'amountCents', amt, 'reason', p_reason));
  end loop;
  return jsonb_build_object('duplicate', dup and not fresh, 'reversals', rows);
end $$;

-- fin_void_payment: a payment entered by mistake. Reverses every standing allocation, then appends a registry reversal row for what is left of the payment.
create function fin_void_payment(p_merchant uuid, p_key text, p_payment_id uuid, p_on date, p_reason text, p_actor jsonb, p_at timestamptz default null) returns jsonb language plpgsql as $$
declare pay fin_payment_registry%rowtype; prior fin_payment_registry%rowtype; hash text; left_cents bigint; a record; items jsonb; rev jsonb := '[]'::jsonb; v_id uuid; v_row fin_payment_registry%rowtype;
begin
  if p_key is null or length(p_key) = 0 then raise exception 'FIN_IDEMPOTENCY_KEY_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fin_void:' || p_merchant::text || ':' || p_key, 0));
  hash := md5(concat_ws('|', 'VOID', p_payment_id, coalesce(p_reason, '')));
  select * into prior from fin_payment_registry where merchant_id = p_merchant and idempotency_key = p_key;
  if found then
    if prior.request_hash <> hash then raise exception 'FIN_IDEMPOTENCY_KEY_REUSED: key % was used for a different request', p_key; end if;
    return jsonb_build_object('duplicate', true, 'reversal', to_jsonb(prior));
  end if;
  select * into pay from fin_payment_registry where id = p_payment_id and merchant_id = p_merchant;
  if not found or pay.reversal_of_id is not null then raise exception 'FIN_PAYMENT_NOT_FOUND'; end if;
  items := coalesce((select jsonb_agg(jsonb_build_object('allocationId', t.id, 'amountCents', null)) from (
      select o.id from fin_payment_allocations o where o.payment_id = pay.id and o.merchant_id = p_merchant and o.amount_cents > 0
        and o.amount_cents + coalesce((select sum(x.amount_cents) from fin_payment_allocations x where x.reverses_allocation_id = o.id and x.merchant_id = p_merchant), 0) > 0) t), '[]'::jsonb);
  if jsonb_array_length(items) > 0 then perform fin_reverse_allocations(p_merchant, p_key || ':void', items, coalesce(p_reason, 'PAYMENT_VOIDED'), p_actor, p_at); end if;
  select pay.amount_cents - coalesce(sum(amount_cents), 0) into left_cents from fin_payment_registry where reversal_of_id = pay.id and merchant_id = p_merchant;
  if left_cents <= 0 then raise exception 'FIN_PAYMENT_ALREADY_REVERSED'; end if;
  insert into fin_payment_registry (merchant_id, direction, amount_cents, currency, paid_on, method, reference, reversal_of_id, request_hash, idempotency_key, actor, created_at)
    values (p_merchant, pay.direction, left_cents, pay.currency, p_on, pay.method, p_reason, pay.id, hash, p_key, p_actor, coalesce(p_at, now())) returning * into v_row;
  insert into fin_events (merchant_id, document_id, at, actor, action, from_status, to_status, detail)
    values (p_merchant, null, coalesce(p_at, now()), p_actor, 'VOID_PAYMENT', null, null, jsonb_build_object('paymentId', pay.id, 'reversalId', v_row.id, 'amountCents', left_cents, 'reason', p_reason));
  return jsonb_build_object('duplicate', false, 'reversal', to_jsonb(v_row));
end $$;

-- ---------- hardening of the new objects ----------
alter table fin_payment_registry enable row level security;
alter table fin_payment_allocations enable row level security;
revoke all on fin_payment_registry, fin_payment_allocations from anon, authenticated;
revoke execute on function fin_record_payment(uuid, text, text, bigint, text, date, text, text, jsonb, jsonb, timestamptz), fin_reverse_allocations(uuid, text, jsonb, text, jsonb, timestamptz), fin_void_payment(uuid, text, uuid, date, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function fin_record_payment(uuid, text, text, bigint, text, date, text, text, jsonb, jsonb, timestamptz), fin_reverse_allocations(uuid, text, jsonb, text, jsonb, timestamptz), fin_void_payment(uuid, text, uuid, date, text, jsonb, timestamptz) to service_role;
