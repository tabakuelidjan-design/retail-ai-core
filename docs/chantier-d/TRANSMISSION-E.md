# Transmission officielle de D au chantier E : `alternative_to` et faits de prix

Date : 2026-10-17. Destinataire : chantier E (session « Social Publishing audit et workflow », branche `feature/social-publishing-e`).

**Statut de la transmission** : la session de E n'est **pas joignable** par messagerie inter-sessions depuis la session D (« No agent named … is reachable »). Ce document est donc la transmission : il est versionné sur la branche D (lisible par E sans rien modifier chez E) et son texte est repris ci-dessous pour être transmis par le propriétaire. Aucun fichier de la branche E n'a été modifié.

---

**Objet : proposition `alternative_to` pour `social-post-proposal.v1` (double approbation de variantes) et deux faits de prix à enregistrer.**

**Le problème, prouvé.** Sur votre code (`feature/social-publishing-e` @ `879198d`) : importer l'original `reserve:P01` et une variante `d:D1` qui déclare `alternative_to`, puis approuver les deux donne `reserve:P01 : APPROVED | d:D1 : APPROVED`. Le champ est ignoré et jamais stocké. D livre des variantes visuelles (D1/D2/D3) de P01, S01 et P02 de la réserve : rien n'empêche de publier les deux.

**La proposition** (champ optionnel, `schema` inchangé) : `"alternative_to": ["habb-editorial-2026-10-16:P01"]`, 0 à 5 identifiants de proposition. Un créneau = plateforme + format. La relation est stockée sur la variante et résolue à chaque contrôle, dans les deux sens : l'ordre d'import est sans effet et une réimportation ne peut pas l'oublier. Un créneau est tenu par `APPROVED`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `VERIFIED` ou `PUBLICATION_UNKNOWN`. `approve`, `schedule`, `retry` et `mark_manual_schedule` sont refusés (`SOCIAL_CONFLICT`, `EXCLUSIVE_VARIANT_ALREADY_HOLDS_THE_SLOT`) tant qu'un rival tient le créneau ; le publisher refuse en plus de publier si un rival est déjà publié (`ERROR EXCLUSIVE_VARIANT_PUBLISHED`). Le champ n'entre dans l'empreinte du contenu que s'il est non vide : l'empreinte de tout post existant est inchangée (testé contre une valeur de référence calculée avant le changement), donc aucune approbation existante n'est invalidée. L'ajouter à un post déjà approuvé annule son approbation.

**Les preuves.**
- Patch : `docs/chantier-d/e-proposals/alternative-to.patch` sur la branche D `feature/chantier-d-branding-creative-pole` (dépôt `retail-ai-core`), commit `97a7335` ou ultérieur. S'applique sans conflit (`git apply --ignore-whitespace`) sur `879198d`.
- Sur une copie de travail hors de votre dépôt : 9 nouveaux tests (EX-1 à EX-9) + votre suite sociale existante = **66/66**. Garde du service retirée : 6 tests échouent ; garde du publisher retirée : EX-7 échoue.
- GitHub : la CI de D applique ce patch à son propre checkout jetable de votre branche. Run `38948667155` (commit `97a7335`), Node 20 et 24 : tests D contre votre code patché **9/9**, votre suite sociale avec le patch **66 tests, 65 réussis, 1 ignoré (chez vous), 0 échec**.
- Détail : `docs/chantier-d/PROPOSITION-E-ALTERNATIVE-TO.md`.

**Limite connue.** Fenêtre de concurrence entre deux approbations strictement simultanées (le magasin sérialise par post, pas globalement) ; la défense du publisher et `exclusivityConflicts()` la couvrent en partie.

**Faits de prix à enregistrer** (`docs/chantier-d/e-proposals/confirmed-facts-prices.json`). Décision du propriétaire : « 25 € » est le prix boutique ; le prix en ligne est la valeur lue sur Shopify. Lecture directe (Admin GraphQL, lecture seule, **2026-10-17**) : les **83 coques** de la collection « Coques personnalisées », 1 variante chacune, **25,00 €**, sans prix barré. Deux entrées datées et sourcées sont proposées : `coque-25-boutique` (canal `IN_STORE`) et `coque-25-web` (canal `WEB`, source Shopify). Vos filtres ne lisent que `excerpts` et `requires` : les clés `channel` et `verified_value` sont facultatives et sans effet chez vous. **Tant que `coque-25-web` n'est pas enregistrée chez E, D ne produit aucun texte citant le prix en ligne**, et aucune autre valeur du prix en ligne n'est à conserver.

**Rappel.** Les variantes D1–D3 sont en **démonstration interne** (droits des rendus de coques non confirmés), non publiables ; leurs notes le disent. D ne touchera pas votre branche : merci d'indiquer si vous adoptez, adaptez ou refusez la proposition.
