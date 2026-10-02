-- Finance CORE - ESSENTIAL PAYMENTS. Builds on 20261003090000 (P0 integrity), which is not yet applied to production either: apply both, in order, BEFORE deploying the code.
-- ADDITIVE: no column dropped, no row rewritten, fin_payments untouched. The only DROP is of fin_record_payment's previous signature, replaced by the same function with one more
-- optional parameter (p_meta), so every earlier call keeps working.
--
-- THE MODEL (single source of truth, nothing else is an authority):
--   Payment     = a row of fin_payment_registry   (IN | OUT, positive cents, one currency, one method, a provenance)
--   Allocation  = a row of fin_payment_allocations (part of a payment applied to ONE document; negative = a reversal of an earlier allocation)
--   Reversal    = a negative allocation (undo an application) or a registry row with reversal_of_id (undo the payment itself); never a delete
--   Refund      = an OUT payment allocated to a customer CREDIT NOTE (the money returned for that credit note), optionally tied to the IN payment it gives back
--   Document payment status = DERIVED from allocations (see fin_invoice_amounts; supplier invoices: fin_supplier_invoice_truth_guard)
--
-- THE AMOUNTS (integer cents, one currency), for a customer invoice I:
--   document_total = gross + rounding of I
--   credited       = sum of document_total of the ISSUED credit notes of I
--   effective_due  = max(0, document_total - credited)
--   allocated      = net (positive - reversed) IN allocations to I
--   refunded       = net OUT allocations to the credit notes of I
--   retained       = allocated - refunded                (what the customer has really paid and not got back)
--   remaining_due  = max(0, effective_due - retained)
--   refundable     = max(0, retained - effective_due)    (what may still be refunded)
-- Invariants: retained >= 0 ; a new allocation never makes retained exceed effective_due ; refund <= refundable and <= its credit note ; a reversal never makes retained negative.
--
-- LOCKING ORDER (unchanged, extended): 1 target document (for a refund: the credit note, then its invoice), 2 payment (the new one, then the original it refunds), 3 bank transaction.

-- ---------- vocabulary and provenance (Belgian structured communication, bank and provider references are stored, not generated, here) ----------
alter table fin_payment_registry
  add column source text not null default 'manual' check (source ~ '^[a-z][a-z0-9_:.-]{0,39}$'),
  add column external_reference text check (length(external_reference) <= 200),
  add column structured_reference text check (length(structured_reference) <= 40),
  add column bank_reference text check (length(bank_reference) <= 200),
  add column refund_of_payment_id uuid,
  add constraint fin_payment_registry_method_chk check (method in ('cash', 'bank_transfer', 'card', 'bancontact', 'direct_debit', 'other', 'unspecified')),
  add constraint fin_payment_registry_refund_fk foreign key (refund_of_payment_id, merchant_id) references fin_payment_registry (id, merchant_id),
  add constraint fin_payment_registry_refund_not_reversal check (refund_of_payment_id is null or reversal_of_id is null);
create index fin_payment_registry_refund_idx on fin_payment_registry (refund_of_payment_id) where refund_of_payment_id is not null;
comment on column fin_payment_registry.source is 'Provenance: manual | bank | provider:<name> | import ... A label, never a secret, never the business type (that is method).';

-- ---------- the amounts of a customer invoice: ONE definition, mirrored by src/finance/amounts.js (a test holds the two equal) ----------
create function fin_invoice_amounts(p_merchant uuid, p_invoice uuid) returns jsonb language sql stable as $$
  with inv as (select fin_payable_cents(d) as total from fin_documents d where d.id = p_invoice and d.merchant_id = p_merchant),
  cr as (select coalesce(sum(fin_payable_cents(c)), 0) as v from fin_documents c where c.doc_type = 'credit_note' and c.related_document_id = p_invoice and c.merchant_id = p_merchant and c.locked_at is not null),
  al as (select coalesce(sum(a.amount_cents), 0) as v from fin_payment_allocations a where a.customer_document_id = p_invoice and a.merchant_id = p_merchant),
  rf as (select coalesce(sum(a.amount_cents), 0) as v from fin_payment_allocations a join fin_documents c on c.id = a.customer_document_id and c.merchant_id = a.merchant_id
         where c.doc_type = 'credit_note' and c.related_document_id = p_invoice and a.merchant_id = p_merchant),
  m as (select inv.total, cr.v as credited, greatest(0, inv.total - cr.v) as due, al.v as allocated, rf.v as refunded, al.v - rf.v as retained from inv, cr, al, rf)
  select jsonb_build_object('document_total', total, 'credited', credited, 'effective_due', due, 'allocated', allocated, 'refunded', refunded, 'retained', retained,
    'remaining_due', greatest(0, due - retained), 'refundable', greatest(0, retained - due)) from m
$$;

-- ---------- registry guard: static rules of a refund link (the ceiling is checked in the allocation guard, where the locks are taken in order) ----------
create or replace function fin_payment_registry_guard() returns trigger language plpgsql as $$
declare orig fin_payment_registry%rowtype; reversed bigint; allocated bigint;
begin
  if new.refund_of_payment_id is not null then
    select * into orig from fin_payment_registry where id = new.refund_of_payment_id and merchant_id = new.merchant_id; -- no lock here: see the allocation guard
    if not found then raise exception 'FIN_PAYMENT_NOT_FOUND'; end if;
    if orig.direction <> 'IN' or orig.reversal_of_id is not null or new.direction <> 'OUT' then raise exception 'FIN_REFUND_MISMATCH: a refund is an OUT payment giving back an IN payment'; end if;
    if orig.currency <> new.currency then raise exception 'FIN_CURRENCY_MISMATCH: refund %, original %', new.currency, orig.currency; end if;
  end if;
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

-- ---------- allocation guard: customer invoices (IN), customer credit notes = refunds (OUT), supplier invoices (OUT) ----------
create or replace function fin_payment_allocation_guard() returns trigger language plpgsql as $$
declare doc fin_documents%rowtype; inv fin_documents%rowtype; sup fin_supplier_invoices%rowtype; pay fin_payment_registry%rowtype; orig fin_payment_allocations%rowtype; opay fin_payment_registry%rowtype;
        target_ccy text; payable bigint; target_net bigint; pay_total bigint; pay_net bigint; orig_left bigint; am jsonb; refunded_of bigint;
begin
  if new.customer_document_id is not null then
    select * into doc from fin_documents where id = new.customer_document_id and merchant_id = new.merchant_id for update; -- 1: the target
    if not found then raise exception 'FIN_TARGET_NOT_FOUND'; end if;
    target_ccy := doc.currency;
    if doc.doc_type = 'credit_note' then
      select * into inv from fin_documents where id = doc.related_document_id and merchant_id = new.merchant_id for update; -- 1b: a refund also locks the invoice it relates to (credit note first, then invoice)
      if not found then raise exception 'FIN_TARGET_NOT_OPEN: credit note without its invoice'; end if;
    elsif doc.doc_type = 'invoice' then inv := doc;
    else raise exception 'FIN_TARGET_NOT_OPEN: a % cannot be settled', doc.doc_type;
    end if;
  else
    select * into sup from fin_supplier_invoices where id = new.supplier_invoice_id and merchant_id = new.merchant_id for update;
    if not found then raise exception 'FIN_TARGET_NOT_FOUND'; end if;
    target_ccy := sup.currency;
  end if;
  select * into pay from fin_payment_registry where id = new.payment_id and merchant_id = new.merchant_id for update; -- 2: the payment
  if not found then raise exception 'FIN_PAYMENT_NOT_FOUND'; end if;
  if pay.reversal_of_id is not null then raise exception 'FIN_ALLOCATION_ON_REVERSAL: a reversal row carries no allocation'; end if;
  if (new.customer_document_id is not null and doc.doc_type = 'invoice' and pay.direction <> 'IN')
     or (new.customer_document_id is not null and doc.doc_type = 'credit_note' and pay.direction <> 'OUT')
     or (new.supplier_invoice_id is not null and pay.direction <> 'OUT') then
    raise exception 'FIN_DIRECTION_MISMATCH: % cannot settle this document', pay.direction;
  end if;
  if new.currency <> pay.currency or target_ccy is distinct from new.currency then raise exception 'FIN_CURRENCY_MISMATCH: payment %, allocation %, document %', pay.currency, new.currency, target_ccy; end if;

  if new.amount_cents > 0 then
    if new.customer_document_id is not null and doc.doc_type = 'invoice' then
      if doc.locked_at is null or doc.status not in ('ISSUED', 'SENT', 'PARTIALLY_PAID') then raise exception 'FIN_TARGET_NOT_OPEN: invoice status %', doc.status; end if;
      am := fin_invoice_amounts(doc.merchant_id, doc.id);
      if (am ->> 'retained')::bigint + new.amount_cents > (am ->> 'effective_due')::bigint then
        raise exception 'FIN_ALLOCATION_EXCEEDS_REMAINING: % > % (cents)', new.amount_cents, (am ->> 'effective_due')::bigint - (am ->> 'retained')::bigint;
      end if;
    elsif new.customer_document_id is not null then -- a refund: money returned for a credit note
      if doc.locked_at is null or inv.locked_at is null then raise exception 'FIN_TARGET_NOT_OPEN: credit note or invoice not issued'; end if;
      select coalesce(sum(amount_cents), 0) into target_net from fin_payment_allocations where customer_document_id = doc.id and merchant_id = doc.merchant_id;
      if target_net + new.amount_cents > fin_payable_cents(doc) then raise exception 'FIN_REFUND_EXCEEDS_CREDIT_NOTE: % > % (cents)', new.amount_cents, fin_payable_cents(doc) - target_net; end if;
      am := fin_invoice_amounts(inv.merchant_id, inv.id);
      if new.amount_cents > (am ->> 'refundable')::bigint then raise exception 'FIN_REFUND_EXCEEDS_REFUNDABLE: % > % (cents)', new.amount_cents, (am ->> 'refundable')::bigint; end if;
      if pay.refund_of_payment_id is not null then -- the refund gives back a given payment: never more than that payment (lock: the original payment, after the refund payment)
        select * into opay from fin_payment_registry where id = pay.refund_of_payment_id and merchant_id = pay.merchant_id for update;
        select coalesce(sum(a.amount_cents), 0) into refunded_of from fin_payment_allocations a join fin_payment_registry r on r.id = a.payment_id and r.merchant_id = a.merchant_id where r.refund_of_payment_id = opay.id and r.merchant_id = opay.merchant_id;
        select coalesce(sum(amount_cents), 0) into pay_total from fin_payment_registry where reversal_of_id = opay.id and merchant_id = opay.merchant_id;
        if refunded_of + new.amount_cents > opay.amount_cents - pay_total then raise exception 'FIN_REFUND_EXCEEDS_PAYMENT: % > % (cents)', new.amount_cents, opay.amount_cents - pay_total - refunded_of; end if;
      end if;
    else
      if sup.document_type = 'CREDIT_NOTE' or sup.status not in ('VALIDATED', 'TO_PAY') or sup.gross_cents is null then raise exception 'FIN_TARGET_NOT_OPEN: supplier document % (%)', sup.status, sup.document_type; end if;
      payable := sup.gross_cents;
      select coalesce(sum(amount_cents), 0) into target_net from fin_payment_allocations where supplier_invoice_id = sup.id and merchant_id = sup.merchant_id;
      if target_net + new.amount_cents > payable then raise exception 'FIN_ALLOCATION_EXCEEDS_REMAINING: % > % (cents)', new.amount_cents, payable - target_net; end if;
    end if;
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
    if new.customer_document_id is not null and doc.doc_type = 'invoice' then -- money already given back cannot be taken back
      am := fin_invoice_amounts(doc.merchant_id, doc.id);
      if (am ->> 'retained')::bigint + new.amount_cents < 0 then raise exception 'FIN_REVERSAL_BREAKS_REFUND: only % cents are retained, the rest was refunded: reverse the refund first', (am ->> 'retained')::bigint; end if;
    end if;
  end if;
  return new;
end $$;

-- ---------- fin_record_payment v2: provenance and method vocabulary (p_meta), refunds ----------
--   p_meta (all optional): { source, externalReference, structuredReference, bankReference, refundOfPaymentId }. The request fingerprint covers them: a retry must repeat the same request.
drop function fin_record_payment(uuid, text, text, bigint, text, date, text, text, jsonb, jsonb, timestamptz);
create function fin_record_payment(
  p_merchant uuid, p_key text, p_direction text, p_amount bigint, p_currency text, p_paid_on date, p_method text, p_reference text, p_actor jsonb, p_allocations jsonb,
  p_at timestamptz default null, p_meta jsonb default null
) returns jsonb language plpgsql as $$
declare v_hash text; v_id uuid; v_existing fin_payment_registry%rowtype; a record; v_docs uuid[]; v_doc uuid; v_doc_status text; v_doc_type text; v_result jsonb; v_action text;
begin
  if p_key is null or length(p_key) = 0 then raise exception 'FIN_IDEMPOTENCY_KEY_REQUIRED'; end if;
  if p_direction not in ('IN', 'OUT') then raise exception 'FIN_DIRECTION_INVALID'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'FIN_AMOUNT_INVALID'; end if;
  v_hash := md5(concat_ws('|', p_direction, p_amount, p_currency, p_paid_on, coalesce(p_method, ''), coalesce(p_reference, ''),
    coalesce(p_meta ->> 'source', ''), coalesce(p_meta ->> 'externalReference', ''), coalesce(p_meta ->> 'structuredReference', ''), coalesce(p_meta ->> 'bankReference', ''), coalesce(p_meta ->> 'refundOfPaymentId', ''),
    (select coalesce(string_agg(coalesce(x ->> 'customerDocumentId', '') || ':' || coalesce(x ->> 'supplierInvoiceId', '') || ':' || (x ->> 'amountCents'), ',' order by coalesce(x ->> 'customerDocumentId', x ->> 'supplierInvoiceId')), '')
       from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) x)));
  insert into fin_payment_registry (merchant_id, direction, amount_cents, currency, paid_on, method, reference, request_hash, idempotency_key, actor, created_at, source, external_reference, structured_reference, bank_reference, refund_of_payment_id)
    values (p_merchant, p_direction, p_amount, p_currency, p_paid_on, coalesce(p_method, 'unspecified'), p_reference, v_hash, p_key, p_actor, coalesce(p_at, now()),
      coalesce(p_meta ->> 'source', 'manual'), p_meta ->> 'externalReference', p_meta ->> 'structuredReference', p_meta ->> 'bankReference', (p_meta ->> 'refundOfPaymentId')::uuid)
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
  select status, doc_type into v_doc_status, v_doc_type from fin_documents where id = v_doc;
  v_action := case when p_direction = 'IN' then 'RECORD_PAYMENT' when cardinality(v_docs) > 0 then 'RECORD_REFUND' else 'RECORD_SUPPLIER_PAYMENT' end;
  insert into fin_events (merchant_id, document_id, at, actor, action, from_status, to_status, detail)
    values (p_merchant, v_doc, coalesce(p_at, now()), p_actor, v_action, v_doc_status, v_doc_status,
      jsonb_build_object('paymentId', v_id, 'amountCents', p_amount, 'currency', p_currency, 'method', coalesce(p_method, 'unspecified'), 'paidOn', p_paid_on, 'direction', p_direction,
        'source', coalesce(p_meta ->> 'source', 'manual'), 'externalReference', p_meta ->> 'externalReference', 'allocations', coalesce(p_allocations, '[]'::jsonb)));
  select jsonb_build_object('duplicate', false, 'payment', to_jsonb(r), 'allocations', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from fin_payment_allocations x where x.payment_id = r.id and x.merchant_id = p_merchant), '[]'::jsonb))
    into v_result from fin_payment_registry r where r.id = v_id;
  return v_result;
end $$;

-- ---------- fin_allocate_payment: apply the unallocated part of an existing payment to documents, later ----------
--   p_allocations: [{ "customerDocumentId" | "supplierInvoiceId": uuid, "amountCents": n }]. Idempotent per (key, target): a repeat returns what was committed, another amount under the same key is refused.
--   Same ceilings as any allocation (merchant, currency, direction, document remaining, payment unallocated), under the usual locks. Never automatic: the caller names every target.
create function fin_allocate_payment(p_merchant uuid, p_key text, p_payment_id uuid, p_allocations jsonb, p_actor jsonb, p_at timestamptz default null) returns jsonb language plpgsql as $$
declare pay fin_payment_registry%rowtype; it record; prior fin_payment_allocations%rowtype; r fin_payment_allocations%rowtype; rows jsonb := '[]'::jsonb; dup boolean := false; fresh boolean := false; idem text;
begin
  if p_key is null or length(p_key) = 0 then raise exception 'FIN_IDEMPOTENCY_KEY_REQUIRED'; end if;
  if p_allocations is null or jsonb_array_length(p_allocations) = 0 then raise exception 'FIN_AMOUNT_INVALID: nothing to allocate'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fin_allocate:' || p_merchant::text || ':' || p_key, 0)); -- same-key retries wait for the first outcome (taken before any row lock)
  select * into pay from fin_payment_registry where id = p_payment_id and merchant_id = p_merchant;
  if not found or pay.reversal_of_id is not null then raise exception 'FIN_PAYMENT_NOT_FOUND'; end if;
  for it in select x ->> 'customerDocumentId' as cd, x ->> 'supplierInvoiceId' as si, (x ->> 'amountCents')::bigint as cents from jsonb_array_elements(p_allocations) x order by coalesce(x ->> 'customerDocumentId', x ->> 'supplierInvoiceId') loop
    idem := p_key || ':' || coalesce(it.cd, it.si);
    select * into prior from fin_payment_allocations where merchant_id = p_merchant and idempotency_key = idem;
    if found then
      if prior.payment_id <> pay.id or prior.amount_cents <> it.cents then raise exception 'FIN_IDEMPOTENCY_KEY_REUSED: key % was used for a different allocation', p_key; end if;
      dup := true; rows := rows || to_jsonb(prior); continue;
    end if;
    insert into fin_payment_allocations (merchant_id, payment_id, customer_document_id, supplier_invoice_id, amount_cents, currency, idempotency_key, actor, created_at)
      values (p_merchant, pay.id, it.cd::uuid, it.si::uuid, it.cents, pay.currency, idem, p_actor, coalesce(p_at, now())) returning * into r;
    fresh := true; rows := rows || to_jsonb(r);
    insert into fin_events (merchant_id, document_id, at, actor, action, from_status, to_status, detail)
      values (p_merchant, r.customer_document_id, coalesce(p_at, now()), p_actor, 'ALLOCATE_PAYMENT', null, null, jsonb_build_object('paymentId', pay.id, 'allocationId', r.id, 'amountCents', r.amount_cents, 'supplierInvoiceId', r.supplier_invoice_id));
  end loop;
  return jsonb_build_object('duplicate', dup and not fresh, 'allocations', rows);
end $$;

-- ---------- hardening ----------
revoke execute on function fin_record_payment(uuid, text, text, bigint, text, date, text, text, jsonb, jsonb, timestamptz, jsonb), fin_allocate_payment(uuid, text, uuid, jsonb, jsonb, timestamptz), fin_invoice_amounts(uuid, uuid) from public, anon, authenticated;
grant execute on function fin_record_payment(uuid, text, text, bigint, text, date, text, text, jsonb, jsonb, timestamptz, jsonb), fin_allocate_payment(uuid, text, uuid, jsonb, jsonb, timestamptz), fin_invoice_amounts(uuid, uuid) to service_role;

-- ---------- supplier truth, both ways: fully allocated = PAID, and nothing but a reversal can say otherwise ----------
-- (20261003090000 refused PAID without allocations; this refuses the opposite hand-written lie: a fully allocated invoice moved away from PAID.)
create or replace function fin_supplier_invoice_truth_guard() returns trigger language plpgsql as $$
declare net bigint;
begin
  select coalesce(sum(amount_cents), 0) into net from fin_payment_allocations where supplier_invoice_id = new.id and merchant_id = new.merchant_id;
  if new.status = 'PAID' and not (coalesce(new.gross_cents, 0) > 0 and net = new.gross_cents) then
    raise exception 'FIN_PAID_REQUIRES_ALLOCATIONS: allocated % of % (cents)', net, coalesce(new.gross_cents, 0);
  end if;
  if coalesce(new.gross_cents, 0) > 0 and net = new.gross_cents and new.status <> 'PAID' then
    raise exception 'FIN_INVOICE_HAS_PAYMENTS: fully allocated, so PAID until a reversal says otherwise';
  end if;
  if tg_op = 'UPDATE' and net <> 0 then
    if new.gross_cents is distinct from old.gross_cents or new.currency is distinct from old.currency or new.status in ('RECEIVED', 'TO_REVIEW', 'REJECTED') then
      raise exception 'FIN_INVOICE_HAS_PAYMENTS: amount, currency and review status are frozen once payments are allocated';
    end if;
  end if;
  new.payment_status := case when net <= 0 then 'unpaid' when coalesce(new.gross_cents, 0) > 0 and net >= new.gross_cents then 'paid' else 'partially_paid' end;
  return new;
end $$;
