# Nordla Achats — procédure de test sur téléphone réel (à faire avant le voyage)

**Pourquoi** : tout ce qui est écrit dans le bilan a été prouvé sur ordinateur (navigateur intégré, base jetable, réseau simulé). **Trois choses n'ont jamais été vues sur un vrai téléphone** : le tunnel HTTPS, l'appareil photo, et le service worker (ouverture de l'application sans réseau). Cette procédure sert à les vérifier — et à ne **rien affirmer** tant qu'une case n'est pas cochée par une personne.

Durée : ~45 min. Matériel : l'ordinateur qui fera tourner le serveur, le téléphone (celui du voyage), un second réseau (partage de connexion 4G) pour l'étape de coupure. Données de test uniquement : un **dossier de données jetable**, pas celui du voyage.

## 0. Préparation (ordinateur)
```bash
# dossier jetable : rien ne se mélange avec les vraies données
set PROCUREMENT_DATA_DIR=C:\temp\achats-test
npm run procurement:phone
```
- [ ] Le terminal affiche « PHONE ACCESS IS ON » et **deux liens** (propriétaire, terrain). Sinon : `cloudflared` absent → noter « tunnel non testé » et s'arrêter ici.
- [ ] Les liens contiennent `#t=…` : **les envoyer uniquement à soi-même**, ne jamais les coller dans un message de groupe, une capture d'écran ou un ticket.

## 1. Ouverture et installation
- [ ] Ouvrir le lien **terrain** sur le téléphone. L'application s'affiche en français, 5 onglets (Visites, Produits, Comparer, Achats, Stock).
- [ ] La barre d'adresse **ne montre plus le `#t=…`** après le chargement.
- [ ] Ajouter à l'écran d'accueil (Chrome : menu → « Installer l'application » ; Safari : Partager → « Sur l'écran d'accueil »). L'icône « N » apparaît.
- [ ] Fermer l'application puis la rouvrir depuis l'icône : elle s'ouvre **sans redemander le jeton**.

## 2. Parcours de visite (réseau normal)
- [ ] Visites → Nouvelle visite : fournisseur « Test Yiwu », devise CNY, lieu.
- [ ] ＋ Produit : **📷 Prendre une photo avec l'appareil photo du téléphone** (pas une image de la galerie). La miniature apparaît.
- [ ] Nom, prix « 0,60 », MOQ 1000, un palier (5000 → 0,50), Incoterm FOB, délai 20. Enregistrer.
- [ ] Le produit apparaît dans la visite avec sa **vraie photo** (l'ouvrir en grand : lisible, pas déformée, pas pivotée de 90°).
- [ ] Un 2ᵉ fournisseur (autre visite), même produit via « Même produit qu'un produit déjà vu ? », prix USD.
- [ ] Comparer : taux saisis (USD, CNY) → classement ; saisir un taux à l'envers (ex. CNY 7,8) → **un avertissement demande confirmation**.
- [ ] Ajouter à la sélection → Achats → Créer le bon (brouillon) → le bon PO-… apparaît en « Brouillons ».

## 3. Coupure réseau (le test qui compte)
- [ ] Ouvrir ＋ Produit, remplir un produit avec photo.
- [ ] **Activer le mode avion**, puis Enregistrer.
- [ ] Attendu : le message « Enregistré sur ce téléphone », le badge « 1 en attente d'envoi », le bandeau rouge « Connexion au serveur indisponible… ». Le produit **n'est pas** dans la liste du serveur.
- [ ] Fermer complètement l'application (la retirer des applications récentes), rouvrir **toujours en mode avion** : le badge « 1 en attente » est **toujours là** (la saisie a survécu).
- [ ] Désactiver le mode avion. Attendu en moins de ~30 s : « 1 saisie envoyée au serveur », le produit apparaît **une seule fois**, avec sa photo.
- [ ] Refaire avec une coupure **au milieu** d'un envoi (activer le mode avion juste après avoir appuyé sur Enregistrer, sur une grosse photo) : au retour, toujours **un seul** produit.
- [ ] Sur l'ordinateur : arrêter le serveur (Ctrl+C), faire Enregistrer sur le téléphone, relancer `npm run procurement:phone` (⚠ **le lien change à chaque démarrage du tunnel** : noter que les saisies en attente doivent alors être envoyées depuis un téléphone ré-appairé avec le nouveau lien, ou que le tunnel garde la même adresse — **à constater et noter**).

## 4. Service worker (ouverture sans réseau)
- [ ] Mode avion, ouvrir l'application depuis l'icône : l'**écran s'affiche** (pas de page d'erreur du navigateur). Les listes peuvent montrer « données anciennes » : c'est normal. **Si l'écran est blanc ou en erreur : le service worker ne fonctionne pas sur ce téléphone → noter « non vérifié / KO ».**
- [ ] Rien d'engageant n'est possible hors connexion : essayer « Approuver » avec le lien propriétaire en mode avion → message d'erreur clair, rien n'est enregistré.

## 5. Réception, stock, photos Sourcing (lien propriétaire)
- [ ] Faire approuver puis « Marquer comme commandé » (avec le lien propriétaire, un bon préparé par le terrain).
- [ ] Achats → le bon → **Réceptionner** : saisir plus que le reste → message d'erreur ; saisir 90 acceptées + 10 défectueuses → Enregistrer. L'onglet **Stock** montre 90 à vendre, 10 en quarantaine, le reste « attendu ».
- [ ] Appuyer deux fois vite sur Enregistrer, ou le faire avec une coupure puis retour : **une seule réception** (le stock ne double pas).
- [ ] Si un dossier China Sourcing a des photos stockées sur le serveur : après import, les miniatures s'affichent ; sinon l'indication « photo sur le téléphone du terrain » (ce n'est pas un bogue : la photo n'est pas sur le serveur).

## 6. Précision et devises
- [ ] Un produit à ~0,05 € la pièce : le comparateur affiche l'avertissement « pièces à quelques centimes… comparez les TOTAUX » et le total en euros, cohérent avec quantité × prix × taux.
- [ ] Les devises de chaque offre sont affichées ; aucune conversion sans taux saisi.

## 7. Nettoyage et compte rendu
- [ ] Ctrl+C sur l'ordinateur (arrête le tunnel), supprimer le dossier de test, **supprimer `users.json` du dossier de test** (les jetons ne servent plus).
- [ ] Désinstaller l'application de test du téléphone.
- Compte rendu à remplir (OK / KO / non testé, avec la date, le modèle du téléphone, le navigateur) : tunnel · installation · appareil photo · coupure réseau · survie à la fermeture · service worker · réception · stock · photos Sourcing · précision. **Joindre des captures d'écran SANS jeton visible.** Tout « KO » ou « non testé » reste écrit comme tel dans le bilan.
