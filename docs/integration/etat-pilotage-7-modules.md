# État de pilotage — 7 modules (mis à jour le 2026-10-15 soir, branche `claude/nordla-core-p0`)

Règle : OPÉRATIONNEL = utilisable par le propriétaire sur le serveur hébergé, prouvé de bout en bout. Compiler ou passer des tests
unitaires ne suffit pas. **Aucun module n'est OPÉRATIONNEL aujourd'hui** : rien n'est encore déployé (Railway en attente d'activation,
identité staging incomplète).

| Module | Ce qui fonctionne réellement (prouvé) | Reste à raccorder | Dans l'interface | Données / dépendances | Commit · preuves | Limites | Statut |
|---|---|---|---|---|---|---|---|
| **Nordla Core** | Sujet → options → recommandation → décision humaine (raison obligatoire, rôle Propriétaire) → suivi ; journal chaîné, persistant, rejoué au redémarrage | Déploiement ; identité staging | Menu « Nordla Core » du téléphone | Identité Supabase (staging), volume Railway | `a550cff` ; `core-pilot` 8/8, navigateur `core:e2e` 5/5 | Sujets « achat sourcing » seulement ; aucune règle propriétaire configurée | PARTIEL |
| **Finance** | Lecture seule par le Core : factures fournisseurs à payer (échéances, retards), trésorerie, achats du mois — moteurs Finance inchangés, aucune écriture | Interface dédiée dans l'entrée unique ; lecture des données réelles (autorisation séparée) | Parle à Nordla (texte) | `MERCHANT_TIMEZONE` ; Finance staging n'a que des données synthétiques d'un autre marchand → réponse « aucune facture » pour HABB en staging | `c333f1a` ; `core-readers` 4/4 (synthétique) | Le service Finance existant garde sa connexion propre (jeton) : pas encore unifié avec l'identité Core | PARTIEL |
| **Analytics** | Lecture seule : ventes d'une période vs période précédente, produits / canaux en hausse et en baisse (faits), causes jamais affirmées, données anciennes signalées | Idem Finance ; génération des rapports depuis la base du serveur | Entrée « Nordla » → Analytics + Parle à Nordla | Rapports reconstruits par le run Analytics (mode `report`) ; ventes synchronisées | `c333f1a` ; `core-readers` 4/4 | Service Analytics existant : accès Basic + jeton, non unifié | PARTIEL |
| **China Sourcing** | Dossiers, photos (copie serveur, conflits), hors ligne, synchronisation, sauvegarde chiffrée + restauration prouvée (local + conteneur) | Déploiement Railway ; restauration sur Railway réel | Application complète | Volume `/app/data`, identité | `20ee43d`, `6d721c4`, `c2c314d` ; e2e photos 6/6, migration 7/7, reconnexion 9/9, PWA 18/18 | Pas encore testé sur Xiaomi | PARTIEL |
| **Branding** | Cycle réel du module Branding : proposition HABB → aperçu indicatif (non officiel) → approbation par le PROPRIÉTAIRE connecté (refusée aux autres rôles) → verdict officiel du Gardien (ex. « dernière chance » = FAIL, texte sobre = PASS) ; persistant au redémarrage | Votre approbation de la proposition | Entrée « Nordla » → Branding | `config/merchants/habb/brand-proposal.json` (tirée de `business-principles.md`, rien d'inventé) | voir journal git ; `core-modules` 2/2, `nordla:e2e` | Aucune affirmation produit approuvée ; aucune règle visuelle (logo, couleurs inconnus) | PARTIEL (à approuver) |
| **Marketing** | Proposition de campagne à partir de données identifiées (Analytics), contrat Marketing existant (contrôles marque + stock), blocages listés, décision du PROPRIÉTAIRE avec raison, journalisée ; aucune diffusion possible | Affirmations approuvées ; stock réel | Entrée « Nordla » → Marketing | Branding approuvé, Analytics | idem | Sans affirmation approuvée, une proposition ne peut pas passer à la Création (dit comme tel) | PARTIEL |
| **Création** | Inventaire réel des moteurs (`docs/integration/creation-inventaire-moteurs.md`) ; statut honnête dans l'interface, clés manquantes nommées ; rien n'est produit ni simulé | Fournisseur de génération + budget plafonné (décision propriétaire) ; défaut de déterminisme PM-6 (session Création) | Entrée « Nordla » → Création (statut) | Clés Alibaba Model Studio | idem | Aucune création réelle possible aujourd'hui | BLOQUÉ (fournisseur) |

## Blocages vérifiés
1. **Supabase staging, migrations 2–5** : le connecteur Supabase bloque tout texte contenant deux `DELETE` (diagnostic prouvé) ; la
   session n'a pas d'accès PostgreSQL direct. Canal prêt, corrigé (`5dc4064` : restauration sans erreur masquée, structure + données
   comparées, couverture déclarée) et testé localement, y compris les échecs forcés. Attend : environnement GitHub `supabase-staging`
   + 2 secrets + votre accord (`run: true`).
2. **Railway** : activation du patch `sourcing-staging` (session Railway, accord propriétaire + coût).
3. **Branding** : examen et approbation de la proposition HABB par le propriétaire (dans l'application, rôle Propriétaire).
4. **Création** : fournisseur de génération (clés, budget) — décision propriétaire.
