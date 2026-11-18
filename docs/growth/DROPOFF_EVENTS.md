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

## Point de collecte des événements du personnalisateur (staging, 2026-11-18)
Route publique `POST /api/growth/collect/personalizer` (code `src/growth/server/collect-personalizer.js`, table `growth_personalizer_events`, migration `supabase/migrations-pending/20261118200000_growth_personalizer_events.sql`).
- **Événements** (`Shopify.analytics.publish('habb_personalizer', …)` côté thème, relayés vers Nordla seulement avec le consentement « analytics » du visiteur) : `submit_blocked_no_photo` (refus : un **obstacle**, pas un abandon), `photo_chosen`, `send_clicked`, `design_ready`, `cart_submit` (**tentative** d'ajout), `export_failed`, `cart_confirmed` (ajout **confirmé** : la page panier relit `/cart.js` de Shopify), `cart_not_found`.
- **Champs autorisés (liste fermée)** : `v`, `attempt`, `step`, `status`, `device`, `product` (identifiant d'URL), `n`, `consent`. Tout autre champ (photo, URL, nom de fichier, texte saisi, e-mail, IP…) fait refuser l'événement en entier.
- **Jeton de tentative (`attempt`)** : 24 caractères hexadécimaux aléatoires, créés pour UNE visite de la page produit. Usage unique : relier les étapes d'une même tentative et dédupliquer (clé `(attempt, step, n)` : un événement renvoyé n'est stocké qu'une fois). Ce n'est ni un cookie ni un identifiant visiteur ; il n'est gardé dans `sessionStorage` (onglet) que le temps de confirmer l'ajout sur la page panier, puis effacé.
- **Ce qui n'est pas stocké** : IP, agent utilisateur, identifiant visiteur, photo, URL, nom de fichier, texte, coordonnées. Lecture par le seul serveur Growth (rôle de service), marchand du serveur ; conservation lue : 90 jours (purge à planifier).
- **Abandons** : non mesurables (aucun signal de fin de visite). Les comptages sont des tentatives distinctes ; un dernier événement « refus » est affiché comme « dernier état observé », jamais comme un abandon confirmé.
- **Garde-fous** : origines autorisées (`GROWTH_COLLECT_ORIGINS`, défaut `https://habb.be`), corps ≤ 1 Ko, limites par IP (en mémoire) et par tentative, réponses silencieuses.
- **Non activé sur la boutique réelle** : le relais n'existe que dans le thème brouillon `209222205788`.
