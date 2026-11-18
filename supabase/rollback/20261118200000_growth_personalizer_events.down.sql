-- Rollback of 20261118200000_growth_personalizer_events.sql: removes the shop's personalizer technical events (aggregates of steps; nothing else references them).
drop table if exists public.growth_personalizer_events;
