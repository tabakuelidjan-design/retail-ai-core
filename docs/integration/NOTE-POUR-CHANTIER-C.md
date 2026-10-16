# Note au chantier Stock/Achats (C) — deux patchs à intégrer de façon contrôlée (aucune de vos branches n'a été modifiée)

Base de vérification : `feature/stock-achat-v1` @ `b3d4161`. Les deux patchs s'appliquent proprement à cette tête (`git apply --check` vérifié) ; ils sont aussi présents dans la branche d'intégration `integration/parle-a-nordla-convergence` (même contenu : si vous les adoptez d'abord, la fusion de ma branche est sans conflit puisque les hunks sont identiques).

## 1. `chantier-c-find-supplier.patch` — outil `find_supplier` (recherche de fournisseur par nom)
- `src/procurement/assistant.js` : nouvel outil de lecture `find_supplier({ text })` → `OK | AMBIGUOUS | NOT_FOUND` + candidats (5 au plus). **Ne renvoie que** `supplierId, name, country, currency, incotermDefault, leadTimeDays` : ni contacts, ni coordonnées bancaires, ni documents. Lié à l'entreprise de l'appelant (le magasin est celui de son marchand).
- `src/integration/procurement-policy.js` : une ligne (`find_supplier`, BUYING, lecture seule).
- Tests mis à jour : 16 outils, 14 lectures, 18 actions (`integration-procurement`, `procurement-assistant`) : **11/11 verts** sur votre tête.
- Droits d'accès : l'outil est en lecture seule ; l'affichage dépend du rôle côté Parle à Nordla (conditions et fiabilité réservées à Propriétaire/Administrateur) — testé, avec isolation entre entreprises et absence de fuite de coordonnées.
- Pas de doublon : une seule implémentation, dans l'assistant ; Parle à Nordla ne fait que l'appeler.

## 2. `chantier-c-procurement-answers-fixes.patch` — deux défauts de `src/core-pilot/procurement-answers.js` (fichier de la convergence)
- **Défaut A** (ligne 29) : la regex `mes|les|toutes les … commandes|bons de commande` contenait de **vrais caractères de contrôle (retour arrière)** à la place de `\b` : la branche ne s'activait jamais, « mes commandes » n'était pas reconnue. Corrigé.
- **Défaut B** : la référence d'article est lue par `\b[A-Za-z]{2,}-\d{2,}\b` : pour `TEST-MAG-001` elle retourne `MAG-001` (article introuvable, « Quel article ? »). Corrigé (`[A-Za-z0-9]{2,}(?:-[A-Za-z0-9]+)*-\d{2,}`) ; même correction dans mon module de comparaison.
- Trouvés par la répétition automatisée du scénario Xiaomi avec les articles `TEST-…` ; test de non-régression `core-procurement-routing` (« SKUs with several hyphen segments… »).
