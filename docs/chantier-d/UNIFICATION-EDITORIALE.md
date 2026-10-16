# Unification éditoriale : une seule source de vérité

Date : 2026-10-17. Aucun fichier de la réserve ni du chantier E n'est modifié.

## Décision

**Source de vérité éditoriale = la réserve `reports/editorial-14j/` (`posts.json` v1)**, dans le dépôt du site. Le plan que j'avais écrit pour D (`data/private/habb-content/editorial-14j.json`) est **absorbé** : il n'est plus un calendrier. Il ne subsiste que ce qu'il apportait en plus (outillage de contrôle, trois visuels variantes, règles découvertes).

Pourquoi la réserve plutôt que mon plan :
- elle est déjà lue par E (`src/social/adapters/habb-editorial.js`) avec des identifiants stables `habb-editorial-2026-10-16:<ID>` : l'importer ne crée pas de doublon ;
- elle est plus complète : 8 publications / 14 stories (plusieurs écrans) / 3 vidéos, légendes aux deux registres (vouvoiement A, tutoiement B), hashtags, texte alternatif, plans de tournage, canaux Facebook / Google Business, faits tirés de `HABB_OS` (horaires 10 h–18 h du lundi au samedi, boutique fermée le dimanche) ;
- mon plan dupliquait ses piliers sans rien de plus que quatre cartes typographiques et des consignes de prise de vue.

« Sans écraser les contenus déjà validés » : **aucun contenu de la réserve n'est validé** (tout y est `PROPOSÉ`), mais rien n'y a été écrasé quand même.

## Écarts relevés (réserve ↔ plan D)

| Sujet | Réserve | Plan D | Traitement |
|---|---|---|---|
| Cadence | 8 posts : 19, 21, 23, 24, 27, 29, 31 oct., 1er nov. | 8 posts : 19, 21, 23, 25, 26, 28, 30 oct., 1er nov. | calendrier de la réserve retenu |
| Piliers | coque, coque, gourdes, boîtes, plaques UV, boutique, idée cadeau, savoir-faire | coque, gourde, horloge ardoise, coffret, puzzle, cadre, savoir-faire | piliers de la réserve ; la réserve garde les plaques UV en brief, sans prix |
| Registre | A (vouvoiement) par défaut, B en variante | tutoiement (B) | **choix du propriétaire en suspens** (réserve Q1) ; D livre ses visuels aux **deux** registres (paquet A par défaut, paquet B à côté) |
| Prix | seule la coque (25 €) | mes premiers textes citaient d'autres prix | alignés : un seul prix, celui de la coque ; le filtre de E bloque les autres |
| Faits | horaires, « boutique fermée le dimanche », « cadrage vérifié avant impression » | « contrôle du fichier avant impression » | faits de la réserve conservés ; mon libellé abandonné |
| Réouverture | aucun texte de réouverture | « On rouvre la porte » (retiré le 2026-10-16) | rien à retirer dans la réserve |
| Gourdes | « personnalisation oui/non ? » (Q4, en suspens) | considérées personnalisables | **le propriétaire a confirmé que les gourdes sont personnalisables** : la question Q4 est partiellement levée ; les textes de la réserve ne sont pas modifiés par D |
| Délai coque | « environ 5 minutes selon modèle/disponibilité » | idem | identique ; autorisé par le propriétaire |
| Canaux | Instagram + Facebook + Google Business + TikTok | Instagram + Facebook | E ignore TikTok et Google Business (signalé par son adaptateur) |
| Visuels | 5 prêts (P01, P02 ×4, P06, P08, S02), 4 briefs, 3 vidéos à tourner | 4 cartes typographiques + 3 démonstrations | voir « Rôle de D » |

Contrôle automatique de la réserve par D (`tools/habb-reserve-check.mjs`, lecture seule) : 25 éléments (8 posts, 14 stories, 3 vidéos), **aucun prix hors coque, aucun mot décoratif interdit, aucune promesse que le filtre de E bloquerait** ; une seule remarque : S02 a un visuel prêt sans texte alternatif.

## Rôle de D après unification

D **ne planifie plus**. D propose des **variantes visuelles** rattachées à des éléments de la réserve, sans jamais les remplacer :

| Création D | Variante de | Date (celle de l'élément) |
|---|---|---|
| D1 publication produit | P01 `habb-editorial-2026-10-16:P01` | 2026-10-19 12:00 |
| D2 story promotionnelle | S01 `habb-editorial-2026-10-16:S01` | 2026-10-19 09:00 |
| D3 pièce savoir-faire | P02 `habb-editorial-2026-10-16:P02` | 2026-10-21 19:00 |

## Adaptation du contrat de transmission

1. **Identifiants** : les variantes de D utilisent l'espace `habb-chantier-d-visuel:<clé>` : un identifiant distinct de ceux de la réserve, donc jamais de collision ni d'écrasement chez E.
2. **Version d'asset** : chaque retouche est une nouvelle version du même `ref` (v2 pour la correction typographique de cette semaine). E annule alors toute approbation (règle de E) : D ne peut pas changer en silence ce que le propriétaire a approuvé.
3. **Lien « variante de »** : E n'a pas de champ pour cela. D l'écrit dans `notes` (« VARIANTE VISUELLE du post P01… : ne publier qu'une des deux »). **Demande à E (non faite par D) : un champ `alternative_to` dans `social-post-proposal.v1`**, pour empêcher d'approuver les deux.
4. **Registre** : D livre `demo-d-to-e/` (A, par défaut de E) et `demo-d-to-e-register-B/` ; seul un registre doit être importé.
5. **Outil** : `tools/habb-reserve-check.mjs` applique les contrôles de D au format de la réserve ; `tools/habb-editorial-check.mjs` (format interne de D) reste pour d'éventuels plans futurs mais n'est plus la référence.

## Restant à trancher par le propriétaire
Registre A ou B ; autoriser ou non « créées en boutique » (D3) ; garder la réserve comme seule source (recommandé) ; confirmation écrite des affirmations restantes (cadrage/fichier vérifié avant impression).
