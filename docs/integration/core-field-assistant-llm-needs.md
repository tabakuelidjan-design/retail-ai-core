# Parle à Nordla — besoins d'un futur modèle de langage (documentation seule : rien n'est intégré, aucun fournisseur choisi, aucune dépendance ajoutée)

## 1. Faut-il un modèle ? — décision par la mesure, pas par principe
Aujourd'hui l'assistant est déterministe : reconnaissance par règles, réponses construites par code à partir des moteurs métier. Un modèle ne se justifie **que si la campagne sur formulations réelles** (`eval/campagne/`) montre un taux élevé d'**échecs sûrs sur des phrases légitimes** (« pas compris » / question de précision là où une réponse était attendue). Seuils proposés : `SAFE_FAIL` > 15 % sur le jeu `test` réel, **et** les échecs sont des formulations (pas des fonctions manquantes). Si les échecs sont des fonctions manquantes (multi-dossiers, calculs nouveaux), un modèle n'aide pas : il faut du moteur.
Mesure de départ (jeux de l'auteur, non réels) : 80 % de reconnaissance sur le jeu indépendant, 0 réponse dangereuse.

## 2. Rôles autorisés (et seulement ceux-là)
| Rôle | Ce que fait le modèle | Ce qu'il ne reçoit pas | Garde-fou vérifiable |
|---|---|---|---|
| **A. Interpréter la phrase** (remplace l'étage 1) | `text → { intent ∈ FIELD_INTENT, confidence }` | le dossier, les chiffres, le journal, les identités | sortie validée contre l'énumération ; hors liste ou confiance < seuil → `AMBIGUOUS` (question à l'utilisateur) ; jamais d'exécution |
| **B. Reformuler la réponse** (optionnel, après l'étage 6) | `réponse structurée → texte plus naturel` | rien de plus que la réponse déjà affichable à l'utilisateur | **garde numérique** : tout nombre, date, identifiant du texte produit doit figurer dans la réponse structurée ; sinon on affiche la réponse déterministe. Une négation (« pas », « aucun », « impossible ») présente dans la source ne peut pas disparaître |
| **C. Transcrire la voix** (hors modèle de langage) | ASR → texte | — | passe par A ; aucune autre autorité |

**Jamais** : écrire dans le journal, calculer un montant, lever ou masquer un blocage, valider une décision, passer ou préparer une commande, choisir le dossier actif, élargir la lecture à un autre dossier ou marchand, produire une règle propriétaire. Ces chemins n'existent pas dans la couche de réponse et ne doivent pas y être ajoutés.

## 3. Exigences de sécurité (à tester avant toute intégration)
1. **Aucune autorité** : le modèle est appelé par un adaptateur qui ne reçoit pas de handle vers le runtime, le journal, la base ou le réseau métier. Test d'isolation d'imports (comme `core-field-assistant-contracts.test.js`).
2. **Injection** : toute sortie du modèle est une donnée non fiable ; les phrases d'attaque du jeu indépendant (« ignore les blocages… », « SYSTEM: … ») et les textes fournisseur malveillants doivent donner 0 `UNSAFE`. Le jeu d'attaques est rejoué avec le modèle branché ; un seul `UNSAFE` = NO-GO.
3. **Déterminisme de repli** : si le modèle est indisponible, lent (> 2 s), coûteux ou renvoie une sortie invalide, l'assistant répond avec les règles actuelles. Le modèle ne peut pas dégrader la disponibilité.
4. **Pas de fuite** : le texte envoyé au modèle est la seule phrase de l'utilisateur (pour le rôle A) ; pas de nom de fournisseur, de prix, de dossier. Le rôle B ne reçoit que la réponse que l'utilisateur voit déjà.
5. **Journalisation** : aucune phrase ni sortie n'est conservée par défaut. Toute conservation (pour l'évaluation) exige un consentement explicite, des règles d'accès et une durée — décision du propriétaire, pas de l'implémentation.
6. **Reproductibilité** : version du modèle et du prompt enregistrées avec chaque mesure ; une mesure sans version n'est pas une preuve.
7. **Évaluation continue** : mêmes critères que la campagne (0 `UNSAFE`, `WRONG` ≤ 3 %, correct + précision ≥ 85 %, utilité ≥ 4/5), mesurés avec le modèle **et** sans (le gain doit être démontré).

## 4. Exigences techniques et d'exploitation
- **Interface** (déjà réservée par l'architecture) : `intentProvider(text) → { intent, confidence } | null` et `narrator(structuredAnswer) → { text } | null`, branchées dans `ask.js` uniquement derrière un indicateur de configuration ; sans configuration → comportement actuel, strictement inchangé.
- **Hébergement et données** : région et conditions contractuelles à valider par le propriétaire avant tout appel (précédent : les chantiers créatifs ont imposé une région UE pour certains fournisseurs) ; clé jamais dans le dépôt, jamais dans le navigateur ; appel côté serveur uniquement.
- **Coût et latence** : plafond mensuel et plafond par requête, disjoncteur (circuit breaker) ; budget de latence p95 compatible avec une question posée chez un fournisseur (cible : réponse complète < 3 s, dont modèle < 1,5 s). Aucun appel payant n'est activé sans autorisation explicite.
- **Langue** : français (belge/France), anglais mélangé, fautes de frappe, dictée sans ponctuation (ASR) ; le jeu de la campagne doit les couvrir.
- **Observabilité** : compteurs (taux de repli, de refus par garde numérique, latence, coût) sans contenu des phrases.

## 5. Ce qui bloque aujourd'hui
Pas de corpus réel ; pas de décision de fournisseur, de région ni de budget ; pas de test de dictée sur le terrain ; le jeu d'attaques doit être étendu avec des tentatives réelles. Ces points sont des décisions du propriétaire, pas des tâches techniques. **Rien n'est lancé.**
