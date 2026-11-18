// Migration 20261119000000 (branch fix/team-removal-revokes-sessions): static contract. The behaviour itself was proven on the staging database in a ROLLED-BACK transaction with the
// fictional test accounts (removal closes every open session of that member in that merchant; a later re-invitation does not revive them; another member and a role change are untouched).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const up = readFileSync(new URL('../supabase/migrations/20261119000000_member_suspension_revokes_sessions.sql', import.meta.url), 'utf8');
const down = readFileSync(new URL('../supabase/rollback/20261119000000_member_suspension_revokes_sessions_down.sql', import.meta.url), 'utf8');
test('the trigger fires only when a membership BECOMES suspended, revokes only that member in that merchant, and is reversible', () => {
  assert.match(up, /after update of status on merchant_members/);
  assert.match(up, /when \(new\.status = 'SUSPENDED' and old\.status is distinct from 'SUSPENDED'\)/);
  assert.match(up, /where merchant_id = new\.merchant_id and user_id = new\.user_id and revoked_at is null/);
  assert.match(up, /revoked_reason = 'REVOKED'/);
  assert.match(up, /security definer set search_path = ''/);
  assert.match(up, /revoke execute on function merchant_members_revoke_sessions\(\) from public, anon, authenticated/);
  assert.doesNotMatch(up, /\b(delete|drop|truncate)\b\s+(from|table|function|trigger)/i);
  assert.match(down, /drop trigger if exists merchant_members_revoke_sessions_trg/);
  assert.match(down, /drop function if exists merchant_members_revoke_sessions\(\)/);
});
