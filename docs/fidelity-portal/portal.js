// FIDELITY PORTAL: static rendering of the six Field-mode states from FICTITIOUS data. Nothing here reads a case, a microphone, a network or an engine.
const I = (d, w = 24, extra = '') => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const ICON = {
  chat: I('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'), camera: I('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'), pencil: I('<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>'),
  bell: I('<path d="M6 17h12l-1.5-2V11a4.5 4.5 0 10-9 0v4L6 17z"/><path d="M10 20a2 2 0 004 0"/>', 26), mic: I('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0012 0M12 17v4"/>', 26),
  list: I('<path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/>', 20), bulb: I('<path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2v.1h5v-.1c0-.8.4-1.5 1-2A6 6 0 0012 3z"/>', 22),
  chev: I('<path d="M9 6l6 6-6 6"/>', 20, 'class="chev"'), dl: I('<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>', 22), warn: I('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>', 22),
  check: I('<path d="M4 12.5l4 4 6-8M11 16.5l1 1 8-9"/>', 15), pause: I('<path d="M9 6v12M15 6v12"/>', 22), stop: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>', x: I('<path d="M6 6l12 12M18 6L6 18"/>', 20),
  tag: I('<path d="M3 12V4h8l9 9-8 8z"/><path d="M7.5 7.5h.01"/>', 17), box: I('<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>', 17), clock: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>', 17), shield: I('<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>', 17),
  pin: I('<path d="M12 21s6-5.5 6-10a6 6 0 10-12 0c0 4.5 6 10 6 10z"/><circle cx="12" cy="11" r="2"/>', 15), msg: I('<path d="M4 5h16v11H9l-5 4z"/>', 22),
};
const ICON_CHECK = I('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 12);
const bottle = '<svg viewBox="0 0 88 88" width="100%" height="100%" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eee6da"/><stop offset="1" stop-color="#d7c9b6"/></linearGradient></defs><rect width="88" height="88" fill="url(#g)"/><rect x="29" y="13" width="30" height="62" rx="8" fill="#2c3443"/><rect x="33" y="19" width="22" height="9" rx="3" fill="#41495a"/><g fill="#e9eef7"><circle cx="36" cy="40" r="2"/><circle cx="44" cy="40" r="2"/><circle cx="52" cy="40" r="2"/></g><rect x="38" y="66" width="12" height="4" rx="1.5" fill="#8d96a8"/><ellipse cx="44" cy="78" rx="22" ry="3" fill="#00000012"/></svg>';
const person = (bg, fg) => `<svg viewBox="0 0 44 44" width="100%" height="100%" aria-hidden="true"><rect width="44" height="44" fill="${bg}"/><circle cx="22" cy="17" r="7.5" fill="${fg}"/><path d="M7 44c1-10 7-15 15-15s14 5 15 15z" fill="${fg}"/></svg>`;
const AV_SUP = person('#cbd7cf', '#456352'), AV_ME = person('#d5d2e2', '#4e4a6b');
const OK = '<span class="gl ok">' + ICON_CHECK + '</span>', CL = '<span class="gl cl"></span>';
const wave = (n = 7) => `<div class="wave" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<s style="height:${6 + Math.round(Math.abs(Math.sin(i * 1.7) + Math.sin(i * .6)) * 9)}px"></s>`).join('')}</div>`;

const empty = '<div class="ph-empty">' + I('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', 34) + '<span>Pas de photo</span></div>';
const header = () => `<div class="hd"><div class="brand">Nordla<small>China Sourcing</small></div><button class="bell" aria-label="Alertes">${ICON.bell}<i></i></button></div>`;
const product = (o = {}) => `<div class="prod ${o.mini ? 'mini' : ''} ${o.hero ? 'hero' : ''}" data-go="s6" role="button" tabindex="0" aria-label="Ouvrir l'évaluation d'achat"><div class="ph ${o.nophoto ? 'nophoto' : ''}">${o.nophoto ? empty : bottle}${o.ref ? '<i class="refchip">Référence</i>' : ''}</div><div class="t"><h1>Power bank 10&nbsp;000&nbsp;mAh</h1>${o.mini ? '' : '<p class="s">Accessoires électroniques</p>'}<span class="pill ${o.state === 'Nouveau' ? 'new' : ''}">${o.state === 'Nouveau' ? '' : ICON.check.replace('15', '14')}${o.state}</span></div>${ICON.chev}</div>`;
const nav = () => `<div class="nav"><button class="on">${ICON.chat}Conversation</button><button>${ICON.camera}Scanner / Ajouter</button><button>${ICON.pencil}Écrire</button></div><div class="hi"></div>`;
const sup = (inner, time, extra = '') => `<div class="row sup"><div class="av">${AV_SUP}</div><div class="stack"><div class="b ${extra}">${inner}</div><div class="meta">${time}</div></div></div>`;
const me = (inner, time) => `<div class="row me"><div class="stack"><div class="b">${inner}</div><div class="meta">${time} ${ICON.check}</div></div><div class="av">${AV_ME}</div></div>`;
const conf = (n) => `<div class="conf">${ICON.list}<span>${n} éléments à confirmer</span>${ICON.chev}</div>`;
const dock = () => `<div class="dock"><div class="rec">${ICON.mic.replace('26', '24')}<i></i></div><div class="t"><b>Écoute en cours</b><small>00:42 · sur ce téléphone</small></div>${wave()}<button class="dk" aria-label="Pause">${ICON.pause}</button><button class="dk stop" aria-label="Terminer" data-go="s5">${ICON.stop}</button></div>`;
const suggest = () => `<div class="sug"><div class="sg"><div class="k"><span class="bl">${ICON.bulb}</span>ASK NEXT</div><p class="en">Can we mix different colours in the same carton?</p><p class="fr">FR — Peut-on mélanger les couleurs dans un carton ?</p></div>${ICON.chev}</div>`;
const zhBubble = sup('我们有黑色、白色、蓝色和粉色。<span class="d">EN · We have black, white, blue and pink.<em>traduction automatique</em></span>', '09:15', 'zh');
const q1 = me('Is the price USD 8 for 50 pieces?', '09:15');
const a1 = sup('Yes. MOQ is 50 pieces, USD 8 each.', '09:16');
const file = '<div class="file"><div class="ic">PDF</div><div><b>PB-X200_datasheet.pdf</b><span>1,8 Mo · reçu à 09:16</span></div><div class="dl">' + ICON.dl + '</div></div>';

const frames = {
  s1: `<div class="scroll">${header()}${product({ state: 'Nouveau', hero: true, nophoto: true })}</div>
    <div class="start"><p>Photographiez le produit, puis parlez naturellement avec le fournisseur.<br>Nordla écoute et ne vous interrompt pas.</p><button class="cam" data-go="s1b">${ICON.camera}Photographier le produit</button><button class="go" data-go="s2"><span class="mic">${ICON.mic}</span>Démarrer la conversation</button></div>${nav()}`,
  s1b: `<div class="scroll">${header()}${product({ state: 'Nouveau', hero: true, ref: true })}<p class="refnote">Cette photo sera la photo de référence du dossier.</p></div>
    <div class="start"><p>Photo enregistrée sur ce téléphone.</p><button class="cam" data-go="s1">${ICON.camera}Reprendre la photo</button><button class="go" data-go="s2"><span class="mic">${ICON.mic}</span>Démarrer la conversation</button></div>${nav()}`,
  s2: `<div class="scroll">${header()}${product({ mini: true, state: 'En discussion' })}<div class="date">Aujourd'hui 09:14</div>${zhBubble}${q1}${a1}${file}</div>${dock()}${nav()}`,
  s3: `<div class="scroll">${header()}${product({ mini: true, state: 'En discussion' })}<div class="date">Aujourd'hui 09:14</div>${zhBubble}${q1}${a1}${suggest()}</div>${dock()}${nav()}`,
  s4: `<div class="scroll">${header()}<div class="alert">${ICON.warn}<div style="flex:1"><span>MOQ : avant 50, maintenant 100</span><small>Contradiction à clarifier</small></div>${ICON.chev}</div>${product({ mini: true, state: 'En discussion' })}<div class="date" style="margin-top:10px">Aujourd'hui 09:14</div>${q1}${a1}${sup('Sorry, the MOQ is 100 pieces for this price.', '09:18', 'hl')}</div>${dock()}${nav()}`,
  s5: `<div class="under"><div class="scroll">${header()}${product({ mini: true, state: 'En discussion' })}<div class="date">Aujourd'hui 09:14</div>${zhBubble}${q1}</div>${nav()}</div><div class="dim"></div>
    <div class="sheet"><div class="grab"></div><div class="sh"><div><h2>Conversation terminée</h2><p>12 min · enregistrée sur ce téléphone</p></div><button class="x" aria-label="Fermer" data-go="s2">${ICON.x}</button></div>
      <div class="k first">Ce que Nordla a compris</div><div class="card"><div class="li"><span class="g">${CL}</span><span>MOQ <b>50 pièces</b></span></div><div class="li"><span class="g">${CL}</span><span>50 pcs <b>8 USD</b> · 100 pcs <b>7,20 USD</b></span></div><div class="li"><span class="g">${CL}</span><span>FOB <b>Shenzhen</b> · délai <b>15 jours</b></span></div></div>
      <div class="k">Ce qui manque réellement</div><div class="card"><div class="li"><i class="dot"></i><span>Prix à 300 pièces</span></div><div class="li"><i class="dot"></i><span>Rapport de test UN38.3 du modèle exact</span></div></div>
      <div class="k">À clarifier</div><div class="crit"><div class="ct">${ICON.warn.replace('22', '20')}<span>MOQ : <b>50</b> puis <b>100</b></span></div><div class="cb"><button>Garder 50</button><button>Prendre 100</button></div></div>
      <div class="k">Prochaine étape</div><div class="next flat"><span class="ic">${ICON.msg}</span><span>Faire confirmer le MOQ, puis demander le mélange des couleurs.</span></div>
      <button class="lnk" data-go="s6">Ouvrir l'évaluation d'achat ${ICON.chev}</button></div>`,
  s6: `<div class="sheet" style="top:0;border-radius:0;box-shadow:none;padding-top:22px"><div class="sh"><div><h2>Évaluation d'achat</h2><p>Power bank 10 000 mAh · Supplier A</p></div><button class="x" aria-label="Fermer" data-go="s2">${ICON.x}</button></div>
      <div class="bar-amber">${ICON.clock.replace('17', '22')}<span>3 éléments à confirmer</span></div>
      <div class="k">Statut</div><div class="steps"><div class="on"><i></i>Discussion</div><div><i></i>Échantillons</div><div><i></i>Validation</div><div><i></i>Commande</div></div>
      <div class="k">Fournisseur</div><div class="sup2"><div class="av">SA</div><div><b>Supplier A</b><div class="city">${ICON.pin} Shenzhen, Chine</div><span class="tag">Fabricant · déclaré${CL}</span></div></div>
      <div class="k">Informations clés</div><div><div class="kv"><span class="ic">${ICON.tag}</span><span class="l">Prix indicatif</span><span class="v"><b>8,00 USD</b> (50 pcs)${OK}</span></div><div class="kv"><span class="ic">${ICON.box}</span><span class="l">MOQ</span><span class="v"><b>50 pièces</b>${OK}</span></div><div class="kv"><span class="ic">${ICON.clock}</span><span class="l">Délai de production</span><span class="v"><b>15 jours</b>${CL}</span></div><div class="kv"><span class="ic">${ICON.shield}</span><span class="l">Certifications</span><span class="v"><b>CE, RoHS, UN38.3</b>${CL}<small>annoncées, non reçues</small></span></div></div>
      <div class="k">Informations manquantes</div><div class="card"><div class="li"><i class="dot"></i><span>Prix à 100 et 300 pièces</span></div><div class="li"><i class="dot"></i><span>Rapport de test UN38.3 du modèle exact</span></div><div class="li"><i class="dot"></i><span>Mélange des couleurs dans un carton</span></div></div>
      <div class="k">Prochaine étape</div><div class="next flat"><span class="ic">${ICON.msg}</span><span>Demander le mélange des couleurs, puis les rapports de test.</span></div>
      <p class="legend">${OK} confirmé par vous · ${CL} annoncé par le fournisseur, pas encore confirmé. Les documents ont leurs propres états : annoncé, reçu.</p></div>`,
};
const TITLES = { s1: '1. Avant conversation', s1b: '1b. Photo prise', s2: '2. Conversation active · écoute', s3: '3. Suggestion ASK NEXT', s4: '4. Alerte critique', s5: '5. Fin de conversation', s6: "6. Évaluation d'achat" };
// Three ways to look at it: the overview grid (desktop), one bare frame (#s1..#s6, used for captures), and the PHONE VIEWER (?view): a thin bar to switch state, the frame at true width.
// A few taps move between states (product banner -> evaluation, "Démarrer" -> listening, stop -> end, close -> back): static navigation only, nothing else is wired.
const q = new URLSearchParams(location.search); const viewer = q.has('view');
function render() {
  const id = frames[location.hash.replace('#', '')] ? location.hash.replace('#', '') : (viewer ? 's1' : '');
  if (viewer) {
    document.body.className = 'viewer'; const w = Math.min(window.innerWidth, 460); const sc = w / 390; const full = id === 's6';
    document.body.innerHTML = `<nav class="pnav" aria-label="États du portail">${Object.keys(frames).map((k) => `<a href="#${k}" class="${k === id ? 'on' : ''}">${k.slice(1)}</a>`).join('')}<span>${TITLES[id].replace(/^d. /, '')}</span></nav><div class="vw" style="width:${390 * sc}px;margin:0 auto"><div class="frame ${full ? 'full' : ''}" style="transform:scale(${sc});transform-origin:0 0;width:390px">${frames[id]}</div></div>`;
    const fr = document.querySelector('.vw .frame'); document.querySelector('.vw').style.height = fr.getBoundingClientRect().height + 'px'; window.scrollTo(0, 0);
  } else if (id) { document.body.className = 'single'; document.body.innerHTML = `<div class="frame ${q.has('full') ? 'full' : ''}">${frames[id]}</div>`; }
  else document.body.innerHTML = `<div class="grid">${Object.entries(frames).map(([k, h]) => `<div class="frame-wrap"><p class="cap">${TITLES[k]}</p><div class="frame">${h}</div></div>`).join('')}</div>`;
}
document.addEventListener('click', (e) => { const t = e.target.closest('[data-go]'); if (!t || !viewer) return; location.hash = t.dataset.go; });
window.addEventListener('hashchange', render); window.addEventListener('resize', () => { if (viewer) render(); }); render();
