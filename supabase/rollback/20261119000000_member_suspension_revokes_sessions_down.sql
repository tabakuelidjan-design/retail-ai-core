-- Rollback of 20261119000000_member_suspension_revokes_sessions.sql: sessions already revoked stay revoked (a revocation is final); only the trigger goes away.
drop trigger if exists merchant_members_revoke_sessions_trg on merchant_members;
drop function if exists merchant_members_revoke_sessions();
