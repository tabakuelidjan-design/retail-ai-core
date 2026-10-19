"""Complete gallery generator (loaded by tools/nordla-icon-tools.py gallery). Static HTML, relative paths, no network."""
import html, json, os
from pathlib import Path

GROUPS_V1 = [('01_navigation_modules', 'Navigation et modules'), ('02_performance_business', 'Performance business'), ('03_clients', 'Clients'), ('04_produits_commerce', 'Produits et commerce'),
             ('04_ui_core', 'Interface Core'), ('08_ui_utilities', 'Utilitaires')]


def gallery(g):
    OUT = g['OUT']; ROOT = g['ROOT']; cat = g['CATALOG']
    inv = json.loads((OUT / 'INVENTORY.json').read_text(encoding='utf-8'))
    man = json.loads((OUT / 'candidates-technical' / 'manifest.json').read_text(encoding='utf-8'))
    esc = lambda x: html.escape(str(x if x is not None else ''))
    rp = lambda p: os.path.relpath(ROOT / p, OUT).replace('\\', '/')
    files = inv['files']; cnt = inv['counts_by_status']

    def img(p, size=64, cls=''):
        return f'<img src="{esc(rp(p))}" width="{size}" height="{size}" alt="" class="{cls}">'

    def multi(p):
        return ''.join(f'<img src="{esc(rp(p))}" width="{s}" height="{s}" alt="">' for s in (16, 24, 32))

    sec = []
    v1 = [r for r in files if r['status'] == 'VALIDATED_V1']

    def v1_group(r):
        n = Path(r['path']).name
        for pre, label in GROUPS_V1:
            if n.startswith(pre):
                return label
        return 'Autres'
    byg = {}
    for r in v1:
        byg.setdefault(v1_group(r), []).append(r)
    cards = []
    for label, rs in byg.items():
        figs = ''.join(
            f'<figure class="c ok"><div class="big">{img(r["path"], 72)}</div><div class="sm">{multi(r["path"])}</div>'
            f'<figcaption><b>{esc(r["registry_key"])}</b><span>{esc(", ".join(r.get("used_by") or []) or "non utilisée par un écran")}</span></figcaption></figure>' for r in rs)
        cards.append(f'<h3>{esc(label)} <small>{len(rs)}</small></h3><div class="grid">{figs}</div>')
    sec.append(('v1', f'1. Validées — pack officiel V1 ({len(v1)})', 'Seules icônes affichées par les écrans. Tailles 16 / 24 / 32 px sous chaque icône.', ''.join(cards)))

    dv = [r for r in files if r['status'] == 'V1_DEFECTIVE']
    figs = ''.join(f'<figure class="c ko"><div class="big">{img(r["path"], 72)}</div><figcaption><b>{esc(r["registry_key"])}</b><span>{esc(r.get("note"))}</span></figcaption></figure>' for r in dv)
    sec.append(('defective', f'2. Pack V1 défectueux — jamais affichés ({len(dv)})', 'Fichiers expédiés tels quels mais bloqués par le registre (traits coupés, fragments de légende). Montrés ici pour décision.', f'<div class="grid">{figs}</div>'))

    fn_by_id = {f['id']: f for f in cat['functions']}
    pend = [r for r in files if r['status'] == 'V2_CONFORME_PENDING_VALIDATION']

    def v2card(r):
        f = fn_by_id.get(r['function_id'], {}); v1s = f.get('v1_official', [])
        v1html = ''.join(f'<div class="v1"><img src="{esc(rp(x["file"]))}" width="56" height="56" alt=""><small>V1 · {esc(x["key"])}</small></div>' for x in v1s)
        tail = ' · arbitrage V1/V2' if v1s else ''
        return (f'<figure class="c wait"><div class="pair"><div><img src="{esc(rp(r["path"]))}" width="72" height="72" alt=""><small>V2</small></div>{v1html}</div>'
                f'<figcaption><b>{esc(r["function_label"])}</b><span>{esc(r["function_id"])}</span><span class="b w">validation graphique en attente{tail}</span></figcaption></figure>')
    sec.append(('v2', f'3. V2 techniquement conformes — validation graphique en attente ({len(pend)})', 'Copies octet pour octet du lot 1, non branchées. Quand une V1 existe, elle est montrée à côté : arbitrage à faire.', '<div class="grid">' + ''.join(v2card(r) for r in pend) + '</div>'))

    def candcard(e):
        warn = f'<span class="b k">{esc(e["style_warning"])}</span>' if e.get('style_warning') else ''
        return (f'<figure class="c cand"><div class="pair"><div><img src="{esc(rp(e["source"]))}" width="64" height="64" alt=""><small>avant</small></div>'
                f'<div class="chk"><img src="{esc(rp(e["candidate"]))}" width="64" height="64" alt=""><small>après</small></div></div>'
                f'<figcaption><b>{esc(e["function_id"])}</b><span>{esc(e["fix_class"])} · natif {e["native_before"][0]}×{e["native_before"][1]} · net jusqu’à ≈ {e["safe_css_size_px"]} px CSS</span>{warn}'
                f'<span class="b w">candidat technique — à valider</span></figcaption></figure>')
    sec.append(('cand', f'4. Corrections techniques proposées — {man["count"]} candidats (à valider)',
                'Fond blanc et résidus de carte retirés (bord reconstruit à partir de la couleur pleine voisine) ou marge transparente ajoutée, sans redessiner, recolorer ni agrandir. Rien n’est branché. Résolution native conservée : nets uniquement jusqu’à la taille indiquée.',
                '<div class="grid">' + ''.join(candcard(e) for e in man['files']) + '</div>'))

    fixed = {e['source'] for e in man['files']}
    redo = [r for r in files if r['status'] == 'V2_TO_FIX' and r['path'] not in fixed]
    lab = {'NEEDS_REDRAW_CLIPPED': 'trait coupé', 'NEEDS_REDRAW_COLOUR': 'accent ou couleur hors famille', 'NEEDS_REDRAW_CAPTION': 'légende intégrée', 'NO_PICTOGRAM': 'texte seul, aucun pictogramme', 'LOWRES_ONLY': 'basse résolution', 'UNCLASSIFIED': 'autre'}
    figs = ''.join(f'<figure class="c ko"><div class="big">{img(r["path"], 64)}</div><figcaption><b>{esc(r["function_label"])}</b><span>{esc(lab.get(r["fix_class"], r["fix_class"]))}</span><span>{esc("; ".join(r.get("defects") or []))}</span></figcaption></figure>' for r in redo)
    sec.append(('redo', f'5. À redessiner par l’équipe créative — {len(redo)} fichiers reçus', 'Défauts qu’aucun traitement d’image ne peut réparer sans inventer du dessin (trait manquant, couleur hors famille, légende, texte seul).', f'<div class="grid">{figs}</div>'))

    miss = inv['missing_functions']
    pr = {}
    for m in miss:
        pr.setdefault(m['priority'] or '—', []).append(m)
    body = ''
    for p, v in sorted(pr.items()):
        items = ''.join(f'<li><b>{esc(m["label"])}</b> <code>{esc(m["id"])}</code> <span>{esc(m["category"])}</span> <span class="r">{esc(", ".join(m["fix_classes"]) or "aucun fichier reçu")}</span></li>' for m in v)
        body += f'<h3>{esc(p)} <small>{len(v)}</small></h3><ul class="miss">{items}</ul>'
    sec.append(('missing', f'6. Fonctions sans aucune icône utilisable — {len(miss)}', 'À créer en SVG par l’équipe créative dans la famille Finance (décision du 2026-10-17). P0 = bloquant pour les écrans actuels.', body))

    gr = [r for r in files if r['status'].startswith('GROWTH')]
    figs = ''.join(f'<figure class="c wait"><div class="big">{img(r["path"], 72)}</div><figcaption><b>{esc(Path(r["path"]).stem)}</b><span>{esc(", ".join(r.get("used_by") or []) or "—")}</span></figcaption></figure>' for r in gr)
    sec.append(('growth', f'7. Collection Growth — {len(gr)} icônes, hors famille Finance (à arbitrer)', 'Style volumétrique (volumes, dégradés) différent de la famille Finance à plat. Utilisées par Développement des ventes. « collection-autumn » montre une feuille.', f'<div class="grid">{figs}</div>'))

    idn = [r for r in files if r['status'] in ('IDENTITY_ASSET', 'APP_ICON', 'MODULE_ASSET')]
    figs = ''.join(f'<figure class="c"><div class="big chk">{img(r["path"], 72, "contain")}</div><figcaption><b>{esc(Path(r["path"]).name)}</b><span>{esc(r["status"])}{" · SVG" if r.get("kind") == "svg" else ""}</span></figcaption></figure>' for r in idn)
    sec.append(('identity', f'8. Identité, icônes d’application et assets de modules — {len(idn)}', 'Logo, monogramme, Parle à Nordla, icônes d’installation (PWA), micro de l’écran Analyses.', f'<div class="grid">{figs}</div>'))

    nav = ''.join(f'<a href="#{k}">{esc(t.split(" — ")[0].split(" (")[0])}</a>' for k, t, _, _ in sec)
    kpis = [('Validées V1', cnt.get('VALIDATED_V1', 0), 'ok'), ('V1 défectueuses', cnt.get('V1_DEFECTIVE', 0), 'ko'), ('V2 conformes (à valider)', cnt.get('V2_CONFORME_PENDING_VALIDATION', 0), 'w'),
            ('Candidats techniques', man['count'], 'w'), ('À redessiner', len(redo), 'ko'), ('Fonctions sans icône', len(miss), 'ko'), ('Growth (à arbitrer)', cnt.get('GROWTH_OUT_OF_FAMILY_TO_ARBITRATE', 0), 'w')]
    font = esc(rp('src/shared/assets/nordla/fonts/montserrat-latin.woff2'))
    kp = ''.join(f'<div class="kpi {c}"><b>{n}</b><span>{esc(l)}</span></div>' for l, n, c in kpis)
    secs = ''.join(f'<section id="{k}"><h2>{esc(t)}</h2><p>{esc(d)}</p>{b}</section>' for k, t, d, b in sec)
    css = open(Path(__file__).with_name('nordla-icon-gallery.css'), encoding='utf-8').read().replace('__FONT__', font)
    doc = (f'<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nordla — galerie complète des icônes</title><style>{css}</style></head><body>'
           f'<header class="top"><h1>Nordla — galerie complète des icônes</h1><p>Générée par tools/nordla-icon-tools.py gallery à partir des fichiers réels du dépôt (aucun réseau). Famille de référence : Finance V1. '
           f'Rien n’est redessiné ni recoloré ; les fichiers validés ne sont jamais modifiés ; les corrections proposées sont des candidats à valider.</p><div class="kpis">{kp}</div></header>'
           f'<nav>{nav}</nav><main>{secs}</main></body></html>')
    (OUT / 'galerie-complete.html').write_text(doc, encoding='utf-8')
    print('gallery written', len(doc), 'bytes')
