// NORDLA price + currency + fiche tabs in a REAL browser engine (Chromium-family through the DevTools Protocol; not a physical phone).
// A price is never shown without saying what is confirmed: "12 USD" only when the amount AND the currency are confirmed; "$" is never read as USD by itself; two suppliers in different or unconfirmed currencies are never ranked on their unit price.
// The five tabs of the supplier sheet are distinct, at least 44 px high, never overlap and never make the page scroll sideways at 360, 375, 390 and 430 px.   Set SOURCING_E2E_SHOTS=<dir> for the screenshots.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser() ?? (process.env.SOURCING_E2E_BROWSER || null); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const SHOTS = process.env.SOURCING_E2E_SHOTS || null; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TOKEN = 'price-currency-token-0123456789-abcdef'; const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 600)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const SONNY = 'prix 12$, MOQ 60, puissance 10000mAp. variante 4 couleur blanc, blue, rouge et noir. puissance 45W. nom de Modele AB521';
const dir = mkdtempSync(join(tmpdir(), 'nordla-price-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => { throw new Error('no network in this test'); }, ecb: async () => ({ date: '2026-10-19', rates: {} }) });
const errs = []; const browser = await new Browser(exe, null, process.getuid?.() === 0 ? ['--no-sandbox'] : []).launch();
browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
const text = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const click = async (t, sel, ms = 450) => { await t.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('missing ${sel.replace(/'/g, '')}'); e.click(); })()`); await sleep(ms); };
const clickText = async (t, scope, label, ms = 450) => { await t.eval(`(() => { const r = [...document.querySelectorAll(${JSON.stringify(scope)})].find((e) => e.innerText.trim().replace(/\\s+/g, ' ').includes(${JSON.stringify(label)})); if (!r) throw new Error('missing ' + ${JSON.stringify(label)}); r.click(); })()`); await sleep(ms); };
const setv = (t, sel, v) => t.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('missing ${sel.replace(/'/g, '')}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const ready = (t) => t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000);
const cases = async (t) => JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases') ?? '{}'"));
const byName = async (t, n) => Object.values(await cases(t)).find((c) => c.supplier?.name === n && !/\(/.test(c.identity?.workingName ?? ''));
const strip = (t) => text(t, '.nx-strip'); const priceCell = (t) => t.eval("[...document.querySelectorAll('.nx-strip > div')].find((d) => /^Prix/.test(d.innerText))?.innerText.replace(/\\s+/g, ' ').trim() ?? ''");
let shotN = 0; const shot = async (t, name) => { if (!SHOTS) return; await sleep(250); const r = await browser.send('Page.captureScreenshot', { format: 'png' }, t.sessionId); writeFileSync(join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`), Buffer.from(r.data, 'base64')); };
const newSupplier = async (t, name, product, note) => { await click(t, '#tabs [data-key="home"]', 500); await click(t, '[data-act="sl-nav"][data-key="new"]', 500); await setv(t, 'input[name="supplier"]', name); await setv(t, 'input[name="product"]', product); await click(t, 'form[data-form="sl-new"] button[type="submit"]', 700); await setv(t, '#nx-text', note); await click(t, 'form#nx-note button.nx-btn', 800); };

try {
  const t = await browser.tab(`${base}/#t=${TOKEN}`, { width: 390, height: 844 }); await ready(t); await sleep(900);

  await check('1. SONNY: amount 12 confirmed, currency read from "$" only PROPOSED -> "12 — devise à confirmer", never "12 USD", never a confirmed price with a guessed currency', async () => {
    await newSupplier(t, 'Sonny', 'batterie externe', SONNY); await clickText(t, 'button.sl-btn', 'Confirmer les', 800);
    const c = await byName(t, 'Sonny'); ok(!c.ledger.some((e) => e.key === 'quote.currency') && c.candidates.some((k) => k.key === 'quote.currency' && k.state === 'PROPOSED' && k.value === 'USD'), 'the currency is a proposal, not a fact'); ok(!c.quotes.at(-1).currency, 'the quote holds no currency');
    await click(t, '.nx-iconbtn', 700); const cell = await priceCell(t); ok(/12/.test(cell) && /devise à confirmer/.test(cell) && /USD proposée/.test(cell) && !/12 USD/.test(cell), cell); const all = await text(t); ok(!/12 USD/.test(all) && !/confirmé.*12 USD/i.test(all), 'no "12 USD" anywhere on the sheet');
    await shot(t, 'sonny-devise-a-confirmer');
  });

  await check('2. HOME / SUPPLIERS / VISITS carry the same wording (the card never shows a bare 12)', async () => {
    await click(t, '#tabs [data-key="suppliers"]', 600); const card = await text(t, '#nx-list'); ok(/12\s*— devise à confirmer/.test(card.replace(/\s+/g, ' ')) && !/12 USD/.test(card), card.slice(0, 300));
    await click(t, '#tabs [data-key="home"]', 600); const home = (await text(t)).replace(/\s+/g, ' '); ok(!/\b12 USD\b/.test(home), 'home'); await click(t, '#tabs [data-key="visits"]', 600); ok(!/\b12 USD\b/.test(await text(t)), 'visits');
  });

  await check('3. A SECOND supplier in EUR (confirmed) and the comparison: the unit prices are NOT ranked when one currency is unconfirmed', async () => {
    await newSupplier(t, 'Lina', 'lampe', 'price 9 EUR, MOQ 100'); const c0 = await byName(t, 'Lina'); const cur = c0.candidates.find((k) => k.key === 'quote.currency'); ok(cur?.value === 'EUR' && cur.state === 'PROPOSED', 'EUR is proposed first');
    await clickText(t, 'button.sl-btn', 'Confirmer les', 800); let c = await byName(t, 'Lina'); if (!c.ledger.some((e) => e.key === 'quote.currency')) { await t.eval(`[...document.querySelectorAll('.nx-prop')].find((e) => /Devise/.test(e.innerText))?.querySelector('[data-act="sl-confirm"]')?.click()`); await sleep(600); c = await byName(t, 'Lina'); }
    ok(c.ledger.some((e) => e.key === 'quote.currency' && e.value === 'EUR') && c.quotes.at(-1).currency === 'EUR', 'EUR confirmed by the owner');
    await click(t, '.nx-iconbtn', 700); const cell = await priceCell(t); ok(/9 EUR/.test(cell) && !/à confirmer/.test(cell), cell);
    await click(t, '#tabs [data-key="suppliers"]', 600); const card = (await text(t, '#nx-list')).replace(/\s+/g, ' '); ok(/9 EUR/.test(card) && /12 — devise à confirmer/.test(card), card.slice(0, 400));
    await t.eval("document.querySelectorAll('.nx-pick')[0].click()"); await sleep(300); await t.eval("document.querySelectorAll('.nx-pick')[1].click()"); await sleep(350); await clickText(t, '.nx-bar2 button', 'Comparer', 900);
    const cmp = (await text(t)).replace(/\s+/g, ' '); ok(/devise à confirmer/.test(cmp), 'the comparison says the currency is to confirm: ' + cmp.slice(0, 500)); ok(!/Qui est le moins cher \?\s*(Sonny|Lina)\s*:/.test(cmp), 'no cheapest winner between a confirmed and an unconfirmed currency'); await shot(t, 'comparaison-devises');
  });

  await check('4. CONFIRM the currency: "12 USD" appears only now; CORRECT it: "12 EUR" follows, the supplier\'s words are kept', async () => {
    await click(t, '#tabs [data-key="suppliers"]', 600); await clickText(t, '.nx-cardmain', 'Sonny', 700); await clickText(t, '.nx-tabs button', 'Infos', 500);
    await t.eval(`[...document.querySelectorAll('.nx-prop')].find((e) => /Devise/.test(e.innerText)).querySelector('[data-act="sl-confirm"]').click()`); await sleep(700);
    let c = await byName(t, 'Sonny'); ok(c.ledger.some((e) => e.key === 'quote.currency' && e.value === 'USD' && e.status === 'SUPPLIER_CLAIM') && c.quotes.at(-1).currency === 'USD', 'USD is now a fact (a supplier claim, not verified)');
    await clickText(t, '.nx-tabs button', 'Aperçu', 500); let cell = await priceCell(t); ok(/12 USD/.test(cell) && !/à confirmer/.test(cell), cell); await shot(t, 'sonny-devise-confirmee');
    await clickText(t, '.nx-tabs button', 'Infos', 500); await click(t, '[data-act="sl-fact-edit"][data-key="CURRENCY"]', 400); await setv(t, 'form[data-id="CURRENCY"] input[name="value"]', 'EUR'); await click(t, 'form[data-id="CURRENCY"] button[type="submit"]', 800);
    c = await byName(t, 'Sonny'); ok(c.quotes.at(-1).currency === 'EUR', 'the quote now holds EUR'); ok(c.ledger.some((e) => e.key === 'quote.currency' && e.value === 'USD') && c.ledger.some((e) => e.key === 'quote.currency' && e.value === 'EUR' && e.status === 'USER_PROVIDED'), 'the earlier USD entry stays in the ledger; EUR is attributed to the owner');
    await clickText(t, '.nx-tabs button', 'Aperçu', 500); cell = await priceCell(t); ok(/12 EUR/.test(cell) && !/12 USD/.test(cell), cell);
  });

  const W_LIST = [360, 375, 390, 430];
  await check('5. TABS at 360, 375, 390 and 430 px: five distinct tabs, each >= 44 px high, no overlap, no clipped label, no sideways scroll of the page, the active tab visible; the bottom menu is unchanged', async () => {
    for (const W of W_LIST) {
      await t.resize(W, 812); await sleep(400); await click(t, '#tabs [data-key="suppliers"]', 500); await clickText(t, '.nx-cardmain', 'Sonny', 700);
      for (const tab of ['Aperçu', 'Infos', 'Questions', 'Chiffres', 'Plus']) {
        await clickText(t, '.nx-tabs button', tab, 450);
        const g = await t.eval(`(() => { const row = document.querySelector('.nx-tabs'); const rr = row.getBoundingClientRect(); const bs = [...row.querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect(); return { label: b.innerText.trim(), l: r.left, r: r.right, h: r.height, w: r.width, clipped: b.scrollWidth > b.clientWidth + 1, sel: b.getAttribute('aria-selected') === 'true' }; }); return { rl: rr.left, rr: rr.right, bs, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, nav: [...document.querySelectorAll('#tabs button')].map((b) => b.innerText.trim()) }; })()`);
        ok(g.bs.length === 5, `5 tabs @${W}`); ok(g.sw <= g.cw, `page overflow ${g.sw}>${g.cw} @${W}/${tab}`); ok(g.bs.every((b) => b.h >= 44 && b.w >= 44), `touch target @${W}: ${JSON.stringify(g.bs.map((b) => [b.label, Math.round(b.h), Math.round(b.w)]))}`); ok(!g.bs.some((b) => b.clipped), `clipped label @${W}`);
        for (let i = 1; i < g.bs.length; i++) ok(g.bs[i].l >= g.bs[i - 1].r - 0.5, `tabs ${g.bs[i - 1].label} / ${g.bs[i].label} overlap @${W}: ${g.bs[i - 1].r} > ${g.bs[i].l}`);
        const sel = g.bs.filter((b) => b.sel); ok(sel.length === 1 && /^Aperçu|^Infos|^Questions|^Chiffres|^Plus/.test(sel[0].label) && sel[0].label.startsWith(tab), `one active tab @${W}`); ok(sel[0].l >= g.rl - 1 && sel[0].r <= g.rr + 1, `the active tab "${tab}" is visible @${W}: ${Math.round(sel[0].l)}-${Math.round(sel[0].r)} in ${Math.round(g.rl)}-${Math.round(g.rr)}`);
        ok(JSON.stringify(g.nav) === JSON.stringify(['Accueil', 'Fournisseurs', 'Noter', 'Visites', 'Plus']), `bottom menu unchanged @${W}: ${g.nav}`);
      }
      if (W === 390) { await clickText(t, '.nx-tabs button', 'Questions', 500); await t.eval('window.scrollTo(0, 0)'); await sleep(200); await shot(t, 'onglets-390'); }
    }
    await t.resize(390, 844);
  });

  await check('6. no uncaught error in the whole session', async () => { ok(errs.length === 0, errs.slice(0, 3).join(' | ')); });
} finally {
  await browser.close(); await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter((x) => !x).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
