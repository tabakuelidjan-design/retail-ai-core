-- Rollback of 20261118120000_security_mfa_recovery_codes.sql: removes the recovery codes only (accounts that rely on a recovery code lose that way in; their authenticator still works).
drop table if exists mfa_recovery_codes;
