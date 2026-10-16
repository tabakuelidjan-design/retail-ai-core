# Chantier E — bilan de transmission (2026-10-16)

Branche `feature/social-publishing-e`. Cible de la PR : `integration/nordla-convergence-v1` (tip e08d98d). **Aucune fusion automatique. Aucun déploiement. Aucun secret. Aucune connexion ni publication réelle.**

## 1. Preuves techniques

| Vérification | Résultat |
|---|---|
| Périmètre | 30 fichiers ajoutés (`src/social/`, `test/social-*`, `docs/…`, `scripts/social-export-jpeg.py`) ; **un seul fichier existant modifié : `package.json` (+2 lignes `social`, `social:cli`, insérées au milieu de la liste pour éviter les conflits)** |
| Tests dédiés Node 24.21.0 (Docker `node:24`) | 57 tests (54 + 3 voyage) — voir l'exécution finale ci-dessous |
| Tests dédiés Node 20.20.2 (Docker `node:20`) | idem |
| Suite générale, comparée **test par test** à la base `f7197d5` (même machine, deux exécutions complètes) | base : 3077 tests, 203 échecs · branche : 3129 tests, 204 échecs. **Les 204 noms d'échecs de la base sont tous présents sur la branche, identiques.** Seul écart : 1 test de performance Finance (« 3 000 factures… < 1 s ») échoué sous charge sur la branche ; rejoué isolément 3 fois sur chaque arbre : **réussi 3/3 des deux côtés** (fluctuation de charge). Aucun échec dans `social-*`. |
| Cause des échecs préexistants (échantillon lu) | paquet absent de l'environnement local (`@resvg/resvg-js`) → certains fichiers plantent à l'import ; autres échecs Finance/PDF/Sourcing identiques à la base. Non analysés un par un : ils sont **identiques avec et sans ma branche**. |
| Fusion dans Convergence (copie jetable, tip e08d98d) | **propre**, 0 conflit après déplacement des scripts npm. Sous-ensemble `social + channel + provider + integration` : mêmes 3 fichiers en échec (`integration-contracts`, `-procurement`, `-workflows`, paquet manquant) **avec et sans** ma branche. |
| Dépendances | `src/social` n'importe que Node intégré et `src/activation/{constants,validation,providers/common,providers/http,providers/instagram}.js`. Aucun paquet npm nouveau. L'export JPEG exige Python + Pillow (hors paquets du dépôt ; le test est ignoré si absent). |
| Risques d'intégration | **D** : aucun fichier partagé ; lecture seule de `reports/editorial-14j`. **Activation / Provider** : réutilisés en import, non modifiés ; le port `credentials.js` est à remplacer par le coffre de Provider au câblage. **Convergence** : `src/social` n'est **pas** enregistré dans `src/integration` (hub, policy, module-map) : à faire par le responsable de convergence ; ses tests ne peuvent pas être exécutés localement (paquet manquant) → **la CI de la PR doit les confirmer**. |

## 2. Contrat D (`social-post-proposal.v1`) — vérifié par test
Identifiant stable (post id dérivé de `proposal_id` + plateforme + format) · version d'asset immuable + empreinte sha256 contrôlée à l'aperçu, au téléchargement et à l'envoi · réimport identique = aucun effet · nouvelle version d'asset ou nouveau texte = brouillon + approbation annulée · post publié intouchable · date du propriétaire jamais écrasée · aucun prix/promotion/délai non confirmé (blocage ; seul « coque 25 € » passe, via un registre explicite du propriétaire).
**JPEG** : `npm run social:cli -- jpeg-for-meta` crée des copies JPEG (qualité 92, sources opaques donc sans aplatissement) en **nouveaux assets** (`…-jpeg`), bascule les posts image (donc approbation annulée, testé) et **conserve les PNG** ; les fichiers de D ne sont pas touchés.

## 3. Voyage
Lot réduit : P01, P06, P08 (photos simples) × Instagram + Facebook = 6 posts. Dates : lun 19/10 12:00 · jeu 29/10 12:00 · dim 01/11 18:00 (Bruxelles ; 10:00Z, 11:00Z, 17:00Z). Changement d'heure du 25/10 testé. Programmation manuelle chez Meta jamais republiée par Nordla : testé, y compris après redémarrage complet. Dossier prêt à l'usage (hors dépôt) : `reports/social-voyage-2026-10-20/` du projet HABB (JPEG, textes, textes alternatifs, checklist).

## 4. Non fait / limites
Aucune PR créée par moi (aucun jeton GitHub disponible) : lien de comparaison fourni. Aucune connexion Meta. CI de la branche non encore exécutée. Aucun test sur vrai téléphone ni réseau chinois.
