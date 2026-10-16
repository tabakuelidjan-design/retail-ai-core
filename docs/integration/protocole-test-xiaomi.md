# Protocole de test Xiaomi — Nordla hébergé, PC éteint, données mobiles (répétition du 18 octobre)

But : prouver sur le **vrai téléphone** ce que les tests navigateur (Chromium 390 px) ne prouvent pas : écran tactile, appareil photo,
réseau mobile réel, fermeture du navigateur, coupure / reprise du réseau. Rien n'est déclaré « prêt pour la Chine » sans ce test.

Préalables (chacun soumis à votre accord, voir le rapport) : Supabase staging prêt (migrations 2–5, marchand de test, compte
propriétaire, module `sourcing`, bucket) ; `sourcing-staging` actif sur le commit candidat ; adresse **autorisée** (d'abord l'adresse
Railway `https://<service>.up.railway.app`, puis `app.nordla.app` après accord DNS). **Données de test uniquement** pendant la répétition.

## État des prérequis (16/10 au matin)

| Prérequis | État | Preuve |
|---|---|---|
| Supabase staging : migrations d'identité 1–5 | **fait** | run `staging-db-ops` 38813124178 |
| Marchand de test `67646dbb-…`, votre adhésion OWNER, module `sourcing`, bucket privé `nordla-backups` | **fait** | run 38815730509, relu sur staging |
| Votre compte de connexion | **fait** : le seul compte de l'Auth **staging** (créé par vous ; e-mail et mot de passe choisis par vous) | Auth staging : 1 compte confirmé |
| Service `sourcing-staging` actif sur `ab02b77` | principe validé le 16/10 ; **activation à confirmer** (2–4 USD/mois) | `docs/infrastructure/procedure-activation-staging.md` |
| Sauvegarde hors serveur + restauration indépendante | **après activation** (B2, B3 de la grille) ; staging non « opérationnel » avant | workflow `staging-backup-drill` |
| Adresse | **`app.nordla.app`** retenue le 16/10 ; DNS **à autoriser** (au plus tard le 17/10) | `docs/infrastructure/domaine-app-nordla-app.md` |

Ce que vous verrez sur staging, et qui est **normal** : Finance / Analytics disent « données indisponibles » (le marchand de test n'a
ni factures ni ventes) ; la Sécurité produits (Safety Gate) peut être marquée « en cache » ; Création, Branding, Marketing et
China Sourcing fonctionnent avec vos photos de test. **Données de test uniquement** pendant la répétition.

Contrôles techniques faits par Infrastructure **avant** de vous donner l'adresse (aucun n'utilise le téléphone) : `/healthz` 200 ;
journal de démarrage « Nordla Core ON for merchant 67646dbb-… », uid 1000, aucun secret ; une requête `http://` est redirigée vers
`https://` ; `/api/core/modules` sans session → 401 ; une sauvegarde forcée apparaît dans `nordla-backups`.

## 0. AVANT tout changement d'adresse : protéger les anciennes données du Xiaomi (ne rien effacer)

Un navigateur range les données **par adresse (origine)**. Les dossiers et photos enregistrés auparavant (Firefox, serveur du PC
`http://<ip-du-pc>:8787`, ou autre) sont dans le `localStorage` et l'`IndexedDB` de **cette** ancienne origine. La nouvelle adresse
part **vide** : aucune migration automatique, et rien ne doit être supposé synchronisé.

1. PC allumé, Firefox du Xiaomi sur l'**ancienne** adresse : ouvrir chaque dossier → réglages → **Exporter en JSON** : un fichier
   `nordla-case-<id>.json` est enregistré dans *Téléchargements*. **L'écran affiche « … N photo(s) sur M »** (version `9e25f1d`+ du
   serveur local) : N doit être égal à M. Sinon il affiche « ATTENTION : … photo(s) absente(s) de ce téléphone » : ces photos ne sont
   pas dans le fichier — ne rien changer, me le signaler (elles peuvent être sur le serveur du PC).
   L'ancien serveur du PC sert-il une version plus ancienne (sans ce compte) ? Alors : compter les vignettes du dossier et, après
   récupération sur la nouvelle adresse (étape 0.R), recompter.
2. Copier ces fichiers hors du téléphone (câble ou envoi à vous-même) : 2 copies.
3. Côté PC : copier le répertoire de données du serveur local (`cases/`, `photos/`) sur une clé USB.
4. **Ne pas** vider Firefox, ne pas désinstaller, ne pas « effacer les données du site » : l'ancienne origine reste la copie de secours.

**0.R** Récupération sur la nouvelle adresse : menu → **Récupérer** → choisir le fichier exporté. La récupération ne remplace jamais rien
(choix « garder les deux »). Point d'attention : un dossier récupéré n'est **pas** marqué « modifié », il n'est donc **pas** envoyé au
serveur tant qu'on ne le modifie pas (une note suffit). Vérifier ensuite qu'il apparaît côté serveur (étape 7).

## 1–10. Déroulé (Wi-Fi coupé, données mobiles, PC éteint)

| # | Action | Résultat attendu | Preuve à noter |
|---|---|---|---|
| 1 | Ouvrir l'adresse autorisée, se connecter (compte propriétaire) | connexion acceptée ; aucune demande de jeton | capture |
| 2 | Créer un dossier fournisseur de test | dossier visible, statut « enregistré sur ce téléphone » | nom du dossier |
| 3 | Ajouter 3 photos (appareil photo + galerie) | 3 vignettes ; envoi des photos signalé | nombre affiché |
| 4 | Écrire des notes, prix, quantités | enregistrés immédiatement | capture |
| 5 | Fermer complètement le navigateur, rouvrir | toujours connecté ; dossier, notes et 3 photos présents | capture |
| 6 | Mode avion ; modifier une note ; rouvrir le dossier ; puis réactiver les données mobiles | hors ligne : « hors ligne », modification gardée ; au retour : synchronisation automatique | heure de reprise |
| 7 | Vérifier la synchronisation | indicateur « à jour » ; dans un 2ᵉ navigateur (ou après « Récupérer → depuis le serveur ») : le dossier **et ses 3 photos** | nombre de photos côté serveur |
| 8 | Menu → Nordla → Finance / Analytics (« Parle à Nordla ») | réponse avec **source, période, fraîcheur** ; sur staging : « aucune facture » / données indisponibles pour HABB (normal) | capture |
| 9 | Nordla Core : analyser le dossier → décision avec raison | décision enregistrée avec votre nom ; visible après fermeture / réouverture | capture |
| 10 | Sauvegardes | journal du service : sauvegarde du jour + copie hors serveur ; restauration d'essai dans un dossier vide (Infrastructure) | nom de l'archive |

Également : Création (photo du téléphone + titre → visuel, contrôles « conforme »), Branding (règles affichées, **ne pas approuver**
pendant le test sauf décision de votre part), Marketing (proposition + décision). Rien n'est publié.

## Critères

- **Réussi** : 1–9 conformes sur le Xiaomi ; 10 vérifié côté service.
- **Échec bloquant** : perte d'une photo ou d'une note, déconnexion non expliquée, donnée affichée sans source, toute erreur
  silencieuse. On note, on n'efface rien, on corrige, on refait le test.
- Après le test : les données de test restent (ou sont archivées) ; aucune suppression sans votre décision.

## Recommandation d'adresse

Faire le test **directement sur `app.nordla.app`** (autorisation DNS avant le 18) avec des données de test : le téléphone ne change
ainsi d'adresse qu'une fois (détails : `docs/infrastructure/domaine-app-nordla-app.md`).

## Fiche téléphone (à garder ouverte pendant le test)

```
AVANT : PC allumé • exporter chaque ancien dossier • l'écran dit « N photo(s) sur N » • copier les fichiers hors du téléphone
        NE PAS vider Firefox • NE PAS effacer les données du site
1  Wi-Fi coupé, données mobiles, PC éteint
2  Ouvrir l'adresse autorisée → se connecter (mon compte)
3  Nouveau dossier fournisseur
4  3 photos (appareil + galerie) → 3 vignettes
5  Notes, prix, quantités
6  Fermer le navigateur → rouvrir → tout est là ?
7  Mode avion → modifier une note → données mobiles → « à jour » ?
8  Autre navigateur : le dossier + 3 photos sont là ?
9  Menu → Nordla → Finance / Analytics : source + période affichées ?
10 Nordla Core : analyser le dossier → décision + raison → fermer/rouvrir → décision toujours là ?
11 Création : photo + titre → visuel + « conforme »
12 Noter l'heure et tout écart. Ne rien effacer.
```
