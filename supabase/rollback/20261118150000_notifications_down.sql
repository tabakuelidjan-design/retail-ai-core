-- Rollback of 20261118150000_notifications.sql. Drops the alerts and the personal choices (nothing else depends on them; check first: select count(*) from notifications;).
drop table if exists notification_preferences;
drop table if exists notifications;
