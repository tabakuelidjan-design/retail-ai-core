// Growth mobile navigation: 5 central pages + "Plus" (6 slots max); every built page stays reachable on mobile.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { growthDom, all, text, hasClass } from './growth-dom.js';

const UI = new URL('../src/growth/ui/', import.meta.url);
const barItems = (root) => all(root, (n) => hasClass(n, 'nav-item') && !hasClass(n, 'gr-desktop-only'));
const moreBtn = (root) => all(root, (n) => hasClass(n, 'gr-more-btn'))[0];
const panel = (root) => all(root, (n) => hasClass(n, 'gr-more-panel'))[0];

test('mobile nav: the bar holds exactly 6 slots - 5 central pages + Plus', async () => {
  const { root, errors } = await growthDom('#/');
  assert.deepEqual(errors, []);
  assert.deepEqual(barItems(root).map((n) => text(n)), ['Vue d’ensemble', 'Opportunités', 'Campagnes', 'Produits Potentiels', 'Audience', 'Plus']);
  const b = moreBtn(root);
  assert.equal(b.tagName, 'BUTTON');
  assert.equal(b.getAttribute('type'), 'button', 'a native button: keyboard accessible (Enter / Space)');
  assert.equal(b.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(b.getAttribute('aria-expanded'), 'false');
  assert.equal(b.getAttribute('aria-controls'), 'gr-more-panel');
  assert.ok(!hasClass(b, 'active'));
});

test('mobile nav: Plus opens a panel with Contenu, Croissance magasin and the disabled entries; navigation closes it', async () => {
  const { root, errors, navigate } = await growthDom('#/');
  moreBtn(root).listeners.click[0]();
  assert.equal(moreBtn(root).getAttribute('aria-expanded'), 'true');
  const p = panel(root);
  assert.equal(p.getAttribute('role'), 'dialog');
  const links = all(p, (n) => n.tagName === 'A').map((n) => [text(n), n.getAttribute('href')]);
  assert.deepEqual(links, [['Contenu', '#/content'], ['Croissance magasin', '#/storeGrowth']]);
  const disabled = all(p, (n) => hasClass(n, 'gr-more-item') && hasClass(n, 'inert'));
  assert.deepEqual(disabled.map((n) => n.getAttribute('aria-disabled')), ['true', 'true', 'true']);
  assert.ok(text(disabled[0]).startsWith('Expériences') && text(disabled[1]).startsWith('Nordla AI') && text(disabled[2]).startsWith('Paramètres'));
  assert.ok(text(disabled[0]).includes('Bientôt disponible'));
  await navigate('#/content');
  assert.equal(panel(root), undefined, 'the panel closes after navigation');
  assert.equal(moreBtn(root).getAttribute('aria-expanded'), 'false');
  assert.deepEqual(errors, []);
});

test('mobile nav: Plus is active on Contenu and Croissance magasin (and only there)', async () => {
  for (const [hash, on] of [['#/content', true], ['#/storeGrowth', true], ['#/', false], ['#/opportunities', false], ['#/campaigns', false], ['#/potential', false], ['#/audience', false]]) {
    const { root, errors } = await growthDom(hash);
    assert.deepEqual(errors, [], hash);
    assert.equal(hasClass(moreBtn(root), 'active'), on, hash);
  }
});

test('mobile nav: from every Growth page, every built page is reachable on mobile (bar or Plus)', async () => {
  for (const hash of ['#/', '#/opportunities', '#/campaigns', '#/potential', '#/audience', '#/content', '#/storeGrowth']) {
    const { root } = await growthDom(hash);
    const inBar = barItems(root).filter((n) => n.tagName === 'A').map((n) => n.getAttribute('href'));
    moreBtn(root).listeners.click[0]();
    const inMore = all(panel(root), (n) => n.tagName === 'A').map((n) => n.getAttribute('href'));
    const built = all(root, (n) => hasClass(n, 'nav-item') && n.tagName === 'A').map((n) => n.getAttribute('href'));
    assert.equal(built.length, 7);
    for (const href of built) assert.ok(inBar.includes(href) || inMore.includes(href), `${hash}: ${href} unreachable on mobile`);
  }
});

test('mobile nav: labels translated FR / NL / EN', async () => {
  const ctx = { window: {} };
  for (const l of ['fr', 'nl', 'en']) vm.runInNewContext(await readFile(new URL(`lang-${l}.js`, UI), 'utf8'), ctx);
  const D = ctx.window.NORDLA_DICTS;
  assert.deepEqual(['fr', 'nl', 'en'].map((l) => D[l]['gr.nav.more']), ['Plus', 'Meer', 'More']);
  for (const l of ['fr', 'nl', 'en']) assert.ok(D[l]['gr.nav.moreTitle']);
});
