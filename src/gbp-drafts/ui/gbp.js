// Publications Google Business: read the drafts, approve ONE version, attest the publication. All text from the server is inserted with textContent (never as HTML).
(() => {
  'use strict';
  const CSRF_COOKIES = ['__Host-nordla_sourcing_csrf'];
  const csrf = () => { for (const part of String(document.cookie).split(';')) { const i = part.indexOf('='); if (i > 0 && CSRF_COOKIES.includes(part.slice(0, i).trim())) return part.slice(i + 1).trim(); } return ''; };
  const app = document.getElementById('app');
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : String(v)); } for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
  const api = async (path, body) => {
    const r = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json', 'x-nordla-csrf': csrf() } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* none */ }
    return { ok: r.ok, status: r.status, json: j };
  };
  const when = (iso) => { try { return new Date(iso).toLocaleString('fr-BE', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Brussels' }); } catch { return iso; } };
  const ERR = { VERSION_CHANGED: 'Le brouillon a changé depuis votre lecture : rechargez la page et relisez-le.', FORBIDDEN_ROLE: 'Votre rôle ne permet pas de décider.', NOT_APPROVED: 'Cette version n’est pas approuvée.', ALREADY_APPROVED: 'Cette version est déjà approuvée.', ALREADY_PUBLISHED: 'Déjà marquée comme publiée.', URL_INVALID: 'Le lien doit commencer par https://', SESSION_INVALID: 'Votre session n’est plus valide : reconnectez-vous.', CSRF_INVALID: 'Session expirée : rechargez la page.' };
  const errText = (r) => ERR[r.json?.error?.code ?? r.json?.error] ?? `Action refusée (${r.status}).`;
  let data = null;

  async function load() {
    const r = await api('/api/gbp/drafts');
    if (r.status === 401 || r.status === 403 && r.json?.error?.code !== 'FORBIDDEN_ROLE') return signIn();
    if (!r.ok) return app.replaceChildren(h('div', { class: 'gbp-wrap' }, h('h1', { text: 'Publications Google' }), h('p', { class: 'gbp-msg err', text: 'Cette page est indisponible pour le moment.' })));
    data = r.json; render();
  }
  function signIn() {
    app.replaceChildren(h('div', { class: 'gbp-wrap' }, h('h1', { text: 'Publications Google' }), h('p', { class: 'gbp-sub', text: 'Connectez-vous avec votre compte Nordla pour voir et approuver les brouillons.' }), h('a', { class: 'gbp-btn', href: '/', text: 'Ouvrir Nordla' })));
  }
  const copyText = async (text, el) => { try { await navigator.clipboard.writeText(text); el.textContent = 'Texte copié'; } catch { el.textContent = 'Copie impossible : sélectionnez le texte'; } setTimeout(() => { el.textContent = 'Copier le texte'; }, 2500); };

  function card(d) {
    const msg = h('p', { class: 'gbp-msg', 'aria-live': 'polite' });
    const act = async (kind, body) => { msg.className = 'gbp-msg'; msg.textContent = '…'; const r = await api(`/api/gbp/drafts/${d.id}/${kind}`, body); if (r.ok) { data = r.json; render(); } else { msg.className = 'gbp-msg err'; msg.textContent = errText(r); } };
    const copy = h('button', { class: 'gbp-btn ghost', type: 'button', text: 'Copier le texte' }); copy.addEventListener('click', () => copyText(d.text, copy));
    const actions = [copy, h('a', { class: 'gbp-btn ghost', href: d.imageUrl, download: `${d.id}.jpg`, text: 'Télécharger l’image' })];
    if (d.state === 'REVIEW' && !d.hold) actions.push(h('button', { class: 'gbp-btn', type: 'button', text: 'Approuver cette version', on: { click: () => act('approve', { expected_version: d.version }) } }));
    if (d.state === 'APPROVED') {
      actions.push(h('button', { class: 'gbp-btn', type: 'button', text: 'J’ai publié sur ma fiche', on: { click: () => { const url = window.prompt('Lien de la publication Google (facultatif, https://…) :', ''); if (url === null) return; act('published', url.trim() ? { url: url.trim() } : {}); } } }));
      actions.push(h('button', { class: 'gbp-btn warn', type: 'button', text: 'Retirer l’approbation', on: { click: () => act('revoke', {}) } }));
    }
    if (d.state === 'PUBLISHED') actions.push(h('button', { class: 'gbp-btn warn', type: 'button', text: 'Retirer l’approbation', on: { click: () => act('revoke', {}) } }));
    actions.push(h('button', { class: 'gbp-btn', type: 'button', disabled: true, title: data.publish.message, text: 'Publier depuis Nordla (indisponible)' }));
    return h('section', { class: 'gbp-card' },
      h('div', { class: 'gbp-head' }, h('h2', { text: `${d.id} · ${d.title}` }), h('span', { class: 'gbp-state', 'data-state': d.state, text: d.stateLabel })),
      h('div', { class: 'gbp-grid' },
        h('div', {}, h('img', { class: 'gbp-img', src: d.imageUrl, alt: `Image de ${d.id}` }), h('p', { class: 'gbp-note', text: d.imageNote })),
        h('div', {}, h('p', { class: 'gbp-text', text: d.text }), h('p', { class: 'gbp-cta' }, h('strong', { text: `Bouton : ${d.cta.label}. ` }), d.cta.note, d.cta.link ? h('span', {}, ' ', h('a', { class: 'gbp-link', href: d.cta.link.url, target: '_blank', rel: 'noopener noreferrer', title: d.cta.link.url, text: d.cta.link.label })) : null), d.hold ? h('p', { class: 'gbp-hold', role: 'note', text: `En attente : ${d.hold}` }) : null, h('ul', { class: 'gbp-checks' }, d.checks.map((c) => h('li', { text: c }))))),
      h('div', { class: 'gbp-actions' }, actions), msg,
      d.approvedAt ? h('p', { class: 'gbp-meta', text: `Approuvé le ${when(d.approvedAt)}.` }) : null,
      d.publishedAt ? h('p', { class: 'gbp-meta' }, `Publié (attesté par vous) le ${when(d.publishedAt)}.`, d.publishedUrl ? h('span', {}, ' ', h('a', { class: 'gbp-link', href: d.publishedUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Voir la publication' })) : null) : null);
  }
  function render() {
    app.replaceChildren(h('div', { class: 'gbp-wrap' },
      h('h1', { text: 'Publications Google Business' }), h('p', { class: 'gbp-sub', text: `${data.network} · ${data.listing}` }),
      h('div', { class: 'gbp-banner' }, h('strong', { text: 'Rien n’est publié par Nordla. ' }), data.publish.message),
      data.drafts.map(card), h('p', { class: 'gbp-note' }, h('a', { class: 'gbp-link', href: '/', text: '← Retour à Nordla' }))));
  }
  load();
})();
