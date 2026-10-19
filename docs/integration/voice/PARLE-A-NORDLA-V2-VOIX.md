# Parle à Nordla V2 — la voix (branche `feature/parle-a-nordla-v2-voice`, base `5a57d0b`)

**Statut : construit et testé en local (faux micro et faux haut-parleur) ; NON essayé sur un Xiaomi, NON déployé, NON fusionné.** Le candidat staging `5a57d0b`, la PR #18, Railway, P0 et `main` ne sont pas touchés.

## 1. Audit des composants vocaux existants
| Composant | Rôle | Réutilisé ? |
|---|---|---|
| `src/sourcing/ui/voice.js` + `voice-engine-worker.js` + `voice-worklet.js` (Moonshine) | transcrire **l'anglais** d'un échange au stand en éléments de dossier (hors ligne dans le navigateur, ~65 Mo au premier démarrage, expérimental, jamais essayé sur appareil) | **Non** : anglais seulement, rôle différent (alimenter un dossier), poids et CSP `unsafe-eval` propres au worker. Conservé tel quel. |
| `src/analytics-premium/ui/speech.js` | dictée de la question d'Analytics par la reconnaissance du navigateur | **Principe repris** (même famille d'API), code non importé : modules isolés (règle du projet). |
| Pipeline de réponse (`src/core-pilot/*`, `/api/core/ask`) | comprend, lit, répond, refuse | **Réutilisé tel quel** : la voix ne fait que remplir la question. |

## 2. Architecture
`src/sourcing/ui/nordla-voice.js` (nouveau, pur et testable sans navigateur) :
- **Deux fournisseurs interchangeables** (`createRecognizer`, `createSynth`) : contrat `{ supported, start/stop }` et `{ supported, speak/cancel }`. Aujourd'hui : reconnaissance et synthèse du navigateur (aucun secret, aucun abonnement). Remplaçables plus tard sans toucher au reste.
- **Contrôleur** `createVoiceController` : états `idle · consent · preparing · listening · processing · review · denied · error · unsupported`.
- `speakable()` : ce qui est lu à voix haute = titre + blocage + prochaine étape, ≤ 320 caractères, **jamais** les sources, tableaux ou références (« la référence affichée »), toujours terminé par « Détails et sources à l'écran ». La réponse écrite reste toujours affichée.
Branchement minimal : `nordla-ask.js` (bloc voix au-dessus des boutons de questions, hook `onAnswer`), `core-panel.js` (une option `refresh`). Aucun fichier du serveur n'est modifié par la voix.

## 3. Ce qui est construit
| Besoin | Fait |
|---|---|
| Gros bouton micro, utilisable d'une main, **en haut** de l'écran (72 px, pleine largeur) | oui |
| Autorisation explicite : notice de consentement avant le premier démarrage (dit que le navigateur envoie le son à son service, Google sur Chrome ; Nordla n'enregistre rien) | oui |
| États visibles : autorisation, **J'écoute** (seulement quand le son arrive vraiment), Nordla réfléchit, relire, erreur | oui |
| Transcription visible **et corrigeable** dans la case, **non envoyée** sans « Demander » | oui |
| Option « Envoyer dès que j'ai fini de parler » (**désactivée par défaut**) | oui |
| Passage au clavier à tout moment ; micro refusé / absent / réseau coupé / rien entendu → message clair + clavier | oui |
| Lecture à voix haute facultative (**désactivée par défaut**), arrêt immédiat, « Écouter la dernière réponse » | oui |
| Le micro ne s'ouvre jamais pendant que Nordla parle (la lecture est coupée avant) | oui |
| Contexte conservé : question vocale puis question au clavier, même dossier, même conversation serveur | oui |
| Aucun enregistrement permanent par Nordla ; la conversation reste en mémoire du navigateur | oui |
| Aucune commande, aucun paiement, aucun ajustement de stock par la voix | oui (refus testés, §5) |

### Corrections de reconnaissance trouvées en testant les phrases du cahier des charges
- « Montre-moi les marchandises que j'attends » n'était pas comprise → reconnue comme Stock/Achats (« en transit »), ou « module non raccordé » si Achats est absent.
- « Est-ce que ce produit vaut la peine d'être acheté ? » → explication en lecture seule (jamais une commande).
- « Nordla, retrouve le dossier de ce fournisseur » (dossier ouvert) → ce que nous savons du dossier, fournisseur compris.
- **Défaut de sécurité corrigé** : « **ok Nordla** valide le paiement du fournisseur » n'était pas détectée comme demande d'action (réponse « pas compris » au lieu du refus). Les amorces parlées (« ok », « euh », « bon », « allez », « dis », « oui »…) ne cachent plus une action. Fichiers : `src/core-pilot/field-intents.js`, `src/core-pilot/procurement-answers.js` (une alternative ajoutée à l'expression « transit »).

## 4. Fichiers
Créés : `src/sourcing/ui/nordla-voice.js`, `test/nordla-voice.test.js`, `test/e2e/nordla-voice.e2e.js`, `docs/integration/core-field-assistant-eval/screens/parle-a-nordla-voix-390px.png`, ce document.
Modifiés : `src/sourcing/ui/nordla-ask.js`, `src/sourcing/ui/core-panel.js`, `src/core-pilot/field-intents.js`, `src/core-pilot/procurement-answers.js`, `docs/integration/xiaomi/verify-candidate.mjs` (ajoute les nouveaux tests à la vérification).
Aucun changement : serveur, Railway, migrations, `railway.json`, dépendances.

## 5. Tests (données synthétiques locales ; aucun staging)
- Unitaires : `test/nordla-voice.test.js` **13/13** — lecture courte sans source ni identifiant ; **quatre ordres parlés refusés** (commande, paiement, ajustement de stock, approbation) avec Stock/Achats intact et aucun outil appelé ; les phrases du cahier des charges routées ; erreurs micro (refus, absent, réseau, rien entendu) sans boucle ; hors ligne ; consentement avant démarrage ; option d'envoi automatique ; lecture activée/désactivée/interrompue ; voix puis clavier dans la même conversation ; échappement du texte.
- Navigateur (Edge, 390 px, serveur hébergé simulé, **faux** micro et haut-parleur injectés) : `test/e2e/nordla-voice.e2e.js` **9/9** — gros bouton avant la case clavier, consentement sans démarrage, « J'écoute » seulement quand le son arrive, mots intermédiaires, transcription corrigeable non envoyée, ordre parlé refusé et refus lu, arrêt de la lecture, micro refusé, navigateur sans reconnaissance, réseau coupé, pas de défilement horizontal.
- Vérification complète `verify-candidate.mjs` : **165 tests (20 fichiers), 0 échec** ; navigateur : répétition Xiaomi 10/10, interface 11/11, voix 9/9, Core 5/5, accès 7/7. (Le seul « FAIL » de la sortie sur arbre non committé est le contrôle d'arbre propre : à relancer après commit.)
- Aucune donnée TEST injectée dans staging.

## 6. Limites réelles (à dire telles quelles)
1. **Non essayé sur un Xiaomi.** Les tests injectent un faux micro : ils prouvent l'écran, le consentement, les replis et la sécurité, **pas** la qualité de la reconnaissance réelle.
2. **Chrome Android envoie le son au service de reconnaissance de Google** : il faut internet. **En Chine continentale ce service est probablement inaccessible** (non vérifié) : la dictée peut alors échouer. Ce n'est **pas** un moteur hors ligne. Repli : la touche micro du clavier Android, ou le clavier.
3. La reconnaissance du navigateur peut mal transcrire des noms de fournisseurs ou de produits : la relecture avant envoi est le garde-fou (l'envoi automatique est donc désactivé par défaut).
4. La lecture à voix haute dépend d'une voix française installée sur l'appareil (non garantie). Sinon : la réponse écrite reste.
5. Contrôle du microphone : Sourcing n'envoie aucun en-tête `Permissions-Policy` sur ses pages (vérifié sur le serveur hébergé simulé), donc le micro n'est pas bloqué par le serveur ; un en-tête ajouté plus tard au niveau de Railway pourrait le bloquer.
6. Le serveur n'écoute ni ne stocke aucun son ; en revanche le service de reconnaissance du navigateur reçoit le son : c'est dit dans la notice de consentement.

## 7. Améliorations utiles (non faites, sans accord)
- Moteur de transcription **français** embarqué (hors ligne) en remplacement du fournisseur du navigateur : nécessite un modèle (poids), un essai sur appareil et une décision de coût/qualité.
- Vocabulaire personnalisé (noms de fournisseurs du dossier) pour améliorer la reconnaissance.
- Mode « terrain » à contraste élevé.
- Essai guidé sur le Xiaomi : relever les phrases mal reconnues (procédure de `scenario-parle-a-nordla-18-octobre.md` §2).

## 8. Transmission pour revue indépendante (ChatGPT)
À vérifier : (a) `git diff 5a57d0b..feature/parle-a-nordla-v2-voice` ne touche ni serveur, ni migrations, ni `railway.json` ; (b) `node --test test/nordla-voice.test.js` et `node test/e2e/nordla-voice.e2e.js` ; (c) lire `speakable()` : rien d'engageant n'est lu ; (d) confirmer qu'aucune autorisation n'est donnée par la voix (`isActionRequest` avant tout) ; (e) relire le texte du consentement. Rien n'est à déployer pour la revue : la voix n'entre dans staging que si le propriétaire autorise une fusion dans P0 puis un nouveau Deploy (nouvelle autorisation distincte).
