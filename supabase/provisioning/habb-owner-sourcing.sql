-- PROVISIONING (not a migration) - run ONCE, by hand, AFTER the owner's explicit go, on the project where the identity sequence
-- (20260928120000..150000 + 20261015093000) is applied. Merchant data only: HABB is configuration, never code.
--   :owner_user_id = the id of the owner's Supabase Auth account, created by the OWNER in the Supabase dashboard
--                    (Authentication > Users > Add user, password chosen by the owner, never written in a chat or a file).
-- What it does, in ONE transaction, through the identity functions only (each writes its identity_events entry):
--   1. the owner becomes the ACTIVE OWNER member of HABB;  2. the 'sourcing' module is ACTIVE for HABB.
-- Rollback: select identity_module_set('<HABB>', 'sourcing', 'SUSPENDED', 'provisioning:manual', now(), gen_random_uuid());
--           (a membership is never deleted; suspending the module closes every Sourcing session at its next request).
-- Expected answers: {"ok": true, "code": "BOOTSTRAPPED"} then {"ok": true, "code": "MODULE_ENABLED"}. Anything else: stop, nothing else is run.
begin;
select identity_member_bootstrap_owner('36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5'::uuid, :'owner_user_id'::uuid, now(), gen_random_uuid(), 'sourcing');
select identity_module_set('36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5'::uuid, 'sourcing', 'ACTIVE', 'provisioning:manual', now(), gen_random_uuid());
commit;
