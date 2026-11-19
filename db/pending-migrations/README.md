# Migrations en attente de relecture - NE PAS DÉPLACER DANS supabase/migrations/

Ces trois migrations (pilote Analyses et rôles de lecture/contrôle d'accès) ne doivent être appliquées sur aucun environnement
sans relecture et décision explicite. Elles sont **hors** de `supabase/migrations/`, donc un `supabase db push` ne les prend pas.

- `20261119160000_analytics_reader_pilot_read.sql` - rôle de lecture pilote (merchants, merchant_connectors, sync_runs)
- `20261119170000_analytics_report_roles.sql` - rôles du processus enfant des rapports (lecture 13 tables, écriture data_quality_flags)
- `20261119180000_analytics_access_checker_roles.sql` - rôle du contrôle d'accès SSO (members, entitlements, MFA)
- `rollback/*.down.sql` - retours arrière correspondants

Les tests de rejeu (`db/staging-replay/`) appliquent ces fichiers explicitement, sur base jetable uniquement.
