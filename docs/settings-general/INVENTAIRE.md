# Paramètres → Général — inventaire de l'existant (2026-11-17, staging `fvhiammdskpcnfodsnrc`)

Relevé en lecture seule, avant tout code. Branche : `feature/settings-general` (depuis `release/sourcing-staging` @4666f715).

## Champs « communs » déjà présents, et qui les lit

| Donnée | Où elle vit aujourd'hui | Lecteurs | Décision |
|---|---|---|---|
| Nom commercial | `merchants.name` (3 lignes : « Nordla Staging Retail (synthetic) », « HABB (test staging) », « Nordla Growth TEST ») | Core (en-tête), Connexions (`merchantLabel`), Sourcing | **Emplacement canonique conservé** : Général écrit `merchants.name`. Aucun lecteur à migrer. |
| Fuseau horaire, devise, pays | `merchant_profile.timezone/currency/country` (2 lignes : HABB test + Growth TEST, la ligne « Retail synthetic » n'en a pas) | Analytics et Growth (`src/metrics/profile.js`, `growth/server/*`), échec fermé si absent | **Emplacement canonique conservé** : Général écrit `merchant_profile`. Les lecteurs existants voient la valeur à leur prochaine lecture sans changement de code. |
| Canaux web / caisse (handles) | `merchant_profile.online_channel_handles / pos_channel_handles / channel_aliases` | Analytics | **Hors Général** : ce sont des règles de module (identifiants techniques). Non touchés. |
| Identité légale du vendeur | `fin_seller_profile_versions` (append-only, hash, instantané figé dans chaque document) ; `fin_companies` = annuaire des contacts (0 ligne) | Finance (documents, Peppol) | **Non réécrite par Général en V1.** Général stocke sa propre rubrique 6 ; le raccordement vers Finance reste « à brancher » (écrire dans une table append-only versionnée relève de Finance). Les deux valeurs seront comparées et un écart sera remonté, jamais écrasé. |
| Lieux | `locations` (2 lignes, `source_system/source_id`, lien fournisseur) | Stock / ventes | **Non réutilisée comme profil** : c'est une table de correspondance fournisseur. Les établissements de Général reçoivent un identifiant Nordla stable ; l'association aux lieux Shopify passera par Connexions plus tard. |
| Site, e-mail, téléphone publics, logo, description | nulle part | — | Nouveaux, stockés par Général. |
| Activités, canaux déclarés, modes de vente, horaires | nulle part | — | Nouveaux. |

Doublons / conflits repérés : aucun conflit de valeur sur le staging (une seule source par champ). Risque structurel signalé, non corrigé : `merchants.source_system/source_id` sont encore NOT NULL sur le staging (la migration M2 qui les rend facultatifs n'y est pas appliquée).

## Modèle retenu (additif)

- `merchant_general_sections (merchant_id, section, data jsonb, version int, updated_at, updated_by)` — une ligne par marchand et par rubrique (`profile`, `activity`, `selling_modes`, `legal`) ; sauvegarde par rubrique, contrôle de version.
- `merchant_establishments` — un établissement = une ligne (id stable, fonctions, adresse, visibilité, horaires réguliers et exceptionnels, principal, archivé), contrôle de version.
- Fuseau et devise : écrits dans `merchant_profile` ; nom : `merchants.name`.
- Droits : lecture par toute session du marchand (la rubrique légale seulement pour OWNER/ADMIN), écriture OWNER/ADMIN, vérifiée côté serveur, CSRF comme les autres formulaires.

## Ce qui reste « à raccorder » (affiché tel quel dans l'avancement)

Core (nom : déjà lu), Analytics/Growth (fuseau : déjà lu), Marketing (coordonnées publiques), Finance (identité légale), Stock/Sourcing (modes de vente), Connexions (association des lieux).
