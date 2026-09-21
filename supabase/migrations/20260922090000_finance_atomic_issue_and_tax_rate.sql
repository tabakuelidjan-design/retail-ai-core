-- Finance hardening.
-- 1. fin_issue_document(): number allocation + locking + snapshot hash + audit event in ONE transaction.
--    A failure at any point rolls back the sequence increment too, so a crash cannot leave a gap or a burnt number.
--    The document row is locked FOR UPDATE, so two approvers cannot issue the same document, and concurrent
--    issuers of different documents serialise on the sequence row and receive distinct consecutive numbers.
--    The hash is computed here from a canonical JSON string supplied by the app in which the number is a unique
--    placeholder; the database substitutes the allocated number and hashes, so the stored hash equals what the app
--    would compute for the final document.
-- 2. order_lines.tax_rate_bp: the VAT rate the source reported for the line (basis points). Additive, nullable:
--    NULL = not captured (older sync), so VAT-by-rate is reported as unavailable/partial for such lines, never guessed.

create function fin_issue_document(
  p_merchant uuid, p_doc_id uuid, p_expected_version integer, p_new_status text,
  p_prefix text, p_pad integer, p_format text, p_year integer,
  p_canonical text, p_placeholder text, p_locked_at timestamptz, p_event jsonb
) returns jsonb
language plpgsql as $$
declare d fin_documents%rowtype; seq integer; num text; canon text; h text; seq_text text;
begin
  if position('{seq}' in p_format) = 0 then raise exception 'FIN_FORMAT_WITHOUT_SEQ'; end if;
  select * into d from fin_documents where id = p_doc_id and merchant_id = p_merchant for update;
  if not found then raise exception 'FIN_NOT_FOUND'; end if;
  if d.locked_at is not null or d.number is not null or d.version <> p_expected_version then raise exception 'FIN_CONCURRENT_MODIFICATION'; end if;

  seq := fin_next_number(p_merchant, d.doc_type, p_year);
  seq_text := case when length(seq::text) >= p_pad then seq::text else lpad(seq::text, p_pad, '0') end;
  num := replace(replace(replace(p_format, '{prefix}', p_prefix), '{year}', p_year::text), '{seq}', seq_text);
  canon := replace(p_canonical, p_placeholder, num);
  h := encode(extensions.digest(canon, 'sha256'), 'hex');

  update fin_documents set number = num, status = p_new_status, locked_at = p_locked_at, snapshot_hash = h, version = version + 1 where id = p_doc_id;
  insert into fin_events (merchant_id, document_id, at, actor, action, from_status, to_status, detail)
    values (p_merchant, p_doc_id, p_locked_at, p_event -> 'actor', p_event ->> 'action', d.status, p_new_status,
            replace((p_event -> 'detail')::text, p_placeholder, num)::jsonb);
  return (select to_jsonb(x) from fin_documents x where x.id = p_doc_id);
end $$;

alter table order_lines add column tax_rate_bp integer;
comment on column order_lines.tax_rate_bp is
  'VAT rate reported by the source for this line, in basis points (2100 = 21%). 0 = the source reported no tax lines. NULL = not captured (synced before this column existed) or several different rates on one line.';
