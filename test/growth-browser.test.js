// Growth - real-browser checks (headless Chrome through the DevTools protocol). These cover what the fake DOM cannot: real layout
// (no horizontal page scroll at 1440 / 1280 / 1024 / 768 / 390 - the permanent Growth validation matrix), loading vs error states,
// retry, the period pill in every state, keyboard focus of the detail panels and of the mobile "Plus" menu.
// Skipped (not failed) when no Chrome / Chromium is installed: set CHROME_PATH to run it elsewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGrowthApp } from '../src/growth/server/app.js';
import { potentialPayload, audiencePayload, contentPayload, storePayload } from './growth-dom.js';

const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const CHROME = CANDIDATES.find((p) => existsSync(p));
const skip = CHROME ? false : 'no Chrome/Chromium found (set CHROME_PATH)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIDTHS = [1440, 1280, 1024, 768, 390];
const PAGES = ['', 'opportunities', 'campaigns', 'potential', 'audience', 'content', 'storeGrowth'];

async function serve(opts) {
  const server = http.createServer(createGrowthApp(opts));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** One headless browser, one tab, driven over CDP. */
async function browser() {
  const dir = mkdtempSync(path.join(tmpdir(), 'growth-cdp-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  let targets = [];
  for (let i = 0; i < 100 && !targets.length; i += 1) { try { targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page'); } catch { /* not up yet */ } if (!targets.length) await sleep(100); }
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  const errors = [];
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' ')); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); });
  const b = {
    errors,
    async open(url, width = 1440, height = 900) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
      await send('Page.navigate', { url: 'about:blank' });
      await send('Page.navigate', { url });
      await sleep(700);
    },
    async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; },
    async key(key, { shift = false } = {}) {
      const codes = { Tab: 9, Escape: 27, Enter: 13 };
      const base = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key], modifiers: shift ? 8 : 0 };
      // Enter must carry its text to activate a focused button (like a real keyboard); Tab / Escape are raw keys.
      await send('Input.dispatchKeyEvent', key === 'Enter' ? { type: 'keyDown', text: String.fromCharCode(13), unmodifiedText: String.fromCharCode(13), ...base } : { type: 'rawKeyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(120);
    },
    async close() { ws.close(); proc.kill(); await sleep(200); try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on Windows: temp dir */ } },
  };
  return b;
}

const sources = () => ({
  productPotential: async () => potentialPayload(), audience: async () => audiencePayload(),
  content: async () => contentPayload(), store: async () => storePayload(),
});

test('browser: 7 pages x 1440 / 1280 / 1024 / 768 / 390 - no horizontal page scroll, no console error, data rendered', { skip, timeout: 240000 }, async () => {
  const app = await serve(sources()); const b = await browser();
  try {
    for (const pg of PAGES) {
      for (const w of WIDTHS) {
        await b.open(`${app.base}/#/${pg}`, w);
        const r = JSON.parse(await b.eval(`JSON.stringify({ sw: document.documentElement.scrollWidth, w: innerWidth, state: !!document.querySelector('.gr-state'), kpis: document.querySelectorAll('.ex-kpi').length })`));
        assert.ok(r.sw <= r.w, `${pg || 'overview'} @${w}: page scrolls horizontally (${r.sw} > ${r.w})`);
        assert.equal(r.state, false, `${pg || 'overview'} @${w}: still in a loading / error state`);
        assert.ok(r.kpis >= 4, `${pg || 'overview'} @${w}: page content rendered`);
      }
    }
    assert.deepEqual(b.errors.filter((e) => !/ResizeObserver/.test(e)), []);
  } finally { await b.close(); await app.close(); }
});

test('browser: loading is distinct from error; error is typed and safe; Réessayer reloads; the period pill never changes', { skip, timeout: 60000 }, async () => {
  let fail = true; let calls = 0;
  const slow = async () => { calls += 1; await sleep(1500); if (fail) throw new Error('db exploded: password=secret'); return potentialPayload(); };
  const app = await serve({ ...sources(), productPotential: slow, audience: null });
  const b = await browser();
  try {
    await b.open(`${app.base}/#/potential`, 1280);
    const loading = JSON.parse(await b.eval(`JSON.stringify({ loading: !!document.querySelector('.gr-state-loading'), error: !!document.querySelector('.gr-state-error'), text: document.querySelector('main').innerText, pill: document.querySelector('.period-pill').textContent })`));
    assert.equal(loading.loading, true, 'a real loading state');
    assert.equal(loading.error, false);
    assert.ok(!/Données indisponibles/.test(loading.text), 'loading never says "unavailable"');
    assert.match(loading.pill, /8 dernières semaines/);
    await sleep(1600);
    const err = JSON.parse(await b.eval(`JSON.stringify({ error: !!document.querySelector('.gr-state-error'), role: document.querySelector('.gr-state-error')?.getAttribute('role'), text: document.querySelector('.gr-state-error')?.innerText, retry: !!document.querySelector('.gr-state-retry'), pill: document.querySelector('.period-pill').textContent })`));
    assert.equal(err.error, true);
    assert.equal(err.role, 'alert');
    assert.match(err.text, /n’ont pas pu être lues/);
    assert.ok(!/secret|password|exploded|stack/i.test(err.text), 'no internal detail shown');
    assert.equal(err.retry, true);
    assert.match(err.pill, /8 dernières semaines/, 'same period while in error');
    fail = false;
    await b.eval(`document.querySelector('.gr-state-retry').click(); 1`);
    await sleep(300);
    assert.equal(await b.eval(`!!document.querySelector('.gr-state-loading')`), true, 'retry shows loading again');
    await sleep(1600);
    assert.ok(await b.eval(`document.querySelectorAll('.gr-pp-row').length`) > 0, 'retry loaded the data');
    assert.equal(calls, 2);
    // Tenant not configured: its own safe message; Audience keeps its 90-day period in the error state.
    await b.open(`${app.base}/#/audience`, 1280);
    const t = JSON.parse(await b.eval(`JSON.stringify({ text: document.querySelector('.gr-state-error')?.innerText, pill: document.querySelector('.period-pill').textContent })`));
    assert.match(t.text, /Aucune boutique n’est configurée/);
    assert.match(t.pill, /90 derniers jours/);
  } finally { await b.close(); await app.close(); }
});

test('browser: detail panels - focus moved in on open, Tab / Shift+Tab trapped, Escape closes, focus restored to the trigger', { skip, timeout: 90000 }, async () => {
  const app = await serve(sources()); const b = await browser();
  try {
    for (const [pg, row] of [['potential', '.gr-pp-row'], ['audience', '.gr-au-row'], ['content', '.gr-ct-row']]) {
      await b.open(`${app.base}/#/${pg}`, 1440);
      const trigger = await b.eval(`(() => { const r = document.querySelector('${row}'); r.focus(); return r.getAttribute('data-focus-id'); })()`);
      assert.ok(trigger, `${pg}: rows carry a focus id`);
      await b.key('Enter');
      assert.equal(await b.eval(`document.activeElement.classList.contains('gr-pp-close') && !!document.activeElement.closest('.gr-pp-drawer')`), true, `${pg}: focus moved into the panel`);
      for (let i = 0; i < 12; i += 1) await b.key('Tab');
      assert.equal(await b.eval(`!!document.activeElement.closest('.gr-pp-drawer')`), true, `${pg}: Tab stays inside the panel`);
      await b.key('Tab', { shift: true }); await b.key('Tab', { shift: true });
      assert.equal(await b.eval(`!!document.activeElement.closest('.gr-pp-drawer')`), true, `${pg}: Shift+Tab stays inside the panel`);
      await b.key('Escape');
      assert.equal(await b.eval(`!!document.querySelector('.gr-pp-drawer')`), false, `${pg}: Escape closes`);
      assert.equal(await b.eval(`document.activeElement.getAttribute('data-focus-id')`), trigger, `${pg}: focus restored to the trigger`);
      // Close button path.
      await b.key('Enter');
      await b.eval(`document.querySelector('.gr-pp-close').click(); 1`); await sleep(150);
      assert.equal(await b.eval(`document.activeElement.getAttribute('data-focus-id')`), trigger, `${pg}: focus restored after the close button`);
    }
  } finally { await b.close(); await app.close(); }
});

test('browser: mobile Plus menu - opens, focus inside and trapped, Escape closes and restores, active on Contenu', { skip, timeout: 60000 }, async () => {
  const app = await serve(sources()); const b = await browser();
  try {
    await b.open(`${app.base}/#/content`, 390, 844);
    assert.equal(await b.eval(`document.querySelector('.gr-more-btn').classList.contains('active')`), true);
    await b.eval(`document.querySelector('.gr-more-btn').focus(); 1`);
    await b.key('Enter');
    assert.equal(await b.eval(`!!document.activeElement.closest('.gr-more-panel')`), true);
    for (let i = 0; i < 6; i += 1) await b.key('Tab');
    assert.equal(await b.eval(`!!document.activeElement.closest('.gr-more-panel')`), true, 'Tab stays in the menu');
    await b.key('Escape');
    assert.equal(await b.eval(`!document.querySelector('.gr-more-panel') && document.activeElement.classList.contains('gr-more-btn')`), true);
    assert.equal(await b.eval(`document.documentElement.scrollWidth <= innerWidth`), true);
  } finally { await b.close(); await app.close(); }
});

test('browser: Overview shows no invented footfall / conversion and uses the real store sales', { skip, timeout: 60000 }, async () => {
  const app = await serve(sources()); const b = await browser();
  try {
    await b.open(`${app.base}/#/`, 1440);
    const r = JSON.parse(await b.eval(`JSON.stringify({ card: document.querySelector('.gr-store')?.innerText, pulse: document.querySelector('.gr-pulse')?.innerText })`));
    assert.match(r.card, /Non connecté[\s\S]*Non connecté/);
    assert.match(r.card, /Données réelles/);
    assert.ok(!/4\s?860|21,4/.test(r.card), 'no demo visitors or conversion');
    const noTenant = await serve({});
    try {
      await b.open(`${noTenant.base}/#/`, 1440);
      assert.match(await b.eval(`document.querySelector('.gr-store').innerText`), /Donnée indisponible/);
    } finally { await noTenant.close(); }
  } finally { await b.close(); await app.close(); }
});
