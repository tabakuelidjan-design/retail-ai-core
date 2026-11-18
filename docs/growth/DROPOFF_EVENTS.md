# Growth — « Où les visiteurs abandonnent » : contrat de données et événements

Règle `growth-dropoff.1` (`src/growth/dropoff/dropoff.js`). Agrégats uniquement : aucun visiteur, aucune photo, aucun nom de fichier.

## Relevé importé (`GET /api/growth/dropoff` le lit ; table `growth_funnel_snapshot`, ou fichier local `data/local/marketing/shop-funnel.json`)
`source_system`, `time_zone`, `window {start, end exclusif}`, `retrieved_at`, `notes[]`, `rows[]`.
Une ligne = `scope` (`shop` | `personalizable` | `product`) × `device` (`mobile|desktop|tablet|other|all`) avec `counts` par étape
(`session, product_view, personalizer_open, photo_upload, personalization_done, add_to_cart, checkout_start, shipping, payment, purchase`).
Une étape absente ou `null` = « Données indisponibles » (jamais 0). Un compte > sessions est refusé.
`photo_upload` (optionnel, lignes `personalizable`) : `{ ok, failed, reasons: { <code_technique>: n } }` — codes en minuscules/underscore uniquement.

## Ce que Shopify Analytics fournit déjà (mesuré)
`FROM sessions` : visites, visites avec ajout au panier, début de commande, achat — par appareil et par page d'arrivée (`landing_page_path`).
Limite : « fiche consultée » n'existe pas dans ShopifyQL ; la page d'arrivée n'est pas « fiche consultée ».

## Événements à ajouter (non mesurés aujourd'hui)
| Étape | Événement | Où |
|---|---|---|
| Fiche consultée | `product_viewed` | Customer Events Shopify (standard) |
| Personnalisateur ouvert | `habb_personalizer_opened` | thème (`Shopify.analytics.publish`) + pixel personnalisé |
| Photo chargée | `habb_photo_upload_status` `{ status: UPLOAD_OK | UPLOAD_FAILED, reason }` | idem |
| Personnalisation terminée | `habb_personalization_completed` | idem |
| Livraison renseignée | `checkout_shipping_info_submitted` | Customer Events (standard) |
| Paiement renseigné | `payment_info_submitted` | Customer Events (standard) |

Charge utile autorisée des événements du personnalisateur : `product_handle`, `device` (déduit côté pixel), `status`, `reason` (code technique : `too_large`, `bad_format`, `network`, `decode_failed`…). **Interdit** : la photo, son nom, son URL, tout texte saisi.

## État
Aucun événement n'est installé sur la boutique réelle. Un point de collecte Nordla (réception des événements du pixel, agrégation par jour/appareil/produit) n'existe pas encore : sans lui, le pixel ne peut pas être installé. Tout changement du thème réel se prépare sur un thème brouillon et attend l'autorisation du propriétaire.
