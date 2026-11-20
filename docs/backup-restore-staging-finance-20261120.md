# Sauvegarde et restauration — staging Finance (état actuel, 2026-11-20)

Périmètre : projet Supabase `fvhiammdskpcnfodsnrc` (staging), service Railway `finance-staging`, marchand de test `67646dbb-5e2e-4cd7-aad6-0ab289b068cb` (« HABB (test staging) »). Données fictives uniquement. Aucune donnée réelle HABB, aucun changement de production, aucun abonnement modifié.

## 1. État actuel unique

| Élément | État |
|---|---|
| Sauvegarde des six tables Finance du marchand de test | **faite** (export REST, 2026-11-20) |
| Sauvegarde des huit fichiers archivés | **faite** (hachages vérifiés contre la base) |
| Restauration dans une base locale jetable | **faite et vérifiée** (données, fichiers, audits, refus) |
| Sauvegarde PostgreSQL complète (schéma système, extensions, séquences, toutes les tables) | **non faite** : aucun accès administrateur à la base depuis ce poste ou le conteneur |
| Restauration sur une instance Supabase dédiée | **non faite** : hors périmètre demandé |
| Sauvegardes régulières automatiques | **non en place** (voir §4) |

## 2. Ce qui a été sauvegardé et restauré

Six tables Finance (marchand de test) : `fin_companies` 1, `fin_documents` 8, `fin_artifacts` 8, `fin_events` 44, `fin_seller_profile_versions` 1, `fin_number_sequences` 2.

Huit fichiers archivés (bucket `finance-inbox`, préfixés par le marchand) : deux PDF et un XML par document émis, chacun vérifié par SHA-256 contre `fin_artifacts.sha256`.

Restauration : base locale jetable (cluster de test, jamais staging) ; schéma, rôles, appartenances, droits et politiques rejoués depuis les migrations du dépôt (v1 à v7) ; données rechargées ; fichiers écrits dans un dossier isolé ; audits pilote à zéro écart ; refus vérifiés (le rôle d'archive ne lit pas `fin_documents` ; le rôle de lecture ne peut pas écrire ; sans liaison de login, le rôle d'archive ne voit aucun artefact).

## 3. Données HABB essentielles encore absentes de cette sauvegarde

Comptage réel sur le marchand de test (toutes tables ayant une colonne `merchant_id`). Les tables à zéro ne sont pas listées.

- **Comptes bancaires et paiements** : `fin_bank_accounts` 1, `fin_bank_transactions` 2, `fin_bank_reconciliations` 4, `fin_payment_allocations` 1, `fin_payment_registry` 1, `fin_bank_connections` 0, `fin_payments` 0.
- **Achats** : `fin_supplier_invoices` 4.
- **Commandes et remboursements** : `orders` 31, `order_lines` 39, `order_attribution` 0, `refunds` 2, `refund_lines` 2.
- **Trésorerie** : `fin_cash_counts` 0, `fin_cash_movements` 0 (rien à sauvegarder pour l'instant).
- **Paramètres et identité** : `merchant_profile` 1, `merchant_establishments` 1, `merchant_general_sections` 5, `module_entitlements` 4, `merchant_members` 16, `merchant_invitations` 9, `merchant_security_settings` 0, `member_recovery_links` 2 (à traiter avec précaution : secrets de récupération).
- **Croissance et notifications** : `growth_follow_up` 1, `growth_funnel_snapshot` 1, `growth_personalizer_events` 13, `notifications` 3, `identity_events` 548.
- **Non nécessaires à restaurer** : `app_sessions` 184 (sessions expirées), `provider_oauth_sessions` 0.
- **Hors base** : le volume Railway `/app/data` (2 entrées en haut de niveau, non examinées), les logos et réglages stockés localement.

Les `merchant_*` ne font partie d'aucune sauvegarde faite à ce jour.

## 4. Sauvegardes régulières nécessaires

1. **Base complète** : export logique quotidien (format custom, schéma et données), avec les rôles reconstruits depuis les migrations. Nécessite un accès administrateur PostgreSQL, à stocker hors du dépôt.
2. **Stockage** : copie quotidienne du bucket `finance-inbox` et du volume `/app/data`, avec vérification des hachages.
3. **Rétention** : au moins 30 jours, avec une copie hors du projet Supabase.
4. **Test de restauration** : mensuel, comme celui de ce jour, dans une base isolée.
5. **Alerte** : échec d'une sauvegarde signalé au propriétaire.

Ces mécanismes ne sont pas en place. Les mettre en place demande un accès administrateur et un choix d'outillage du propriétaire.

## 5. Accès et limites constatés

- Conteneur staging : ni `pg_dump`, ni `psql`, ni `pg_restore`.
- Aucune variable de connexion administrateur à la base dans le service. Seule l'URL du login pilote restreint (`nordla_fin_pilot_staging`) y figure : elle ne lit que son marchand, via les rôles limités.
- Clé de service : présente uniquement dans le conteneur ; elle a servi à l'export REST et à la lecture du stockage, sans être copiée sur le poste.
- Accès SSH : ouvert par une clé temporaire, retirée après usage.

## 6. Reste à faire pour une sauvegarde complète

Sans accès administrateur PostgreSQL ni outil de sauvegarde côté plateforme, la sauvegarde complète ne peut pas être réalisée. C'est l'obstacle principal à lever par le propriétaire.

## 7. Inventaire du périmètre HABB (état au 2026-11-20, mise à jour)

**Services staging (projet Railway `app.nordla.app`, environnement staging)** : tous les services Nordla partagent le même projet Supabase de staging (`fvhiammdskpcnfodsnrc`) pour la base et le stockage. Une sauvegarde de la base couvre donc les lignes de tous les services ; elle ne couvre pas les volumes.

| Service | Volume | Contenu | Sauvegardé |
|---|---|---|---|
| finance-staging | `finance-staging-volume` → `/app/data` (87 Mo) | réglages, logo, données locales | **non** (contenu non listé : accès SSH refusé) |
| sourcing-staging | `sourcing-staging-data` → `/app/data` (50 Mo) | données Sourcing | **non** |
| analytics-staging | `analytics-staging-volume` → `/app/reports` (139 Mo) | rapports | **non** |
| growth-staging, growth-staging Copy, core-staging, shopify-stub-staging | aucun volume | base uniquement | base : oui (même projet) |

**Source de vérité commerciale HABB** : la boutique Shopify (`habb.be`), non présente dans ce staging (stub). Commandes, produits, clients et stocks réels vivent là ; aucune sauvegarde de Shopify n'a été faite. Hors de ce poste et de ce staging.

**Données réelles ou test** : le marchand `67646dbb-…` est de test (« HABB (test staging) »). Aucune donnée réelle HABB n'a été lue ou modifiée. Le projet de production n'existe pas encore (« new prod Supabase chosen », non créé).

**Stockage Supabase** : seul le bucket `finance-inbox` est connu et sauvegardé (8 objets). Les autres buckets éventuels ne sont pas listés.

## 8. Obstacle réel et unique intervention humaine

Pour inventorier et sauvegarder les volumes et les autres buckets, il faut un accès SSH au conteneur, ou un export fourni par le propriétaire. La création de clé SSH a été refusée par le contrôle de sécurité de l'environnement (la demande dépasse l'autorisation donnée pour la seule recette) ; rien n'a été enregistré ni contourné.

Intervention unique demandée au propriétaire : enregistrer une clé SSH dédiée au projet Railway (`railway.com/account/ssh-keys`), ou autoriser explicitement la création temporaire de cette clé, puis le signaler. Aucun secret ne doit transiter par le chat : la clé privée reste sur le poste.

## 9. Sauvegardes régulières : décision propriétaire (aucune dépense engagée)

- Copie indépendante : un second emplacement hors de Railway et de Supabase (ex. stockage objet d'un fournisseur déjà utilisé par HABB, à choisir).
- Exécution régulière : quotidienne pour la base et les volumes, hebdomadaire pour le test de restauration.
- Détection des échecs : notification au propriétaire en cas d'échec ou de hachage non concordant.
- Coût : tout service payant nécessite une décision explicite du propriétaire ; rien n'a été souscrit.
