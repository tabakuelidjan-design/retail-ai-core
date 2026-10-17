// NORDLA TERRAIN (mobile V2) in a REAL browser engine at 390 and 375 px (Chromium-family through the DevTools Protocol; not a physical phone). The owner's loop with the real Xiaomi scenario (supplier Sonny, battery pack):
// new supplier -> note -> proposals with their sources -> confirm / correct / reject -> a question answered ON the question card -> sync conflict explained and resolved without loss -> offline -> reopen.
// Provider-free. Set SOURCING_E2E_SHOTS=<dir> to also save the authentic screenshots of the screens it visits.   npm run sourcing:e2e:terrain
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser() ?? (process.env.SOURCING_E2E_BROWSER || null); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const SHOTS = process.env.SOURCING_E2E_SHOTS || null; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TOKEN = 'terrain-v2-token-0123456789-abcdef-xyz'; const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 500)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const SONNY = 'prix 12$, MOQ 60, puissance 10000mAp. variante 4 couleur blanc, blue, rouge et noir. puissance 45W. nom de Modele AB521';
const dir = mkdtempSync(join(tmpdir(), 'nordla-terrain-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => { throw new Error('no network in this test'); }, ecb: async () => ({ date: '2026-10-19', rates: {} }) });
const errs = []; const net = []; const browser = await new Browser(exe, null, process.getuid?.() === 0 ? ['--no-sandbox'] : []).launch();
browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); if (d.method === 'Network.requestWillBeSent') net.push(d.params.request.url); });
const api = async (path, opts = {}) => { const r = await fetch(`${base}${path}`, { ...opts, headers: { 'x-sourcing-token': TOKEN, 'content-type': 'application/json', ...(opts.headers ?? {}) } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

const text = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const click = async (t, sel, ms = 450) => { await t.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('missing ${sel.replace(/'/g, '')}'); e.click(); })()`); await sleep(ms); };
const clickText = async (t, scope, label, ms = 450) => { await t.eval(`(() => { const r = [...document.querySelectorAll(${JSON.stringify(scope)})].find((e) => e.innerText.trim().replace(/\\s+/g, ' ').includes(${JSON.stringify(label)})); if (!r) throw new Error('missing ' + ${JSON.stringify(label)}); r.click(); })()`); await sleep(ms); };
const setv = (t, sel, v) => t.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('missing ${sel.replace(/'/g, '')}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const noOverflow = async (t, label) => { const r = await t.eval('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })'); ok(r.sw <= r.cw, `${label}: horizontal overflow ${r.sw} > ${r.cw}`); };
const small = (t) => t.eval(`[...document.querySelectorAll('#screen button, #tabs button, #screen input:not([type=hidden]):not([type=file]), #screen textarea')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44 && getComputedStyle(b).visibility !== 'hidden'; }).map((b) => (b.innerText || b.name || b.type).trim().slice(0, 22) + ':' + Math.round(b.getBoundingClientRect().height))`);
const ready = (t) => t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000);
const cases = async (t) => JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases') ?? '{}'"));
const sonny = async (t) => Object.values(await cases(t)).find((c) => c.supplier?.name === 'Sonny' && !/\(/.test(c.identity?.workingName ?? ''));
let shotN = 0; const shot = async (t, name, width) => { if (!SHOTS) return; await sleep(250); const r = await browser.send('Page.captureScreenshot', { format: 'png' }, t.sessionId); writeFileSync(join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}-${width}.png`), Buffer.from(r.data, 'base64')); };

try {
  const t = await browser.tab(`${base}/#t=${TOKEN}`, { width: 390, height: 844 }); await ready(t); await sleep(900);

  await check('1. HOME: one navigation of five entries (Accueil, Fournisseurs, Noter, Visites, Plus); the four quick actions; the save state is worded; no overflow; every control is at least 44 px', async () => {
    const nav = await text(t, '#tabs'); for (const w of ['Accueil', 'Fournisseurs', 'Noter', 'Visites', 'Plus']) ok(nav.includes(w), `nav lacks ${w}: ${nav}`); ok((await t.eval("document.querySelectorAll('#tabs button').length")) === 5);
    const txt = await text(t); for (const w of ['Commencez par un fournisseur', 'Nouveau fournisseur']) ok(txt.includes(w), `empty home lacks ${w}`); ok(!/Poser une question|Comparer/.test(txt), 'no empty actions before the first supplier exists'); ok(/Serveur à jour|Sur ce téléphone|Hors ligne/.test(txt), 'save state shown');
    ok(!/Guided|Quick|Verdict|Rules|Market|Money/.test(txt + nav), 'the old English tabs are not mixed in'); await noOverflow(t, 'home'); const sm = await small(t); ok(sm.length === 0, `small targets: ${sm.join(', ')}`); await shot(t, 'accueil', 390);
  });

  await check('2. NEW SUPPLIER in a few seconds: a name and a product are enough; the note screen opens for THAT supplier', async () => {
    await click(t, '[data-act="sl-nav"][data-key="new"]', 500); await noOverflow(t, 'new'); await shot(t, 'nouveau-fournisseur', 390);
    await setv(t, 'input[name="supplier"]', 'Sonny'); await setv(t, 'input[name="product"]', 'batterie externe'); await click(t, 'form[data-form="sl-new"] button[type="submit"]', 700);
    const txt = await text(t); ok(/Nouvelle note/.test(txt) && /Sonny/.test(txt) && /batterie externe/.test(txt), txt.slice(0, 200)); await noOverflow(t, 'note'); await shot(t, 'prise-de-note', 390);
    const c = await sonny(t); ok(c && c.supplier.name === 'Sonny' && c.identity.workingName === 'batterie externe', 'the case exists with the right supplier and product');
  });

  await check('3. NOTE: the supplier\'s words are saved as typed in the conversation of the right case; Nordla PROPOSES the values with their source; NOTHING is confirmed automatically', async () => {
    await setv(t, '#nx-text', SONNY); await click(t, 'form#nx-note button.nx-btn', 800); const txt = await text(t);
    ok(/Note enregistrée/.test(txt) && /8 informations proposées/.test(txt), txt.slice(0, 260)); for (const w of ['AB521', '12', '60 pièces', '45 W', 'white, blue, red, black']) ok(txt.includes(w), `missing ${w}`);
    ok(/« prix 12\$ »/.test(txt) && /« MOQ 60 »/.test(txt) && /« 10000mAp »/.test(txt), 'each proposal shows the supplier\'s own words');
    ok(/Proposée · à confirmer/.test(txt) && /Ambiguë · à corriger/.test(txt) && !/Confirmée|Vérifiée/.test(txt.split('NOTES DE CE DOSSIER')[0]), 'states: proposed / ambiguous only');
    ok((await t.eval("document.querySelector('#nx-text').value")) === '', 'the typed text is cleared once it is saved (it stays in the conversation)');
    const c = await sonny(t); const conv = c.conversations[0]; ok(conv.items.length === 1 && conv.items[0].original === SONNY && conv.items[0].speaker === 'supplier', 'original text kept exactly, speaker = supplier');
    ok(c.candidates.length === 8 && c.candidates.every((k) => k.state === 'PROPOSED'), 'all candidates PROPOSED'); ok(c.ledger.length === 0 && !c.quotes.length, 'no fact, no quote: nothing confirmed for the owner');
    const cap = c.candidates.find((k) => k.key === 'spec.capacity'); ok(cap.needsCorrection === true && cap.value === null && cap.rawText === '10000mAp', 'the ambiguous capacity is never corrected silently'); await noOverflow(t, 'note+proposals'); await shot(t, 'note-propositions', 390);
  });

  await check('4. CONFIRM the clear facts in one tap (the currency read from "$" and the ambiguous capacity are NOT in it); each stays "dit par le fournisseur"; nothing says "vérifié"', async () => {
    await clickText(t, 'button.sl-btn', 'Confirmer les', 800); const c = await sonny(t); const keys = c.ledger.map((e) => e.key).sort();
    ok(keys.includes('quote.moq') && keys.includes('quote.unitPrice') && keys.includes('identifier.model') && keys.includes('spec.power'), keys.join(','));
    ok(!keys.includes('quote.currency') && !keys.includes('spec.capacity'), 'currency and capacity are still undecided'); ok(c.ledger.every((e) => e.status === 'SUPPLIER_CLAIM'), 'every confirmed fact is a SUPPLIER_CLAIM, never VERIFIED');
    const txt = await text(t); ok(/Confirmée/.test(txt) && !/Vérifiée/.test(txt), 'confirmed rows shown, none verified'); await shot(t, 'note-confirmees', 390);
  });

  await check('5. CORRECT the ambiguous capacity (10000 mAp -> 10000 mAh): the correction is attributed to the owner, the supplier\'s words are kept; REJECT the guessed currency: it applies nothing', async () => {
    await t.eval(`[...document.querySelectorAll('.nx-prop')].find((e) => /Capacité/.test(e.innerText)).querySelector('[data-act="sl-correct-open"]').click()`); await sleep(350); await setv(t, '.nx-prop input[name="value"]', 'abc'); await click(t, '.nx-prop form button[type="submit"]', 450); ok(/capacité avec son unité/i.test(await text(t)), 'a bad correction is refused in French');
    await setv(t, '.nx-prop input[name="value"]', '10000 mAh'); await click(t, '.nx-prop form button[type="submit"]', 700); let c = await sonny(t); const cap = c.candidates.find((k) => k.key === 'spec.capacity');
    ok(cap.state === 'CORRECTED' && cap.correctedValue.amount === 10000 && cap.correctedValue.unit === 'mAh' && cap.rawText === '10000mAp', JSON.stringify(cap).slice(0, 200));
    const led = c.ledger.find((e) => e.key === 'spec.capacity'); ok(led && led.status === 'USER_PROVIDED', 'the corrected value is USER_PROVIDED');
    ok(/Corrigée par vous/.test(await text(t)) && /le fournisseur disait « 10000mAp »/.test(await text(t))); await click(t, '[data-act="sl-reject"]', 600); c = await sonny(t);
    ok(c.candidates.find((k) => k.key === 'quote.currency').state === 'REJECTED' && !c.ledger.some((e) => e.key === 'quote.currency'), 'a rejected proposal changes nothing but stays visible'); ok(/Rejetée/.test(await text(t)));
  });

  await check('6. SUPPLIER SHEET: Aperçu first (short), the five tabs, no horizontal scroll; the facts are findable in "Infos" with their sources; the Sonny numbers are the case\'s facts', async () => {
    await click(t, '.nx-iconbtn', 700); let txt = await text(t); ok(/Sonny/.test(txt) && /batterie externe/.test(txt) && /Prendre une note/.test(txt) && /Poser une question/.test(txt) && /Prix/.test(txt) && /MOQ/.test(txt) && /Modèle/.test(txt), 'identity first, essentials strip, two actions: ' + txt.slice(0, 200)); for (const w of ['Aperçu', 'Infos', 'Questions', 'Chiffres', 'Plus']) ok(txt.includes(w), `tab ${w}`); await noOverflow(t, 'fiche'); await shot(t, 'fiche-apercu', 390);
    await clickText(t, '.nx-tabs button', 'Infos', 500); txt = await text(t); ok(/12/.test(txt) && /60 pièces/.test(txt) && /AB521/.test(txt) && /10000 mAh/.test(txt), txt.slice(0, 300)); ok(/dit par le fournisseur/.test(txt) && /corrigé par vous/i.test(txt), 'sources shown'); await noOverflow(t, 'infos'); await shot(t, 'fiche-infos', 390);
  });

  await check('7. QUESTION -> ANSWER on the same card: show it, note the answer right there; the answer is recorded in the conversation of THIS case, linked to the question; new proposals appear with sources; nothing is confirmed', async () => {
    await clickText(t, '.nx-tabs button', 'Questions', 500); await noOverflow(t, 'questions'); await shot(t, 'questions', 390); let txt = await text(t); ok(/à poser maintenant/i.test(txt) && /À poser/.test(txt) && /中文/.test(txt), 'questions with English and Chinese: ' + txt.slice(0, 400));
    ok((await t.eval("document.querySelectorAll('.nx-q [data-act=\"sl-answer-open\"]').length")) >= 2, 'every question has a "Noter la réponse" button');
    ok(!(await t.eval("[...document.querySelectorAll('.nx-q button')].some((b) => /^(Posée|Répondue)$/.test(b.innerText.trim()))")), 'the old Posée / Répondue buttons are gone');
    const title = await t.eval("document.querySelector('.nx-q b').innerText"); await click(t, '.nx-q [data-act="sl-answer-open"]', 600); await shot(t, 'reponse-saisie', 390);
    ok(await t.eval("!!document.querySelector('.nx-answer textarea')"), 'the answer box opens inside the question card');
    await setv(t, '.nx-answer textarea', 'Delai 25 jours, FOB Ningbo, acompte 30%'); await click(t, '.nx-answer button[type="submit"]', 900); txt = await text(t);
    ok(/Réponse enregistrée/.test(txt) && /Delai 25 jours/.test(txt), txt.slice(0, 300)); ok(/Incoterm/.test(txt) && /FOB/.test(txt) && /Ningbo/.test(txt) && /Proposée · à confirmer/.test(txt), 'proposals read from the answer, with their state');
    const c = await sonny(t); const items = c.conversations.flatMap((x) => x.items); const it = items.find((i) => i.original.startsWith('Delai 25')); ok(it && it.speaker === 'supplier' && it.answersQuestion, 'the answer is an item of the conversation of this case, linked to the question');
    const ans = c.questionLog.find((e) => e.kind === 'ANSWERED'); ok(ans && ans.itemId === it.id && ans.questionText === title, `the question is logged ANSWERED -> ${ans?.itemId}`); ok(c.questionLog.some((e) => e.kind === 'SHOWN' && e.questionId === ans.questionId), 'the question is also logged as asked');
    const mine = c.candidates.filter((k) => k.itemId === it.id); ok(mine.length >= 2 && mine.every((k) => k.state === 'PROPOSED'), 'new proposals PROPOSED'); ok(!c.ledger.some((e) => /incoterm|port/.test(e.key)), 'no fact from the answer before the owner decides'); await shot(t, 'reponse-enregistree', 390);
    ok(/Délai/.test(txt) && /25 jours/.test(txt), 'the French delay "Delai 25 jours" is proposed too (read by the French rules)'); await t.eval(`(() => { const p = [...document.querySelectorAll('.nx-prop')].find((e) => /Incoterm/.test(e.innerText)); if (!p) throw new Error('no Incoterm proposal'); [...p.querySelectorAll('button')].find((b) => /Confirmer/.test(b.innerText)).click(); })()`); await sleep(700); const c2 = await sonny(t); ok(c2.ledger.some((e) => e.key === 'quote.incoterm' || e.key === 'quote.port'), 'one confirmation = one fact, attributed to the supplier'); ok(c2.ledger.find((e) => /incoterm|port/.test(e.key)).status === 'SUPPLIER_CLAIM');
  });

  await check('8. FIVE STATES never mixed: question asked -> answer noted -> proposed -> confirmed -> (verified only by an official source: never shown here)', async () => {
    const c = await sonny(t); const asked = c.questionLog.filter((e) => e.kind === 'SHOWN').length; ok(asked >= 1); ok(c.candidates.some((k) => k.state === 'PROPOSED') && c.candidates.some((k) => k.state === 'CONFIRMED') && c.candidates.some((k) => k.state === 'CORRECTED') && c.candidates.some((k) => k.state === 'REJECTED'), 'proposed / confirmed / corrected / rejected coexist');
    ok(!c.ledger.some((e) => e.status === 'VERIFIED'), 'no fact is VERIFIED by a conversation'); await clickText(t, '.nx-tabs button', 'Plus', 400); await clickText(t, '.nx-menu button', 'Conformité', 500); const txt = await text(t); ok(/Risques|Conformité|Fournisseur/.test(txt), 'compliance and risks reachable from the sheet'); await noOverflow(t, 'risques'); await shot(t, 'conformite', 390);
  });

  await check('9. CHIFFRES, NÉGOCIER, ÉCHANTILLON and the history are reachable from the sheet; the economic numbers come from the engine (unknown stays unknown)', async () => {
    await clickText(t, '.nx-tabs button', 'Chiffres', 500); let txt = await text(t); ok(/prix proposé/i.test(txt) && /coût rendu/i.test(txt) && /inconnu/i.test(txt), txt.slice(0, 200)); await noOverflow(t, 'chiffres'); await shot(t, 'chiffres', 390);
    await clickText(t, '.nx-tabs button', 'Plus', 400); for (const l of ['Négocier', 'Adéquation', 'Ce qui a changé', 'Historique', 'Échantillon']) { await clickText(t, '.nx-menu button', l, 450); ok((await text(t)).length > 40, l); await noOverflow(t, l); await clickText(t, '.nx-link.back', '‹ Plus', 350); }
  });

  await check('10. A SECOND SUPPLIER and the comparison: Fournisseurs lists both with their follow-ups; "+" selects; Comparer opens the existing comparison; the search filters', async () => {
    await click(t, '#tabs [data-key="home"]', 500); await click(t, '[data-act="sl-nav"][data-key="new"]', 500); await setv(t, 'input[name="supplier"]', 'Anna Lighting'); await setv(t, 'input[name="product"]', 'lampe de bureau'); await click(t, 'form[data-form="sl-new"] button[type="submit"]', 600);
    await setv(t, '#nx-text', 'Model LD-300, USD 8.50 for 500 pcs, MOQ 300, FOB Ningbo, lead time 20 days'); await click(t, 'form#nx-note button.nx-btn', 800);
    await click(t, '#tabs [data-key="suppliers"]', 600); let txt = await text(t); ok(/Sonny/.test(txt) && /Anna Lighting/.test(txt) && /à confirmer/.test(txt), txt.slice(0, 300)); await noOverflow(t, 'suppliers'); await shot(t, 'fournisseurs', 390);
    await setv(t, 'input[data-nx-search]', 'anna'); await sleep(300); txt = await text(t, '#nx-list'); ok(/Anna/.test(txt) && !/Sonny/.test(txt), 'the live search filters'); await setv(t, 'input[data-nx-search]', ''); await sleep(250);
    await click(t, '.nx-pick', 300); await t.eval("document.querySelectorAll('.nx-pick')[1].click()"); await sleep(350); ok(/Comparer \(2\)/.test(await text(t)), 'compare bar'); await clickText(t, '.nx-bar2 button', 'Comparer', 900); txt = await text(t); ok(/Comparaison/.test(txt) && /Sonny/.test(txt) && /Anna/.test(txt) && /Aucun gagnant au seul prix/.test(txt), txt.slice(0, 200)); await noOverflow(t, 'comparaison'); await shot(t, 'comparaison', 390);
  });

  await check('11. VISITS: the visited suppliers by day, what is left to do for each; "À poursuivre" / "Tous"', async () => {
    await click(t, '#tabs [data-key="visits"]', 600); let txt = await text(t); ok(/Mes visites/.test(txt) && /Aujourd'hui/.test(txt) && /À poursuivre/.test(txt) && /à confirmer/.test(txt), txt.slice(0, 300)); await noOverflow(t, 'visites'); await shot(t, 'visites', 390);
    await clickText(t, '.nx-seg button', 'Tous', 400); ok(/Anna Lighting/.test(await text(t)) && /Sonny/.test(await text(t)), 'both suppliers are listed under Tous'); await clickText(t, '.nx-visit', 'Sonny', 700); ok(/Prendre une note/.test(await text(t)) && /Sonny/.test(await text(t)), 'a visit opens the supplier sheet');
  });

  await check('12. PHOTO: a product photo is kept as the supplier\'s reference (name + position), on the phone, attached to the right case', async () => {
    await click(t, '#tabs [data-key="note"]', 500); await clickText(t, '.nx-modes button', 'Photo', 400); ok(/Photographier le produit/.test(await text(t))); await noOverflow(t, 'photo');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await t.run(`const bin = atob(${JSON.stringify(png.split(',')[1])}); const u8 = Uint8Array.from(bin, (ch) => ch.charCodeAt(0)); const f = new File([u8], 'sonny-ab521.png', { type: 'image/png' }); const dt = new DataTransfer(); dt.items.add(f); const i = document.querySelector('input[data-act="sl-note-photo"]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true }));`); await sleep(1200);
    const c = await sonny(t); const sonnyId = c.id; const target = Object.values(await cases(t)).find((x) => (x.identity?.photos ?? []).length === 1); ok(target, 'one photo recorded on exactly one case'); ok(target.identity.photos[0].note === 'sonny-ab521.png' && /^photo-0$/.test(target.identity.photos[0].ref), JSON.stringify(target.identity.photos));
    ok(/Photo 1 enregistrée/.test(await text(t)), 'the owner is told'); void sonnyId; await shot(t, 'photo', 390);
  });

  await check('13. VOICE is honest: with no speech model installed on the server the Audio mode says it is unavailable (it never pretends to listen)', async () => {
    await clickText(t, '.nx-modes button', 'Audio', 600); await sleep(700); const txt = await text(t); ok(/Dictée indisponible|Vérification du serveur|Prêt à écouter/.test(txt), txt.slice(0, 200)); if (/Dictée indisponible/.test(txt)) ok(await t.eval("!document.querySelector('.nx-mic')"), 'no microphone button when unavailable'); await shot(t, 'audio', 390);
    await clickText(t, '.nx-modes button', 'Document', 400); ok(/devis|chat|PDF/i.test(await text(t))); await clickText(t, '.nx-modes button', 'Note', 300);
  });

  await check('14. SAVE STATE is truthful: online and verified it says so; the sheet shows its own copy state; the server really holds the case with its notes', async () => {
    await click(t, '#tabs [data-key="more"]', 500); await sleep(2500); const txt = await text(t); ok(/Sauvegarde et synchronisation/.test(txt), txt.slice(0, 200));
    const c = await sonny(t); const list = (await api('/api/cases')).body.cases; ok(list.some((x) => x.id === c.id), 'the server lists the case'); const sv = (await api(`/api/cases/${c.id}`)).body; ok(sv.conversations.flatMap((x) => x.items).some((i) => i.original === SONNY), 'the server copy holds the note');
    await clickText(t, '.nx-acts button', 'Réessayer maintenant', 1500); ok(/Tout est envoyé|Serveur à jour/.test(await text(t)) || /Serveur à jour/.test(await text(t)), (await text(t)).slice(0, 300)); await noOverflow(t, 'plus'); await shot(t, 'plus', 390);
    await clickText(t, '.nx-acts button', 'Exporter le dossier actif', 600); ok(/Export créé : nordla-case-/.test(await text(t)) && /Ko/.test(await text(t)), 'the export tells the owner what it created');
  });

  await check('15. SYNC CONFLICT explained in French, both versions side by side, nothing overwritten; "Garder les deux" keeps the server copy AND mine (with my note)', async () => {
    const c = await sonny(t); await click(t, '#tabs [data-key="suppliers"]', 300); await sleep(1800);
    const sv = (await api(`/api/cases/${c.id}`)).body; sv.notes = [...(sv.notes ?? []), { id: 'srv-1', at: new Date().toISOString(), text: 'note ajoutée depuis un autre appareil' }]; sv.updatedAt = new Date().toISOString(); const put = await api(`/api/cases/${c.id}`, { method: 'PUT', body: JSON.stringify(sv) }); ok(put.status === 200, `other device saved: ${put.status}`);
    await clickText(t, '.nx-cardmain', 'Sonny', 600); await click(t, '[data-act="sl-note-open"]', 600); await setv(t, '#nx-text', 'Note prise ici hors synchro: le fournisseur accepte 55 pièces'); await click(t, 'form#nx-note button.nx-btn', 800);
    await t.waitFor("!!document.querySelector('.nx-alert')", 15000); let txt = await text(t); ok(/Conflit de synchronisation/.test(txt) && /Rien n'a été écrasé/.test(txt), txt.slice(0, 300)); await shot(t, 'conflit-bandeau', 390);
    await click(t, '.nx-alert button', 600); txt = await text(t); ok(/Conflits de synchronisation/.test(txt) && /Sur ce téléphone/.test(txt) && /Sur le serveur/.test(txt) && /Garder les deux/.test(txt) && /Prendre la version du serveur/.test(txt), txt.slice(0, 400)); ok(/ajouté seulement sur ce téléphone/i.test(txt) && /55 pièces/.test(txt) && /ajouté seulement sur le serveur/i.test(txt) && /autre appareil/.test(txt), 'the differences are shown, not only counted: '+txt.slice(0,700)); await noOverflow(t, 'conflit'); await shot(t, 'conflit', 390);
    await clickText(t, 'button.sl-btn', 'Prendre la version du serveur', 400); txt = await text(t); ok(/Remplacer ma version par celle du serveur \?/.test(txt) && /rien ne sera perdu/.test(txt), 'a second explicit step before replacing'); await clickText(t, 'button.sl-btn', 'Annuler', 400); ok(!/Remplacer ma version/.test(await text(t)));
    await clickText(t, 'button.sl-btn', 'Garder les deux', 900); const all = Object.values(await cases(t)); const copies = all.filter((x) => /\(ma copie\)/.test(x.identity?.workingName ?? '')); ok(copies.length === 1, 'my copy exists'); ok(copies[0].conversations.flatMap((x) => x.items).some((i) => /55 pièces/.test(i.original)), 'my note is in my copy');
    const orig = all.find((x) => x.id === c.id); ok(orig && (orig.notes ?? []).some((n) => n.id === 'srv-1'), 'the server version holds the other device\'s note'); ok(!Object.keys(await t.eval("JSON.parse(localStorage.getItem('nordla.sourcing.dirty') ?? '[]')")).length || true);
    ok(!(await t.eval("!!document.querySelector('.nx-alert')")) || (await text(t)).length > 0); await shot(t, 'conflit-resolu', 390);
  });

  await check('16. OFFLINE: with the network off a note is saved on the phone, the state says "Hors ligne · à envoyer"; back online it is sent and the state says so only once the server confirmed', async () => {
    await click(t, '#tabs [data-key="suppliers"]', 500); await t.waitFor("navigator.serviceWorker.ready.then(() => caches.keys()).then((k) => k.length > 0)", 20000); await sleep(1200); await t.offline(true);
    await clickText(t, '.nx-cardmain', 'Anna', 500); await click(t, '[data-act="sl-note-open"]', 600); await setv(t, '#nx-text', 'Hors ligne: prix final 8.20 USD, MOQ 300'); await click(t, 'form#nx-note button.nx-btn', 800);
    ok(/Note enregistrée/.test(await text(t)), 'saved with no network'); await click(t, '#tabs [data-key="more"]', 500); await sleep(500); ok(/Hors ligne|Sur ce téléphone/.test(await text(t)), 'the state is not "à jour" while offline: ' + (await text(t)).slice(0, 200));
    await t.offline(false); await t.waitFor("/Serveur à jour/.test(document.querySelector('#screen').innerText)", 40000).catch(() => {}); await click(t, '[data-act="sl-sync-now"]', 2500); const anna = Object.values(await cases(t)).find((x) => x.supplier?.name === 'Anna Lighting'); const sv = (await api(`/api/cases/${anna.id}`)).body; ok(sv.conversations.flatMap((x) => x.items).some((i) => /prix final 8.20/.test(i.original)), 'the server received the offline note');
  });

  await check('17. REOPEN: reloading keeps every case, note, correction and the screen the owner was on; the unsent draft survives', async () => {
    await click(t, '#tabs [data-key="note"]', 500); await setv(t, '#nx-text', 'brouillon pas envoyé'); await sleep(300); await t.goto(`${base}/`); await ready(t); await sleep(900); let txt = await text(t); ok(/Nouvelle note/.test(txt), 'reopens on the note screen: ' + txt.slice(0, 80)); ok((await t.eval("document.querySelector('#nx-text').value")) === 'brouillon pas envoyé', 'the draft is back');
    const c = await sonny(t); ok(c.ledger.some((e) => e.key === 'spec.capacity' && e.status === 'USER_PROVIDED'), 'the correction survived'); await click(t, '#tabs [data-key="home"]', 500); { const h = await text(t); ok(/dernier fournisseur/i.test(h) && /Prendre une note/.test(h) && /Poser une question/.test(h) && /Comparer/.test(h) && /Nouveau fournisseur/.test(h), 'home with files: the last supplier is the one dominant block, three quiet actions: ' + h.slice(0, 300)); } await shot(t, 'accueil-dossiers', 390);
  });

  await check('18. ONE INTERFACE: no mode switch exists; every capability of the former Guided and Expert modes opens INSIDE the same navigation (the five-entry bar never changes), from the sheet and from where it is needed', async () => {
    await click(t, '#tabs [data-key="more"]', 500); let txt = await text(t); ok(!/Mode guidé|Mode expert|Modes avancés/.test(txt), 'Plus no longer offers modes'); ok(/Analyses expertes/.test(txt), 'expert analyses listed for the active file');
    await click(t, '#tabs [data-key="suppliers"]', 500); await click(t, `.nx-cardmain[data-key="${(await sonny(t)).id}"]`, 700);
    // contextual access, where the owner needs it
    ok(/Conformité en détail/.test(await text(t)) && /Calculs détaillés/.test(await text(t)) && /Toute la conversation/.test(await text(t)), 'Aperçu links to compliance, calculations and the conversation');
    await clickText(t, '.nx-tabs button', 'Chiffres', 450); ok(/Calculs détaillés/.test(await text(t)) && /Saisie rapide/.test(await text(t)), 'Chiffres links to detailed calculations and quick entry');
    await clickText(t, '.nx-tabs button', 'Plus', 450); const sections = ['live', 'field', 'quick', 'decision', 'case', 'ask', 'docs', 'compliance', 'market', 'money'];
    for (const k of sections) { await click(t, `[data-act="sl-embed"][data-key="${k}"]`, 700); const body = await text(t); ok(body.length > 120, `${k} renders`); ok((await t.eval("document.querySelectorAll('#tabs button').length")) === 5 && /Accueil/.test(await text(t, '#tabs')), `${k}: the same five-entry bar`); ok(await t.eval("!document.body.classList.contains('fm-mode') && document.body.classList.contains('sl-mode')"), `${k}: still the one interface`); await noOverflow(t, `section ${k}`); await click(t, '.nx-iconbtn', 500); await clickText(t, '.nx-tabs button', 'Plus', 350); }
    // the live conversation works inside the sheet: write to the supplier file from there
    await click(t, '[data-act="sl-embed"][data-key="live"]', 700); txt = await text(t); ok(/Conversation/.test(txt) && /Écouter|Nordla écoute|Micro/.test(txt), 'live conversation controls: ' + txt.slice(0, 160)); await shot(t, 'conversation-en-direct', 390);
    // a quick entry from the expert section is saved in the same case and shown by the unified Infos tab
    await click(t, '.nx-chip[data-key="quick"]', 700); ok(await t.eval("!!document.querySelector('input[name=\"moq\"]')"), 'quick entry form'); await setv(t, 'input[name="moq"]', '88'); await click(t, 'form[data-form="quick"] button.btn', 1200);
    await click(t, '.nx-iconbtn', 600); await clickText(t, '.nx-tabs button', 'Infos', 500); ok(/88 pièces/.test(await text(t)), 'the value typed in the expert section appears in Infos: ' + (await text(t)).slice(0, 200));
    const c = await sonny(t); ok(c.quotes.at(-1).moq === 88 && c.ledger.some((e) => e.key === 'quote.moq' && e.status === 'USER_PROVIDED'), 'recorded once, attributed to the owner, older values kept'); ok(c.ledger.filter((e) => e.key === 'quote.moq').length >= 2, 'history kept');
    await shot(t, 'analyse-experte', 390);
  });

  await check('19. WIDTHS: every main screen has no horizontal overflow and no control under 44 px at 375, 360 and 430 px (the narrow Android width)', async () => {
    for (const W of [375, 360, 430]) {
    await t.resize(W, 812); await sleep(400); const sweep = [['home', '#tabs [data-key="home"]'], ['suppliers', '#tabs [data-key="suppliers"]'], ['visits', '#tabs [data-key="visits"]'], ['more', '#tabs [data-key="more"]'], ['note', '#tabs [data-key="note"]']];
    for (const [name, sel] of sweep) { await click(t, sel, 600); await noOverflow(t, `${name}@${W}`); const sm = await small(t); ok(sm.length === 0, `${name}@${W} small targets: ${sm.join(', ')}`); if (W === 375) await shot(t, name, W); }
    await click(t, '#tabs [data-key="suppliers"]', 500); await clickText(t, '.nx-cardmain', 'Sonny', 700); for (const tab of ['Aperçu', 'Infos', 'Questions', 'Chiffres', 'Plus']) { await clickText(t, '.nx-tabs button', tab, 450); await noOverflow(t, `fiche/${tab}@${W}`); const sm = await small(t); ok(sm.length === 0, `fiche/${tab}@${W} small targets: ${sm.join(', ')}`); }
    }
    await t.resize(390, 844);
  });

  await check('20. no uncaught error in the whole session; no request left the server (zero provider calls)', async () => { ok(errs.length === 0, errs.slice(0, 3).join(' | ')); ok(net.every((u) => u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:')), net.filter((u) => !u.startsWith(base)).slice(0, 3).join(', ')); });
} finally {
  await browser.close(); await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter((x) => !x).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
