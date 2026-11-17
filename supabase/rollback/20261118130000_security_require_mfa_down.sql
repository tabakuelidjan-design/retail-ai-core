-- Rollback of 20261118130000_security_require_mfa.sql (journal entries MFA_RULE_* stay: identity_events is append-only).
drop function if exists security_set_require_mfa(uuid, uuid, boolean, timestamptz, uuid, text);
drop function if exists security_mfa_noncompliant(uuid);
drop function if exists security_mfa_status(uuid, uuid);
drop table if exists merchant_security_settings;
