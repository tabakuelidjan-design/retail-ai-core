# Chaîne D → E : ce qui fonctionne réellement (2026-10-16)

Branche `feature/chantier-d-branding-creative-pole`. Aucune publication, dépense, fusion ni secret. E = Social Publishing (`feature/social-publishing-e`) : ses fichiers ne sont pas modifiés.

## 1. Le contrat réel de E et ce que D en fait

E possède le calendrier, l'approbation et la publication ; D possède la création. D livre `social-post-proposal.v1` : `proposal_id` stable, `subject`, `asset {ref, version, sha256, content_type, width, height, ai_generated, alt_text}`, `caption`, `hashtags`, `targets [{platform, format}]`, `suggested_date` (suggestion), `notes`. E importe de façon idempotente : même contenu = aucun effet, nouvelle version d'asset = brouillon + approbation annulée, post déjà publié = intouchable.

Règles de E qui s'imposent à D (reflétées dans `buildSocialProposal`, avec le même motif de refus) :
- **JPEG obligatoire** pour une image Instagram envoyée automatiquement → D produit désormais du JPEG (encodeur déterministe `src/studio-compose/jpeg.js`) ; E n'a plus besoin de Python/Pillow.
- **Aucune promesse non confirmée** : prix, remise, délai en jours/heures, garantie, urgence. Le seul fait confirmé chez E est « coque 25 € » (mot « coque » requis). **Conséquence : le plan éditorial ne cite plus aucun autre prix** (gourde, horloge, coffret, puzzle, cadre). « Environ 5 minutes, selon le modèle et la disponibilité » n'est pas bloqué par le filtre.
- `ai_generated` et `alt_text` obligatoires ; stories et carrousels publiés à la main en V1.

Paquet livré : `proposals.json` + `assets/` au format de la bibliothèque d'assets de E (`index.json` + `files/<sha256>.jpg`) : E le monte tel quel. Les empreintes sont vérifiées avant écriture.

## 2. Preuves

| Preuve | Résultat |
|---|---|
| `test/social-compat.test.js` SE-1/SE-2 : le **vrai code de E** (service, post, assets) reçoit le paquet de D | CREATED ×3, aucun problème, `READY_FOR_REVIEW`, ni approbation ni publication par D, un agent ne peut pas approuver, relivraison = `UNCHANGED`, octets relus = octets livrés, règles de claims identiques chez D et chez E |
| Import du **paquet réel** des 3 démonstrations dans un service E (mémoire) | 5 posts (Instagram + Facebook), tous `READY_FOR_REVIEW`, 0 problème de préparation, `approval: null`, `publication: null` ; la story est signalée « manuelle en V1 » par E |
| CI de la branche | voir `ETAT-REEL.md` §Résultats (workflow `chantier-d-creative-pole`, Node 20 + 24, branche de E extraite à côté) |

## 3. Limites

- E ne publie rien en réel (aucun compte connecté, mode manuel/simulation) : « technique compatible » ne veut pas dire « publié ».
- Une **seconde réserve éditoriale** existe : `reports/editorial-14j/` (autre session, dépôt du site) que l'adaptateur de E sait lire. Mon plan et cette réserve se recoupent ; **une seule source de vérité doit être choisie par le propriétaire** (je n'ai touché à aucun de ses fichiers).
- Le miroir des règles de claims de D est une copie : le test SE-2 détecte toute dérive quand le checkout de E est présent.
