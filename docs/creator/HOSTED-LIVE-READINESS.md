# Creator : génération réelle sur le staging hébergé — état des lieux (2026-11-17)

Branche : `feature/creator-hosted-live-readiness` (depuis `df559108`). Document seul : aucun code d'exécution, aucun changement de l'image, aucun secret. Rien ici n'est déployé.

## 1. Ce que fait `/creator` sur le staging aujourd'hui
- Mode **DÉMO uniquement** : `GET /api/creator/status` répond `mode: SIMULATED`, `demo: true`. Chaque résultat est marqué DÉMO, rien n'est publié, aucun appel payant.
- Le « hub » du serveur est `src/creative-autonomy/creator/staging-world.js` : il ne répond qu'à `produce_product_visual` et rejoue deux runs archivés (image de test, run `cr-08a0933b0836` pour le cas `NONE`). Aucun fournisseur, aucun réseau.
- Le mode réel existe **seulement en local** : `LIVE_LOCAL` (`npm run creator:live`, worktree `nordla-creator-live`, branche `feature/creator-live-local-v1`) : boucle locale 127.0.0.1, session administrateur, moteurs Python locaux, clés Alibaba lues dans `~/nordla-private/alibaba.env`, registre de dépense sur fichier, plafond 0,60 € par tentative et 5 € par mois, chaque phase payante autorisée par l'administrateur. Sa doc dit : « Interface hébergée : inchangée, toujours en DEMO ; mode hébergé réel hors V1 ».

## 2. Ce qui manque pour un réel hébergé (rien de cela n'existe sur le staging)
| # | Manque | Détail |
|---|---|---|
| 1 | Moteurs Python | `examine_product.py`, `scene_plate.py`, `scene_check.py`, `compose_stage.py` et `local-environment.js` ne sont pas dans la branche staging. L'image (`deploy/sourcing/Dockerfile`, `node:24-slim`) n'a ni Python ni numpy 2.5.3 / Pillow 12.3.0 / scipy 1.18.1 (`requirements-creator.txt`), ni les polices. |
| 2 | Monde « réel » hébergé | `live-world.js` est écrit pour un poste (fichiers privés, loopback, administrateur). Il faut un équivalent hébergé : registre de dépense et politique sur le volume, par marchand, autorisation par phase depuis la session Nordla (et non depuis un lien de session local). |
| 3 | Secrets Railway | Variables à créer sur `sourcing-staging` (noms seulement, jamais les valeurs dans Git ni dans le chat) : `ALIBABA_MODEL_STUDIO_WORKSPACE_ID` + `ALIBABA_MODEL_STUDIO_API_KEY` (texte, espace EU), `ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID` + `ALIBABA_MODEL_STUDIO_IMAGE_API_KEY` (image, Nordla-C2, périmètre Global), `NORDLA_ALIBABA_SCOPE`. |
| 4 | Décision NDR-D02 | L'interdiction d'appel payant sur le serveur n'est levée que pour LIVE_LOCAL. Un réel hébergé demande une décision explicite du propriétaire (hébergé, staging, plafond). |
| 5 | Autorisations de médias | La politique permanente `policy://habb/creative-media-live-local` est acceptée localement (2026-11-05). Pour l'hébergé : l'équivalent enregistré par marchand sur le volume. |
| 6 | Fenêtre de build | L'ajout de Python modifie l'image commune à tous les services (zone d'impact élevée) : à faire dans une image ou un service **dédié** à Creator, pas dans l'image partagée. |

## 3. Configuration Alibaba (vérifiée localement, sans afficher de clé)
- Runtime (`marketing-creative/alibaba/config.js`) : région **`eu-central-1` (Francfort)** seule autorisée (défaut) ; image **`qwen-image-3.0-pro`** seul modèle image autorisé ; texte `qwen3.8-max` ou `qwen3-vl-plus` ; vidéo `wan3.0-video`. L'hôte appelé est `<workspace>.eu-central-1.maas.aliyuncs.com`.
- `~/nordla-private/alibaba.env` (modifié le 2026-11-05) : l'entrée **image** (`ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID` + clé) **correspond à Nordla-C2** (périmètre Global) et diffère de l'entrée générique (`ALIBABA_MODEL_STUDIO_WORKSPACE_ID` + clé), qui est l'espace **texte EU**. C'est donc l'entrée générique, pas l'image, qui est « un autre workspace » : voulu (texte EU, image Global).
- Absents du fichier (valeurs par défaut du code) : région (→ `eu-central-1`), modèles (→ ceux ci-dessus), `NORDLA_ALIBABA_SCOPE` (le lanceur doit le déclarer ; sans lui le texte n'est pas branché).
- Aucune variable Alibaba n'existe sur Railway : le staging ne peut donc pas appeler le fournisseur, indépendamment du reste.

## 4. Essai réel avec `batterie-noir.png` (état de préparation)
- Photo : `C:\Users\etaba\nordla-trials\batterie\batterie-noir.png`, PNG 800×799, SHA-256 `f5d76544…f75bf5` (identique au plan d'origine).
- Environnement local : l'interpréteur par défaut (`pythoncore-3.14.4`) n'a pas scipy ; `C:\Python314\python.exe` (3.14.7) passe tous les contrôles → `NORDLA_PYTHON=C:\Python314\python.exe`.
- Politique de médias : acceptée (2026-11-05). Registre local : 22 réservations, 0 ouverte, 1,4537 € réglés en novembre (base registre) sur 5 € par mois.
- Autorisation d'essai : **non donnée dans cette conversation** (identifiant de plan et plafond de l'essai). Les appels payants exigent l'autorisation explicite du propriétaire pour chaque plan. Aucun appel n'a été fait.
- Ordre d'exécution prévu, une fois autorisé : (a) contrôle gratuit hors réseau ; (b) sonde gratuite de Nordla-C2 (paramètre invalide, HTTP 400 attendu `InvalidParameter`, pas `Model.Unsupported`) ; (c) phase concept texte (plafond 0,20 €) ; (d) phase image (plafond 0,60 € la tentative), puis contrôle de fidélité du boîtier, des deux câbles tressés et des connecteurs USB-C / Lightning.

## 5. Proposition (pour décision, sans l'implémenter)
Service Railway **dédié** `creator-staging` (image avec Python, non partagée), même volume de données par marchand, session Nordla existante, secrets propres, un seul marchand pilote, plafond 0,60 € par tentative, déclenchement par phase depuis l'écran. Les moteurs viennent de `feature/creator-live-local-v1` (cherry-pick des seuls fichiers moteur, comme pour l'intégration de `8a417062`).
