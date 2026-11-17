-- Rollback of 20261118140000_member_preferences.sql. Drops the personal preferences and saved views (nothing else depends on them; no permission is derived from them).
-- Back up first if people have saved views: select count(*) from member_saved_views; select count(*) from member_preferences;
drop table if exists member_saved_views;
drop table if exists member_preferences;
