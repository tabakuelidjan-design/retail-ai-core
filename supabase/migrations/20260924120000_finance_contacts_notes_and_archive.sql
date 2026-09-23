-- Contacts V1: two additive, nullable fields on fin_companies (the same canonical Contact store as Phase 1/2).
-- Neither changes existing data or existing queries; both default to absent (no notes, not archived).

-- Internal note about the contact, visible only in the Finance dashboard - never printed on a document.
alter table fin_companies add column notes text;

-- Archiving hides a contact from the active views without deleting it or touching its documents/relations.
-- A non-null value means archived (at that timestamp); null (the default) means active.
alter table fin_companies add column archived_at timestamptz;

-- Supports filtering the active/archived views without a full scan.
create index fin_companies_archived_idx on fin_companies (merchant_id, archived_at);
