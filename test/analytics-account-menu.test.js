import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';

const UI = new URL('../src/analytics-premium/ui/', import.meta.url);
const plain = (x) => JSON.parse(JSON.stringify(x)); // objects built inside the vm context have another realm's prototype

async function loadMenu() {
  const src = await readFile(new URL('account-menu.js', UI), 'utf8');
  const ctx = { window: {} };
  vm.runInNewContext(src, ctx);
  return ctx.window.NordlaAccountMenu;
}

test('account menu: opens on the control, closes again, and moves focus accordingly', async () => {
  const { menuNext } = await loadMenu();
  const opened = menuNext({ open: false }, 'toggle');
  assert.deepEqual(plain(opened), { open: true, focus: 'menu' });
  assert.deepEqual(plain(menuNext(opened, 'toggle')), { open: false, focus: 'button' });
  assert.deepEqual(plain(menuNext({ open: false }, 'open')), { open: true, focus: 'menu' }); // ArrowDown on the control
});

test('account menu: closes on Escape (focus back to the control), outside click, tab-out and selection', async () => {
  const { menuNext } = await loadMenu();
  const open = { open: true };
  assert.deepEqual(plain(menuNext(open, 'escape')), { open: false, focus: 'button' });
  assert.deepEqual(plain(menuNext(open, 'outside')), { open: false, focus: null });
  assert.deepEqual(plain(menuNext(open, 'tabout')), { open: false, focus: null });
  assert.deepEqual(plain(menuNext(open, 'select')), { open: false, focus: null });
  assert.deepEqual(plain(menuNext({ open: false }, 'escape')), { open: false, focus: null }); // Escape while closed does nothing
});

test('account menu: no fake actions - Analytics has no session and no settings page, so none are offered', async () => {
  const { menuItems, ANALYTICS_ACCOUNT } = await loadMenu();
  assert.equal(ANALYTICS_ACCOUNT.logoutEndpoint, null);
  assert.equal(ANALYTICS_ACCOUNT.settingsHref, null);
  assert.equal(menuItems().length, 0);
  // and the server really exposes no logout/session route to wire to
  const dir = await mkdtemp(path.join(tmpdir(), 'ap-account-'));
  const server = http.createServer(createAnalyticsPremiumApp({ reportsDir: dir }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/logout`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/api/session`)).status, 404);
    assert.equal((await fetch(`${base}/account-menu.js`)).status, 200);
  } finally { server.close(); }
});

test('account menu: logout is wired to a real server call when a session endpoint exists (POST, then reload only on success)', async () => {
  const { menuItems, performLogout } = await loadMenu();
  const [logout] = menuItems({ logoutEndpoint: '/api/logout', settingsHref: null });
  assert.deepEqual({ id: logout.id, kind: logout.kind, method: logout.method, url: logout.url }, { id: 'logout', kind: 'logout', method: 'POST', url: '/api/logout' });
  const calls = []; let reloaded = 0;
  await performLogout(logout, async (url, init) => { calls.push([url, init.method]); return { ok: true, status: 200 }; }, () => { reloaded += 1; });
  assert.deepEqual(calls, [['/api/logout', 'POST']]);
  assert.equal(reloaded, 1);
  // a refused logout never pretends: no reload, the error surfaces
  await assert.rejects(performLogout(logout, async () => ({ ok: false, status: 500 }), () => { reloaded += 1; }));
  assert.equal(reloaded, 1);
});

test('account menu: settings navigation is wired when a real settings route exists', async () => {
  const { menuItems } = await loadMenu();
  const items = menuItems({ logoutEndpoint: '/api/logout', settingsHref: '#/settings' });
  assert.deepEqual(plain(items.map((i) => i.id)), ['settings', 'logout']);
  assert.equal(items[0].kind, 'link');
  assert.equal(items[0].href, '#/settings');
});

test('account menu: the header uses the control, the page loads it, FR/NL/EN copy exists, the language switch is untouched', async () => {
  const app = await readFile(new URL('app.js', UI), 'utf8');
  assert.ok(app.includes('NordlaAccountMenu.accountControl({ h, t, svg, icon })'));
  assert.ok(!/class: 'avatar-group' \}/.test(app)); // the old inert span is gone
  assert.ok(app.includes('langSwitch(onLangChange),'));
  const html = await readFile(new URL('index.html', UI), 'utf8');
  assert.ok(html.indexOf('/account-menu.js') > 0 && html.indexOf('/account-menu.js') < html.indexOf('/app.js'));
  const menu = await readFile(new URL('account-menu.js', UI), 'utf8');
  assert.ok(!/location\.(href|assign|replace)/.test(menu)); // logout never fakes itself with a redirect
  for (const l of ['fr', 'nl', 'en']) {
    const dict = await readFile(new URL(`lang-${l}.js`, UI), 'utf8');
    for (const k of ['account.menuLabel', 'account.title', 'account.statusLocal', 'account.noSession', 'account.settings', 'account.logout']) assert.ok(dict.includes(`'${k}':`), `${l} missing ${k}`);
  }
});
