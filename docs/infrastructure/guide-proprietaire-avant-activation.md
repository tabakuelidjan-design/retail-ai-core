# Avant l'activation — vos 5 gestes (environ 20 minutes)

Règle unique : **une valeur secrète ne va que dans le champ prévu** (Railway ou GitHub). Jamais dans un chat, un e-mail, une note
partagée ou une capture d'écran. Gardez une copie dans votre gestionnaire de mots de passe.

## 1. Voir le budget Railway
railway.com → connectez-vous → en haut à gauche, votre **espace de travail** (*workspace*) → **Usage**.
Notez le montant « mois en cours » de **tout** l'espace (vos services existants y comptent déjà).

## 2. Créer l'alerte à 8 USD
Même page **Usage** → **Usage Limits** (ou *Set usage limits*) :
- **Custom email alert** : `8` → enregistrer. Vous recevrez un e-mail à 8 USD ; rien ne s'arrête.
- **Hard limit** : laissez **vide**, sauf si le montant noté au §1 est très bas. Une limite stricte arrête **tous** vos services Railway
  quand elle est atteinte (minimum 10 USD).

## 3. Les 5 secrets dans Railway (et les sceller)
Projet **app.nordla.app** → environnement **staging** → service **sourcing-staging** → onglet **Variables** → **New Variable**.
Pour chacune : nom exact, valeur, **Add**. Puis sur la ligne : **⋮ → Seal** (la valeur devient illisible, même pour vous et pour le
connecteur ; le service la reçoit quand même). Ne cliquez **pas** sur *Deploy* : les variables restent en attente.

| Nom exact | Où prendre la valeur |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | supabase.com → projet **nordla-finance-staging** → *Project Settings* → *API Keys* → clé **service_role** (onglet *Legacy API keys*) |
| `SUPABASE_ANON_KEY` | même page, **même projet** → clé **anon** |
| `NORDLA_IDENTITY_RATE_LIMIT_KEY` | gestionnaire de mots de passe → générer un mot de passe de **64 caractères** |
| `NORDLA_CSRF_KEY` | idem, **un autre** mot de passe de 64 caractères |
| `SOURCING_BACKUP_PASSPHRASE` | une phrase d'au moins 16 caractères, **enregistrée d'abord** dans le gestionnaire (et sur papier) : sans elle aucune sauvegarde ne se relit |

Vérifiez que l'adresse de la page Supabase contient `fvhiammdskpcnfodsnrc` (staging) et **pas** `xbtzjabbseclmqfozjeo` (production).
Si une clé de production est collée par erreur, le service refusera de démarrer : rien n'est abîmé.

## 4. Les 2 secrets dans GitHub
github.com → dépôt **retail-ai-core** → **Settings** → **Environments** → **supabase-staging** → *Environment secrets* →
**Add environment secret** :
- `STAGING_SERVICE_ROLE_KEY` = la **même** clé `service_role` du projet staging ;
- `STAGING_SOURCING_BACKUP_PASSPHRASE` = **exactement la même** phrase que `SOURCING_BACKUP_PASSPHRASE`.

## 5. Vérifier que tout est prêt (sans rien révéler)
- Railway, onglet *Variables* de `sourcing-staging` : les 5 noms ci-dessus sont présents, chacun avec l'icône **scellé** (cadenas).
- GitHub, environnement `supabase-staging` : les 2 noms apparaissent avec la date du jour (GitHub n'affiche jamais les valeurs).
- Dites ensuite à ChatGPT : « secrets saisis, vérifie le lot » — il compte les lignes en attente **sans lire aucune valeur** (attendu :
  les 33 lignes déjà auditées + 5 secrets = **38**, toutes sur `sourcing-staging`).
- Enfin, si tout est conforme : écrivez « J'autorise le Deploy du lot staging de sourcing-staging ».
