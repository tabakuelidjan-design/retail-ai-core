-- Emergency containment, SQL administrator only. This DISABLES restricted runtimes.
-- It deliberately keeps policies, schemas and grants intact and never re-enables service-key fallback.
begin;
update nordla_runtime.principals set enabled=false where enabled;
commit;
