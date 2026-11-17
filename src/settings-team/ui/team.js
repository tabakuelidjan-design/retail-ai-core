// Paramètres › Équipe et accès: four rubrics (list on the left, detail on the right; on a phone the list, then the detail with "Retour").
// Everything comes from /api/team*; all server text goes in with textContent. The page never decides a right: it shows the buttons the server says are possible
// (`actions`), and the server refuses the rest anyway (403 / 409 with a precise message, shown as is).
(() => {
  'use strict';
  const { h, api, shell, signIn, app } = window.NordlaShell;
  const guard = (r) => (r.status === 401 ? (signIn(), true) : false); // only a lost session sends back to sign-in: a 403 here is a role refusal, shown as is
  const SLUG = { members: 'membres', invitations: 'invitations', roles: 'roles', history: 'historique' };
  const OF = Object.fromEntries(Object.entries(SLUG).map(([k, v]) => [v, k]));
  const TITLE = { members: 'Membres', invitations: 'Invitations', roles: 'Rôles et permissions', history: 'Historique des accès' };
  const SUB = { members: 'Qui a accès à ce commerce, avec quel rôle.', invitations: 'Inviter une personne et suivre les invitations.', roles: 'Ce que chaque rôle peut faire, tel qu’il est appliqué par les serveurs.', history: 'Qui a fait quoi, sur quel membre ou quelle invitation.' };
  const NS = 'http://www.w3.org/2000/svg';
  const icon = (d) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'cx-ico tm-row-ico'); s.setAttribute('aria-hidden', 'true'); for (const x of d) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', x); s.append(p); } return s; };
  const ICON = { members: ['M9 11a4 4 0 100-8 4 4 0 000 8z', 'M2 21v-1a6 6 0 0112 0v1', 'M16 4a4 4 0 010 7', 'M18 14a6 6 0 013 5v2'], invitations: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'], roles: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z', 'M9 12l2 2 4-4'], history: ['M12 7v5l3 2', 'M3 12a9 9 0 109-9 9 9 0 00-7 3.5', 'M3 4v4h4'] };
  const wide = () => window.matchMedia('(min-width: 900px)').matches;
  const when = (iso) => { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('fr-BE', { dateStyle: 'medium', timeStyle: 'short' }); };
  const fail = (r, fallback = 'Action impossible pour le moment.') => r.json?.error?.message ?? (r.status === 0 ? 'Le serveur ne répond pas : rien n’a été modifié.' : `${fallback} (${r.status})`);

  let ov = null; let shellData = null; let current = null; let flash = null; let rights = null;
  const detail = h('section', { class: 'cx-detail', id: 'tm-detail' }); const listBox = h('div', { class: 'cx-list' }); const side = h('div');
  const msg = (m) => h('div', { class: `tm-msg ${m.tone}`, role: m.tone === 'err' ? 'alert' : 'status' }, m.text);
  const chip = (text, tone) => h('span', { class: 'tm-chip', 'data-tone': tone, text });
  const STATUS_TONE = { ACTIVE: 'ok', SUSPENDED: 'wait', REMOVED: 'lock', PENDING: 'wait', ACCEPTED: 'ok', EXPIRED: 'lock', CANCELLED: 'lock' };
  const head = (id) => h('div', { class: 'tm-head' }, h('h2', { text: TITLE[id] }), h('p', { text: SUB[id] }));
  const locked = (id) => [head(id), h('p', { class: 'tm-note', text: 'Cette rubrique est réservée au propriétaire et aux administrateurs. Votre rôle (' + ov.me.roleLabel + ') ne permet pas d’y accéder.' })];

  // ------------------------------------------------------------------ rights tables
  const LEVEL = () => rights.levelLabel;
  function rightsGrid() {
    const roles = rights.roles; const mods = roles[0].rights.modules;
    const table = h('table', { class: 'tm-grid' }, h('caption', { class: 'tm-sr', text: 'Droits par module et par rôle' }),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Module' }), roles.map((r) => h('th', { scope: 'col', text: r.label })))),
      h('tbody', {}, mods.map((m, i) => h('tr', {}, h('th', { scope: 'row' }, h('span', { text: m.label }), m.note ? h('small', { text: m.note }) : null), roles.map((r) => { const l = r.rights.modules[i].level; return h('td', { 'data-label': r.label }, h('span', { class: 'tm-lvl', 'data-level': l, text: LEVEL()[l] })); })))));
    const sens = roles[0].rights.sensitive;
    const table2 = h('table', { class: 'tm-grid' }, h('caption', { class: 'tm-sr', text: 'Actions sensibles par rôle' }),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Action sensible' }), roles.map((r) => h('th', { scope: 'col', text: r.label })))),
      h('tbody', {}, sens.map((a, i) => h('tr', {}, h('th', { scope: 'row' }, h('span', { text: a.label }), a.note ? h('small', { text: a.note }) : null), roles.map((r) => { const v = r.rights.sensitive[i].value; return h('td', { 'data-label': r.label }, h('span', { class: 'tm-lvl', 'data-level': v === 'yes' ? 'edit' : v === 'limited' ? 'view' : 'none', text: rights.sensitiveLabel[v] })); })))));
    return [h('h3', { text: 'Accès par module' }), table, h('h3', { text: 'Actions sensibles' }), table2];
  }
  const rightsList = (r) => h('div', {}, h('ul', { class: 'tm-rl' }, r.modules.map((m) => h('li', {}, h('span', { text: m.label }), h('span', { class: 'tm-lvl', 'data-level': m.level, text: LEVEL()[m.level] })))), h('p', { class: 'tm-help', text: 'Actions sensibles : ' + r.sensitive.map((a) => `${a.label} (${rights.sensitiveLabel[a.value].toLowerCase()})`).join(' · ') }));

  // ------------------------------------------------------------------ members
  async function viewMembers() {
    const q = h('input', { class: 'tm-input', type: 'search', placeholder: 'Nom ou e-mail', 'aria-label': 'Rechercher un membre par nom ou e-mail', maxlength: 100 });
    const role = h('select', { class: 'tm-input', 'aria-label': 'Filtrer par rôle' }, h('option', { value: '', text: 'Tous les rôles' }), ov.roles.map((r) => h('option', { value: r.id, text: r.label })));
    const status = h('select', { class: 'tm-input', 'aria-label': 'Filtrer par statut' }, h('option', { value: '', text: 'Tous les statuts' }), h('option', { value: 'ACTIVE', text: 'Actif' }), h('option', { value: 'SUSPENDED', text: 'Suspendu' }), h('option', { value: 'REMOVED', text: 'Accès retiré' }));
    const box = h('div', { class: 'tm-list', 'aria-live': 'polite' });
    let timer = null;
    const load = async () => {
      const r = await api(`/api/team/members?${new URLSearchParams({ q: q.value, role: role.value, status: status.value })}`); if (guard(r)) return;
      if (!r.ok) { box.replaceChildren(msg({ tone: 'err', text: fail(r) })); return; }
      box.replaceChildren(...(r.json.members.length ? r.json.members.map((m) => h('button', { class: 'tm-member', type: 'button', on: { click: () => openMember(m.id) } },
        h('span', { class: 'tm-who' }, h('strong', { class: 'tm-ell', text: m.name + (m.isSelf ? ' (vous)' : '') }), h('small', { class: 'tm-ell', text: m.email ?? '' })),
        h('span', { class: 'tm-tags' }, chip(m.roleLabel, 'role'), chip(m.statusLabel, STATUS_TONE[m.status] ?? 'todo')))) : [h('p', { class: 'tm-note', text: 'Aucun membre ne correspond.' })]));
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); }); role.addEventListener('change', load); status.addEventListener('change', load);
    await load();
    return [head('members'), h('div', { class: 'tm-filters' }, q, role, status), box];
  }
  async function openMember(id) {
    const r = await api(`/api/team/members/${id}`); if (guard(r)) return;
    if (!r.ok) { flash = { tone: 'err', text: fail(r) }; return openSection('members', true); }
    detail.replaceChildren(memberCard(r.json)); window.scrollTo(0, 0);
  }
  function memberCard(d) {
    const m = d.member; const a = m.actions; const note = h('div', { class: 'tm-slot' });
    const act = async (path, body, ok) => { note.replaceChildren(); const r = await api(path, body ?? {}); if (guard(r)) return; if (!r.ok) { note.replaceChildren(msg({ tone: 'err', text: fail(r) })); return; } flash = { tone: 'ok', text: ok }; detail.replaceChildren(memberCard(r.json)); window.scrollTo(0, 0); refreshOverview(); };
    const pick = h('select', { class: 'tm-input tm-auto', 'aria-label': 'Nouveau rôle' }, a.changeRole.map((r) => h('option', { value: r, text: ov.roles.find((x) => x.id === r)?.label ?? r })));
    const buttons = [
      a.changeRole.length ? h('div', { class: 'tm-inline' }, pick, h('button', { class: 'cx-btn', type: 'button', text: 'Changer le rôle', on: { click: () => { const label = pick.selectedOptions[0].textContent; if (window.confirm(`Passer ${m.name} au rôle « ${label} » ? Le changement s’applique tout de suite, y compris pour une session déjà ouverte.`)) act(`/api/team/members/${m.id}/role`, { role: pick.value }, 'Rôle modifié.'); } } })) : null,
      a.suspend ? h('button', { class: 'cx-btn ghost', type: 'button', text: 'Suspendre', on: { click: () => { if (window.confirm(`Suspendre l’accès de ${m.name} ? La personne perd l’accès à ce commerce dès sa prochaine action. Vous pourrez le réactiver.`)) act(`/api/team/members/${m.id}/suspend`, {}, 'Accès suspendu.'); } } }) : null,
      a.reactivate ? h('button', { class: 'cx-btn ghost', type: 'button', text: 'Réactiver', on: { click: () => act(`/api/team/members/${m.id}/reactivate`, {}, 'Accès réactivé.') } }) : null,
      a.remove ? h('button', { class: 'cx-btn ghost tm-danger', type: 'button', text: 'Retirer l’accès au commerce', on: { click: () => { if (window.confirm(`Retirer l’accès de ${m.name} à ce commerce ? L’historique est conservé et ses accès à d’autres commerces ne changent pas. Pour revenir, une nouvelle invitation sera nécessaire.`)) act(`/api/team/members/${m.id}/remove`, {}, 'Accès retiré.'); } } }) : null,
    ].filter(Boolean);
    const out = h('div', { class: 'tm-form' },
      h('button', { class: 'cx-back tm-backbtn', type: 'button', text: '‹ Retour aux membres', on: { click: () => openSection('members', true) } }),
      flash ? msg(flash) : null,
      h('div', { class: 'tm-head' }, h('h2', { class: 'tm-wrap', text: m.name + (m.isSelf ? ' (vous)' : '') }), h('p', { class: 'tm-wrap', text: m.email ?? '' })),
      h('div', { class: 'tm-tags' }, chip(m.roleLabel, 'role'), chip(m.statusLabel, STATUS_TONE[m.status] ?? 'todo')),
      h('p', { class: 'tm-help', text: `Membre depuis le ${when(m.since)}.${m.removedAt ? ` Accès retiré le ${when(m.removedAt)}.` : m.suspendedAt ? ` Suspendu le ${when(m.suspendedAt)}.` : ''}` }),
      h('h3', { text: 'Droits effectifs' }), rightsList(d.rights), h('p', { class: 'tm-note', text: d.establishments.note }),
      buttons.length ? [h('h3', { text: 'Actions' }), h('div', { class: 'tm-actions' }, buttons), note] : h('p', { class: 'tm-note', text: m.status === 'REMOVED' ? 'L’accès est retiré : une nouvelle invitation est nécessaire pour revenir.' : 'Votre rôle ne permet pas de modifier ce membre.' }));
    flash = null; return out;
  }

  // ------------------------------------------------------------------ invitations
  async function viewInvitations() {
    const r = await api('/api/team/invitations'); if (guard(r)) return null;
    if (!r.ok) return [head('invitations'), msg({ tone: 'err', text: fail(r) })];
    const email = h('input', { class: 'tm-input', type: 'email', inputmode: 'email', autocomplete: 'off', maxlength: 254, placeholder: 'adresse@exemple.be', 'aria-label': 'Adresse e-mail de la personne invitée' });
    const role = h('select', { class: 'tm-input', 'aria-label': 'Rôle de la personne invitée' }, ov.assignable.map((x) => h('option', { value: x, text: ov.roles.find((y) => y.id === x)?.label ?? x })));
    if (ov.assignable.includes('VIEWER')) role.value = 'VIEWER'; // least privilege first: the broader roles are a deliberate choice
    const preview = h('div', { class: 'tm-preview', 'aria-live': 'polite' });
    const drawPreview = () => { const rr = rights.roles.find((x) => x.id === role.value); preview.replaceChildren(h('p', { class: 'tm-help' }, h('strong', { text: rr.label + ' : ' }), rr.summary), rightsList(rr.rights)); };
    role.addEventListener('change', drawPreview); drawPreview();
    const out = h('div', { class: 'tm-slot' }); const list = h('div', { class: 'tm-list' });
    const drawList = (rows) => list.replaceChildren(...(rows.length ? rows.map((i) => h('div', { class: 'tm-inv' },
      h('div', { class: 'tm-who' }, h('strong', { class: 'tm-ell', text: i.email }), h('small', { text: `${i.roleLabel} · envoyée le ${when(i.sentAt)} · échéance ${when(i.expiresAt)}${i.sendCount > 1 ? ` · envoyée ${i.sendCount} fois` : ''}` })),
      h('div', { class: 'tm-tags' }, chip(i.statusLabel, STATUS_TONE[i.status] ?? 'todo'), i.canResend ? h('button', { class: 'cx-btn ghost', type: 'button', text: 'Renvoyer', on: { click: () => inviteAction(i, 'resend') } }) : null, i.canCancel ? h('button', { class: 'cx-btn ghost tm-danger', type: 'button', text: 'Annuler', on: { click: () => { if (window.confirm(`Annuler l’invitation de ${i.email} ? Le lien ne fonctionnera plus.`)) inviteAction(i, 'cancel'); } } }) : null))) : [h('p', { class: 'tm-note', text: 'Aucune invitation pour le moment.' })]));
    const reload = async () => { const x = await api('/api/team/invitations'); if (x.ok) drawList(x.json.invitations); };
    const showLink = (j, title) => { const field = h('input', { class: 'tm-input tm-mono', type: 'text', readonly: true, value: j.link, 'aria-label': 'Lien d’invitation', on: { focus: (e) => e.target.select() } });
      out.replaceChildren(h('div', { class: 'tm-linkbox' }, msg({ tone: 'ok', text: title }), h('label', { class: 'tm-label', text: 'Lien d’invitation (affiché une seule fois)' }), field,
        h('div', { class: 'tm-actions' }, h('button', { class: 'cx-btn', type: 'button', text: 'Copier le lien', on: { click: async (e) => { try { await navigator.clipboard.writeText(j.link); e.currentTarget.textContent = 'Lien copié'; } catch { field.select(); } } } })), h('p', { class: 'tm-help', text: j.linkNote }))); };
    async function inviteAction(i, what) { out.replaceChildren(); const x = await api(`/api/team/invitations/${i.id}/${what}`, {}); if (guard(x)) return; if (!x.ok) { out.replaceChildren(msg({ tone: 'err', text: fail(x) })); return; } if (what === 'resend') showLink(x.json, `Invitation renvoyée à ${i.email}.`); else out.replaceChildren(msg({ tone: 'ok', text: 'Invitation annulée.' })); reload(); }
    const send = h('button', { class: 'cx-btn', type: 'button', text: 'Créer l’invitation', on: { click: async () => {
      out.replaceChildren(); send.disabled = true; const x = await api('/api/team/invitations', { email: email.value, role: role.value }); send.disabled = false; if (guard(x)) return;
      if (!x.ok) { out.replaceChildren(msg({ tone: 'err', text: fail(x) })); return; }
      email.value = ''; showLink(x.json, `Invitation créée pour ${x.json.invitation.email}.`); reload(); } } });
    drawList(r.json.invitations);
    return [head('invitations'),
      h('div', { class: 'tm-form' }, h('h3', { text: 'Inviter une personne' }), h('label', { class: 'tm-label', text: 'Adresse e-mail' }), email, h('label', { class: 'tm-label', text: 'Rôle' }), role, h('h4', { text: 'Droits que cette personne aura' }), preview,
        h('p', { class: 'tm-note', text: r.json.mail.note + ` Le lien est valable ${r.json.ttlDays} jours, utilisable une seule fois, par cette adresse seulement.` }), h('div', { class: 'tm-actions' }, send), out),
      h('h3', { text: 'Invitations' }), list];
  }

  // ------------------------------------------------------------------ roles
  async function viewRoles() {
    return [head('roles'),
      h('div', { class: 'tm-roles' }, rights.roles.map((r) => h('div', { class: 'tm-rolecard' }, h('strong', { text: r.label }), h('p', { text: r.summary })))),
      h('p', { class: 'tm-note' }, h('strong', { text: 'Employé boutique' }), ' : ', rights.nextRole.note),
      h('p', { class: 'tm-note', text: 'Les appareils et la double authentification relèvent de Paramètres › Sécurité.' }), ...rightsGrid(),
      h('h3', { text: 'Ce que la grille ne montre pas' }), h('ul', { class: 'tm-ul' }, rights.notControlled.map((t) => h('li', { text: t })))];
  }

  // ------------------------------------------------------------------ history
  async function viewHistory() {
    const list = h('div', { class: 'tm-list' }); const more = h('div', { class: 'tm-actions' });
    const line = (e) => h('div', { class: 'tm-ev', 'data-outcome': e.outcome },
      h('div', { class: 'tm-ev-top' }, h('strong', { text: e.label }), h('time', { text: when(e.at) })),
      h('p', { class: 'tm-ev-body' }, e.actor, e.subject ? ` → ${e.subject.label}` : '', e.change ? (e.change.from ? ` : ${e.change.from} → ${e.change.to}` : e.change.to ? ` : ${e.change.to}` : e.change.role ? ` : ${e.change.role}` : '') : ''),
      e.refusal ? h('p', { class: 'tm-help', text: 'Refusé : ' + e.refusal }) : null);
    const load = async (before) => { const r = await api(`/api/team/history?limit=30${before ? `&before=${encodeURIComponent(before)}` : ''}`); if (guard(r)) return; if (!r.ok) { list.append(msg({ tone: 'err', text: fail(r) })); return; }
      if (!before) list.replaceChildren(); if (!r.json.items.length && !before) list.append(h('p', { class: 'tm-note', text: 'Aucun événement pour le moment.' })); for (const e of r.json.items) list.append(line(e));
      more.replaceChildren(r.json.next ? h('button', { class: 'cx-btn ghost', type: 'button', text: 'Voir plus ancien', on: { click: () => load(r.json.next) } }) : ''); };
    await load(null); return [head('history'), list, more];
  }

  // ------------------------------------------------------------------ page
  const VIEW = { members: viewMembers, invitations: viewInvitations, roles: viewRoles, history: viewHistory };
  function renderList() {
    listBox.replaceChildren(...ov.sections.map((s) => h('a', { class: 'cx-row', href: `/settings/team/${SLUG[s.id]}`, 'aria-current': current === s.id ? 'true' : null, on: { click: (e) => { e.preventDefault(); go(s.id); } } }, icon(ICON[s.id]), h('span', { class: 'cx-row-name', text: s.label }), s.locked ? chip('Réservé', 'lock') : null)));
    side.replaceChildren(h('div', { class: 'tm-aside' }, h('h3', { text: 'Votre accès' }), h('p', { text: `${ov.me.roleLabel} sur ${ov.merchant.name ?? 'ce commerce'}.` }), h('p', { class: 'tm-help', text: ov.canManage ? 'Vous pouvez gérer les accès selon votre rôle.' : 'Vous consultez les rôles ; la gestion des accès est réservée au propriétaire et aux administrateurs.' })));
  }
  async function refreshOverview() { const r = await api('/api/team'); if (r.ok) { ov = r.json; renderList(); } }
  async function openSection(id) {
    const s = ov.sections.find((x) => x.id === id); current = id;
    const nodes = s.locked ? locked(id) : (await VIEW[id]()); if (!nodes) return false;
    detail.replaceChildren(...[!wide() ? h('button', { class: 'cx-back', type: 'button', text: '‹ Retour', on: { click: () => go(null) } }) : null, flash ? msg(flash) : null, ...nodes].filter(Boolean)); flash = null;
    renderList(); layout(); document.title = `Nordla AI · Paramètres · ${TITLE[id]}`; return true;
  }
  function layout() { const split = document.getElementById('tm-split'); if (!split) return; const showDetail = wide() || current; listBox.hidden = !wide() && !!current; side.hidden = listBox.hidden; detail.hidden = !showDetail; }
  async function go(id) { if (id === null) { current = null; history.pushState(null, '', '/settings/team'); renderList(); layout(); window.scrollTo(0, 0); return; } if (!(await openSection(id))) return; history.pushState(null, '', `/settings/team/${SLUG[id]}`); window.scrollTo(0, 0); }
  window.addEventListener('popstate', () => { const slug = location.pathname.split('/')[3]; if (OF[slug]) openSection(OF[slug]); else { current = null; renderList(); layout(); } });
  window.matchMedia('(min-width: 900px)').addEventListener('change', () => { if (wide() && !current) openSection(ov.sections.find((s) => !s.locked)?.id ?? 'roles'); else layout(); });

  async function start() {
    const r = await api('/api/team'); if (guard(r)) return;
    if (!r.ok) return app.replaceChildren(h('div', { class: 'cx-wrap' }, h('h1', { text: 'Équipe et accès' }), h('p', { class: 'cx-msg err', text: 'Cette page est indisponible pour le moment.' })));
    ov = r.json; shellData = r.json.shell ?? { nav: [{ id: 'settings', label: 'Paramètres', href: '/settings', icon: 'settings' }], merchant: null, environment: null };
    const rr = await api('/api/team/rights'); rights = rr.ok ? rr.json : { roles: [], levelLabel: {}, sensitiveLabel: {}, notControlled: [], nextRole: { note: '' } };
    const wanted = OF[location.pathname.split('/')[3]] ?? null;
    const split = h('div', { class: 'cx-split', id: 'tm-split' }, h('div', {}, listBox, side), detail);
    app.replaceChildren(shell(shellData, 'settings', [h('p', { class: 'cx-crumb' }, h('a', { class: 'cx-link', href: '/settings', text: 'Paramètres' }), ' / ', h('strong', { text: 'Équipe et accès' })), h('h1', { text: 'Équipe et accès' }), split]));
    renderList();
    const first = wanted ?? (wide() ? (ov.sections.find((s) => !s.locked)?.id ?? 'roles') : null);
    if (first) await openSection(first); else layout();
  }
  start();
})();
