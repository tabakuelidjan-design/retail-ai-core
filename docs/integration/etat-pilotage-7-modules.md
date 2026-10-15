# État de pilotage — 7 modules (mis à jour le 2026-10-15, branche `claude/nordla-core-p0`)

Règle : OPÉRATIONNEL = utilisable par le propriétaire sur le serveur hébergé, prouvé de bout en bout. Compiler ou passer des tests
unitaires ne suffit pas. **Aucun module n'est OPÉRATIONNEL aujourd'hui** : rien n'est encore déployé (Railway en attente d'activation,
identité staging incomplète).

| Module | Ce qui fonctionne réellement (prouvé) | Reste à raccorder | Dans l'interface | Données / dépendances | Commit · preuves | Limites | Statut |
|---|---|---|---|---|---|---|---|
| **Nordla Core** | Sujet → options → recommandation → décision humaine (raison obligatoire, rôle Propriétaire) → suivi ; journal chaîné, persistant, rejoué au redémarrage | Déploiement ; identité staging | Menu « Nordla Core » du téléphone | Identité Supabase (staging), volume Railway | `a550cff` ; `core-pilot` 8/8, navigateur `core:e2e` 5/5 | Sujets « achat sourcing » seulement ; aucune règle propriétaire configurée | PARTIEL |
| **Finance** | Lecture seule par le Core : factures fournisseurs à payer (échéances, retards), trésorerie, achats du mois — moteurs Finance inchangés, aucune écriture | Interface dédiée dans l'entrée unique ; lecture des données réelles (autorisation séparée) | Parle à Nordla (texte) | `MERCHANT_TIMEZONE` ; Finance staging n'a que des données synthétiques d'un autre marchand → réponse « aucune facture » pour HABB en staging | `c333f1a` ; `core-readers` 4/4 (synthétique) | Le service Finance existant garde sa connexion propre (jeton) : pas encore unifié avec l'identité Core | PARTIEL |
| **Analytics** | Lecture seule : ventes d'une période vs période précédente, produits / canaux en hausse et en baisse (faits), causes jamais affirmées, données anciennes signalées | Idem Finance ; génération des rapports depuis la base du serveur | Parle à Nordla (texte) | Rapports reconstruits par le run Analytics (mode `report`) ; ventes synchronisées | `c333f1a` ; `core-readers` 4/4 | Service Analytics existant : accès Basic + jeton, non unifié | PARTIEL |
| **China Sourcing** | Dossiers, photos (copie serveur, conflits), hors ligne, synchronisation, sauvegarde chiffrée + restauration prouvée (local + conteneur) | Déploiement Railway ; restauration sur Railway réel | Application complète | Volume `/app/data`, identité | `20ee43d`, `6d721c4`, `c2c314d` ; e2e photos 6/6, migration 7/7, reconnexion 9/9, PWA 18/18 | Pas encore testé sur Xiaomi | PARTIEL |
| **Branding** | Moteurs présents (`checkClaimsAgainstBrand`, `evaluateBrandGuardian`) | Raccordement au Core | — | **Aucune règle de marque HABB approuvée n'existe** (config/merchants/habb n'en contient pas) : rien ne peut être vérifié sans elles | — | Ne pas inventer de règles | BLOQUÉ (données propriétaire) |
| **Marketing** | Contrat de campagne déterministe (`buildCampaignContract`, contrôles stock + marque) dans la couche d'intégration | Raccordement au Core, stockage persistant (aujourd'hui en mémoire) | — | Produits, stock, règles de marque | — | Publication impossible par conception | PARTIEL (non raccordé) |
| **Création** | Chaîne `runCreativeEndToEnd` avec statuts honnêtes (`PROVIDER_NOT_CONNECTED`, `NEEDS_OWNER_REVIEW`…) ; fonctionne avec des ports de test uniquement | Fournisseur de génération réel ; déterminisme du masque produit (PM-6) | — | Clés Alibaba Model Studio + budget (dépense : accord requis) | — | Sans fournisseur : aucune création réelle ne sera présentée | BLOQUÉ (fournisseur) |

## Blocages vérifiés
1. **Supabase staging, migrations 2–5** : le connecteur Supabase bloque tout texte contenant deux `DELETE` (diagnostic prouvé) ; la
   session n'a pas d'accès PostgreSQL direct. Canal prêt et testé : `.github/workflows/staging-db-ops.yml` (sauvegarde chiffrée,
   restauration prouvée, une transaction par migration, contrôles). Attend : environnement GitHub `supabase-staging` + 2 secrets + accord.
2. **Railway** : activation du patch `sourcing-staging` (session Railway, accord propriétaire + coût).
3. **Branding** : règles de marque HABB approuvées par le propriétaire.
4. **Création** : fournisseur de génération (clés, budget) — décision propriétaire.
