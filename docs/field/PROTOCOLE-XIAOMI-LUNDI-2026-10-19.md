# Protocole Xiaomi — lundi matin 19 octobre 2026 (sauvegarde, récupération, hors-ligne, photos, secours JSON)

**Objectif unique : ne perdre aucune donnée avant le départ en Chine (mardi matin).** Aucun autre test fonctionnel ou visuel.
**Document seul** : rien n'est déployé ni modifié par ce protocole. Il complète `02_RECETTE_XIAOMI.md` (X01–X15) de ChatGPT, dont il reprend l'URL staging et les critères d'arrêt.

## Règles
- Un seul navigateur sur le Xiaomi (Chrome, application installée si elle l'est déjà). Ne **pas** vider les données du navigateur, ne **pas** désinstaller l'application, ne **pas** supprimer ni modifier les dossiers existants (`TEST XIAOMI – GOURDE 18-10`, `test Jeremy`).
- URL à utiliser : celle confirmée par le propriétaire pour le staging (déclarée par Railway : `https://sourcing-staging-staging.up.railway.app`). Ne saisir aucun mot de passe sur une adresse non confirmée.
- Staging, données de test uniquement. Aucune vraie commande, aucun paiement.
- À tout échec : **stop**, noter l'heure, l'identifiant de l'étape, une capture d'écran, et ne rien effacer.
- Gel : aucun changement de code après lundi 12:00. Ce qui n'est pas validé à ce moment-là est signalé, pas corrigé.

## Étape 0 — Filet de sécurité d'abord (avant tout autre test, 5 min)
1. Dans l'application (ancienne adresse comprise), pour **chaque** dossier existant : « Exporter » en JSON. Vérifier la mention « N photo(s) sur N ».
2. Envoyer les fichiers JSON sur le PC ET sur un second support (messagerie à soi-même ou cloud). Réussi si on voit **deux copies hors du téléphone**.
3. Noter le nombre de dossiers et de photos affichés avant de commencer (point de comparaison).

## Étape 1 — Sauvegarde serveur (10 min)
| ID | Action | Réussi uniquement si |
|---|---|---|
| S1 | Connecté en OWNER, en 4G/5G (Wi-Fi coupé), appuyer sur « Sauvegarder sur le serveur » | Le bouton rapporte un envoi terminé ; **aucune erreur** ; le même nombre de dossiers et de photos qu'à l'étape 0 |
| S2 | Lire l'indicateur de synchronisation | Il affiche « Serveur à jour » (serveur vérifié ET file d'attente vide). Tout autre état = **stop**, ne pas considérer la sauvegarde comme faite |
| S3 | Rouvrir la liste des dossiers | Aucun dossier ne manque, aucune photo ne manque |

Rappel : un dossier ou une photo jamais envoyé ne part **que** par ce bouton (réservé au propriétaire).

## Étape 2 — Récupération dans un navigateur indépendant (10 min)
But : prouver que le serveur seul suffit à tout retrouver.
| ID | Action | Réussi uniquement si |
|---|---|---|
| R1 | Sur le PC (ou un second navigateur, profil vierge / navigation privée), ouvrir la même URL, se connecter en OWNER | Connexion normale, sans jeton de développement |
| R2 | Ouvrir chaque dossier de l'étape 0 | Mêmes dossiers, mêmes notes (dernière version), **mêmes photos (nombre et aspect)** |
| R3 | Comparer avec les compteurs notés à l'étape 0 | Égalité exacte. Sinon : **ne rien supprimer**, noter l'écart et exporter le JSON de nouveau |

## Étape 3 — Hors ligne (10 min)
| ID | Action | Réussi uniquement si |
|---|---|---|
| H1 | Avec réseau : ouvrir l'application et chaque dossier utile (préchargement) | Les écrans s'affichent sans erreur |
| H2 | Mode avion. Fermer complètement le navigateur, le rouvrir sur l'application | L'application s'ouvre ; dossiers et photos visibles |
| H3 | Toujours hors ligne : modifier la note du dossier de test (ex. `TEST_NOTE_B`) | Modification acceptée et conservée |
| H4 | Réactiver le réseau. Appuyer sur « Sauvegarder sur le serveur », attendre « Serveur à jour » | La note B est sur le serveur : la retrouver depuis le navigateur indépendant (R1) |
| H5 | En cas de conflit annoncé | Les **deux versions** sont conservées ; ne rien écraser, noter l'écart |

## Étape 4 — Photos (5 min)
- Sur un dossier de test : 3 photos (2 prises avec la caméra, 1 de la galerie).
- Réussi si : 3 vignettes exactes, rien ne disparaît après fermeture/réouverture du navigateur, et les 3 photos réapparaissent dans le navigateur indépendant après S1/S2.
- Une photo manquante côté serveur = échec P0 : ré-envoyer via le bouton ; si ça persiste, repli JSON (étape 5).

## Étape 5 — Export JSON de secours (3 min, à refaire en dernier)
1. **Dernier acte avant de quitter le Xiaomi** : exporter à nouveau tous les dossiers en JSON (photos comprises, « N sur N »).
2. Copier les fichiers sur le PC et sur un second support. Vérifier que le fichier s'ouvre et que la taille est cohérente (non nulle).
3. Conserver ces fichiers jusqu'au retour de Chine ; ne pas les renommer.

## Compte rendu attendu (à remplir par le propriétaire, ou à me dicter)
| Étape | Résultat (OK / écart / stop) | Heure | Capture |
|---|---|---|---|
| 0 Exports (2 copies) | | | |
| S1–S3 Sauvegarde serveur | | | |
| R1–R3 Navigateur indépendant | | | |
| H1–H5 Hors ligne | | | |
| Photos | | | |
| 5 Export final | | | |

## Limites connues (à ne pas confondre avec un échec)
- La voix, la fiabilité réseau en Chine et les rôles VIEWER/ACCOUNTANT ne sont pas validés ici.
- L'envoi d'une photo ou d'un document à l'IA reste désactivé sur le staging (aucun fournisseur configuré) et sera réservé au propriétaire.
- Je ne peux pas vérifier depuis le serveur la présence des dossiers de test existants : seule la comparaison R2/R3 le prouve.
