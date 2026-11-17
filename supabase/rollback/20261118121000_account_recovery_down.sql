-- Rollback of 20261118121000_account_recovery.sql (the journal entries RECOVERY_* stay: identity_events is append-only).
drop function if exists recovery_consume(text, timestamptz, uuid, text);
drop function if exists recovery_lookup(text, timestamptz);
drop function if exists recovery_issue(uuid, uuid, uuid, text, timestamptz, timestamptz, uuid, text);
drop table if exists member_recovery_links;
