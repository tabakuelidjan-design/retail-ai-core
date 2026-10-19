"""Module -> pictogram map (loaded by tools/nordla-icon-tools.py modulemap). Reads the Core screen's MODULE_META and the catalogue; says, for each module, what the screens use TODAY and what exists for it.
Nothing is applied: a V2 file is only ever proposed, and only after the graphic validation."""
import json, re
from pathlib import Path

# module (as named in the mission) -> catalogue function id, and how the Core screen (src/sourcing/nordla-ui/nordla-view.js MODULE_META) keys it
MODULES = [
    ('Nordla Core', 'module-tableau-de-bord', 'core'), ('Centre de pilotage', 'module-centre-de-pilotage', None), ('Finance', 'module-finance', 'finance'), ('Analyses', 'module-analyses', 'analytics'),
    ('China Sourcing', 'module-china-sourcing', 'sourcing'), ('Stock & Achats', 'module-stock-achats', 'procurement'), ('Développement des ventes', 'module-developpement-des-ventes', 'growth'),
    ('Branding', 'module-branding', 'branding'), ('Marketing', 'module-marketing', 'marketing'), ('Création', 'module-creation', 'creative'), ('Social Publishing', None, 'social'),
    ('Parle à Nordla', 'module-parle-a-nordla', 'parle'), ('Validations', 'validation', 'validations'), ('Conformité', 'module-conformite', None), ('Service après-vente', 'module-service-apres-vente', None),
    ('Journal des décisions', 'module-journal-des-decisions', None), ('Centre des connexions', 'module-centre-des-connexions', 'activation'), ('Assistants et automatisations', 'module-assistants-automatisations', None),
    ('Détection des opportunités', 'detection-opportunites', None), ('Fournisseurs', 'module-fournisseurs', None), ('Ventes et CRM', 'module-ventes-crm', None), ('Produits', 'module-produits', None),
]


def modulemap(g):
    ROOT = g['ROOT']; OUT = g['OUT']; cat = g['CATALOG']
    fn = {f['id']: f for f in cat['functions']}
    view = (ROOT / 'src' / 'sourcing' / 'nordla-ui' / 'nordla-view.js').read_text(encoding='utf-8')
    meta = dict((m.group(1), (m.group(2), m.group(3))) for m in re.finditer(r"(\w+): \{ icon: (null|'\w+')(?:, initial: '(\w)')?", re.search(r'MODULE_META = Object\.freeze\(\{(.*?)\n\}\);', view, re.S).group(1)))
    rows = []; today_keys = {}
    for label, fid, mkey in MODULES:
        f = fn.get(fid) if fid else None
        v1 = [v['key'] for v in f['v1_official']] if f else []
        v2 = f['id'] if (f and f.get('file')) else None
        if mkey and mkey in meta:
            icon, initial = meta[mkey]
            today = f"V1 `{icon.strip(chr(39))}`" if icon != 'null' else f"lettre « {initial} » (aucune icône officielle utilisable)"
            if icon != 'null': today_keys.setdefault(icon.strip("'"), []).append(label)
        else:
            today = 'pas d’entrée dans l’écran Core (module non listé comme tel)'
        if v1: avail = f"V1 validée `{v1[0]}`"
        elif v2: avail = 'aucune V1'
        else: avail = 'aucune V1'
        prop = f"V2 `{v2}` (techniquement conforme, validation graphique en attente)" if v2 else ('à créer (aucun fichier utilisable)' if not v1 else '—')
        rows.append((label, today, avail, prop, f['priority'] if f and f.get('priority') else ''))
    dups = {k: v for k, v in today_keys.items() if len(v) > 1}
    L = ['# Nordla — pictogramme de chaque module : ce que les écrans utilisent aujourd’hui et ce qui existe', '',
         'Généré par `tools/nordla-icon-tools.py modulemap` (écran Core : `MODULE_META` de `src/sourcing/nordla-ui/nordla-view.js` ; catalogue : `src/shared/assets/nordla/library/catalog.json`). **Rien n’est appliqué** : une V2 n’est proposée qu’après validation graphique.', '',
         '| Module | Aujourd’hui (écran Core) | Icône V1 validée existante | Proposition / reste à faire | Priorité |', '|---|---|---|---|---|']
    for r in rows: L.append('| ' + ' | '.join(r) + ' |')
    L += ['', '## Une fonction = un pictogramme', '']
    if dups: L += [f"- **Même pictogramme pour plusieurs modules** : " + '; '.join(f"`{k}` → {', '.join(v)}" for k, v in dups.items()) + '. À arbitrer (le catalogue donne `growth` à Marketing, tandis que « Développement des ventes » n’a pas de V1 propre).']
    L += ['- **Même pictogramme pour deux sens** : `tresorerie` est à la fois l’icône du module Finance (écran Core) et celle de la vue « Trésorerie » dans Finance. À arbitrer avec la validation de `module-finance` (le fichier Finance du lot 1 est coupé : à redessiner).',
          '- **Stand-in** : « Centre des connexions » utilise provisoirement `synchronisation` (aucune icône dédiée) ; Social Publishing n’a aucune fonction dans le catalogue V2 (« Publication sociale » est à ajouter).', '']
    (OUT / 'MODULE-ICON-MAP.md').write_text('\n'.join(L) + '\n', encoding='utf-8')
    print('module map', len(rows), 'modules; duplicates:', dups)
