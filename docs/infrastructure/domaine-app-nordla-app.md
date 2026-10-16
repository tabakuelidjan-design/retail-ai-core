# Domaine `app.nordla.app` — prérequis, configuration préparée, risques (AUCUN changement DNS fait)

Vérification directe du DNS impossible depuis la session de travail : la politique réseau de l'environnement refuse
`app.nordla.app`, `nordla.app` et `dns.google`. L'état actuel du DNS est à lire chez le registraire (Porkbun) ou dans Railway.

## Ce que le code impose (vérifié dans le dépôt)

| Point | Comportement | Conséquence |
|---|---|---|
| Origine | `SOURCING_PUBLIC_ORIGIN` = **une seule** origine https exacte ; son hôte est le seul accepté (`src/sourcing/server/hosted.js`) | l'adresse Railway temporaire et `app.nordla.app` ne marchent **pas en même temps** : changer l'origine = redémarrer le service avec la nouvelle valeur |
| Sonde Railway | `/healthz` répond avant le contrôle d'hôte | le healthcheck reste vert quel que soit le domaine |
| Cookies de session | `__Host-` (https obligatoire, sans `Domain`, liés à l'hôte exact) + CSRF | changer de domaine = **se reconnecter** ; aucun cookie partagé entre domaines |
| HTTPS | en-tête HSTS `max-age=31536000` | une fois `app.nordla.app` servi en https, le navigateur refuse le http pendant un an (normal) |
| Données du téléphone | `localStorage` + IndexedDB (photos) + cache du service worker (`nordla-sourcing-terrain-v2-1`) **par origine** | la nouvelle adresse démarre **vide** sur le téléphone ; rien n'est migré automatiquement |
| Données du serveur | volume `/app/data` + Supabase | **inchangées** par un changement de domaine |

Transfert d'une adresse à l'autre **prouvé** dans un vrai navigateur (pas sur le Xiaomi) : `test/e2e/sourcing-origin-migration.e2e.js`
7/7 — export sur l'ancienne origine (le dossier et ses 3 photos, l'écran affiche « 3 photo(s) sur 3 »), récupération sur la
nouvelle, rien de perdu, rien d'effacé.

## Recommandation pour le 18 octobre

Faire la répétition Xiaomi **directement sur `app.nordla.app`** (autorisation DNS avant le 18), avec des **données de test** :
le téléphone ne changera ainsi d'adresse qu'une seule fois. Un essai technique préalable sur l'adresse Railway temporaire se fait
depuis un navigateur d'ordinateur, sans y mettre de vraies données.

## Configuration préparée (à appliquer seulement après votre accord)

1. Railway → service `sourcing-staging` → *Settings* → *Networking* → *Custom Domain* → `app.nordla.app`. Railway affiche la cible
   exacte (un nom `*.up.railway.app`) et, le cas échéant, un enregistrement TXT de vérification.
2. Porkbun → `nordla.app` → DNS : enregistrement **CNAME** `app` → la cible affichée par Railway (TTL 600) ; + le TXT si demandé.
   Aucun autre enregistrement n'est touché.
3. Attendre le certificat (émis automatiquement par Railway ; quelques minutes).
4. Variable `SOURCING_PUBLIC_ORIGIN=https://app.nordla.app` sur `sourcing-staging` (redémarrage).
5. Contrôles : `https://app.nordla.app/healthz` → 200 ; page de connexion ; un hôte différent → refusé ; cookie `__Host-` présent.

Redirections : aucune nécessaire (pas d'ancien domaine public). Le passage `http://` → `https://` est fait par le réseau Railway :
à contrôler au point 5 (`http://app.nordla.app/healthz` doit aboutir en https), non vérifiable d'ici.

## Validation HTTPS, certificat, redirections — méthode exacte (préparée le 16/10, AUCUN DNS modifié)

Adresse retenue par le propriétaire (16/10) : **`app.nordla.app`**. L'état DNS actuel n'est **pas lisible** depuis la session de travail
(résolution DNS publique et `nordla.app` bloqués par la politique réseau) : les points « avant » ci-dessous se lisent chez Porkbun.

Avant (lecture seule, Porkbun → `nordla.app` → DNS) :
- aucun enregistrement `app` existant (sinon : le noter, ne pas l'écraser sans accord) ;
- **CAA** : s'il existe des enregistrements CAA sur `nordla.app`, l'un doit autoriser `letsencrypt.org` (Railway émet ses certificats
  avec Let's Encrypt) ; aucun CAA = tout est autorisé ;
- **DNSSEC** : s'il est activé chez Porkbun, il doit être cohérent (un DNSSEC cassé bloque silencieusement la validation).

Ajout (après accord DNS explicite) :
1. Railway → `sourcing-staging` → *Settings* → *Networking* → *Custom Domain* → `app.nordla.app` : Railway donne **deux** valeurs : la
   cible du CNAME (`<quelque chose>.up.railway.app`) et un jeton de vérification de propriété.
2. Porkbun : `CNAME app → <cible Railway>` (TTL 600) **et** `TXT _railway-verify.app → <jeton Railway>`. Rien d'autre.
3. Attendre dans Railway l'état « certificat émis » (minutes ; d'après la communauté Railway, le certificat reste bloqué tant que le TXT
   manque). **Ne pas** supprimer / recréer le domaine plusieurs fois : Let's Encrypt limite les certificats répétés.
4. `SOURCING_PUBLIC_ORIGIN=https://app.nordla.app` sur le service (redémarrage). Avant ce changement le service refuse l'hôte
   `app.nordla.app` (421) : c'est attendu.

Vérification (depuis un ordinateur, avant de donner l'adresse au téléphone) :
| Contrôle | Commande | Attendu |
|---|---|---|
| Résolution | `nslookup app.nordla.app` | CNAME vers la cible Railway |
| Certificat | `openssl s_client -connect app.nordla.app:443 -servername app.nordla.app </dev/null 2>/dev/null \| openssl x509 -noout -issuer -subject -dates` | émetteur Let's Encrypt, sujet `app.nordla.app`, dates valides |
| Santé | `curl -sS https://app.nordla.app/healthz` | `{"ok":true}` |
| Redirection | `curl -sI http://app.nordla.app/healthz` | 301/308 vers `https://` (fait par Railway) ; de toute façon **tout le domaine `.app` est en HSTS préchargé** : aucun navigateur n'y fait de requête `http://` |
| En-têtes | `curl -sI https://app.nordla.app/` | `strict-transport-security`, `content-security-policy`, `x-frame-options: DENY` |
| Hôte strict | `curl -sI https://<cible>.up.railway.app/` (après bascule) | 421 (seul `app.nordla.app` est servi) |
| Sans session | `curl -s https://app.nordla.app/api/core/modules` | 401 |

Délai conseillé : faire l'ajout DNS au plus tard le **17/10**, pour garder une journée si le certificat tarde. Plan B si le certificat
n'est pas émis à temps : test sur l'adresse Railway générée (le téléphone changera alors d'adresse une fois de plus : export « N photo(s)
sur N » obligatoire avant tout changement).

## Retour arrière

Supprimer l'enregistrement CNAME `app` et le TXT `_railway-verify.app` chez Porkbun, retirer le domaine dans Railway, et remettre `SOURCING_PUBLIC_ORIGIN` sur l'adresse Railway : aucune
donnée serveur touchée. Les données d'un téléphone restent sur l'origine où elles ont été saisies (elles ne sont pas effacées).

## Risques

- Données saisies sur une origine puis abandon de celle-ci : récupérables seulement par export / récupération ou via le serveur
  (si le dossier a été synchronisé). D'où : **export vérifié (« N photo(s) sur N ») avant tout changement d'adresse**.
- Propagation DNS : de quelques minutes à quelques heures selon le TTL actuel.
