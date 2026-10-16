# Procédure de publication de secours (manuelle) et plan voyage

Valable **dès aujourd'hui**, sans aucune connexion Meta : c'est le chemin qui marche déjà, testé.
Principe : Nordla garde le contrôle (approbation de la version exacte, historique, calendrier) ; **vous** ou une personne que vous désignez faites le geste de publier dans l'app Meta.

> Aucun jeton, aucun mot de passe ne passe par Nordla dans ce mode. Ne les collez jamais dans une conversation.

## A. Publier un post à la main (à tout moment)

1. Ouvrez l'app Nordla Publications → onglet **Programmés** (ou **À examiner** pour décider d'abord).
2. Le post doit être **Approuvé** pour cette version exacte. (Si le texte ou le visuel change ensuite, l'approbation tombe : vous le voyez dans l'historique.)
3. **Pack de publication manuelle** : copiez le texte (bouton), téléchargez le visuel (bouton : le fichier est contrôlé, il refuse s'il n'est plus celui approuvé).
4. Dans **Meta Business Suite** (ou l'app Instagram / Facebook) : créer une publication → visuel → coller le texte **sans le modifier** → publier, ou **programmer** à la date et à l'heure de Belgique indiquées.
5. Revenez dans Nordla :
   - vous avez **programmé** dans Meta : bouton **« Je l'ai programmé dans Meta »**. Nordla ne publiera alors **jamais** ce post lui-même (pas de doublon) ;
   - vous avez **publié** : bouton **« J'ai publié à la main »**, collez le lien du post → état « Publié à la main (attesté) » ;
   - après avoir regardé le post en ligne : **« J'ai vérifié le post en ligne »** → Vérifié.
6. Si vous changez d'avis sur un post déjà programmé chez Meta : retirez l'approbation dans Nordla **et supprimez la programmation dans Meta Business Suite**. Nordla affiche une alerte rouge tant que vous n'avez pas confirmé (« J'ai supprimé la copie chez Meta »).

Carrousels, stories et visuels PNG pour Instagram : **toujours ce chemin** dans cette V1.

## B. Avant le départ — la méthode la plus robuste (recommandée)

Elle ne dépend d'aucune connexion de Nordla, ni du réseau chinois, ni d'un PC allumé.

| Quand | Action |
|---|---|
| J-5 | D livre les visuels manquants et des **JPEG** pour Instagram ; vous tranchez vouvoiement/tutoiement (A/B) et le rythme. |
| J-4 | Vous **approuvez** dans Nordla chaque post retenu (texte + visuel + date). Rien d'approuvé ne change sans que l'approbation tombe. |
| J-3 | Pour chaque post approuvé : pack manuel → **programmer dans Meta Business Suite** (date/heure de Belgique) → « Je l'ai programmé dans Meta ». Vérifiez la limite de programmation que Meta affiche (non vérifiée par moi). |
| J-2 | Contrôle : onglet *Calendrier* = ce que Meta montre dans son planificateur. Cochez ce qui est programmé, ce qui reste à la main. |
| J-1 | Désignez **qui** gère les commentaires/messages et d'éventuelles publications de secours (question ouverte de D). Donnez-lui l'accès **dans Meta** (rôle Business Suite), pas votre mot de passe. |
| Pendant | Au besoin : approuver / refuser depuis le téléphone ; consulter « Publiés » ; à chaque post passé, « J'ai publié à la main » + lien (ou demandez à la personne désignée). |

Le calendrier de départ : `docs/operations/social-calendar-2026-10-19.md`.

## C. Réseau en Chine — ce que je sais et ce que je n'ai pas testé

- **Je n'ai rien testé depuis la Chine.** Ne supposez pas que Nordla, Instagram ou Facebook seront accessibles depuis tous les réseaux chinois.
- Instagram et Facebook sont réputés **inaccessibles** depuis la Chine continentale sans itinérance ou VPN. À régler **avant** le départ : itinérance de votre opérateur belge (le trafic passe généralement par le réseau d'origine) ou eSIM de voyage, et tester l'accès à Meta Business Suite et à l'app Nordla **à l'étranger avant** de dépendre d'eux. Respectez la réglementation locale sur les VPN.
- L'app Nordla elle-même doit être **joignable depuis votre téléphone** : aujourd'hui elle tourne sur le PC de bureau en boucle locale. Pour y accéder à distance, il faut une décision d'hébergement ou de tunnel (voir `social-go-live.md` §5). Sans cela, **la méthode B (tout programmé avant le départ) est la seule qui ne dépend de rien**.
- Si rien n'est joignable : les posts déjà **programmés dans Meta** partent quand même. Les contenus non programmés ne partent pas : c'est le comportement voulu (aucune publication sans votre approbation).

## D. Quand quelque chose ne va pas

| Ce que vous voyez | Ce que ça veut dire | Quoi faire |
|---|---|---|
| « Résultat inconnu — à vérifier » | une publication a peut-être abouti (coupure réseau) | regardez la Page/le compte ; si le post existe : « C'est publié (lien) » ; sinon « Rien n'est publié » (Nordla pourra réessayer) |
| « Erreur : RECONNECT_REQUIRED » | jeton expiré/révoqué | régénérez le jeton (`social-go-live.md` §2), ou publiez à la main |
| « Erreur : MISSED_WINDOW » | l'heure est passée de plus de 6 h : Nordla ne publie pas en retard sans vous | décidez : « Réessayer » ou « Annuler » |
| « Erreur : ASSET_CHANGED » | le fichier en ligne n'est plus celui approuvé | ne rien publier ; demandez à D une nouvelle version, réapprouvez |
| Bandeau rouge « suppression… non confirmée » | une copie programmée chez Facebook/Meta existe peut-être encore | supprimez-la dans Meta Business Suite |
| « SIMULÉ — rien n'a été publié » | mode démonstration | rien n'est parti ; ne comptez pas dessus |
