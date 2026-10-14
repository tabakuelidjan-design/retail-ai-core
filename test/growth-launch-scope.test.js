// Développement des ventes - launch scope of the internal HABB beta (owner decisions 2026-09-28):
//   - Campagnes is out: no desktop / mobile entry, no client route, no script, no endpoint, no card or shortcut, no figure;
//   - no demonstration data anywhere (no demo builder, no demo flag, no "Démo" badge);
//   - no action button that performs no action, on any page, in any language;
//   - the promise shown is the honest one (no measurable growth, no causality, no automated campaigns).
// Synthetic payloads only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createGrowthApp } from '../src/growth/server/app.js';
import { growthDom, potentialPayload, audiencePayload, contentPayload, storePayload, all, text, hasClass, title, NOW } from './growth-dom.js';

const GROWTH = new URL('../src/growth/', import.meta.url);
const HASHES = ['#/', '#/opportunities', '#/potential', '#/audience', '#/content', '#/storeGrowth'];
// The Campagnes page / its figures / its button (FR, NL "Campagnes", EN "Campaigns"). A suggestion such as Audience's "Préparer une
// campagne de réactivation" is advice to the owner, not the Campagnes page, and is not matched.
const CAMPAIGN = /Campagnes|Campaigns|Nouvelle campagne|Nieuwe campagne|New campaign|ROAS/;
const srcFiles = (dir) => readdirSync(new URL(dir, GROWTH), { recursive: true }).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => new URL(`${dir}${String(f).replace(/\\/g, '/')}`, GROWTH));

test('Campagnes: no page definition, no desktop or mobile entry, no script, no card or shortcut, in FR / NL / EN', async () => {
  for (const lang of ['fr', 'nl', 'en']) {
    for (const h of HASHES) {
      const { root, errors, ctx } = await growthDom(h, { lang });
      assert.deepEqual(errors, []);
      assert.equal(vm.runInContext("typeof PAGES.campaigns === 'undefined' && typeof renderCampaigns === 'undefined'", ctx), true);
      assert.ok(!CAMPAIGN.test(text(root)), `${lang} ${h}: a campaign mention is visible`);
      assert.equal(all(root, (n) => n.tagName === 'A' && /campaign/i.test(n.getAttribute('href') || '')).length, 0);
    }
  }
  assert.equal(existsSync(new URL('ui/campaigns.js', GROWTH)), false);
  assert.equal(existsSync(new URL('server/demo-campaigns.js', GROWTH)), false);
});

test('Campagnes: a direct URL shows Vue d\'ensemble; its script and endpoint answer 404', async () => {
  const { root } = await growthDom('#/campaigns');
  assert.equal(title(root), 'Développement des ventes');
  const server = http.createServer(createGrowthApp({ now: () => NOW, productPotential: async () => potentialPayload(), audience: async () => audiencePayload(), content: async () => contentPayload(), store: async () => storePayload() }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ['/campaigns.js', '/api/growth/campaigns', '/api/growth/campaigns?x=1']) assert.equal((await fetch(base + p)).status, 404, p);
    // No served payload carries a demonstration flag or a campaign / ROAS / channel figure.
    for (const p of ['overview', 'opportunities', 'products', 'audience', 'content', 'store']) {
      const json = await (await fetch(`${base}/api/growth/${p}`)).text();
      assert.ok(!/"demo"\s*:\s*true/.test(json), `${p}: demo flag`);
      assert.ok(!/"(campaigns|roas|activeCampaigns|channels)"/.test(json), `${p}: campaign field`);
    }
  } finally { server.close(); }
});

test('no demonstration data: no demo builder or demo fixture in the served code, no "Démo" badge on any page', async () => {
  for (const f of srcFiles('')) {
    const code = readFileSync(f, 'utf8');
    assert.ok(!/buildDemo|demo-campaigns|demo:\s*true/.test(code), `${f.pathname}: demonstration data`);
  }
  for (const lang of ['fr', 'nl', 'en']) {
    for (const h of HASHES) {
      const { root } = await growthDom(h, { lang });
      assert.equal(all(root, (n) => hasClass(n, 'gr-demo')).length, 0, `${lang} ${h}`);
      assert.ok(!/\b(Démo|Demo)\b|démonstration|demonstratie|demonstration/i.test(text(root)), `${lang} ${h}: demo wording`);
    }
  }
});

test('no fictive action button: every button on every page does something (language, Plus menu, filters, rows, close, retry)', async () => {
  const code = srcFiles('ui/').map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.ok(!/disabled:\s*'disabled'/.test(code), 'no disabled button is built anywhere');
  for (const k of ['gr.pp.d.opportunity', 'gr.au.newSegment', 'gr.ct.d.improve', 'gr.op.appr.approve', 'gr.cp.new', 'gr.op.actionsSoon', 'gr.att.soon']) assert.ok(!code.includes(`'${k}'`), `${k} is gone`);
  for (const lang of ['fr', 'nl', 'en']) {
    for (const h of HASHES) {
      const { root } = await growthDom(h, { lang });
      for (const b of all(root, (n) => n.tagName === 'BUTTON')) {
        assert.equal(b.getAttribute('disabled'), null, `${lang} ${h}: disabled button "${text(b)}"`);
        assert.ok((b.listeners.click || []).length > 0, `${lang} ${h}: button without behaviour "${text(b)}"`);
      }
    }
  }
});

test('honest promise: shown on Vue d\'ensemble; no measurable growth, causality, guaranteed increase, ads or automated campaigns promised', async () => {
  const promise = { fr: 'Nordla vérifie la qualité de vos fiches produit et de vos données', nl: 'Nordla controleert de kwaliteit van uw productfiches en gegevens', en: 'Nordla checks the quality of your product listings and data' };
  const forbidden = /mesurable|meetbare|measurable|garanti|gegarandeerd|guaranteed|causalit[ée] prouv|campagnes? automatis|automated campaign/i;
  for (const lang of ['fr', 'nl', 'en']) {
    const { root } = await growthDom('#/', { lang });
    assert.ok(text(root).includes(promise[lang]), `${lang}: honest promise`);
    for (const h of HASHES) { const { root: r } = await growthDom(h, { lang }); assert.ok(!forbidden.test(text(r)), `${lang} ${h}: forbidden promise`); }
  }
});

test('Expériences stays out of the product, Nordla AI and Paramètres stay disabled entries (unchanged decision)', async () => {
  const { root, ctx } = await growthDom('#/');
  assert.equal(vm.runInContext('Object.keys(PAGES).join()', ctx), 'overview,opportunities,potential,audience,content,storeGrowth');
  const inert = all(root, (n) => hasClass(n, 'nav-item') && hasClass(n, 'inert')).map(text);
  assert.deepEqual(inert, ['Nordla AI', 'Paramètres']);
  assert.ok(!/exp[ée]rience|experiment/i.test(text(root)));
});
