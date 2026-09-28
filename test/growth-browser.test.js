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
import { makeDemandData } from './fixtures/demand-sample.js';
import { makeAudienceData } from './fixtures/audience-sample.js';
import { makeContentData } from './fixtures/content-sample.js';
import { makeStoreData } from './fixtures/store-sample.js';

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
  let b;
  b = {
    errors,
    send,
    // Waits until the page left its loading state (polling, not a fixed delay: the suite runs files in parallel and a busy
    // machine must not make a test flaky). `ready: false` returns as soon as the shell is on screen (to observe loading).
    async open(url, width = 1440, height = 900, { ready = true } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
      await send('Page.navigate', { url: 'about:blank' });
      await send('Page.navigate', { url });
      const cond = ready ? `!!document.querySelector('.ex-title') && !document.querySelector('.gr-state-loading')` : `!!document.querySelector('.ex-title')`;
      for (let i = 0; i < 100; i += 1) { if (await b.eval(cond)) break; await sleep(100); }
      await sleep(150);
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
    await b.open(`${app.base}/#/potential`, 1280, 900, { ready: false });
    const loading = JSON.parse(await b.eval(`JSON.stringify({ loading: !!document.querySelector('.gr-state-loading'), error: !!document.querySelector('.gr-state-error'), text: document.querySelector('main').innerText, pill: document.querySelector('.period-pill').textContent })`));
    assert.equal(loading.loading, true, 'a real loading state');
    assert.equal(loading.error, false);
    assert.ok(!/Données indisponibles/.test(loading.text), 'loading never says "unavailable"');
    assert.match(loading.pill, /8 dernières semaines/);
    for (let i = 0; i < 60 && !(await b.eval(`!!document.querySelector('.gr-state-error')`)); i += 1) await sleep(100);
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
    for (let i = 0; i < 60 && !(await b.eval(`document.querySelectorAll('.gr-pp-row').length > 0`)); i += 1) await sleep(100);
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
    // Growth Pulse: no attribution source, no footfall source -> stated in the card, no curve, no figure (both views).
    assert.match(r.pulse, /Source non connectée/);
    assert.equal(await b.eval(`document.querySelectorAll('.gr-pulse svg path').length`), 0, 'no curve drawn');
    await b.eval(`(() => { const s = document.querySelector('.gr-pulse select'); s.value = 'traffic'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(150);
    const traffic = await b.eval(`document.querySelector('.gr-pulse').innerText`);
    assert.match(traffic, /Non connecté|non connecté/i);
    assert.doesNotMatch(traffic, /\d/, 'no visitor figure');
    const noTenant = await serve({});
    try {
      await b.open(`${noTenant.base}/#/`, 1440);
      assert.match(await b.eval(`document.querySelector('.gr-store').innerText`), /Donnée indisponible/);
    } finally { await noTenant.close(); }
  } finally { await b.close(); await app.close(); }
});

// ================= Post-fix verification of the deep audit (2026-09-28) =================

test('post-fix P2 Contenu: 1440 / 1280 / 1180 / 1024 / 768 / 390 - no page overflow, no clipped content, the list stays usable', { skip, timeout: 90000 }, async () => {
  const app = await serve(sources()); const b = await browser();
  try {
    for (const w of [1440, 1280, 1180, 1024, 768, 390]) {
      await b.open(`${app.base}/#/content`, w);
      const r = JSON.parse(await b.eval(`JSON.stringify((() => {
        const de = document.documentElement; const list = document.querySelector('.gr-ct-list');
        const clipped = [...document.querySelectorAll('main *')].filter((el) => { const s = getComputedStyle(el); return !['IMG', 'SVG', 'svg', 'VIDEO', 'CANVAS'].includes(el.tagName) && (s.overflowX === 'hidden' || s.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis'; }).map((el) => el.className);
        const scrollers = [...document.querySelectorAll('main *')].filter((el) => { const s = getComputedStyle(el); return el.scrollWidth > el.clientWidth + 1 && (s.overflowX === 'auto' || s.overflowX === 'scroll'); }).map((el) => el.className);
        const lr = list.getBoundingClientRect();
        const rowsOut = [...list.querySelectorAll('.gr-ct-row')].filter((row) => [...row.children].some((c) => { const b = c.getBoundingClientRect(); return b.width > 0 && (b.right > lr.right + 1 || b.left < lr.left - 1); })).length;
        return { sw: de.scrollWidth, cw: de.clientWidth, listSw: list.scrollWidth, listCw: list.clientWidth, clipped, scrollers, rowsOut, rows: list.querySelectorAll('.gr-ct-row').length,
          rowFocusable: list.querySelector('.gr-ct-row')?.tabIndex === 0 };
      })())`));
      assert.ok(r.sw <= r.cw, `@${w}: page scrollWidth ${r.sw} > clientWidth ${r.cw}`);
      assert.ok(r.listSw <= r.listCw, `@${w}: Contenu list overflows (${r.listSw} > ${r.listCw})`);
      assert.deepEqual(r.clipped, [], `@${w}: content clipped by overflow hidden`);
      assert.deepEqual(r.scrollers, [], `@${w}: no hidden inner scroll area needed`);
      assert.equal(r.rowsOut, 0, `@${w}: a row cell leaves the list`);
      assert.ok(r.rows > 0 && r.rowFocusable, `@${w}: rows rendered and keyboard-reachable`);
      // Where the Action column is hidden (1024-1180, < 1024 cards), the row itself opens the same panel.
      await b.eval(`document.querySelector('.gr-ct-row').focus(); 1`);
      await b.key('Enter');
      assert.equal(await b.eval(`!!document.querySelector('.gr-pp-drawer')`), true, `@${w}: the row opens the detail panel`);
      await b.key('Escape');
    }
  } finally { await b.close(); await app.close(); }
});

const PILL = { potential: /8 dernières semaines/, audience: /90 derniers jours/, content: /8 dernières semaines/, storeGrowth: /8 dernières semaines/, '': /30 derniers jours/, opportunities: /30 derniers jours/, campaigns: /30 derniers jours/ };
const SOURCE_OF = { potential: 'productPotential', audience: 'audience', content: 'content', storeGrowth: 'store' };
const EMPTY = { potential: () => potentialPayload({ ...makeDemandData(), orders: [], orderLines: [] }), audience: () => audiencePayload(makeAudienceData({})), content: () => contentPayload(makeContentData([])), storeGrowth: () => storePayload(makeStoreData({})) };

test('post-fix P2 states: every real page - loading, error + safe message + Réessayer, retry refetches, empty, normal - one period per page', { skip, timeout: 180000 }, async () => {
  const b = await browser();
  try {
    for (const pg of ['potential', 'audience', 'content', 'storeGrowth']) {
      let mode = 'fail'; let calls = 0;
      const full = sources()[SOURCE_OF[pg]];
      const src = async () => { calls += 1; await sleep(1200); if (mode === 'fail') throw new Error('internal: token=abc stack'); return mode === 'empty' ? EMPTY[pg]() : full(); };
      const app = await serve({ ...sources(), [SOURCE_OF[pg]]: src });
      try {
        const pill = () => b.eval(`document.querySelector('.period-pill').textContent`);
        await b.open(`${app.base}/#/${pg}`, 1280, 900, { ready: false });
        assert.equal(await b.eval(`!!document.querySelector('.gr-state-loading') && !document.querySelector('.gr-state-error')`), true, `${pg}: real loading state`);
        assert.equal(await b.eval(`document.querySelector('.gr-state-loading').getAttribute('role')`), 'status');
        assert.match(await pill(), PILL[pg], `${pg}: period while loading`);
        for (let i = 0; i < 60 && !(await b.eval(`!!document.querySelector('.gr-state-error')`)); i += 1) await sleep(100);
        const err = JSON.parse(await b.eval(`JSON.stringify({ role: document.querySelector('.gr-state-error')?.getAttribute('role'), text: document.querySelector('.gr-state-error')?.innerText || '', retry: document.querySelector('.gr-state-retry')?.innerText })`));
        assert.equal(err.role, 'alert', `${pg}: distinct error state`);
        assert.doesNotMatch(err.text, /token|abc|stack|internal/i, `${pg}: safe message`);
        assert.match(err.retry, /Réessayer/, `${pg}: retry button`);
        assert.match(await pill(), PILL[pg], `${pg}: period on error`);
        mode = 'empty'; const before = calls;
        await b.eval(`document.querySelector('.gr-state-retry').click(); 1`);
        await sleep(200);
        assert.equal(await b.eval(`!!document.querySelector('.gr-state-loading')`), true, `${pg}: retry shows loading`);
        for (let i = 0; i < 60 && (await b.eval(`!!document.querySelector('.gr-state')`)); i += 1) await sleep(100);
        assert.equal(calls, before + 1, `${pg}: retry really refetched`);
        assert.equal(await b.eval(`!!document.querySelector('.gr-state')`), false, `${pg}: empty page rendered`);
        assert.match(await pill(), PILL[pg], `${pg}: period on the empty page`);
      } finally { await app.close(); }
      // Normal state (fresh server).
      const ok = await serve(sources());
      try { await b.open(`${ok.base}/#/${pg}`, 1280); assert.match(await b.eval(`document.querySelector('.period-pill').textContent`), PILL[pg], `${pg}: period on the normal page`); } finally { await ok.close(); }
    }
    // Shell pages: their declared 30-day window in every state they have (loading + normal).
    const app = await serve(sources());
    try {
      for (const pg of ['', 'opportunities', 'campaigns']) {
        await b.open(`${app.base}/#/${pg}`, 1280, 900, { ready: false });
        assert.match(await b.eval(`document.querySelector('.period-pill').textContent`), PILL[pg], `${pg || 'overview'}: period while loading`);
        await b.open(`${app.base}/#/${pg}`, 1280);
        assert.match(await b.eval(`document.querySelector('.period-pill').textContent`), PILL[pg], `${pg || 'overview'}: period`);
      }
    } finally { await app.close(); }
  } finally { await b.close(); }
});

test('post-fix P2 drawers: aria contract, focus in / trapped / restored, Escape, close button, backdrop, no duplicated listeners', { skip, timeout: 120000 }, async () => {
  const app = await serve(sources()); const b = await browser();
  // Count listeners registered on document and window, from the first script on.
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__lc = 0; for (const t of [Document.prototype, Window.prototype]) { const o = t.addEventListener; t.addEventListener = function (type, fn, opt) { window.__lc += 1; return o.call(this, type, fn, opt); }; }' });
  try {
    for (const [pg, row] of [['potential', '.gr-pp-row'], ['audience', '.gr-au-row'], ['content', '.gr-ct-row']]) {
      await b.open(`${app.base}/#/${pg}`, 1440);
      const listeners0 = await b.eval(`window.__lc`);
      assert.ok(listeners0 > 0, 'listener counter installed');
      const trigger = await b.eval(`(() => { const r = document.querySelector('${row}'); r.focus(); return r.getAttribute('data-focus-id'); })()`);
      for (let round = 0; round < 6; round += 1) {
        await b.key('Enter');
        const a = JSON.parse(await b.eval(`JSON.stringify((() => { const d = document.querySelector('.gr-pp-drawer'); return { role: d?.getAttribute('role'), modal: d?.getAttribute('aria-modal'), label: d?.getAttribute('aria-label'), h2: d?.querySelector('h2')?.textContent, inside: !!document.activeElement.closest('.gr-pp-drawer'), n: document.querySelectorAll('.gr-pp-drawer').length }; })())`));
        assert.deepEqual([a.role, a.modal, a.n, a.inside], ['dialog', 'true', 1, true], `${pg} round ${round}`);
        assert.ok(a.label && a.label === a.h2, `${pg}: dialog labelled by its title`);
        for (let i = 0; i < 15; i += 1) await b.key('Tab');
        assert.equal(await b.eval(`!!document.activeElement.closest('.gr-pp-drawer')`), true, `${pg}: Tab trapped`);
        for (let i = 0; i < 15; i += 1) await b.key('Tab', { shift: true });
        assert.equal(await b.eval(`!!document.activeElement.closest('.gr-pp-drawer')`), true, `${pg}: Shift+Tab trapped`);
        // The three closing paths, in turn.
        if (round % 3 === 0) await b.key('Escape');
        else if (round % 3 === 1) { await b.eval(`document.querySelector('.gr-pp-close').click(); 1`); await sleep(150); }
        else { await b.eval(`document.querySelector('.gr-pp-backdrop').click(); 1`); await sleep(150); }
        assert.equal(await b.eval(`document.querySelectorAll('.gr-pp-drawer').length`), 0, `${pg} round ${round}: closed`);
        assert.equal(await b.eval(`document.activeElement.getAttribute('data-focus-id')`), trigger, `${pg} round ${round}: focus back on the exact trigger`);
      }
      assert.equal(await b.eval(`window.__lc`), listeners0, `${pg}: no document/window listener added by 6 open/close cycles`);
    }
    assert.deepEqual(b.errors, []);
  } finally { await b.close(); await app.close(); }
});

test('post-fix navigation Plus @390: FR/NL/EN, Contenu and Croissance magasin reachable, Plus active, Escape, focus, browser back', { skip, timeout: 120000 }, async () => {
  const app = await serve(sources()); const b = await browser();
  try {
    for (const lang of ['fr', 'nl', 'en']) {
      await b.open(`${app.base}/#/`, 390, 844);
      await b.eval(`localStorage.setItem('nordla_lang', '${lang}'); 1`);
      await b.open(`${app.base}/#/`, 390, 844);
      assert.equal(await b.eval(`document.documentElement.lang`), lang);
      assert.equal(await b.eval(`document.querySelector('.gr-more-btn').classList.contains('active')`), false, `${lang}: Plus inactive on the overview`);
      for (const hash of ['#/content', '#/storeGrowth']) {
        await b.eval(`document.querySelector('.gr-more-btn').click(); 1`); await sleep(150);
        assert.equal(await b.eval(`!!document.activeElement.closest('.gr-more-panel')`), true, `${lang}: focus in the menu`);
        assert.equal(await b.eval(`!![...document.querySelectorAll('.gr-more-panel a')].find((x) => x.getAttribute('href') === '${hash}')`), true, `${lang}: ${hash} in the menu`);
        await b.eval(`[...document.querySelectorAll('.gr-more-panel a')].find((x) => x.getAttribute('href') === '${hash}').click(); 1`);
        for (let i = 0; i < 40 && (await b.eval(`location.hash`)) !== hash; i += 1) await sleep(50);
        for (let i = 0; i < 60 && (await b.eval(`!!document.querySelector('.gr-state-loading')`)); i += 1) await sleep(100);
        await sleep(150);
        const st = JSON.parse(await b.eval(`JSON.stringify({ open: !!document.querySelector('.gr-more-panel'), active: document.querySelector('.gr-more-btn').classList.contains('active'), cur: document.querySelector('.gr-more-btn').getAttribute('aria-current'), title: document.querySelector('.ex-title')?.innerText, sw: document.documentElement.scrollWidth, w: innerWidth })`));
        assert.deepEqual([st.open, st.active, st.cur], [false, true, 'page'], `${lang} ${hash}: menu closed, Plus active`);
        assert.ok(st.title, `${lang} ${hash}: page rendered`);
        assert.ok(st.sw <= st.w, `${lang} ${hash}: no horizontal scroll`);
      }
      // Escape closes and gives focus back to Plus.
      await b.eval(`document.querySelector('.gr-more-btn').focus(); 1`); await b.key('Enter'); await b.key('Escape');
      assert.equal(await b.eval(`!document.querySelector('.gr-more-panel') && document.activeElement.classList.contains('gr-more-btn')`), true, `${lang}: Escape`);
      // Browser back: storeGrowth -> content (Plus still active) -> overview (Plus inactive).
      await b.eval(`history.back(); 1`); await sleep(600);
      assert.equal(await b.eval(`location.hash`), '#/content', `${lang}: back to Contenu`);
      assert.equal(await b.eval(`document.querySelector('.gr-more-btn').classList.contains('active')`), true);
      await b.eval(`history.back(); 1`); await sleep(600);
      assert.equal(await b.eval(`location.hash`), '#/', `${lang}: back to the overview`);
      assert.equal(await b.eval(`document.querySelector('.gr-more-btn').classList.contains('active')`), false, `${lang}: Plus inactive outside its pages`);
    }
    assert.deepEqual(b.errors.filter((e) => !/ResizeObserver/.test(e)), []);
  } finally { await b.close(); await app.close(); }
});

test('mobile bar @320 / 375 / 390 in FR / NL / EN: no item overlaps or spills into its neighbour; no page overflow (Croissance magasin @320)', { skip, timeout: 120000 }, async () => {
  const app = await serve(sources()); const b = await browser();
  try {
    for (const w of [320, 375, 390]) {
      for (const pg of ['', 'storeGrowth']) {
        await b.open(`${app.base}/#/${pg}`, w, 844);
        for (const lang of ['FR', 'NL', 'EN']) {
          const r = JSON.parse(await b.eval(`(async () => {
            const btn = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '${lang}'); if (btn) { btn.click(); await new Promise((s) => setTimeout(s, 300)); }
            const items = [...document.querySelectorAll('.sidebar .nav-item')].filter((e) => e.getBoundingClientRect().width > 0);
            const rs = items.map((e) => e.getBoundingClientRect());
            const spill = items.filter((e) => { const r = e.getBoundingClientRect(); const tw = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode())) { if (!n.textContent.trim()) continue; const g = document.createRange(); g.selectNodeContents(n); for (const q of g.getClientRects()) if (q.left < r.left - 0.5 || q.right > r.right + 0.5) return true; } return false; }).map((e) => e.innerText);
            return JSON.stringify({ n: items.length, overlap: rs.some((r, i) => i && r.left < rs[i - 1].right - 0.5), spill, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth });
          })()`));
          const at = `${pg || 'overview'} @${w} ${lang}`;
          assert.equal(r.n, 6, `${at}: 6 bar items`);
          assert.equal(r.overlap, false, `${at}: items overlap`);
          assert.deepEqual(r.spill, [], `${at}: label spills out of its item`);
          assert.ok(r.sw <= r.cw, `${at}: page overflow ${r.sw} > ${r.cw}`);
        }
      }
    }
  } finally { await b.close(); await app.close(); }
});
