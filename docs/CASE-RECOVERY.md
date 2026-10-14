# Récupération des dossiers China Sourcing

## Pourquoi
Le téléphone garde ses dossiers dans le stockage du navigateur, **par adresse**. Un tunnel Cloudflare rapide change d'adresse à chaque démarrage : la nouvelle adresse ouvre un téléphone vide. Les dossiers sont toujours dans `data/local/sourcing/cases/<id>.json` sur le PC (un fichier par dossier, ignoré par git).

## Ce qui a été vérifié avant de coder (sync actuelle)
- `sync()` envoie en `PUT /api/cases/:id` les dossiers marqués « modifiés » (`nordla.sourcing.dirty`) et le dossier courant.
- Le serveur compare la révision (`rev`) envoyée à celle du fichier : si elles diffèrent → **409**, le fichier n'est pas touché. Un dossier sans révision face à un dossier existant → 409 aussi.
- Un 409 ne remplace rien : l'app garde les deux versions et propose « Keep both copies » / « Take the server copy » (choix explicite existant).
- Avant ce changement, l'app n'avait **aucun GET de récupération**, ni import.

## Ce qui a été ajouté
- Menu → **Récupérer mes dossiers** : « Voir les dossiers du serveur » (`GET /api/cases`), cases à cocher (rien de coché), bouton « Récupérer » (`GET /api/cases/:id` uniquement pour les dossiers cochés).
- **Importer un fichier exporté** (aussi sans serveur). Le menu « Export » écrit désormais `nordla-case-<id>.json` = dossier complet + les photos que ce téléphone possède. Les anciens exports (dossier seul) restent importables.
- Dossier absent du téléphone → ajouté tel quel (même identifiant, conversations, faits confirmés/corrigés/rejetés, historiques, photos du fichier).
- Dossier déjà présent et identique → « déjà sur ce téléphone », rien n'est fait.
- Dossier déjà présent et différent → **jamais remplacé**. Comparaison (version, date, nombre de conversations/faits/confirmés/corrigés/rejetés/événements/photos, et lequel contient l'autre) puis « Garder les deux » (copie sous un nouvel identifiant, version 0, nom « … (copie récupérée) ») ou « Ignorer ».
- Import répété : aucun doublon (empreinte du contenu, hors révision).
- Un dossier récupéré n'est **jamais** marqué « modifié » : aucune sauvegarde automatique. S'il est modifié plus tard, la sauvegarde part avec sa révision ; si le serveur a avancé → 409, rien n'est écrasé.
- Fichiers refusés : non JSON, > 8 Mo, identifiant invalide, schéma plus récent, clés `__proto__`/`constructor`/`prototype`, collections mal formées.

## Correction de la synchronisation (anomalie confirmée par test)
Avant correction, `sync()` marquait **le dossier ouvert** comme modifié à chaque cycle. Un test navigateur l'a reproduit : un téléphone fraîchement appairé envoyait son dossier vide, et un dossier récupéré (Sonny) ou importé, simplement ouvert puis reconnecté, produisait un PUT (révision du serveur +1, fichier réécrit, dossier importé créé sur le serveur).
Maintenant : seuls les dossiers marqués par une modification explicite (`commit()`, Salon, « garder les deux ») sont envoyés. Ouvrir, récupérer, importer, changer de dossier, redémarrer ou se reconnecter n'envoie rien. La liste « modifiés » écrite par une ancienne version reste honorée. Limite : une modification faite sur un ancien téléphone **sans jeton**, avant cette version, n'était pas dans cette liste et ne sera plus envoyée d'office : exportez-la.

## Limites (honnêtes)
- **Photos** : elles sont dans le stockage du téléphone (IndexedDB), pas sur le serveur. Une récupération depuis le serveur restitue le dossier avec ses références de photos, pas les images. Les images ne reviennent que via un export fait avec cette version, ou si l'ancien téléphone n'a pas été vidé.
- Un dossier créé sur le téléphone puis jamais synchronisé n'existe nulle part ailleurs : sans export, il n'est pas récupérable.
- Aucune fusion automatique de deux copies divergentes : on garde les deux.
- Testé dans un navigateur Chromium à 390 px et par des tests automatiques. **Pas testé sur le Xiaomi physique ni avec un vrai tunnel Cloudflare.**
