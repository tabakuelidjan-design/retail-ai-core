// Finance inside Nordla Core: one vertical scrollbar (no nested scroll containers) and a prompt start
// (UI script in parallel with the module session, Finance frame drawn before the session answer, pdf.js only on demand).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

test('one vertical scrollbar: the Finance overlay page scrolls; Core menu column and document do not scroll on their own', async () => {
  const css = await read('../src/sourcing/ui/nordla-home.css');
  assert.match(css, /\.nx-finance-panel \{ height: auto; min-height: 520px; overflow: visible;/);
  assert.match(css, /\.nxf-host \{ display: block; width: 100%; height: auto; min-height: 0; overflow: visible;/);
  assert.match(css, /@media \(min-width: 900px\) \{ \.nx-finance-core \.nx-home-side \{ position: static; height: auto; overflow: visible; \} \}/);
  assert.match(css, /html:has\(\.nx-finance-core\) \{ overflow: hidden; \}/);
  // no fixed-height Finance box left (it was the inner scrollbar)
  assert.doesNotMatch(css, /\.nx-finance-panel \{ height: calc\(100vh - 42px\)/);
  assert.doesNotMatch(css, /\.nxf-host \{[^}]*overflow: auto/);
});

test('the mobile drawer is not changed: the menu column keeps its drawer position below 900px', async () => {
  const css = await read('../src/sourcing/ui/nordla-home.css');
  const hits = [...css.matchAll(/\.nx-finance-core \.nx-home-side \{ position: static/g)];
  assert.equal(hits.length, 1, 'one static rule');
  assert.match(css.slice(0, hits[0].index), /@media \(min-width: 900px\) \{ $/, 'and it is only inside the desktop query');
});

test('Finance starts promptly: the UI script loads in parallel with the module session, not after it', async () => {
  const app = await read('../src/sourcing/ui/app.js');
  const start = app.indexOf('function prepareFinance()');
  const embedAt = app.indexOf('const embed = loadFinanceEmbed();', start);
  const openAt = app.indexOf("api('/api/core/finance/open'", start);
  const sessionAt = app.indexOf('await fetch(target.href', start);
  assert.ok(embedAt > start && openAt > embedAt, 'the script download starts before the open request');
  assert.ok(sessionAt > openAt, 'the session is opened after the ticket is known');
  assert.match(app, /embed\.catch\(\(\) => \{\}\)/, 'a failed download is reported where it is awaited, not as an unhandled error');
  assert.match(app, /await embed;/);
  // the session checks are unchanged
  assert.match(app, /target\.origin !== window\.location\.origin \|\| !target\.pathname\.startsWith\('\/finance\/sso'\)/);
  assert.match(app, /if \(!res\.ok\) throw new Error\('finance session'\)/);
});

test('Finance draws its frame (header and horizontal menu) before the session answer when embedded', async () => {
  const fin = await read('../src/finance/ui/app.js');
  const routeStart = fin.indexOf('async function route() {');
  const skeleton = fin.indexOf("class: 'shell shell-embedded'", routeStart);
  const session = fin.indexOf("api('GET', 'api/session?include=settings')", routeStart);
  assert.ok(routeStart >= 0 && skeleton > routeStart && session > skeleton, 'the frame is drawn before the session request');
  assert.match(fin, /if \(!state\.csrf && typeof finApiBase === 'string' && finApiBase\) \{/, 'standalone Finance keeps its own start');
});

test('pdf.js is loaded only when a PDF preview is opened, never at Finance startup', async () => {
  const preview = await read('../src/finance/ui/pdf-preview.js');
  const app = await read('../src/finance/ui/app.js');
  const embed = await read('../src/finance-embed/finance-embed.js');
  assert.match(preview, /function renderPdfPreview\(container, url\) \{[\s\S]*loadPdfJs\(\)/);
  assert.doesNotMatch(app, /pdf\.mjs/);
  // the bundle references pdf.js only inside the lazy loader
  const refs = [...embed.matchAll(/pdf\.mjs/g)].length;
  assert.equal(refs, 1, 'a single reference, inside loadPdfJs');
});

test('the Finance embed is up to date with its sources after these changes', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../tools/build-finance-embed.mjs', import.meta.url)), '--check'], { encoding: 'utf8' });
  assert.match(out, /up to date/);
});

test('inside Core the Accueil Nordla link is removed from Finance header (the Core menu is the way back); standalone keeps it', async () => {
  const fin = await read('../src/finance/ui/app.js');
  assert.match(fin, /state\.nordlaHome && !embedded \? h\('a', \{ class: 'back-nordla'/, 'the link is drawn only outside the embedded layout');
});

test('Finance is prepared on interest (hover, focus, touch) and the click reuses it; the ticket window is bounded', async () => {
  const app = await read('../src/sourcing/ui/app.js');
  assert.match(app, /document\.addEventListener\('pointerover', onFinanceInterest, \{ passive: true \}\)/);
  assert.match(app, /document\.addEventListener\('focusin', onFinanceInterest\)/);
  assert.match(app, /document\.addEventListener\('touchstart', onFinanceInterest, \{ passive: true \}\)/);
  assert.match(app, /const FINANCE_TICKET_WINDOW_MS = 40000;/, 'a 60 s ticket is reused for at most 40 s, then prepared again');
  assert.match(app, /financePrepared && Date\.now\(\) - financePrepared\.at < FINANCE_TICKET_WINDOW_MS \? financePrepared : prepareFinance\(\)/);
  // the ticket exchange stays one-time: a failed preparation is redone once, never reused
  assert.match(app, /ready\.catch\(\(\) => \{ financePrepared = null; return prepareFinance\(\)\.ready; \}\)/);
  // the server still validates the ticket and the session: the same endpoints, the same checks
  assert.match(app, /fetch\('\/finance\/api\/session\?include=settings'/);
  assert.match(app, /if \(target\.origin !== window\.location\.origin \|\| !target\.pathname\.startsWith\('\/finance\/sso'\)\)/);
});

test('the first Finance session answer is handed to the embed and used once; without it Finance asks as before', async () => {
  const fin = await read('../src/finance/ui/app.js');
  const shim = await read('../src/finance/ui/embed/shim.js');
  const build = await read('../tools/build-finance-embed.mjs');
  assert.match(shim, /prefetchedSession: options\.session \|\| null/);
  assert.match(build, /let finPrefetchedSession = env\.prefetchedSession;/);
  assert.match(fin, /finPrefetchedSession \? \(finPrefetchedSession\.authenticated \? finPrefetchedSession : await api\('GET', 'api\/session\?include=settings'\)\) : await api\('GET', 'api\/session\?include=settings'\)/);
  assert.match(fin, /finPrefetchedSession = null;/);
});
