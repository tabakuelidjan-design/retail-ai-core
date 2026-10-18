// Builds galerie.html (local, static, no network) from src/shared/assets/nordla/library/catalog.json.
//   node docs/design/nordla-icon-library-v2/build-gallery.mjs
// Shows every function by category: retained V2 icon (or none), the V1 official icon already in production, and every received
// variant with its technical verdict. Nothing is fetched: the catalogue is embedded at build time (file:// cannot read JSON).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const cat = JSON.parse(readFileSync(join(ROOT, 'src/shared/assets/nordla/library/catalog.json'), 'utf8'));
const rel = (p) => relative(HERE, join(ROOT, p));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MOD = { core: 'Nordla Core', finance: 'Finance', analytics: 'Analyses', growth: 'Développement des ventes', procurement: 'Stock / Achats', sourcing: 'China Sourcing', parle: 'Parle à Nordla',
  sales: 'Ventes / CRM', marketing: 'Marketing', branding: 'Branding', creative: 'Création', suppliers: 'Fournisseurs', compliance: 'Conformité', afterSales: 'Après-vente',
  connections: 'Centre des connexions', decisions: 'Journal des décisions', assistants: 'Assistants', settings: 'Paramètres', products: 'Produits' };
const badge = (cls, txt) => `<span class="b ${cls}">${esc(txt)}</span>`;
const state = (f) => (f.file ? badge('ok', f.reuses ? 'V2 conforme (réutilisée)' : 'V2 conforme') : f.v1_official.length ? badge('bv1', 'V1 seule') : badge('ko', 'aucune icône utilisable'));
const card = (f) => {
  const v1 = f.v1_official.map((v) => `<figure class="v1"><img src="${esc(rel(v.file))}" alt=""><figcaption>V1 · ${esc(v.key)}</figcaption></figure>`).join('');
  const main = f.file ? `<figure class="main"><img src="${esc(rel(f.file))}" alt=""><figcaption>V2 retenue</figcaption></figure>` : '<figure class="main none"><span>—</span><figcaption>pas de V2 conforme</figcaption></figure>';
  const variants = (f.sources ?? []).map((s) => {
    const p = s.library_path ?? s.reference_path; const name = s.source.split('/').pop();
    const tag = s.verdict === 'conforme' ? (s.retained ? 'retenue' : `doublon${s.duplicate_of ? ' de ' + s.duplicate_of : ''}`) : 'À CORRIGER';
    return `<li class="${s.verdict === 'conforme' ? 'c' : 'x'}">${p ? `<img src="${esc(rel(p))}" alt="">` : '<span class="nofile">·</span>'}<div><b>${esc(s.lot)}</b> ${esc(name)}<br><span class="t">${esc(tag)}</span>${s.reasons.length ? `<br><span class="r">${esc(s.reasons.join(' ; '))}</span>` : ''}${s.note ? `<br><span class="n">${esc(s.note)}</span>` : ''}</div></li>`;
  }).join('');
  return `<article class="f" data-state="${f.file ? 'v2' : f.v1_official.length ? 'v1' : 'none'}"><header><h3>${esc(f.label)}</h3><code>${esc(f.id)}</code></header>
    <div class="vis">${main}${v1}</div><div class="st">${state(f)}${f.file ? badge('wait', 'validation graphique en attente') : ''}</div>
    <p class="mods">${f.modules.map((m) => esc(MOD[m] ?? m)).join(' · ')}</p>${variants ? `<details><summary>${f.sources.length} fichier(s) reçu(s)</summary><ul class="var">${variants}</ul></details>` : ''}</article>`;
};
const F = cat.functions;
const sections = Object.entries(cat.categories).map(([k, label]) => {
  const fs = F.filter((f) => String(f.category) === k);
  const v1only = cat.v1_without_v2_equivalent.filter((f) => String(f.category) === k);
  return `<section id="c${k}"><h2>${esc(k)}. ${esc(label)} <small>${fs.length} fonctions · ${fs.filter((f) => f.file).length} V2 conformes</small></h2><div class="grid">${fs.map(card).join('')}${v1only.map(card).join('')}</div></section>`;
}).join('');
const tot = { fn: F.length, v2: F.filter((f) => f.file).length, files: new Set(F.filter((f) => f.file).map((f) => f.file)).size, v1: F.filter((f) => f.v1_official.length).length + cat.v1_without_v2_equivalent.length,
  none: F.filter((f) => !f.file && !f.v1_official.length).length, ref: F.flatMap((f) => f.sources).filter((s) => s.verdict !== 'conforme').length };
const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bibliothèque d'icônes Nordla V2</title>
<style>
@font-face{font-family:Montserrat;src:url(${esc(rel('src/shared/assets/nordla/fonts/montserrat-latin.woff2'))}) format('woff2');font-weight:100 900}
:root{--bg:#F5F6F8;--card:#fff;--ink:#111827;--muted:#5B6678;--line:#E5E7EB;--navy:#0F2A52;--bronze:#95652F;--ok:#137A54;--okt:#E6F4EE;--ko:#B83A2F;--kot:#FBECEA;--wt:#FBF1DD;--w:#8A5A00;--v1t:#EEF0F3}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 Montserrat,system-ui,sans-serif}
.top{position:sticky;top:0;z-index:2;background:var(--card);border-bottom:1px solid var(--line);padding:12px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.top img{width:30px;height:30px}.top h1{font-size:18px;margin:0}.top .k{color:var(--muted);font-size:12px}
.filters{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}.filters button{font:inherit;font-size:12px;border:1px solid var(--line);background:var(--card);border-radius:99px;padding:5px 10px;cursor:pointer}
.filters button[aria-pressed=true]{background:var(--navy);color:#F8F5ED;border-color:var(--navy)}
nav.cats{padding:8px 16px;display:flex;gap:6px;flex-wrap:wrap}nav.cats a{font-size:12px;color:var(--bronze);text-decoration:none;border:1px solid var(--line);border-radius:99px;padding:3px 9px;background:var(--card)}
main{padding:0 16px 40px;max-width:1440px;margin:0 auto}h2{font-size:17px;margin:22px 0 10px}h2 small{color:var(--muted);font-weight:500;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.f{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;min-width:0}.f header{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.f h3{font-size:14px;margin:0}.f code{font-size:10.5px;color:var(--muted);overflow-wrap:anywhere}
.vis{display:flex;gap:10px;margin:10px 0 6px;align-items:flex-end}figure{margin:0;text-align:center;font-size:10px;color:var(--muted)}
figure.main img,figure.main span{width:72px;height:72px;display:grid;place-items:center;object-fit:contain}figure.v1 img{width:48px;height:48px;object-fit:contain}
figure.none span{border:1.5px dashed #C49A60;border-radius:10px;color:#C49A60;font-size:20px}
.st{display:flex;gap:5px;flex-wrap:wrap}.b{font-size:10.5px;font-weight:700;border-radius:99px;padding:2px 8px}.ok{background:var(--okt);color:var(--ok)}.ko{background:var(--kot);color:var(--ko)}.wait{background:var(--wt);color:var(--w)}.bv1{background:var(--v1t);color:var(--muted)}
.mods{font-size:11px;color:var(--muted);margin:6px 0 0}details{margin-top:6px}summary{cursor:pointer;font-size:12px;color:var(--bronze)}
ul.var{list-style:none;padding:0;margin:6px 0 0;display:grid;gap:6px}ul.var li{display:flex;gap:8px;align-items:flex-start;font-size:11px}ul.var img,.nofile{width:40px;height:40px;object-fit:contain;flex:none;background:conic-gradient(#e6e6e6 25%,#fff 0 50%,#e6e6e6 0 75%,#fff 0) 0 0/10px 10px;border-radius:6px}
li.x .t{color:var(--ko);font-weight:700}li.c .t{color:var(--ok);font-weight:700}.r{color:var(--muted)}.n{color:var(--w)}
@media (max-width:600px){.top{position:static}.top h1{font-size:16px}.grid{grid-template-columns:1fr}}
</style></head><body>
<div class="top"><img src="${esc(rel('src/shared/assets/nordla/brand/nordla-monogram.svg'))}" alt=""><div><h1>Bibliothèque d'icônes Nordla V2</h1><div class="k">${tot.fn} fonctions · ${tot.v2} avec V2 conforme (${tot.files} fichiers) · ${tot.v1} V1 officielles en production · ${tot.none} sans icône utilisable · ${tot.ref} fichiers À CORRIGER</div></div>
<div class="filters" role="group" aria-label="Filtrer"><button data-f="all" aria-pressed="true">Toutes</button><button data-f="v2" aria-pressed="false">V2 conformes</button><button data-f="v1" aria-pressed="false">V1 seule</button><button data-f="none" aria-pressed="false">Sans icône</button></div></div>
<nav class="cats">${Object.entries(cat.categories).map(([k, l]) => `<a href="#c${k}">${esc(k)}. ${esc(l)}</a>`).join('')}</nav>
<main>${sections}</main>
<script>if(location.search.includes('ouvrir'))document.querySelectorAll('details').forEach((d)=>{d.open=true;});document.querySelector('.filters').addEventListener('click',(e)=>{const b=e.target.closest('button');if(!b)return;document.querySelectorAll('.filters button').forEach((x)=>x.setAttribute('aria-pressed',String(x===b)));document.querySelectorAll('.f').forEach((f)=>{f.hidden=b.dataset.f!=='all'&&f.dataset.state!==b.dataset.f;});});</script>
</body></html>`;
writeFileSync(join(HERE, 'galerie.html'), html);
console.log(`galerie.html: ${tot.fn} fonctions, ${tot.files} fichiers V2, ${tot.ref} à corriger`);
