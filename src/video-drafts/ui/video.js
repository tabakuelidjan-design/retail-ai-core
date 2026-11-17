// Ajouter une vidéo: drop an MP4, watch it, edit the TikTok and Instagram captions separately, find everything again after a reload. Drafts only: nothing is published.
// All text from the server is inserted with textContent (never as HTML).
(() => {
  'use strict';
  const CSRF_COOKIES = ['__Host-nordla_sourcing_csrf'];
  const csrf = () => { for (const part of String(document.cookie).split(';')) { const i = part.indexOf('='); if (i > 0 && CSRF_COOKIES.includes(part.slice(0, i).trim())) return part.slice(i + 1).trim(); } return ''; };
  const app = document.getElementById('app');
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); else if (k === 'text') e.textContent = v; else if (k === 'value') e.value = v; else e.setAttribute(k, v === true ? '' : String(v)); } for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
  const request = async (path, init = {}) => {
    const r = await fetch(path, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...(init.method === 'POST' ? { 'x-nordla-csrf': csrf() } : {}), ...(init.headers || {}) } });
    let j = null; try { j = await r.json(); } catch { /* none */ }
    return { ok: r.ok, status: r.status, json: j };
  };
  const post = (path, body) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const ERR = { NOT_AN_MP4: 'Ce fichier n’est pas une vidéo MP4. Exportez de nouveau depuis CapCut en MP4.', VIDEO_TOO_LARGE: 'Cette vidéo est trop lourde pour être déposée ici.', VIDEO_EMPTY: 'Le fichier est vide.', FORBIDDEN_ROLE: 'Votre rôle ne permet pas de modifier.', SESSION_INVALID: 'Votre session n’est plus valide : reconnectez-vous.', CSRF_INVALID: 'Session expirée : rechargez la page.', TIKTOK_CAPTION_TOO_LONG: 'La légende TikTok est trop longue.', INSTAGRAM_CAPTION_TOO_LONG: 'La légende Instagram est trop longue.', UPLOAD_ABORTED: 'Le dépôt a été interrompu.' };
  const errText = (r) => ERR[r.json?.error?.code ?? r.json?.error] ?? `Action refusée (${r.status}).`;
  const mb = (n) => `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} Mo`;
  const when = (iso) => { try { return new Date(iso).toLocaleString('fr-BE', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Brussels' }); } catch { return iso; } };
  const NET = { tiktok: 'TikTok', instagram: 'Instagram' };
  let data = null;

  // "Contexte du commerce": what Général gives (read only). An explicit objective in a brief always wins over it.
  const contextCard = (c) => {
    if (!c) return null;
    const rows = []; const add = (k, v) => { if (v) rows.push(h('li', {}, h('strong', { text: `${k} : ` }), v)); };
    add('Commerce', [c.profile?.name, c.profile?.website].filter(Boolean).join(' · '));
    const o = c.objectives ?? {}; add('Priorité du moment', o.priority ? `${o.priority.label ?? o.priority.value}${o.priority.note ? ` — ${o.priority.note}` : ''}` : null);
    add('Résultat attendu', o.expected_result); add('Échéance', o.deadline);
    add('Offres à mettre en avant', (o.featured_offers ?? []).map((x) => x.label).join(', '));
    const k = o.constraints ?? {}; add('Contraintes', [k.budget?.amount != null ? `budget ${k.budget.amount}${k.budget.period ? ` (${k.budget.period})` : ''}` : null, k.time?.note && `temps : ${k.time.note}`, k.stock?.note && `stock : ${k.stock.note}`, k.production?.note && `production : ${k.production.note}`].filter(Boolean).join(' ; '));
    const places = (c.places ?? []).map((p) => [p.name, [p.address?.street, p.address?.postal_code, p.address?.city].filter(Boolean).join(' '), p.phone, p.email].filter(Boolean).join(', '));
    add('Coordonnées publiques', places.length ? places.join(' / ') : 'aucune à reprendre (à renseigner dans Général)');
    return h('div', { class: 'ctx-card', 'data-general-context': '' }, h('strong', { text: 'Contexte du commerce (Général)' }), h('ul', {}, rows), h('p', { class: 'ctx-note' }, 'L’objectif explicite d’un brief reste prioritaire. ', h('a', { href: '/settings/general', text: 'Modifier dans Général' })));
  };
  async function load() {
    const r = await request('/api/videos');
    if (r.status === 401 || (r.status === 403 && r.json?.error?.code !== 'FORBIDDEN_ROLE')) return signIn();
    if (!r.ok) return app.replaceChildren(h('div', { class: 'vid-wrap' }, h('h1', { text: 'Ajouter une vidéo' }), h('p', { class: 'vid-msg err', text: 'Cette page est indisponible pour le moment.' })));
    data = r.json; try { data.context = (await request('/api/videos/context')).json?.context ?? null; } catch { data.context = null; } render();
  }
  function signIn() { app.replaceChildren(h('div', { class: 'vid-wrap' }, h('h1', { text: 'Ajouter une vidéo' }), h('p', { class: 'vid-sub', text: 'Connectez-vous avec votre compte Nordla.' }), h('a', { class: 'vid-btn', href: '/', text: 'Ouvrir Nordla' }))); }

  function uploader() {
    const msg = h('p', { class: 'vid-msg', 'aria-live': 'polite' }); const bar = h('progress', { class: 'vid-progress', max: 100, value: 0, hidden: true });
    const input = h('input', { type: 'file', accept: 'video/mp4,video/quicktime,.mp4,.mov', class: 'vid-file', id: 'vid-file' });
    const upload = (file) => new Promise((resolve) => {
      if (!file) return resolve();
      if (file.size > data.limits.videoMaxBytes) { msg.className = 'vid-msg err'; msg.textContent = ERR.VIDEO_TOO_LARGE; return resolve(); }
      const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/videos'); xhr.withCredentials = true;
      xhr.setRequestHeader('x-nordla-csrf', csrf()); xhr.setRequestHeader('content-type', 'video/mp4'); xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
      bar.hidden = false; bar.value = 0; msg.className = 'vid-msg'; msg.textContent = 'Dépôt en cours…';
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.value = Math.round((e.loaded / e.total) * 100); };
      xhr.onload = () => { let j = null; try { j = JSON.parse(xhr.responseText); } catch { /* none */ } bar.hidden = true; if (xhr.status === 201) { data = j; render(); } else { msg.className = 'vid-msg err'; msg.textContent = errText({ status: xhr.status, json: j }); } resolve(); };
      xhr.onerror = () => { bar.hidden = true; msg.className = 'vid-msg err'; msg.textContent = 'Dépôt impossible : vérifiez votre connexion.'; resolve(); };
      xhr.send(file);
    });
    input.addEventListener('change', () => upload(input.files[0]));
    const zone = h('label', { class: 'vid-drop', for: 'vid-file' }, h('strong', { text: 'Déposez votre MP4 ici' }), h('span', { text: ` ou cliquez pour le choisir (exporté depuis CapCut, ${mb(data.limits.videoMaxBytes)} au maximum).` }), input);
    for (const ev of ['dragenter', 'dragover']) zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); });
    zone.addEventListener('drop', (e) => upload(e.dataTransfer?.files?.[0]));
    return h('section', { class: 'vid-card' }, h('h2', { text: 'Nouvelle vidéo' }), zone, bar, msg);
  }

  function card(v) {
    const msg = h('p', { class: 'vid-msg', 'aria-live': 'polite' });
    const title = h('input', { class: 'vid-title', type: 'text', maxlength: 120, value: v.title, 'aria-label': 'Titre interne' });
    const areas = {}; const counts = {};
    const field = (net) => {
      const ta = h('textarea', { class: 'vid-text', rows: 7, maxlength: data.limits.captionMax, 'aria-label': `Légende ${NET[net]}` }); ta.value = v.captions[net].text; areas[net] = ta;
      const cnt = h('span', { class: 'vid-count' }); counts[net] = cnt; const upd = () => { cnt.textContent = `${ta.value.length} / ${data.limits.captionMax}`; }; ta.addEventListener('input', upd); upd();
      return h('div', { class: 'vid-cap' }, h('label', {}, h('strong', { text: `Légende ${NET[net]}` }), ta), cnt, v.captions[net].updatedAt ? h('p', { class: 'vid-meta', text: `Enregistrée le ${when(v.captions[net].updatedAt)}.` }) : h('p', { class: 'vid-meta', text: 'Pas encore enregistrée.' }));
    };
    const save = h('button', { class: 'vid-btn', type: 'button', text: 'Enregistrer le brouillon' });
    save.addEventListener('click', async () => {
      msg.className = 'vid-msg'; msg.textContent = '…'; save.disabled = true;
      const r = await post(`/api/videos/${v.id}`, { title: title.value, tiktok: areas.tiktok.value, instagram: areas.instagram.value }); save.disabled = false;
      if (r.ok) { data = r.json; render(); } else { msg.className = 'vid-msg err'; msg.textContent = errText(r); }
    });
    const del = h('button', { class: 'vid-btn warn', type: 'button', text: 'Supprimer ce brouillon' });
    del.addEventListener('click', async () => { if (!window.confirm('Supprimer cette vidéo et ses deux légendes de Nordla ? (Elle ne touche à aucun compte TikTok ou Instagram.)')) return; const r = await post(`/api/videos/${v.id}/remove`, {}); if (r.ok) { data = r.json; render(); } else { msg.className = 'vid-msg err'; msg.textContent = errText(r); } });
    return h('section', { class: 'vid-card' },
      h('div', { class: 'vid-head' }, title, h('span', { class: 'vid-state', text: v.stateLabel })),
      h('div', { class: 'vid-grid' },
        h('div', {}, h('video', { class: 'vid-player', src: v.fileUrl, controls: true, playsinline: true, preload: 'metadata' }), h('p', { class: 'vid-meta', text: `${v.filename} · ${mb(v.size)} · déposée le ${when(v.createdAt)}` })),
        h('div', {}, field('tiktok'), field('instagram'))),
      h('div', { class: 'vid-actions' }, save, del), msg);
  }

  function render() {
    app.replaceChildren(h('div', { class: 'vid-wrap' },
      h('h1', { text: 'Ajouter une vidéo' }), h('p', { class: 'vid-sub', text: 'Un MP4 de CapCut, une légende TikTok et une légende Instagram, gardés en brouillon.' }),
      h('div', { class: 'vid-banner' }, h('strong', { text: 'Rien n’est publié par Nordla. ' }), data.notice), contextCard(data.context),
      uploader(), data.videos.length ? data.videos.map(card) : h('p', { class: 'vid-sub', text: 'Aucune vidéo pour le moment.' }), h('p', { class: 'vid-note' }, h('a', { class: 'vid-link', href: '/', text: '← Retour à Nordla' }))));
  }
  load();
})();
