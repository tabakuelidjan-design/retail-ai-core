// Nordla settings shell (menu + header), copied from the deployed Connexions page (connections.js) so Général looks and behaves the same. Copy, not import: Connexions is untouched.
// Technical debt (documented): the two copies should become one shared file in a separate, approved task.
(() => {
  'use strict';
  // A direct Settings URL must return to the Core host; the same route stays in this frame when already embedded.
  if (window.self === window.top) {
    const target = location.pathname + location.search + location.hash;
    location.replace('/?ouvrir=settings&path=' + encodeURIComponent(target));
    return;
  }
  const CSRF_COOKIES = ['__Host-nordla_sourcing_csrf'];
  const csrf = () => { for (const part of String(document.cookie).split(';')) { const i = part.indexOf('='); if (i > 0 && CSRF_COOKIES.includes(part.slice(0, i).trim())) return part.slice(i + 1).trim(); } return ''; };
  const app = document.getElementById('app');
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : String(v)); } for (const k of kids.flat(Infinity)) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
  const svg = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'cx-ico'); s.setAttribute('aria-hidden', 'true'); for (const p of d) { const e = document.createElementNS('http://www.w3.org/2000/svg', 'path'); e.setAttribute('d', p); s.append(e); } return s; };
  const ICONS = {
    home: ['M3 11l9-8 9 8', 'M5 10v10h14V10'], sourcing: ['M11 4a7 7 0 100 14 7 7 0 000-14z', 'M21 21l-5-5'], procurement: ['M3 4h2l2 11h11l2-8H7', 'M9 20h.01', 'M17 20h.01'], finance: ['M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z', 'M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7', 'M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5'],
    analytics: ['M5 20V12', 'M12 20V5', 'M19 20v-9'], growth: ['M3 17l6-6 4 4 8-8', 'M15 7h6v6'], marketing: ['M4 10v4l12 5V5L4 10z', 'M7 14l1 5h3l-1-4'], settings: ['M12 9a3 3 0 100 6 3 3 0 000-6z', 'M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.5-2.3 1a7 7 0 00-2-1.2L14 3h-4l-.6 2.6a7 7 0 00-2 1.2l-2.3-1-2 3.5 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.3-1a7 7 0 002 1.2L10 21h4l.6-2.6a7 7 0 002-1.2l2.3 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z'],
    gear: ['M12 9a3 3 0 100 6 3 3 0 000-6z', 'M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.5-2.3 1a7 7 0 00-2-1.2L14 3h-4l-.6 2.6a7 7 0 00-2 1.2l-2.3-1-2 3.5 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.3-1a7 7 0 002 1.2L10 21h4l.6-2.6a7 7 0 002-1.2l2.3 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z'],
    users: ['M9 11a4 4 0 100-8 4 4 0 000 8z', 'M2 21v-1a6 6 0 0112 0v1', 'M16 4a4 4 0 010 7', 'M18 14a6 6 0 013 5v2'], plug: ['M9 2v6', 'M15 2v6', 'M6 8h12v4a6 6 0 01-12 0V8z', 'M12 18v4'],
    bell: ['M6 9a6 6 0 0112 0c0 6 2 7 2 8H4c0-1 2-2 2-8z', 'M10 21h4'], sliders: ['M4 6h10', 'M18 6h2', 'M4 12h4', 'M12 12h8', 'M4 18h12', 'M20 18h0', 'M14 4v4', 'M8 10v4', 'M16 16v4'], shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z'], chevron: ['M9 6l6 6-6 6'], back: ['M15 6l-6 6 6 6'], menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  };
  const ico = (name) => svg(ICONS[name] ?? ICONS.gear);
  const api = async (path, body) => {
    const r = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json', 'x-nordla-csrf': csrf() } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* none */ }
    return { ok: r.ok, status: r.status, json: j };
  };
  const SETTINGS_NAV = [
    { id: 'overview', label: 'Vue d’ensemble', href: '/settings', icon: 'home', colour: '#0F1B2D' },
    { id: 'general', label: 'Général', href: '/settings/general', icon: 'settings', colour: '#6B7280' },
    { id: 'team', label: 'Équipe et accès', href: '/settings/team', icon: 'users', colour: '#46778D' },
    { id: 'connections', label: 'Connexions', href: '/settings/connections', icon: 'plug', colour: '#7842B8' },
    { id: 'notifications', label: 'Notifications', href: '/settings/notifications', icon: 'bell', colour: '#E87924' },
    { id: 'preferences', label: 'Préférences', href: '/settings/preferences', icon: 'sliders', colour: '#D1A44F' },
    { id: 'security', label: 'Sécurité', href: '/settings/security', icon: 'shield', colour: '#B92335' },
  ];
  function shell(settings, current, content) {
    const path = location.pathname.endsWith('/') ? location.pathname.slice(0, -1) || '/' : location.pathname;
    const nav = h('nav', { class: 'cx-nav', id: 'cx-nav', 'aria-label': 'Navigation Paramètres' }, SETTINGS_NAV.map((n) => {
      const active = n.id === 'overview' ? path === '/settings' : (n.id === 'team' ? path.startsWith('/settings/team') : path === n.href);
      const itemIcon = ico(n.icon); itemIcon.style.color = n.colour;
      return h('a', { class: 'cx-nav-item', href: n.href, 'aria-current': active ? 'page' : null }, itemIcon, h('span', { text: n.label }));
    }));
    return h('div', { class: 'cx-shell' },
      h('div', { class: 'cx-main' },
        h('header', { class: 'cx-top' }, h('strong', { class: 'cx-module-title', text: 'Paramètres' }), h('span', { class: 'cx-top-spacer' }), h('span', { class: 'cx-shop', text: settings.merchant?.name ?? 'Boutique' }), settings.environment ? h('span', { class: 'cx-env', text: settings.environment }) : null),
        nav,
        h('main', { class: 'cx-page' }, content)));
  }
  const signIn = () => app.replaceChildren(h('div', { class: 'cx-wrap' }, h('h1', { text: 'Paramètres' }), h('p', { class: 'cx-sub', text: 'Connectez-vous avec votre compte Nordla.' }), h('a', { class: 'cx-btn', href: '/', text: 'Ouvrir Nordla' })));
  // MFA_REQUIRED_FOR_ROLE: the team requires a second factor for this role; the person is signed in, so say so and lead to Sécurité (the only page still open)
  const mfaNeeded = () => app.replaceChildren(h('div', { class: 'cx-wrap' }, h('h1', { text: 'Double authentification requise' }), h('p', { class: 'cx-sub', text: 'Votre rôle exige la double authentification. Activez-la pour retrouver l’accès à cette page.' }), h('a', { class: 'cx-btn', href: '/settings/security', text: 'Ouvrir Paramètres › Sécurité' })));
  const guard = (r) => (r.json?.error?.code === 'MFA_REQUIRED_FOR_ROLE' ? (mfaNeeded(), true) : r.status === 401 || (r.status === 403 && r.json?.error?.code !== 'FORBIDDEN_ROLE') ? (signIn(), true) : false);
  window.NordlaShell = { h, ico, api, csrf, shell, signIn, guard, app };
})();
