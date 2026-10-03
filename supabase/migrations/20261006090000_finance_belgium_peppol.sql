-- Finance - BELGIUM & PEPPOL FINALIZATION. Builds on 20261003090000, 20261004090000, 20261005090000 (none applied to production yet: apply in order).
-- ADDITIVE ONLY: three new tables (the three of the frozen architecture), their guards and RPCs. Nothing dropped, nothing rewritten. No production migration is run by this repository.
-- ROLLBACK (documented, destructive of the NEW tables only, run by hand if ever needed before any real data exists in them):
--   drop function if exists fin_peppol_enqueue, fin_peppol_transition, fin_peppol_inbound_register, fin_seller_profile_record, fin_vcs_valid, fin_artifacts_guard, fin_peppol_messages_guard, fin_seller_profile_versions_guard;
--   drop table if exists fin_peppol_messages, fin_artifacts, fin_seller_profile_versions;
--
-- THE MODEL
--   fin_seller_profile_versions  append-only versions of the seller profile (legal identity, address, IBAN, Peppol id, fiscal facts). A document keeps ITS OWN issue snapshot (fin_documents.body, hash-locked);
--                                the version is the lineage: which profile was in force, by hash. Changing the profile creates version N+1; nothing historical changes.
--   fin_artifacts                durable metadata of legal artifacts: the EXACT bytes (kept in the storage behind storage_ref), SHA-256, size, media type, provenance, original/regenerated classification, retention class.
--                                Immutable (no update except legal_hold, no delete). One ORIGINAL PDF and one ORIGINAL structured document per issued document; the Belgian payment reference (VCS/OGM) is stored once, here,
--                                valid (mod 97) and unique per merchant.
--   fin_peppol_messages          one row per Peppol message, OUT or IN: guarded state machine, idempotency key, attempts, provider message id, validation summary, linkage to document / supplier invoice / artifacts. No secrets.
-- STATE MACHINE (database-enforced)
--   OUT: QUEUED -> SUBMITTING -> SUBMITTED -> DELIVERED | DELIVERY_FAILED ; SUBMITTING -> SUBMISSION_FAILED -> QUEUED (explicit retry) ; VALIDATION_FAILED is terminal (never queued, never sent).
--   IN : RECEIVED -> TO_REVIEW -> ACCEPTED | REJECTED ; RECEIVED -> VALIDATION_FAILED -> TO_REVIEW (a failed validation is shown to a person, never auto-accepted) ; DUPLICATE is terminal.
--   HTTP 200 from a provider is NOT delivery: SUBMITTED means the provider took it, DELIVERED needs a delivery status.
-- IDEMPOTENCY: one OUT message per logical document (unique (merchant, document)); the claim QUEUED -> SUBMITTING is a compare-and-set under the row lock, so concurrent senders get exactly one claim.
--   An inbound message is registered once per (provider, provider message id) and once per document hash; a business duplicate (same sender endpoint + document id + issue date) is registered as DUPLICATE.

-- ---------- VCS / OGM (Febelfin): 12 digits, last two = (first ten) mod 97, 97 when 0 ----------
create function fin_vcs_valid(p text) returns boolean language sql immutable as $$
  select p ~ '^[0-9]{12}$' and (substr(p, 11, 2))::int = case when (substr(p, 1, 10))::bigint % 97 = 0 then 97 else (substr(p, 1, 10))::bigint % 97 end
$$;

-- ---------- seller profile versions ----------
create table fin_seller_profile_versions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  version integer not null check (version > 0),
  profile jsonb not null,
  profile_sha256 text not null check (profile_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from timestamptz not null default now(),
  created_by jsonb,
  created_at timestamptz not null default now(),
  constraint fin_seller_profile_versions_uq unique (merchant_id, version),
  constraint fin_seller_profile_versions_hash_uq unique (merchant_id, profile_sha256),
  constraint fin_seller_profile_versions_id_merchant_uq unique (id, merchant_id)
);
create function fin_seller_profile_versions_guard() returns trigger language plpgsql as $$
begin raise exception 'FIN_SELLER_PROFILE_VERSIONS_ARE_APPEND_ONLY'; end $$;
create trigger fin_seller_profile_versions_guard_trg before update or delete on fin_seller_profile_versions for each row execute function fin_seller_profile_versions_guard();
alter table fin_seller_profile_versions enable row level security;
revoke all on fin_seller_profile_versions from anon, authenticated;

-- records a profile: the SAME content (hash) is the same version (idempotent, concurrency-safe); new content is version max+1
create function fin_seller_profile_record(p_merchant uuid, p_profile jsonb, p_sha256 text, p_actor jsonb, p_at timestamptz)
returns jsonb language plpgsql as $$
declare cur fin_seller_profile_versions%rowtype; nxt integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('fin_seller_profile:' || p_merchant::text, 0));
  select * into cur from fin_seller_profile_versions where merchant_id = p_merchant and profile_sha256 = p_sha256;
  if found then return jsonb_build_object('duplicate', true, 'version', to_jsonb(cur)); end if;
  select coalesce(max(version), 0) + 1 into nxt from fin_seller_profile_versions where merchant_id = p_merchant;
  insert into fin_seller_profile_versions (merchant_id, version, profile, profile_sha256, effective_from, created_by) values (p_merchant, nxt, p_profile, p_sha256, coalesce(p_at, now()), p_actor) returning * into cur;
  return jsonb_build_object('duplicate', false, 'version', to_jsonb(cur));
end $$;

-- ---------- artifacts ----------
create table fin_artifacts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  kind text not null check (kind in ('PDF_ORIGINAL', 'STRUCTURED_ORIGINAL', 'INBOUND_ORIGINAL', 'ATTACHMENT', 'REGENERATED_COPY')),
  classification text not null check (classification in ('ORIGINAL', 'REGENERATED')),
  document_id uuid,
  supplier_invoice_id uuid,
  peppol_message_id uuid,
  parent_artifact_id uuid,
  storage_ref text not null check (length(storage_ref) between 1 and 500),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes >= 0),
  media_type text not null check (length(media_type) between 3 and 120),
  file_name text check (file_name is null or length(file_name) <= 200),
  payment_reference text,
  retention_class text not null default 'FISCAL_DOCUMENT' check (retention_class in ('FISCAL_DOCUMENT', 'SUPPORTING_DOCUMENT', 'TECHNICAL', 'REGENERATED_COPY')),
  legal_hold boolean not null default false,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint fin_artifacts_id_merchant_uq unique (id, merchant_id),
  constraint fin_artifacts_document_fk foreign key (document_id, merchant_id) references fin_documents (id, merchant_id),
  constraint fin_artifacts_supplier_fk foreign key (supplier_invoice_id, merchant_id) references fin_supplier_invoices (id, merchant_id),
  constraint fin_artifacts_parent_fk foreign key (parent_artifact_id, merchant_id) references fin_artifacts (id, merchant_id),
  constraint fin_artifacts_original_has_class check ((kind = 'REGENERATED_COPY') = (classification = 'REGENERATED')),
  constraint fin_artifacts_vcs_valid check (payment_reference is null or fin_vcs_valid(payment_reference)),
  constraint fin_artifacts_vcs_only_pdf_original check (payment_reference is null or kind = 'PDF_ORIGINAL'),
  constraint fin_artifacts_owner check (document_id is not null or supplier_invoice_id is not null or peppol_message_id is not null)
);
-- exactly ONE original PDF and ONE original structured document per issued document; one inbound original per message
create unique index fin_artifacts_pdf_original_uq on fin_artifacts (merchant_id, document_id) where kind = 'PDF_ORIGINAL';
create unique index fin_artifacts_structured_original_uq on fin_artifacts (merchant_id, document_id) where kind = 'STRUCTURED_ORIGINAL';
create unique index fin_artifacts_inbound_original_uq on fin_artifacts (merchant_id, peppol_message_id) where kind = 'INBOUND_ORIGINAL';
-- the Belgian payment reference is unique within the merchant
create unique index fin_artifacts_payment_reference_uq on fin_artifacts (merchant_id, payment_reference) where payment_reference is not null;
-- the same bytes are never stored twice under the same owner and kind
create unique index fin_artifacts_content_uq on fin_artifacts (merchant_id, kind, sha256, coalesce(document_id, supplier_invoice_id, peppol_message_id));
create index fin_artifacts_document_idx on fin_artifacts (merchant_id, document_id);
create function fin_artifacts_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'FIN_ARTIFACTS_ARE_IMMUTABLE: no delete (retention is a policy, nothing is deleted automatically)'; end if;
  if (to_jsonb(new) - 'legal_hold') is distinct from (to_jsonb(old) - 'legal_hold') then raise exception 'FIN_ARTIFACTS_ARE_IMMUTABLE: only legal_hold can change'; end if;
  return new;
end $$;
create trigger fin_artifacts_guard_trg before update or delete on fin_artifacts for each row execute function fin_artifacts_guard();
alter table fin_artifacts enable row level security;
revoke all on fin_artifacts from anon, authenticated;

-- ---------- Peppol messages ----------
create table fin_peppol_messages (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  direction text not null check (direction in ('OUT', 'IN')),
  document_id uuid,
  supplier_invoice_id uuid,
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  document_version text,
  provider text not null check (length(provider) between 1 and 60),
  provider_message_id text check (provider_message_id is null or length(provider_message_id) <= 200),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,200}$'),
  state text not null check (state in ('QUEUED', 'SUBMITTING', 'SUBMITTED', 'DELIVERED', 'VALIDATION_FAILED', 'SUBMISSION_FAILED', 'DELIVERY_FAILED', 'RECEIVED', 'TO_REVIEW', 'ACCEPTED', 'REJECTED', 'DUPLICATE')),
  attempts integer not null default 0 check (attempts >= 0),
  sender_endpoint text check (sender_endpoint is null or length(sender_endpoint) <= 120),
  receiver_endpoint text check (receiver_endpoint is null or length(receiver_endpoint) <= 120),
  business_key text check (business_key is null or length(business_key) <= 300),
  duplicate_of uuid,
  validation jsonb,
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_.:-]{1,80}$'),
  queued_at timestamptz,
  last_attempt_at timestamptz,
  submitted_at timestamptz,
  delivered_at timestamptz,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fin_peppol_messages_id_merchant_uq unique (id, merchant_id),
  constraint fin_peppol_messages_key_uq unique (merchant_id, direction, idempotency_key),
  constraint fin_peppol_messages_document_fk foreign key (document_id, merchant_id) references fin_documents (id, merchant_id),
  constraint fin_peppol_messages_supplier_fk foreign key (supplier_invoice_id, merchant_id) references fin_supplier_invoices (id, merchant_id),
  constraint fin_peppol_messages_duplicate_fk foreign key (duplicate_of, merchant_id) references fin_peppol_messages (id, merchant_id),
  constraint fin_peppol_messages_direction_state check ((direction = 'OUT' and state in ('QUEUED', 'SUBMITTING', 'SUBMITTED', 'DELIVERED', 'VALIDATION_FAILED', 'SUBMISSION_FAILED', 'DELIVERY_FAILED'))
    or (direction = 'IN' and state in ('RECEIVED', 'TO_REVIEW', 'ACCEPTED', 'REJECTED', 'VALIDATION_FAILED', 'DUPLICATE'))),
  constraint fin_peppol_messages_out_document check (direction <> 'OUT' or document_id is not null)
);
create unique index fin_peppol_messages_out_document_uq on fin_peppol_messages (merchant_id, document_id) where direction = 'OUT';
create unique index fin_peppol_messages_provider_id_uq on fin_peppol_messages (merchant_id, direction, provider, provider_message_id) where provider_message_id is not null and state <> 'DUPLICATE';
create unique index fin_peppol_messages_in_hash_uq on fin_peppol_messages (merchant_id, document_sha256) where direction = 'IN' and state <> 'DUPLICATE';
create unique index fin_peppol_messages_in_business_uq on fin_peppol_messages (merchant_id, business_key) where direction = 'IN' and business_key is not null and state <> 'DUPLICATE';
create index fin_peppol_messages_queue_idx on fin_peppol_messages (merchant_id, direction, state, queued_at);
alter table fin_artifacts add constraint fin_artifacts_message_fk foreign key (peppol_message_id, merchant_id) references fin_peppol_messages (id, merchant_id);

create function fin_peppol_messages_guard() returns trigger language plpgsql as $$
declare ok boolean;
begin
  if tg_op = 'DELETE' then raise exception 'FIN_PEPPOL_MESSAGES_ARE_NOT_DELETABLE'; end if;
  if new.merchant_id <> old.merchant_id or new.direction <> old.direction or new.document_id is distinct from old.document_id or new.idempotency_key <> old.idempotency_key
     or new.document_sha256 <> old.document_sha256 or new.provider <> old.provider or new.created_at <> old.created_at then raise exception 'FIN_PEPPOL_MESSAGE_IDENTITY_IS_IMMUTABLE'; end if;
  if new.state <> old.state then
    ok := (old.state, new.state) in (('QUEUED', 'SUBMITTING'), ('SUBMITTING', 'SUBMITTED'), ('SUBMITTING', 'SUBMISSION_FAILED'), ('SUBMISSION_FAILED', 'QUEUED'), ('SUBMITTED', 'DELIVERED'), ('SUBMITTED', 'DELIVERY_FAILED'), ('SUBMITTING', 'QUEUED'),
      ('RECEIVED', 'TO_REVIEW'), ('RECEIVED', 'VALIDATION_FAILED'), ('VALIDATION_FAILED', 'TO_REVIEW'), ('TO_REVIEW', 'ACCEPTED'), ('TO_REVIEW', 'REJECTED'), ('RECEIVED', 'DUPLICATE'));
    if not ok then raise exception 'FIN_PEPPOL_INVALID_TRANSITION: % -> %', old.state, new.state; end if;
  end if;
  if new.attempts < old.attempts then raise exception 'FIN_PEPPOL_ATTEMPTS_CANNOT_DECREASE'; end if;
  new.updated_at := now(); return new;
end $$;
create trigger fin_peppol_messages_guard_trg before update or delete on fin_peppol_messages for each row execute function fin_peppol_messages_guard();
alter table fin_peppol_messages enable row level security;
revoke all on fin_peppol_messages from anon, authenticated;

-- enqueue an outbound message: ONE per logical document (the same document again returns it; a different document hash for the same document id is refused)
create function fin_peppol_enqueue(p_merchant uuid, p_document uuid, p_key text, p_sha256 text, p_provider text, p_state text, p_validation jsonb, p_sender text, p_receiver text, p_doc_version text, p_error text, p_at timestamptz)
returns jsonb language plpgsql as $$
declare m fin_peppol_messages%rowtype;
begin
  if p_state not in ('QUEUED', 'VALIDATION_FAILED') then raise exception 'FIN_PEPPOL_INVALID_INITIAL_STATE: %', p_state; end if;
  perform pg_advisory_xact_lock(hashtextextended('fin_peppol_out:' || p_merchant::text || ':' || p_document::text, 0));
  select * into m from fin_peppol_messages where merchant_id = p_merchant and direction = 'OUT' and document_id = p_document;
  if found then
    if m.document_sha256 <> p_sha256 then raise exception 'FIN_PEPPOL_DOCUMENT_CHANGED: the logical document already has a message for other bytes'; end if;
    return jsonb_build_object('duplicate', true, 'message', to_jsonb(m));
  end if;
  insert into fin_peppol_messages (merchant_id, direction, document_id, document_sha256, document_version, provider, idempotency_key, state, sender_endpoint, receiver_endpoint, validation, error_code, queued_at)
    values (p_merchant, 'OUT', p_document, p_sha256, p_doc_version, p_provider, p_key, p_state, p_sender, p_receiver, p_validation, p_error, case when p_state = 'QUEUED' then coalesce(p_at, now()) end) returning * into m;
  return jsonb_build_object('duplicate', false, 'message', to_jsonb(m));
end $$;

-- compare-and-set transition: succeeds only when the row is currently in one of the expected states (that is what makes "exactly one claim" true under concurrency)
create function fin_peppol_transition(p_merchant uuid, p_id uuid, p_from jsonb, p_to text, p_patch jsonb, p_at timestamptz)
returns jsonb language plpgsql as $$
declare m fin_peppol_messages%rowtype;
begin
  select * into m from fin_peppol_messages where id = p_id and merchant_id = p_merchant for update;
  if not found then raise exception 'FIN_PEPPOL_MESSAGE_NOT_FOUND'; end if;
  if not (p_from ? m.state) then return jsonb_build_object('changed', false, 'message', to_jsonb(m)); end if;
  update fin_peppol_messages set state = p_to,
    attempts = attempts + case when p_to = 'SUBMITTING' then 1 else 0 end,
    last_attempt_at = case when p_to = 'SUBMITTING' then coalesce(p_at, now()) else last_attempt_at end,
    queued_at = case when p_to = 'QUEUED' then coalesce(p_at, now()) else queued_at end,
    submitted_at = case when p_to = 'SUBMITTED' then coalesce(p_at, now()) else submitted_at end,
    delivered_at = case when p_to = 'DELIVERED' then coalesce(p_at, now()) else delivered_at end,
    provider_message_id = coalesce(p_patch ->> 'providerMessageId', provider_message_id),
    error_code = case when p_patch ? 'errorCode' then p_patch ->> 'errorCode' when p_to in ('SUBMITTED', 'DELIVERED', 'QUEUED', 'TO_REVIEW', 'ACCEPTED') then null else error_code end,
    validation = coalesce(p_patch -> 'validation', validation),
    supplier_invoice_id = coalesce((p_patch ->> 'supplierInvoiceId')::uuid, supplier_invoice_id)
    where id = p_id returning * into m;
  return jsonb_build_object('changed', true, 'message', to_jsonb(m));
end $$;

-- register an inbound message: once per (provider, provider message id), once per document hash; a business duplicate becomes DUPLICATE pointing at the first message
create function fin_peppol_inbound_register(p_merchant uuid, p_provider text, p_provider_message_id text, p_key text, p_sha256 text, p_sender text, p_receiver text, p_business_key text, p_validation jsonb, p_at timestamptz)
returns jsonb language plpgsql as $$
declare m fin_peppol_messages%rowtype; first fin_peppol_messages%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('fin_peppol_in:' || p_merchant::text, 0));
  select * into first from fin_peppol_messages where merchant_id = p_merchant and direction = 'IN' and state <> 'DUPLICATE'
    and ((provider = p_provider and provider_message_id = p_provider_message_id) or document_sha256 = p_sha256 or (p_business_key is not null and business_key = p_business_key)) order by created_at limit 1;
  if found then
    select * into m from fin_peppol_messages where merchant_id = p_merchant and direction = 'IN' and idempotency_key = p_key;
    if found then return jsonb_build_object('duplicate', true, 'message', to_jsonb(m), 'first', to_jsonb(first)); end if;
    insert into fin_peppol_messages (merchant_id, direction, document_sha256, provider, provider_message_id, idempotency_key, state, sender_endpoint, receiver_endpoint, business_key, duplicate_of, received_at)
      values (p_merchant, 'IN', p_sha256, p_provider, null, p_key, 'DUPLICATE', p_sender, p_receiver, null, first.id, coalesce(p_at, now())) returning * into m;
    return jsonb_build_object('duplicate', true, 'message', to_jsonb(m), 'first', to_jsonb(first));
  end if;
  insert into fin_peppol_messages (merchant_id, direction, document_sha256, provider, provider_message_id, idempotency_key, state, sender_endpoint, receiver_endpoint, business_key, validation, received_at)
    values (p_merchant, 'IN', p_sha256, p_provider, p_provider_message_id, p_key, 'RECEIVED', p_sender, p_receiver, p_business_key, p_validation, coalesce(p_at, now())) returning * into m;
  return jsonb_build_object('duplicate', false, 'message', to_jsonb(m));
end $$;

revoke all on function fin_vcs_valid(text), fin_seller_profile_record(uuid, jsonb, text, jsonb, timestamptz), fin_peppol_enqueue(uuid, uuid, text, text, text, text, jsonb, text, text, text, text, timestamptz),
  fin_peppol_transition(uuid, uuid, jsonb, text, jsonb, timestamptz), fin_peppol_inbound_register(uuid, text, text, text, text, text, text, text, jsonb, timestamptz) from public, anon, authenticated;
