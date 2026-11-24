// Nordla Core navigation frame, shared by every Nordla module that is rebuilt on the Core design.
// Classic script served as /nordla-core-rail.js (src/shared/nordla-static.js). It draws the Core menu (vertical):
// a fixed left column on a computer, a drawer opened by ☰ on a phone. Pure DOM API: no innerHTML, no global state
// beyond window.NordlaCoreRail. If this script does not load, a module renders without the Core menu and keeps working.
(function () {
  'use strict';

  var ICON_PATHS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>',
    box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    megaphone: '<path d="M4 10v4h3l8 4V6L7 10z"/>',
    paint: '<path d="M4 20l4-1 11-11-3-3L5 16z"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'
  };

  // One entry per Nordla module. `path` is relative to the Nordla home address (or to this origin when no base is given).
  // Entries without `path` are shown as not available yet: no link is written for them.
  // `?ouvrir=` entries open the module's own sign-in ticket from Core (no token is typed by the person).
  var MENU = Object.freeze([
    { key: 'dashboard', label: 'Tableau de bord', path: '/', icon: 'grid', colour: '#0F1B2D' },
    { key: 'parle', label: 'Parle à Nordla', path: '/?ouvrir=parle', icon: 'chat', colour: '#0F1B2D' },
    { key: 'finance', label: 'Finance', path: '/?ouvrir=finance', icon: 'card', colour: '#46778D' },
    { key: 'analytics', label: 'Analyses', path: '/?ouvrir=analyses', icon: 'chart', colour: '#7842B8' },
    { key: 'procurement', label: 'Stock & Achats', path: '/procurement/?tab=stock', icon: 'box', colour: '#E87924' },
    { key: 'sourcing', label: 'Sourcing', path: '/sourcing', icon: 'globe', colour: '#B92335' },
    { key: 'growth', label: 'Croissance', icon: 'chart', colour: '#D1A44F', note: 'Écran pas encore accessible' },
    { key: 'marketing', label: 'Marketing', path: '/videos', icon: 'megaphone', colour: '#F17821' },
    { key: 'creation', label: 'Création', path: '/creator', icon: 'paint', colour: '#C84FA4' },
    { key: 'branding', label: 'Branding', icon: 'tag', colour: '#9E2F86', note: 'Écran pas encore accessible' },
    { key: 'settings', label: 'Paramètres', path: '/settings', icon: 'gear', colour: '#6B7280' }
  ]);

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  function icon(name, colour) {
    var span = el('span', { 'class': 'cr-ico', 'aria-hidden': 'true' });
    span.style.setProperty('--m', colour);
    var doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (ICON_PATHS[name] || ICON_PATHS.grid) + '</svg>', 'image/svg+xml');
    span.appendChild(document.importNode(doc.documentElement, true));
    return span;
  }

  /** Address of a menu entry: on the Nordla home address when a base is given, else on this origin. */
  function hrefFor(path, base) {
    try { return base ? new URL(path, base).href : path; } catch (e) { return null; }
  }

  /** The Core menu. `current` is the key of the module showing it; `base` is the Nordla home address (optional). */
  function create(options) {
    var current = (options && options.current) || '';
    var base = (options && options.base) || '';
    var items = MENU.map(function (m) {
      var body = [icon(m.icon, m.colour), el('span', null, [m.label, m.note ? el('em', { 'class': 'cr-note' }, [m.note]) : null])];
      if (m.key === current) return el('li', null, [el('span', { 'class': 'cr-cur', 'aria-current': 'page' }, body)]);
      var href = m.path ? hrefFor(m.path, base) : null;
      if (!href) return el('li', null, [el('span', { 'class': 'cr-off', 'aria-disabled': 'true' }, body)]);
      return el('li', null, [el('a', { href: href }, body)]);
    });
    var brand = el('div', { 'class': 'cr-brand' }, []);
    brand.appendChild(el('span', { 'class': 'cr-mark' }, ['N']));
    brand.appendChild(el('span', null, ['Nordla']));
    var list = el('ul', { 'class': 'cr-menu' }, items);
    var nav = el('nav', { 'class': 'corerail', id: 'corerail', 'aria-label': 'Menu Nordla' }, [brand, el('p', { 'class': 'cr-title' }, ['Menu principal']), list]);
    return nav;
  }

  /** Update the active item when an SPA changes screens without changing its URL. */
  function setCurrent(key) {
    var old = document.getElementById('corerail');
    if (!old || !old.parentNode) return;
    old.parentNode.replaceChild(create({ current: key, base: location.origin }), old);
  }

  /** The ☰ button of a phone: it opens and closes the drawer of the enclosing .shell.nordla-frame. */
  function toggle() {
    var button = el('button', { 'class': 'menu-toggle', type: 'button', 'aria-label': 'Menu Nordla', 'aria-controls': 'corerail' }, ['☰']);
    button.addEventListener('click', function () {
      var shell = button.closest('.shell.nordla-frame');
      if (shell) shell.classList.toggle('menu-open');
    });
    return button;
  }

  /** Fills the placeholders of a static page: [data-nordla-core-rail="<current key>"] and [data-nordla-core-toggle]. */
  function autoMount() {
    var host = document.querySelector('[data-nordla-core-rail]');
    // The frame layout (two columns) applies only once the menu is really there: without this script the page keeps one column.
    if (host) { if (host.parentElement) host.parentElement.classList.add('nordla-frame'); host.replaceWith(create({ current: host.getAttribute('data-nordla-core-rail'), base: location.origin })); }
    var slot = document.querySelector('[data-nordla-core-toggle]');
    if (slot && host) slot.appendChild(toggle());
  }

  window.NordlaCoreRail = { MENU: MENU, create: create, toggle: toggle, setCurrent: setCurrent, autoMount: autoMount };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
  else autoMount();
})();
