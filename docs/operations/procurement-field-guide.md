# Nordla Achats — guide terrain (visites fournisseurs, Yiwu)

Ce que l'application fait aujourd'hui, comment la lancer, et ce qu'elle ne fait pas. Rien ici ne paie, n'achète ni n'écrit dans Shopify.

## Lancer
```bash
npm run procurement          # sur l'ordinateur : http://127.0.0.1:8975 (loopback uniquement)
npm run procurement:phone    # + un tunnel HTTPS (cloudflared) pour le téléphone
```
Premier démarrage : deux accès personnels sont créés dans `data/local/procurement/users.json` (dossier ignoré par Git). Le lien affiché contient le jeton **après le `#`** : le navigateur ne l'envoie jamais à un serveur et l'application le retire de la barre d'adresse. Traitez ce lien comme un mot de passe.
- **propriétaire** : peut approuver et marquer « commandé ».
- **terrain** : saisit, compare, prépare des brouillons, envoie pour approbation ; ne peut pas approuver.
Données : `procurement.json` (écriture atomique, refuse de démarrer sur un fichier corrompu), `uploads/` (photos nommées par leur SHA-256), `merchant-id.txt`.

## Parcours
1. **Visites → Nouvelle visite** : fournisseur, devise de ses prix, lieu. (Une connexion est nécessaire pour démarrer une visite.)
2. **＋ Produit** : photos, nom, prix (paliers, MOQ, Incoterm, délai). Si c'est le même produit qu'un autre fournisseur, le choisir dans « Même produit… » : les deux prix se retrouvent sur un produit. La saisie est **d'abord gardée sur le téléphone**, puis envoyée.
3. **Comparer** : produit + quantité + taux de change saisis par vous (jamais inventés) + transport / droits / prix de vente (optionnels). Sans coûts d'approche le classement porte sur les marchandises seules, et le dit.
4. **Ajouter à la sélection** → **Achats** → **Créer le bon (brouillon)**.
5. **Achats** : brouillons, à approuver, approuvés, commandés. « Envoyer pour approbation » (terrain) → « Approuver » (une autre personne habilitée) → « Marquer comme commandé » (la commande a été passée **hors Nordla**).
6. **Importer depuis China Sourcing** : reprend fournisseur, produit, photos, devis (paliers, MOQ, devise, Incoterm) d'un dossier existant, sans ressaisie, sans doublon ; option « + brouillon de commande ».

## Connexion instable : ce qui est garanti, ce qui ne l'est pas
Garanti (testé, y compris dans un navigateur réel avec une coupure simulée) : une saisie de produit ou un brouillon d'achat est gardé sur le téléphone, renvoyé automatiquement, **jamais perdu et jamais envoyé deux fois** (clé d'idempotence réutilisée à chaque essai). Le compteur « N en attente d'envoi » s'affiche en haut ; un envoi refusé par le serveur reste visible pour être corrigé ou supprimé.
**Non garanti** : ce n'est pas un mode hors-ligne. Démarrer une visite, lire les données et toute étape engageante (approuver, commander) exigent le serveur ; les dernières données lues restent consultables, marquées comme anciennes. Le service worker (ouverture de l'application sans réseau) est écrit mais **n'a pas pu être vérifié** : le navigateur intégré utilisé pour les essais ne l'enregistre pas. À tester sur le vrai téléphone avant d'y compter.

## Sauvegarde
Copiez `data/local/procurement/` (fichier + photos) sur un support externe à la fin de chaque journée : c'est la seule copie tant que la base PostgreSQL n'est pas branchée. Fermez le serveur (Ctrl+C) avant de copier.

## Limites connues
- Un seul processus écrit le fichier (un verrou l'impose). Plusieurs appareils passent par le même serveur ; plusieurs ordinateurs exigent la base PostgreSQL (non branchée, voir `procurement-staging-migration.md`).
- Le calcul de coût rendu vient de Finance et arrondit **au centime par pièce** : pour des pièces à quelques centimes, fiez-vous au total affiché.
- Les montants en euros issus d'un taux saisi sont des **estimations**, jamais un montant fiscal définitif.
- Réception des marchandises, ajustements de stock et inventaires existent dans le module mais n'ont pas d'écran mobile.
