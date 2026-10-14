// NORDLA: correct a sentence of the conversation WHERE IT IS SHOWN (dictation, typed note, saved answer, earlier history), in a REAL browser engine (Chromium-family through the DevTools Protocol; not a physical phone).
// The raw words are never overwritten; the corrected text is the main text; the proposals follow; the microphone stays paused until the owner taps it; the edit field is prefilled, focused and visible at 360, 375, 390 and 430 px, also with a short (keyboard-open) screen.
// Set SOURCING_E2E_SHOTS=<dir> for the screenshots.   npm run sourcing:e2e:revision
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser() ?? (process.env.SOURCING_E2E_BROWSER || null); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const SHOTS = process.env.SOURCING_E2E_SHOTS || null; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TOKEN = 'item-revision-token-0123456789-abcdef'; const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 700)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const dir = mkdtempSync(join(tmpdir(), 'nordla-rev-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => { throw new Error('no network in this test'); }, ecb: async () => ({ date: '2026-10-19', rates: {} }) });
const errs = []; const browser = await new Browser(exe, null, process.getuid?.() === 0 ? ['--no-sandbox'] : []).launch();
browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
const text = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const click = async (t, sel, ms = 450) => { await t.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('missing ${sel.replace(/'/g, '')}'); e.click(); })()`); await sleep(ms); };
const clickText = async (t, scope, label, ms = 450) => { await t.eval(`(() => { const r = [...document.querySelectorAll(${JSON.stringify(scope)})].find((e) => e.innerText.trim().replace(/\\s+/g, ' ').includes(${JSON.stringify(label)})); if (!r) throw new Error('missing ' + ${JSON.stringify(label)}); r.click(); })()`); await sleep(ms); };
const setv = (t, sel, v) => t.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('missing ${sel.replace(/'/g, '')}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const ready = (t) => t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000);
const store = async (t) => JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases') ?? '{}'")); const sonny = async (t) => Object.values(await store(t)).find((c) => c.supplier?.name === 'Sonny');
const noOverflow = async (t, label) => { const r = await t.eval('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })'); ok(r.sw <= r.cw, `${label}: horizontal overflow ${r.sw} > ${r.cw}`); };
let shotN = 0; const shot = async (t, name) => { if (!SHOTS) return; await sleep(250); const r = await browser.send('Page.captureScreenshot', { format: 'png' }, t.sessionId); writeFileSync(join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`), Buffer.from(r.data, 'base64')); };
const seatEdit = (t) => t.eval(`(() => { const ta = document.getElementById('nx-edit-text'); const f = document.getElementById('nx-edit'); if (!ta) return null; const r = ta.getBoundingClientRect(); const b = [...f.querySelectorAll('button')].map((x) => { const q = x.getBoundingClientRect(); return { label: x.innerText.trim(), top: q.top, bottom: q.bottom, h: q.height, w: q.width }; }); const nav = document.querySelector('#tabs').getBoundingClientRect(); return { value: ta.value, focused: document.activeElement === ta, top: r.top, bottom: r.bottom, ih: innerHeight, navTop: nav.top, b, href: location.href }; })()`);

try {
  const t = await browser.tab(`${base}/#t=${TOKEN}`, { width: 390, height: 844 }); await ready(t); await sleep(900);
  // seed a realistic case with the core itself: a dictated sentence Moonshine got wrong, a typed note, and a saved answer (nothing is confirmed)
  await t.eval(`(async () => { const m = await import('/core/case.js'); const T0 = new Date('2026-10-20T08:00:00Z'); const at = (k) => new Date(T0.getTime() + k * 60000);
    let c = m.newCase({ id: 'sonny-rev', name: 'batterie externe', now: T0 }); c = m.dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Sonny' } }, at(0)); c = m.dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Sonny', lang: 'auto' }, at(1));
    c = m.dispatch(c, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'supplier', lang: 'auto', text: 'prix 12$, MOQ 60, modele AB521' }, at(2));
    c = m.dispatch(c, { type: 'CONVERSATION_ITEM', convId: 'conv-1', modality: 'SPEECH', speaker: 'supplier', speakerBy: 'OWNER_DECISION', lang: 'en', text: 'Forty five What', provider: 'moonshine', version: 'tiny' }, at(3));
    c = m.dispatch(c, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'supplier', lang: 'auto', text: 'Fabricant Shenzhen Sonny, FOB Ningbo', answersQuestion: 'manufacturer', questionText: 'Fabricant (nom et adresse)' }, at(4));
    const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases') ?? '{}'); cases[c.id] = c; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); })()`); await sleep(500);
  await t.eval('location.reload()'); await ready(t); await sleep(1200);
  const openNote = async (mode) => { await click(t, '#tabs [data-key="suppliers"]', 600); await clickText(t, '.nx-cardmain', 'Sonny', 700); await click(t, '#tabs [data-key="note"]', 700); if (mode) await click(t, `[data-act="sl-note-mode"][data-key="${mode}"]`, 500); };

  await check('1. THE REAL TEST in the Audio mode: "Forty five What" -> Corriger opens a prefilled, focused field IN PLACE -> "Forty five watts" is shown in the same conversation, the original stays one tap away, "Puissance : 45 W" is proposed to confirm', async () => {
    await openNote('voice'); const first = await text(t); ok(/Forty five What/.test(first), first.slice(0, 300)); const n = await t.eval(`[...document.querySelectorAll('.nx-item')].find((li) => /Forty five What/.test(li.innerText)).querySelector('[data-act="sl-item-edit"]').getBoundingClientRect().height`); ok(n >= 44, `Corriger is ${n}px high`);
    const href0 = await t.eval('location.href'); await t.eval(`[...document.querySelectorAll('.nx-item')].find((li) => /Forty five What/.test(li.innerText)).querySelector('[data-act="sl-item-edit"]').click()`); await sleep(600); const s = await seatEdit(t);
    ok(s && s.value === 'Forty five What' && s.focused, 'prefilled and focused: ' + JSON.stringify(s)); ok(s.top >= 0 && s.bottom <= s.ih && s.b.every((x) => x.bottom <= s.navTop + 1), 'the field and its buttons are visible above the menu: ' + JSON.stringify(s)); ok(s.href === href0 && /Qui parle|Dictée/.test(await text(t)), 'no navigation: same page, same screen'); ok(/Note|Audio/.test(await text(t)) && (await text(t)).includes('Enregistrer') && (await text(t)).includes('Annuler'), 'Enregistrer and Annuler are shown');
    await shot(t, 'correction-ouverte-audio'); await setv(t, '#nx-edit-text', 'Forty five watts'); await click(t, '#nx-edit button[type="submit"]', 800);
    const li = await t.eval(`[...document.querySelectorAll('.nx-item')].find((x) => /Forty five watts/.test(x.querySelector('.nx-itext')?.innerText ?? ''))?.innerText ?? ''`); ok(/Forty five watts/.test(li) && /Corrigé par vous/.test(li), 'the corrected text is shown at once, in place: ' + li); ok(/Voir l'original/.test(li), 'the original is consultable');
    const all = await text(t); ok(/Correction enregistrée/.test(all) && /Puissance/.test(all) && /45 W/.test(all) && /Proposée · à confirmer/.test(all), 'proposal 45 W to confirm: ' + all.slice(0, 500));
    const c = await sonny(t); const it = c.conversations[0].items.find((x) => x.modality === 'SPEECH'); ok(it.derived[0].text === 'Forty five What' && it.segments[0].text === 'Forty five What', 'the raw Moonshine transcription is untouched'); const r = it.revisions[0]; ok(r.by === 'owner' && r.ref === it.id && r.previousText === 'Forty five What' && r.text === 'Forty five watts' && r.source === 'salon-inline' && r.at, JSON.stringify(r));
    const p = c.candidates.filter((k) => k.itemId === it.id && k.key === 'spec.power'); ok(p.length === 1 && p[0].state === 'PROPOSED' && p[0].value.amount === 45, 'one proposal'); ok(!c.ledger.some((e) => e.key === 'spec.power'), 'nothing confirmed'); await noOverflow(t, 'voice pane');
    await clickText(t, '.nx-orig summary', "Voir l'original", 300); await shot(t, 'correction-enregistree-audio'); ok(/Transcription brute \(Moonshine\)/.test(await text(t)) && /« Forty five What »/.test(await text(t)), 'the raw transcription is shown on demand');
  });

  await check('2. ANNULER keeps the text and creates nothing; an identical text creates no empty revision', async () => {
    const before = JSON.stringify((await sonny(t)).conversations); await t.eval(`[...document.querySelectorAll('.nx-item')].find((li) => /Forty five watts/.test(li.innerText)).querySelector('[data-act="sl-item-edit"]').click()`); await sleep(500); const s = await seatEdit(t); ok(s.value === 'Forty five watts', 'the field opens on the CORRECTED text'); await setv(t, '#nx-edit-text', 'junk'); await click(t, '[data-act="sl-item-cancel"]', 500);
    ok(!(await seatEdit(t)), 'the field is closed'); ok(JSON.stringify((await sonny(t)).conversations) === before, 'nothing changed'); ok(/Forty five watts/.test(await text(t)));
    await t.eval(`[...document.querySelectorAll('.nx-item')].find((li) => /Forty five watts/.test(li.innerText)).querySelector('[data-act="sl-item-edit"]').click()`); await sleep(400); await click(t, '#nx-edit button[type="submit"]', 600); ok(JSON.stringify((await sonny(t)).conversations) === before, 'saving the same text changes nothing');
  });

  await check('3. TYPED NOTE: price, currency, MOQ and model are corrected in the sentence; the proposals follow; the original text is kept; confirmed facts are untouched', async () => {
    await click(t, '[data-act="sl-note-mode"][data-key="text"]', 500); const li = `[...document.querySelectorAll('.nx-item')].find((x) => /prix 12/.test(x.innerText))`;
    await t.eval(`${li}.querySelector('[data-act="sl-item-edit"]').click()`); await sleep(500); const s = await seatEdit(t); ok(s.value === 'prix 12$, MOQ 60, modele AB521', s.value);
    await setv(t, '#nx-edit-text', 'prix 15 EUR, MOQ 600, modele AB522'); await click(t, '#nx-edit button[type="submit"]', 800); const txt = await text(t);
    ok(/15/.test(txt) && /600 pièces/.test(txt) && /AB522/.test(txt) && /EUR/.test(txt), 'new proposals shown: ' + txt.slice(0, 700));
    const c = await sonny(t); const it = c.conversations[0].items[0]; ok(it.original === 'prix 12$, MOQ 60, modele AB521', 'the typed original is intact'); ok(c.ledger.length === 0 && !(c.quotes ?? []).length, 'nothing confirmed, no quote'); const live = (k) => c.candidates.filter((x) => x.itemId === it.id && x.key === k && x.state === 'PROPOSED').map((x) => String(x.value));
    ok(live('quote.unitPrice').join() === '15' && live('quote.moq').join() === '600' && live('identifier.model').join() === 'AB522' && live('quote.currency').join() === 'EUR', JSON.stringify([live('quote.unitPrice'), live('quote.moq'), live('identifier.model'), live('quote.currency')]));
  });

  await check('4. SAVED ANSWER (Questions tab): Corriger on the answer, in place; the link to the question survives', async () => {
    await click(t, '#tabs [data-key="suppliers"]', 600); await clickText(t, '.nx-cardmain', 'Sonny', 700); await clickText(t, '.nx-tabs button', 'Questions', 500); const txt = await text(t); ok(/Fabricant Shenzhen Sonny/.test(txt) && /Corriger/.test(txt), txt.slice(0, 400));
    await t.eval(`[...document.querySelectorAll('.nx-ans')].find((x) => /Shenzhen Sonny/.test(x.innerText)).querySelector('[data-act="sl-item-edit"]').click()`); await sleep(500); const s = await seatEdit(t); ok(s && s.value === 'Fabricant Shenzhen Sonny, FOB Ningbo' && s.focused, JSON.stringify(s));
    await setv(t, '#nx-edit-text', 'Fabricant Shenzhen Sonny Electronics, EXW Ningbo'); await click(t, '#nx-edit button[type="submit"]', 800); const after = await text(t); ok(/Sonny Electronics/.test(after) && /Corrigé par vous/.test(after) && /EXW/.test(after), after.slice(0, 600));
    const c = await sonny(t); const it = c.conversations[0].items.find((x) => x.answersQuestion); ok(it.answersQuestion === 'manufacturer' && it.original === 'Fabricant Shenzhen Sonny, FOB Ningbo' && it.revisions.length === 1 && c.questionLog.some((e) => e.kind === 'ANSWERED' && e.itemId === it.id), 'link and original kept');
  });

  await check('5. HISTORY: "Toute la conversation" lists every earlier sentence, each with Corriger; an old one is corrected there', async () => {
    await clickText(t, '.nx-tabs button', 'Aperçu', 500); await clickText(t, '.nx-link', 'Toute la conversation', 700); const txt = await text(t); ok(/Conversation/.test(txt) && /Forty five watts/.test(txt) && /Sonny Electronics/.test(txt), txt.slice(0, 500));
    const n = await t.eval("document.querySelectorAll('.nx-thread [data-act=\"sl-item-edit\"]').length"); ok(n === 3, `every sentence has Corriger (${n}/3)`); await t.eval(`[...document.querySelectorAll('.nx-thread .nx-item')].find((x) => /15 EUR/.test(x.innerText)).querySelector('[data-act="sl-item-edit"]').click()`); await sleep(500);
    await setv(t, '#nx-edit-text', 'prix 15 EUR, MOQ 650, modele AB522'); await click(t, '#nx-edit button[type="submit"]', 800); const after = await text(t); ok(/MOQ 650/.test(after) && /Corrigé par vous/.test(after), after.slice(0, 400));
    const c = await sonny(t); const it = c.conversations[0].items[0]; ok(it.revisions.length === 2 && it.revisions[1].of === it.revisions[0].id && it.original === 'prix 12$, MOQ 60, modele AB521', 'the chain of corrections keeps the original'); await shot(t, 'conversation-complete'); await noOverflow(t, 'thread');
  });

  await check('6. MICROPHONE: it is paused when a correction opens, never restarted by saving or cancelling', async () => {
    await t.eval(`(() => { const v = window.nordlaVoice; window.__mic = { state: 'listening', pause: 0, resume: 0, start: 0 }; Object.defineProperty(v, 'state', { get: () => window.__mic.state, configurable: true }); v.pause = async () => { window.__mic.pause += 1; window.__mic.state = 'paused'; }; v.resume = async () => { window.__mic.resume += 1; }; v.start = async () => { window.__mic.start += 1; }; })()`);
    await t.eval(`document.querySelector('.nx-thread [data-act="sl-item-edit"]').click()`); await sleep(600); let m = await t.eval('window.__mic'); ok(m.pause === 1 && m.state === 'paused', JSON.stringify(m)); ok(/Micro en pause pendant la correction/.test(await text(t)), 'the owner is told'); await click(t, '[data-act="sl-item-cancel"]', 400);
    await t.eval(`document.querySelector('.nx-thread [data-act="sl-item-edit"]').click()`); await sleep(400); await setv(t, '#nx-edit-text', 'MOQ 700, ' + Date.now()); await click(t, '#nx-edit button[type="submit"]', 700); m = await t.eval('window.__mic'); ok(m.resume === 0 && m.start === 0, 'no automatic restart: ' + JSON.stringify(m));
  });

  const W_LIST = [360, 375, 390, 430];
  await check('7. WIDTHS 360 / 375 / 390 / 430 px (also with a short, keyboard-open screen): the field is prefilled, focused and visible with Enregistrer and Annuler above the menu; every Corriger is >= 44 px; no horizontal overflow', async () => {
    for (const W of W_LIST) for (const H of [812, 430]) {
      await t.resize(W, H); await sleep(400); await click(t, '#tabs [data-key="suppliers"]', 500); await clickText(t, '.nx-cardmain', 'Sonny', 700); await clickText(t, '.nx-link', 'Toute la conversation', 700); await noOverflow(t, `thread@${W}x${H}`);
      const fix = await t.eval(`[...document.querySelectorAll('[data-act="sl-item-edit"]')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.height), Math.round(r.width)]; })`); ok(fix.length === 3 && fix.every(([h, w]) => h >= 44 && w >= 44), `Corriger targets @${W}: ${JSON.stringify(fix)}`);
      await t.eval(`document.querySelectorAll('[data-act="sl-item-edit"]')[1].click()`); await sleep(700); const s = await seatEdit(t); ok(s && s.focused && s.value.length > 3, `focused @${W}x${H}`); ok(s.top >= 0 && s.bottom <= s.ih, `field in view @${W}x${H}: ${Math.round(s.top)}-${Math.round(s.bottom)} of ${s.ih}`); ok(s.b.length === 2 && s.b.every((x) => x.h >= 44 && x.w >= 44 && x.top >= 0 && x.bottom <= s.navTop + 1), `buttons visible above the menu @${W}x${H}: ${JSON.stringify(s.b)} nav ${s.navTop}`); ok(s.b[0].label === 'Enregistrer' && s.b[1].label === 'Annuler', 'labels');
      await noOverflow(t, `edit@${W}x${H}`); if (W === 390 && H === 812) await shot(t, 'correction-390'); await click(t, '[data-act="sl-item-cancel"]', 300);
    }
    await t.resize(390, 844);
  });

  await check('8. no uncaught error in the whole session', async () => { ok(errs.length === 0, errs.slice(0, 3).join(' | ')); });
} finally {
  await browser.close(); await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter((x) => !x).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
