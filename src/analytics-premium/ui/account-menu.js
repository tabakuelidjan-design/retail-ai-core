'use strict';
// Analytics Premium - top-right account control (round profile icon + chevron). Plain global script, same convention as
// the rest of this UI. Two layers:
//   - pure logic (menuNext, menuItems): no DOM, unit-tested in test/analytics-account-menu.test.js
//   - the DOM control (accountControl), built by topbar() in app.js
//
// Honesty rule: Analytics Premium has NO session/login layer and NO settings page yet (the server is a local, read-only
// preview - see server/app.js). The only real session in the codebase belongs to the separate Finance server, which this
// page cannot reach. So no "Se déconnecter" or "Paramètres" item is offered: a logout that only redirects, or a settings link
// to a page that does not exist, would be fake. The menu states that plainly. When a real mechanism exists, declare it in
// ANALYTICS_ACCOUNT and menuItems() wires it (logout = POST to the server's logout endpoint, then reload; settings = a route).
window.NordlaAccountMenu = (function () {
  const ANALYTICS_ACCOUNT = Object.freeze({
    logoutEndpoint: null, // e.g. '/api/logout' once the Analytics server has real sessions
    settingsHref: null, // e.g. '#/settings' once a real settings page exists
  });

  /** State machine of the menu. state = { open }, event = 'toggle' | 'open' | 'escape' | 'outside' | 'tabout' | 'select'. */
  function menuNext(state, event) {
    if (event === 'toggle') return { open: !state.open, focus: state.open ? 'button' : 'menu' };
    if (event === 'open') return { open: true, focus: 'menu' };
    if (event === 'escape') return state.open ? { open: false, focus: 'button' } : { open: false, focus: null };
    if (event === 'outside' || event === 'tabout') return { open: false, focus: null };
    if (event === 'select') return { open: false, focus: null };
    return { open: Boolean(state.open), focus: null };
  }

  /** Actions offered by the menu - only the ones backed by a real mechanism. */
  function menuItems(account = ANALYTICS_ACCOUNT) {
    const items = [];
    if (account.settingsHref) items.push({ id: 'settings', labelKey: 'account.settings', kind: 'link', href: account.settingsHref });
    if (account.logoutEndpoint) items.push({ id: 'logout', labelKey: 'account.logout', kind: 'logout', method: 'POST', url: account.logoutEndpoint });
    return items;
  }

  /** Real logout: the server destroys the session (its response clears the cookie); only then does the page reload. */
  async function performLogout(item, fetchImpl = fetch, reload = () => location.reload()) {
    const res = await fetchImpl(item.url, { method: item.method, credentials: 'same-origin' });
    if (!res.ok) throw new Error(`logout failed (${res.status})`);
    reload();
  }

  // ---------- DOM control ----------
  let uid = 0;
  function accountControl({ h, t, svg, icon, account = ANALYTICS_ACCOUNT }) {
    const id = `ap-account-menu-${++uid}`;
    let state = { open: false };
    const button = h('button', { type: 'button', class: 'avatar-group ap-account-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': t('account.menuLabel') },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, svg(['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5'], 16)), icon('chevronDown', 13));
    const items = menuItems(account);
    const panel = h('div', { class: 'ap-account-menu', id, role: items.length ? 'menu' : 'dialog', 'aria-label': t('account.menuLabel'), tabindex: '-1', hidden: 'hidden' },
      h('div', { class: 'ap-account-head' },
        h('span', { class: 'avatar ap-account-avatar', 'aria-hidden': 'true' }, svg(['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5'], 16)),
        h('div', { class: 'ap-account-id' }, h('strong', null, t('account.title')), h('span', { class: 'ap-account-status' }, h('i', { class: 'ap-account-dot', 'aria-hidden': 'true' }), t('account.statusLocal')))),
      items.length
        ? h('div', { class: 'ap-account-items' }, items.map((it) => h(it.kind === 'link' ? 'a' : 'button', { class: 'ap-account-item', role: 'menuitem', ...(it.kind === 'link' ? { href: it.href } : { type: 'button' }), 'data-action': it.id, on: { click: () => onSelect(it) } }, t(it.labelKey))))
        : h('p', { class: 'ap-account-note' }, t('account.noSession')));
    const wrap = h('div', { class: 'ap-account' }, button, panel);

    function apply(next) {
      state = next;
      panel.hidden = !state.open;
      button.setAttribute('aria-expanded', String(state.open));
      wrap.classList.toggle('open', state.open);
      if (state.open) { document.addEventListener('pointerdown', onOutside, true); document.addEventListener('keydown', onKey, true); }
      else { document.removeEventListener('pointerdown', onOutside, true); document.removeEventListener('keydown', onKey, true); }
      if (next.focus === 'menu') (panel.querySelector('.ap-account-item') || panel).focus();
      if (next.focus === 'button') button.focus();
    }
    function onOutside(e) { if (!wrap.isConnected || !wrap.contains(e.target)) apply(menuNext(state, 'outside')); }
    function onKey(e) {
      if (!wrap.isConnected) { apply(menuNext(state, 'outside')); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); apply(menuNext(state, 'escape')); return; }
      if (e.key === 'Tab') setTimeout(() => { if (state.open && !wrap.contains(document.activeElement)) apply(menuNext(state, 'tabout')); }, 0);
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && wrap.contains(document.activeElement)) {
        const list = [...panel.querySelectorAll('.ap-account-item')]; if (!list.length) return;
        e.preventDefault();
        const i = list.indexOf(document.activeElement);
        list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus();
      }
    }
    async function onSelect(it) {
      apply(menuNext(state, 'select'));
      if (it.kind === 'logout') { try { await performLogout(it); } catch (e) { /* stays signed in; the server refused */ } }
    }
    button.addEventListener('click', () => apply(menuNext(state, 'toggle')));
    button.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && !state.open) { e.preventDefault(); apply(menuNext(state, 'open')); } });
    return wrap;
  }

  return { ANALYTICS_ACCOUNT, menuNext, menuItems, performLogout, accountControl };
})();
