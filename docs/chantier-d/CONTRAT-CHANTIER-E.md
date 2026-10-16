# Contrat de transmission Chantier D → Chantier E / système central

Version 1 · 2026-10-16 · code : `src/asset-library/contract.js` (validateurs partagés), tests : `test/asset-library.test.js` (AL-6 à AL-9).

**Le chantier « E » n'est défini dans aucun document du dépôt** (recherche dans `docs/`, `src/`, `*.md`, historique git). Ce contrat est donc écrit sur les points d'accès qui existent déjà : le Socle Resource Resolver (`src/resources`, nature ASSET et CLAIM), la propriété des entités (`src/integration/ownership.js`) et le contrat de campagne de l'intégration (`buildCampaignContract`). Si E attend autre chose, c'est une décision à prendre avant tout raccordement (voir « Questions »).

## Principes

1. D **propose**, ne publie jamais : `published: false` et `execution: "PROPOSAL_ONLY"` sont obligatoires, le validateur refuse le reste.
2. Aucun chemin de fichier, aucune URL : les assets sont désignés par une référence opaque `private-asset://…` et un hash SHA-256.
3. Droits et approbation ne sont jamais déduits : seul un humain nommé les fait avancer (`evidence://` / `approval://`).
4. Un asset n'est « publiable » que s'il est un actif HABB réel (pas image fournisseur, pas image générée, pas capture), avec droits confirmés par le propriétaire ET approbation.
5. Une affirmation sans `claim_ref` approuvé ne peut pas figurer dans un élément approuvé (le propriétaire de CLAIM est Branding).

## 1. `nordla.chantier-d.asset-handoff` (v1)

| Champ | Règle |
|---|---|
| `asset_id`, `content_hash`, `source_ref`, `media_type`, `width_px`, `height_px` | identité et format ; `source_ref` opaque |
| `channel` | `INSTAGRAM_FEED` 1080×1350 · `INSTAGRAM_STORY`, `INSTAGRAM_REEL`, `FACEBOOK_STORY` 1080×1920 · `FACEBOOK_FEED` 1080×1350 ; mauvaise taille = refus |
| `stage` | `ORIGINAL`, `BRAND`, `TEMPLATE`, `CREATION`, `APPROVED_CREATION`, `PUBLISH_READY` ; les deux derniers exigent un asset publiable |
| `origin_class`, `rights_status`, `approval {status, ref}` | `approved` exige une référence |
| `asset_version`, `derived_from` | historique de versions et filiation (hash du parent) |
| `produced_by` | `NORDLA_ENGINE` (exige `engine_run_id`), `HUMAN_DESIGNER`, `ASSISTANT_PROPOSAL` (proposition rédigée par une session d'assistant : jamais une preuve de capacité de Nordla) |
| `published` | toujours `false` |

## 2. `nordla.chantier-d.campaign-handoff` (v1)

`campaign_id`, `window {start,end}`, `status`, `execution: "PROPOSAL_ONLY"`, `items[]` avec : `item_id`, `kind` (POST/STORY/REEL), `channel`, `day`, `product_ref` (clé du catalogue Shopify), `objective`, `concept`, `hook`, `caption`, `asset_refs[]`, `asset_status` (`MISSING` / `DRAFT` / `READY`), `claims[] {text, claim_ref|null}`, `validation_status` (`PROPOSED` → `IN_REVIEW` → `APPROVED`/`REJECTED`), `blockers[]` (ce qui manque, en clair).

Un élément `APPROVED` exige : tous ses claims avec `claim_ref`, des `asset_refs` non vides et `asset_status: READY`.

Contrôles supplémentaires côté D (`checkEditorialPlan`) : prix cités = prix du catalogue lu dans Shopify, produit présent au catalogue, aucun motif décoratif interdit (cœurs/feuilles/or/halo) sauf s'il fait partie du produit, aucune affirmation commerciale non vérifiée (livraison gratuite, remise, « le moins cher », horaires), nombres 8/14/3.

## 3. Ce que D attend du système central

- Propriété : CREATIVE_ASSET reste à CREATIVE ; CAMPAIGN à MARKETING (D ne garde aucun état de campagne : le plan est une proposition versionnée) ; BRAND_PROFILE et CLAIM_EVIDENCE à BRANDING.
- Persistance : aucune table n'est créée par D (même constat que l'intégration §6.2). Les index vivent dans `data/private/` (ignoré par git, le dépôt est public).
- Exécution (publication, dépense, OAuth) : hors périmètre, `ADAPTER_READY` seulement.

## 4. Fichiers touchés / non touchés

Créés par D : `src/asset-library/*`, `test/asset-library.test.js`, `tools/habb-asset-index.mjs`, `tools/habb-editorial-check.mjs`, `docs/chantier-d/*`. Aucun fichier de `src/integration`, `src/sourcing`, `src/core-pilot`, `src/procurement`, ni du workflow CI n'est modifié.

## Questions pour le propriétaire / E

1. Qu'est-ce que le chantier E exactement, et quel format attend-il (fichiers, API, table) ?
2. Le contrat de campagne de l'intégration (`CampaignContract`) doit-il absorber ce `campaign-handoff`, ou coexister ?
