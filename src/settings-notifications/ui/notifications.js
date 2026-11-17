// Paramètres › Notifications: four rubrics (list on the left, detail on the right; on a phone the list, then the detail with "Retour").
// Everything comes from GET /api/notifications and GET /api/notifications/inbox. All server text is inserted with textContent (never innerHTML).
// A switch saves at once (one alert, one channel) and shows the state the server answered; an unavailable channel is shown inactive with its reason.
(() => {
  'use strict';
  const { h, api, shell, guard, app } = window.NordlaShell;
  const NS = 'http://www.w3.org/2000/svg';
  const icon = (paths) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'cx-ico nt-row-ico'); s.setAttribute('aria-hidden', 'true'); for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); } return s; };
  const ICON = { alerts: ['M6 9a6 6 0 0112 0c0 6 2 7 2 8H4c0-1 2-2 2-8z', 'M10 21h4'], inbox: ['M4 13l2-8h12l2 8', 'M4 13v6h16v-6', 'M4 13h5l1 2h4l1-2h5'], channels: ['M4 6h16', 'M4 12h16', 'M4 18h10'], rights: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z'] };
  const RUBRICS = [{ id: 'alerts', slug: 'alertes', label: 'Alertes' }, { id: 'inbox', slug: 'recues', label: 'Alertes reçues' }, { id: 'channels', slug: 'canaux', label: 'Canaux et fréquence' }, { id: 'rights', slug: 'droits', label: 'Mes préférences et droits' }];
  const OF = Object.fromEntries(RUBRICS.map((r) => [r.slug, r.id]));
  const wide = () => window.matchMedia('(min-width: 900px)').matches;
  const ERRORS = { NOT_WIRED: 'Cette alerte n’est pas encore raccordée : rien ne peut arriver.', CHANNEL_UNAVAILABLE: 'Ce canal est indisponible.', FORBIDDEN: 'Votre rôle ne donne pas accès à cette alerte.', NOT_FOUND: 'Cette alerte n’existe plus ou ne vous est pas accessible.', VALIDATION: 'Valeur invalide : rien n’a été enregistré.' };
  const when = (iso) => { try { return new Intl.DateTimeFormat('fr-BE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return ''; } };
  let ov = null; let shellData = null; let current = null; let flash = null; let inbox = null;
  const detail = h('section', { class: 'cx-detail', id: 'nt-detail' }); const listBox = h('div', { class: 'cx-list' });
  const head = (title, sub) => h('div', { class: 'nt-head' }, h('h2', { text: title }), sub ? h('p', { text: sub }) : null);
  const msg = (m) => h('div', { class: `nt-msg ${m.tone}`, role: m.tone === 'err' ? 'alert' : 'status', text: m.text });

  async function setPref(type, enabled, box) {
    box.disabled = true; const r = await api('/api/notifications/preferences', { type, channel: 'in_app', enabled });
    if (guard(r)) return;
    if (r.ok) { ov = { ...ov, ...r.json }; flash = { tone: 'ok', text: 'Réglage enregistré.' }; } else flash = { tone: 'err', text: ERRORS[r.json?.error?.code] ?? `Action refusée (${r.status}).` };
    render();
  }
  // ---- Alertes: grouped by module; each alert = trigger + channels + the member's own switch
  function alertsView() {
    const groups = new Map(); for (const a of ov.alerts) (groups.get(a.module) ?? groups.set(a.module, { label: a.moduleLabel, items: [] }).get(a.module)).items.push(a);
    return [head('Alertes', 'Ce que Nordla peut vous signaler, module par module. Vos choix sont personnels et valables pour ce commerce.'),
      ...[...groups.values()].map((g) => h('div', { class: 'nt-group' }, h('h3', { text: g.label }), g.items.map((a) => h('div', { class: 'nt-alert', 'data-alert': a.id },
        h('div', { class: 'nt-alert-top' }, h('strong', { text: a.label }), h('span', { class: 'cx-pill sm', 'data-tone': a.wired ? 'ok' : 'planned', text: a.stateLabel })),
        h('p', { class: 'nt-trigger', text: `Déclencheur : ${a.trigger}` }),
        a.reason ? h('p', { class: 'nt-reason', text: a.reason }) : null,
        h('div', { class: 'nt-channels' }, a.channels.map((c) => {
          const id = `nt-${a.id}-${c.id}`; const on = c.available && c.enabled;
          const box = h('input', { type: 'checkbox', id, checked: on, disabled: !c.available, 'aria-describedby': `${id}-s`, on: { change: (e) => setPref(a.id, e.target.checked, e.target) } });
          return h('label', { class: `nt-switch${c.available ? '' : ' off'}`, for: id }, box, h('span', { class: 'nt-ch', text: c.label }), h('span', { class: 'nt-ch-state', id: `${id}-s`, text: c.id === 'email' ? ov.email.label : (!c.available ? 'Inactif' : c.enabled ? 'Activé' : 'Désactivé') }));
        }))))))];
  }
  // ---- Alertes reçues: open (goes to the item) / mark as read
  async function loadInbox() { const r = await api('/api/notifications/inbox'); if (guard(r)) return; inbox = r.ok ? r.json : { items: [], unread: 0, failed: true }; }
  async function openAlert(it) {
    const r = await api('/api/notifications/open', { id: it.id }); if (guard(r)) return;
    if (!r.ok) { flash = { tone: 'err', text: ERRORS[r.json?.error?.code] ?? 'Cette alerte n’est plus accessible.' }; await loadInbox(); render(); return; }
    location.assign(r.json.link);
  }
  async function readOne(it) { const r = await api('/api/notifications/read', { ids: [it.id] }); if (guard(r)) return; await refresh(); render(); }
  async function readAll() { const r = await api('/api/notifications/read-all', {}); if (guard(r)) return; flash = { tone: 'ok', text: 'Tout est marqué comme lu.' }; await refresh(); render(); }
  function inboxView() {
    const items = inbox?.items ?? [];
    return [head('Alertes reçues', 'Les alertes que Nordla vous a adressées. Ouvrir une alerte la marque comme lue et vous mène à l’élément concerné.'),
      inbox?.failed ? h('p', { class: 'nt-msg err', text: 'Les alertes sont indisponibles pour le moment.' }) : null,
      items.length ? h('div', { class: 'nt-bar' }, h('span', { class: 'nt-count', text: inbox.unread ? `${inbox.unread} non lue${inbox.unread > 1 ? 's' : ''}` : 'Tout est lu' }), inbox.unread ? h('button', { class: 'cx-btn ghost', type: 'button', text: 'Tout marquer comme lu', on: { click: readAll } }) : null) : null,
      items.length ? h('ul', { class: 'nt-list' }, items.map((it) => h('li', { class: `nt-item${it.read ? '' : ' unread'}`, 'data-notification': it.id },
        h('div', { class: 'nt-item-top' }, h('span', { class: 'nt-mod', text: it.moduleLabel }), h('time', { class: 'nt-time', datetime: it.createdAt, text: when(it.createdAt) }), it.read ? h('span', { class: 'nt-read', text: 'Lu' }) : h('span', { class: 'nt-new', text: 'Non lu' })),
        h('strong', { class: 'nt-title', text: it.title }), it.body ? h('p', { class: 'nt-body', text: it.body }) : null,
        h('div', { class: 'nt-actions' }, h('button', { class: 'cx-btn', type: 'button', text: it.linkLabel, on: { click: () => openAlert(it) } }), it.read ? null : h('button', { class: 'cx-btn ghost', type: 'button', text: 'Marquer comme lue', on: { click: () => readOne(it) } }))))) : (inbox?.failed ? null : h('div', { class: 'nt-empty' }, h('strong', { text: 'Aucune alerte pour le moment' }), h('p', { text: 'Quand un événement réel concerne ce commerce, il apparaît ici.' })))];
  }
  // ---- Canaux et fréquence: real state of e-mail and digest
  function channelsView() {
    return [head('Canaux et fréquence', 'Par où et à quelle fréquence vous êtes prévenu.'),
      h('div', { class: 'nt-channel-card' }, h('div', { class: 'nt-alert-top' }, h('strong', { text: 'Dans Nordla' }), h('span', { class: 'cx-pill sm', 'data-tone': 'ok', text: 'Disponible' })), h('p', { class: 'nt-trigger', text: 'Les alertes raccordées arrivent dans « Alertes reçues ». Réglez chacune dans « Alertes ».' })),
      h('div', { class: 'nt-channel-card' }, h('div', { class: 'nt-alert-top' }, h('strong', { text: 'E-mail' }), h('span', { class: 'cx-pill sm', 'data-tone': 'planned', text: ov.email.label })), h('p', { class: 'nt-reason', text: ov.email.reason }), h('label', { class: 'nt-switch off' }, h('input', { type: 'checkbox', disabled: true, 'aria-label': 'Recevoir les alertes par e-mail' }), h('span', { class: 'nt-ch', text: 'Recevoir par e-mail' }), h('span', { class: 'nt-ch-state', text: 'Inactif' }))),
      h('div', { class: 'nt-channel-card' }, h('div', { class: 'nt-alert-top' }, h('strong', { text: 'Récapitulatif quotidien ou hebdomadaire' }), h('span', { class: 'cx-pill sm', 'data-tone': 'planned', text: ov.digest.label })), h('p', { class: 'nt-reason', text: ov.digest.reason }))];
  }
  function rightsView() {
    return [head('Mes préférences et droits', 'Ce que vous réglez ici ne concerne que votre compte.'),
      h('ul', { class: 'nt-points' }, [
        'Vos choix sont enregistrés par compte et par commerce : ils ne changent rien pour les autres membres.',
        'Tous les rôles, y compris « Lecture seule », règlent leurs propres notifications.',
        'Une alerte n’est adressée et affichée que si votre rôle actuel permet de consulter l’élément concerné. Si votre accès à ce commerce est retiré, ses alertes ne sont plus accessibles.',
      ].map((t) => h('li', { text: t }))), h('div', { class: 'nt-note' }, h('strong', { text: 'Compte et connexion. ' }), ov.accountNote, ' ', h('a', { class: 'cx-link', href: '/settings/security', text: 'Ouvrir Sécurité' }))];
  }
  const VIEW = { alerts: alertsView, inbox: inboxView, channels: channelsView, rights: rightsView };
  const badge = (id) => (id === 'inbox' && ov.unread ? h('span', { class: 'nt-badge', 'aria-label': `${ov.unread} non lues`, text: String(ov.unread) }) : null);

  function renderList() {
    listBox.replaceChildren(...RUBRICS.map((r) => h('a', { class: 'cx-row', href: `/settings/notifications/${r.slug}`, 'aria-current': current === r.id ? 'true' : null, on: { click: (e) => { e.preventDefault(); go(r.id); } } }, icon(ICON[r.id]), h('span', { class: 'cx-row-name', text: r.label }), badge(r.id))));
  }
  function render() {
    if (!current) return;
    detail.replaceChildren(...[!wide() ? h('button', { class: 'cx-back', type: 'button', text: '‹ Retour', on: { click: () => go(null) } }) : null, flash ? msg(flash) : null, ...VIEW[current]()].filter(Boolean)); flash = null;
    renderList(); layout();
  }
  function layout() { const showDetail = wide() || current; listBox.hidden = !wide() && !!current; detail.hidden = !showDetail; }
  async function refresh() { const [a, b] = await Promise.all([api('/api/notifications'), loadInbox()]); if (!guard(a) && a.ok) ov = { ...ov, ...a.json }; return b; }
  async function go(id) {
    if (id === null) { current = null; history.pushState(null, '', '/settings/notifications'); renderList(); layout(); window.scrollTo(0, 0); return; }
    history.pushState(null, '', `/settings/notifications/${RUBRICS.find((r) => r.id === id).slug}`); current = id;
    if (id === 'inbox' || id === 'alerts') await refresh(); render(); window.scrollTo(0, 0);
  }
  window.addEventListener('popstate', () => { const rid = OF[location.pathname.split('/')[3]] ?? null; current = rid; if (rid) render(); else { renderList(); layout(); } });
  window.matchMedia('(min-width: 900px)').addEventListener('change', () => { if (wide() && !current) go('alerts'); else layout(); });

  async function start() {
    const r = await api('/api/notifications'); if (guard(r)) return;
    if (!r.ok) return app.replaceChildren(h('div', { class: 'cx-wrap' }, h('h1', { text: 'Notifications' }), h('p', { class: 'cx-msg err', text: 'Cette page est indisponible pour le moment.' })));
    ov = r.json; shellData = r.json.shell ?? { nav: [{ id: 'settings', label: 'Paramètres', href: '/settings', icon: 'settings' }], merchant: null, environment: null };
    await loadInbox();
    app.replaceChildren(shell(shellData, 'settings', [h('p', { class: 'cx-crumb' }, h('a', { class: 'cx-link', href: '/settings', text: 'Paramètres' }), ' / ', h('strong', { text: 'Notifications' })), h('h1', { text: 'Notifications' }), h('div', { class: 'cx-split', id: 'nt-split' }, listBox, detail)]));
    current = OF[location.pathname.split('/')[3]] ?? (wide() ? 'alerts' : null);
    renderList(); if (current) render(); else layout();
  }
  start();
})();
