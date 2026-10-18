#!/usr/bin/env python3
"""Nordla icon tooling (local, offline, deterministic). Needs Pillow + numpy. Nothing is fetched, nothing is redrawn.

  python tools/nordla-icon-tools.py inventory     -> docs/design/icons/INVENTORY.json + INVENTORY.md + CLASSIFICATION.md
  python tools/nordla-icon-tools.py candidates    -> docs/design/icons/candidates-technical/  (TECHNICAL clean-ups of files the audit marked "to fix"; never wired anywhere)
  python tools/nordla-icon-tools.py sharpness     -> docs/design/icons/SHARPNESS.json + SHARPNESS.md + sheets
  python tools/nordla-icon-tools.py gallery       -> docs/design/icons/galerie-complete.html
  python tools/nordla-icon-tools.py modulemap     -> docs/design/icons/MODULE-ICON-MAP.md

Rules kept: validated files are never modified (candidates are written to their own folder); a bitmap is never presented as vector; no colour, proportion or stroke is changed.
"""
import csv, hashlib, io, json, os, re, sys
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'design' / 'icons'
ASSETS = ROOT / 'src' / 'shared' / 'assets' / 'nordla'
CATALOG = json.loads((ASSETS / 'library' / 'catalog.json').read_text(encoding='utf-8'))
rel = lambda p: str(Path(p).resolve().relative_to(ROOT)).replace('\\', '/')
sha = lambda b: hashlib.sha256(b).hexdigest()


def registry():
    """ICONS and DEFECTIVE of src/shared/nordla-icon.js (the production registry), read as text: single source of truth."""
    src = (ROOT / 'src' / 'shared' / 'nordla-icon.js').read_text(encoding='utf-8')
    def block(name):
        m = re.search(r'const %s = \{(.*?)\n  \};' % name, src, re.S)
        return dict(re.findall(r"(\w+):\s*'([^']+)'", m.group(1))) if m else {}
    return block('ICONS'), block('DEFECTIVE')


def image_facts(path):
    raw = Path(path).read_bytes()
    ext = Path(path).suffix.lower()
    # text assets (SVG) are fingerprinted with LF line endings: the same file must give the same fingerprint on Windows (CRLF checkout) and on Linux
    f = {'bytes': len(raw), 'sha256_16': sha(raw.replace(b'
', b'
') if ext == '.svg' else raw)[:16]}
    if ext == '.svg':
        text = raw.decode('utf-8', 'replace'); m = re.search(r'viewBox="([^"]+)"', text)
        f.update(kind='svg', vector=True, viewBox=m.group(1) if m else None); return f
    try:
        im = Image.open(io.BytesIO(raw)); im.load()
    except Exception as e:  # not an image
        f.update(kind='other', error=str(e)[:60]); return f
    f.update(kind=ext.lstrip('.'), vector=False, width=im.width, height=im.height, mode=im.mode)
    rgba = np.asarray(im.convert('RGBA')); a = rgba[..., 3]
    f['has_alpha'] = bool((a < 255).any()); f['transparent_pct'] = round(float((a == 0).mean()) * 100, 1)
    ys, xs = np.where(a > 8)
    if len(ys):
        h, w = a.shape
        f['margins_px'] = {'top': int(ys.min()), 'left': int(xs.min()), 'bottom': int(h - 1 - ys.max()), 'right': int(w - 1 - xs.max())}
    corners = [tuple(rgba[y, x]) for y in (0, -1) for x in (0, -1)]
    f['corners_opaque'] = sum(1 for c in corners if c[3] > 200)
    solid = rgba[a > 200][:, :3]
    if len(solid):
        q = (solid // 32) * 32 + 16
        top = Counter(map(tuple, q)).most_common(3); f['dominant_rgb'] = ['#%02x%02x%02x' % c for c, _ in top]
    return f


def walk(d, exts=('.png', '.webp', '.svg', '.jpg', '.ico')):
    d = Path(d)
    return sorted(p for p in d.rglob('*') if p.is_file() and p.suffix.lower() in exts) if d.exists() else []


def usage_index():
    """Which source files mention an icon file name / registry key: {needle: [paths]} computed lazily by grep over src/ (not tests, not docs)."""
    texts = {}
    for p in (ROOT / 'src').rglob('*'):
        if p.is_file() and p.suffix in ('.js', '.html', '.css', '.mjs') and 'assets' not in p.parts[-2:-1]:
            try: texts[rel(p)] = p.read_text(encoding='utf-8', errors='ignore')
            except Exception: pass
    return texts


def module_of(path):
    parts = path.split('/')
    if len(parts) >= 2 and parts[0] == 'src':
        return {'sourcing': 'sourcing (app terrain + /nordla)', 'finance': 'finance', 'analytics-premium': 'analyses', 'growth': 'développement des ventes', 'procurement': 'stock-achats', 'social': 'social', 'shared': 'partagé', 'core-pilot': 'core'}.get(parts[1], parts[1])
    return '?'


def inventory():
    ICONS, DEFECTIVE = registry()
    texts = usage_index()
    by_file_key = {v: k for k, v in ICONS.items()}
    defective_files = {v: k for k, v in DEFECTIVE.items()}
    rows = []

    def add(path, source_set, status, **extra):
        r = {'path': rel(path), 'set': source_set, 'status': status, **image_facts(path), **extra}
        rows.append(r); return r

    # 1. official V1 pack
    for p in walk(ASSETS / 'official-icons'):
        name = p.name
        if name in by_file_key:
            key = by_file_key[name]; users = sorted({module_of(f) for f, t in texts.items() if re.search(r"semantic\(\s*'%s'" % key, t) or ("'%s'" % key in t and 'ICON_FILES' in t)})
            add(p, 'v1-official', 'VALIDATED_V1', registry_key=key, used_by=users)
        elif name in defective_files:
            add(p, 'v1-official', 'V1_DEFECTIVE', registry_key=defective_files[name], note='listed DEFECTIVE: never rendered (clipped / caption fragment); needs a clean re-export')
        else:
            add(p, 'v1-official', 'UNREGISTERED', note='present in the pack, not in the registry')
    # 2. V2 library (technically conforming, graphic validation pending)
    byfile = {}
    for f in CATALOG['functions']:
        if f.get('file'): byfile[f['file']] = f
    for p in walk(ASSETS / 'library'):
        f = byfile.get(rel(p)); add(p, 'v2-library', 'V2_CONFORME_PENDING_VALIDATION', function_id=f['id'] if f else None, function_label=f['label'] if f else None, category=f['category_label'] if f else None, v1_in_production=[v['key'] for v in f['v1_official']] if f else [])
    # 3. V2 reference files (to fix)
    reasons = {}
    for f in CATALOG['functions']:
        for s in f['sources']:
            if s.get('reference_path'): reasons[s['reference_path']] = (f, s)
    for p in walk(ROOT / 'docs' / 'design' / 'nordla-icon-library-v2' / 'reference'):
        f, s = reasons.get(rel(p), (None, None))
        reasons_list = s['reasons'] if s else []
        add(p, 'v2-reference', 'V2_TO_FIX', function_id=f['id'] if f else None, function_label=f['label'] if f else None, lot=s['lot'] if s else None, defects=reasons_list, fix_class=classify_defects(reasons_list))
    # 4. Growth collection
    gtxt = {f: t for f, t in texts.items() if f.startswith('src/growth/')}
    for p in walk(ROOT / 'src' / 'growth' / 'ui' / 'assets' / 'icons'):
        stem = p.stem
        users = sorted({module_of(f) for f, t in gtxt.items() if stem in t})
        note = 'volumetric / shaded illustration style (gradients, bevels), outside the flat Finance outline family: to arbitrate'
        if stem == 'collection-autumn': note += '; shows a LEAF (decorative leaf rule: confirm it is a function icon, not decoration)'
        add(p, 'growth', 'GROWTH_OUT_OF_FAMILY_TO_ARBITRATE', used_by=users, note=note)
    # 5. brand, Parle, app icons, other module assets
    for p in walk(ASSETS / 'brand'): add(p, 'brand', 'IDENTITY_ASSET')
    for p in walk(ASSETS / 'parle-a-nordla'): add(p, 'parle', 'IDENTITY_ASSET', note='official Parle à Nordla icon (white / terracotta)')
    for d, st in ((ROOT / 'src' / 'sourcing' / 'ui', 'APP_ICON'), (ROOT / 'src' / 'procurement' / 'ui', 'APP_ICON'), (ROOT / 'src' / 'analytics-premium' / 'ui' / 'assets', 'MODULE_ASSET')):
        for p in walk(d): add(p, 'module-assets', st)
    for p in walk(ROOT / 'src' / 'analytics-premium' / 'assets'): add(p, 'module-assets', 'MODULE_ASSET')
    # 6. missing functions (no usable icon) from the catalogue
    missing = [{'id': f['id'], 'label': f['label'], 'category': f['category_label'], 'priority': f.get('priority'), 'modules': f['modules'], 'received_files': len(f['sources']), 'fix_classes': sorted({classify_defects(s.get('reasons', [])) for s in f['sources'] if s.get('verdict') == 'a-corriger'})}
               for f in CATALOG['functions'] if not f.get('file') and not f['v1_official']]
    counts = Counter(r['status'] for r in rows)
    data = {'generated_from': 'repository files (see path); catalogue version %s' % CATALOG['version'], 'counts_by_status': dict(counts), 'files_total': len(rows), 'missing_functions': missing, 'files': rows}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'INVENTORY.json').write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    write_inventory_md(data); write_classification_md(data)
    print(json.dumps(counts, indent=1), 'files', len(rows), 'missing functions', len(missing))


def classify_defects(reasons):
    """What a TECHNICAL operation (no redraw, no recolour) could do for a file with these audit reasons."""
    r = ' | '.join(reasons)
    if not reasons: return 'NONE'
    if 'texte seul' in r: return 'NO_PICTOGRAM'
    if 'trait coupé' in r or 'fragment de légende' in r and 'coupé' in r: return 'NEEDS_REDRAW_CLIPPED'
    if 'accent brun' in r or 'aucun accent cuivre' in r or 'hors famille' in r: return 'NEEDS_REDRAW_COLOUR'
    if 'légende intégrée' in r or 'fragment de légende' in r: return 'NEEDS_REDRAW_CAPTION'
    if 'basse résolution' in r: return 'FIX_BACKGROUND_LOWRES' if 'résidus' in r else 'LOWRES_ONLY'
    if 'résidus' in r: return 'FIX_BACKGROUND'
    if 'recadré au ras' in r: return 'FIX_MARGIN'
    return 'UNCLASSIFIED'


STATUS_FR = {
    'VALIDATED_V1': 'validée (pack officiel V1, en production)', 'V1_DEFECTIVE': 'défectueuse (V1, jamais affichée)', 'UNREGISTERED': 'non enregistrée',
    'V2_CONFORME_PENDING_VALIDATION': 'V2 techniquement conforme — validation graphique en attente', 'V2_TO_FIX': 'à corriger (référence)',
    'GROWTH_OUT_OF_FAMILY_TO_ARBITRATE': 'collection Growth — hors famille, à arbitrer', 'IDENTITY_ASSET': 'identité (marque / Parle)', 'APP_ICON': 'icône d\'application', 'MODULE_ASSET': 'asset de module',
}


def write_inventory_md(data):
    rows = data['files']; by = defaultdict(list)
    for r in rows: by[r['set']].append(r)
    L = ['# Nordla — inventaire des icônes et assets graphiques existants', '',
         'Généré par `tools/nordla-icon-tools.py inventory` à partir des **fichiers réels du dépôt** (aucune estimation) ; chaque ligne renvoie à un chemin vérifiable. Rien n\'est modifié par cet inventaire.', '',
         '## Synthèse', '', '| Ensemble | Fichiers | Statuts |', '|---|---|---|']
    names = {'v1-official': 'Pack officiel V1 (`src/shared/assets/nordla/official-icons/`)', 'v2-library': 'Bibliothèque V2 conforme (`…/library/`)', 'v2-reference': 'V2 à corriger — références (`docs/design/nordla-icon-library-v2/reference/`)',
             'growth': 'Collection Growth (`src/growth/ui/assets/icons/`)', 'brand': 'Marque (`…/brand/`)', 'parle': 'Parle à Nordla', 'module-assets': 'Icônes d\'application et assets de modules'}
    for k, rs in by.items():
        st = Counter(r['status'] for r in rs)
        L.append(f"| {names.get(k, k)} | {len(rs)} | {', '.join(f'{STATUS_FR.get(s, s)} : {n}' for s, n in st.items())} |")
    L += ['', f"Total : **{len(rows)} fichiers** · **{len(data['missing_functions'])} fonctions** du catalogue sans aucune icône utilisable.", '',
          '**Aucune source vectorielle (SVG) d\'icône de fonction n\'existe dans le dépôt** : le pack V1 et la bibliothèque V2 sont des PNG 256 px ; les seuls SVG sont les logos de marque et les icônes d\'application. Aucun PNG n\'est présenté comme vectoriel.', '',
          '## Fichiers']
    for k, rs in by.items():
        L += ['', f'### {names.get(k, k)} ({len(rs)})', '', '| Fichier | Dimensions | Transparence | Statut | Remarques |', '|---|---|---|---|---|']
        for r in rs:
            dim = f"{r.get('width')}×{r.get('height')}" if 'width' in r else ('SVG' if r.get('kind') == 'svg' else '—')
            tr = 'oui' if r.get('has_alpha') else ('non' if 'has_alpha' in r else '—')
            extra = []
            if r.get('registry_key'): extra.append('clé `%s`' % r['registry_key'])
            if r.get('function_id'): extra.append('fonction `%s`' % r['function_id'])
            if r.get('used_by'): extra.append('utilisée par : ' + ', '.join(r['used_by']))
            if r.get('defects'): extra.append('défauts : ' + '; '.join(r['defects']))
            if r.get('note'): extra.append(r['note'])
            L.append(f"| `{r['path']}` | {dim} | {tr} | {STATUS_FR.get(r['status'], r['status'])} | {' · '.join(extra)} |")
    (OUT / 'INVENTORY.md').write_text('\n'.join(L) + '\n', encoding='utf-8')


def write_classification_md(data):
    rows = data['files']; ok = [r for r in rows if r['status'] == 'VALIDATED_V1']; pend = [r for r in rows if r['status'] == 'V2_CONFORME_PENDING_VALIDATION']
    bad = [r for r in rows if r['status'] in ('V1_DEFECTIVE', 'V2_TO_FIX')]; grow = [r for r in rows if r['status'].startswith('GROWTH')]
    fixc = Counter(r.get('fix_class') for r in rows if r['status'] == 'V2_TO_FIX')
    L = ['# Nordla — classement des icônes : validées, à corriger, manquantes', '',
         'Source : `INVENTORY.json` (fichiers réels) + `src/shared/assets/nordla/library/catalog.json`. Décisions déjà actées (2026-10-17) : la famille Finance V1 reste la référence ; accents **cuivre** conservés ; rien n\'est remplacé sans validation graphique.', '',
         f'## 1. Validées — {len(ok)} icônes (pack officiel V1, en production)', '',
         'Seules icônes affichées par les écrans. Registre : `src/shared/nordla-icon.js` (une fonction = une clé = un fichier).', '',
         ', '.join(f"`{r['registry_key']}`" for r in ok), '',
         f'## 2. Candidates V2 techniquement conformes — {len(pend)} (validation graphique en attente)', '',
         'Copies octet pour octet du lot 1, **non branchées** dans les écrans. Pour {} fonctions elles côtoient une V1 déjà en production (arbitrage V1/V2 à faire dans la galerie).'.format(sum(1 for r in pend if r.get('v1_in_production'))), '',
         ', '.join(f"`{r['function_id']}`" for r in pend), '',
         f'## 3. À corriger — {len(bad)} fichiers', '',
         f"- Pack V1 défectueux : **{sum(1 for r in bad if r['status']=='V1_DEFECTIVE')}** fichiers (déclarés DEFECTIVE dans le registre : jamais affichés).",
         f"- V2 reçus à corriger : **{sum(1 for r in bad if r['status']=='V2_TO_FIX')}** fichiers, par nature du défaut :", '']
    desc = {'FIX_MARGIN': 'marge nulle seule → correction technique possible (marge transparente ajoutée, dessin intact)', 'FIX_BACKGROUND_LOWRES': 'fond blanc/résidus + basse résolution → fond nettoyable, mais résolution native ≤ 112 px (usage ≤ 48 px CSS seulement)',
            'FIX_BACKGROUND': 'fond/résidus seuls → nettoyage technique possible', 'LOWRES_ONLY': 'basse résolution seule', 'NEEDS_REDRAW_CLIPPED': 'trait coupé → **à redessiner** (le trait manquant n\'existe plus dans le fichier)',
            'NEEDS_REDRAW_COLOUR': 'accent brun / hors famille → à redessiner dans la palette cuivre (aucune recoloration automatique)', 'NEEDS_REDRAW_CAPTION': 'légende intégrée → à redessiner ou à re-exporter', 'NO_PICTOGRAM': 'texte seul, aucun pictogramme → à créer'}
    for k, n in fixc.most_common(): L.append(f"  - {n} × `{k}` : {desc.get(k, k)}")
    L += ['', f"## 4. Manquantes — {len(data['missing_functions'])} fonctions sans aucune icône utilisable", '']
    byp = defaultdict(list)
    for m in data['missing_functions']: byp[m['priority'] or '—'].append(m)
    for p in sorted(byp): L.append(f"- **{p}** ({len(byp[p])}) : " + ', '.join(f"{m['label']} (`{m['id']}`)" for m in byp[p]))
    L += ['', f'## 5. Collection Growth — {len(grow)} icônes, hors famille Finance (à arbitrer)', '',
          'Style volumétrique (dégradés, volumes) différent de la famille Finance (traits bleu nuit et accent cuivre à plat). Utilisées par l\'écran Développement des ventes. Une icône (`collection-autumn`) montre une **feuille** : à confirmer. Le catalogue V2 ne les couvre pas.', '',
          ', '.join(f"`{Path(r['path']).stem}`" for r in grow), '']
    (OUT / 'CLASSIFICATION.md').write_text('\n'.join(L) + '\n', encoding='utf-8')


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'inventory': inventory()
    elif cmd == 'modulemap':
        import importlib.util
        spec = importlib.util.spec_from_file_location('nordla_icon_modulemap', ROOT / 'tools' / 'nordla-icon-tools-modulemap.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); m.modulemap(globals())
    elif cmd == 'gallery':
        import importlib.util
        spec = importlib.util.spec_from_file_location('nordla_icon_gallery', ROOT / 'tools' / 'nordla-icon-tools-gallery.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); m.gallery(globals())
    elif cmd in ('candidates', 'sharpness'):
        import importlib.util
        spec = importlib.util.spec_from_file_location('nordla_icon_more', ROOT / 'tools' / 'nordla-icon-tools-more.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); getattr(m, cmd)(globals())
    else: print(__doc__)
