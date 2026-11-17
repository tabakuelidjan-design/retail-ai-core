-- Paramètres -> Général, 7th rubric "Objectifs et priorités": the section list of merchant_general_sections gains 'objectives'.
-- Only a CHECK constraint is replaced (widened); no row is touched. Rollback: restore the 4-value check (refused while an 'objectives' row exists: delete it first).
alter table merchant_general_sections drop constraint merchant_general_sections_section_check;
alter table merchant_general_sections add constraint merchant_general_sections_section_check check (section in ('profile', 'activity', 'selling_modes', 'legal', 'objectives'));
