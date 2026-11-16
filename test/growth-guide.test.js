// Opportunités > « Guide des fonctions »: every function of lots _01 to _11 under a plain name, its state FOR THIS MERCHANT (read from the page's own data), what connection is missing, where it opens;
// the guided-preview link when configured, the preview banner in the simulation; FR / NL / EN. The guide invents no state and starts nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboxSource } from '../src/growth/server/inbox.js';
import { createSocialSource } from '../src/growth/server/social.js';
import { growthDom, prioritiesPayload, text, all, hasClass } from './growth-dom.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const norm = (t) => t.replace(/[  ]/g, ' ');
const click = (b) => b.listeners.click[0]();
const habb = async (extra = {}) => { // a merchant like HABB today: no ad account, no social source, no site source; the inbox test is offered for a manual statement
  const inbox = await createInboxSource({ loaders: {}, accounts: async () => [], now: () => NOW, cacheMs: 0 })(); const social = await createSocialSource({ now: () => NOW, cacheMs: 0, loaders: {} })();
  return { ...prioritiesPayload(), historyScope: 'merchant-a', ads: { state: 'NOT_CONNECTED', channel: null, campaigns: [], items: [] }, social, inbox, ...extra };
};
const open = async (opportunities, lang = 'fr') => { const ui = await growthDom('#/overview', { opportunities, lang }); await ui.navigate('#/opportunities'); assert.deepEqual(ui.errors, []); return ui; };
const guide = (ui) => all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-guide'))[0];
const row = (ui, id) => all(guide(ui), (n) => n.getAttribute?.('data-guide') === id)[0];

test('GUI-1 the guide is the first block of Opportunités: 12 functions under plain names, lot marks, the state for THIS merchant, what is missing', async () => {
  const ui = await open(await habb({ guide: { previewUrl: 'http://127.0.0.1:4414/#/opportunities', isPreview: false } })); const g = guide(ui); assert.ok(g, 'the guide exists');
  const first = all(ui.root, (n) => n.tagName === 'DETAILS' || (n.getAttribute && /gr-pr-card/.test(n.getAttribute('class') || '')))[0]; assert.ok(hasClass(first, 'gv-guide'), 'the first card of the page is the guide');
  assert.equal(norm(text(all(g, (n) => n.tagName === 'SUMMARY')[0])), 'Guide des fonctions12 fonctions');
  const names = ['Préparer une action', 'Actions prioritaires', 'Revoir un résultat', 'Campagnes e-mail', 'Campagnes publicitaires', 'Site indépendant', 'Abonnés Instagram / TikTok', 'Brief pour Creator', 'Calendrier de publication', 'Demandes qualifiées', 'Suite commerciale', 'Dossier de correction'];
  for (const n of names) assert.ok(norm(text(g)).includes(n), n);
  assert.ok(norm(text(row(ui, 'prepare'))).includes('lot _01 · _03') && norm(text(row(ui, 'pipeline'))).includes('lot _11'));
  // HABB today: no ad account, no social source, no site source
  assert.ok(norm(text(row(ui, 'ads'))).includes('non connecté') && norm(text(row(ui, 'ads'))).includes('Compte publicitaire (Meta Ads) à connecter.'));
  assert.ok(norm(text(row(ui, 'site'))).includes('non raccordé à cet écran') && norm(text(row(ui, 'social'))).includes('non connecté'), norm(text(row(ui, 'social'))));
  assert.ok(norm(text(row(ui, 'inquiry'))).includes('disponible · 1') && norm(text(row(ui, 'inquiry'))).includes('relevé manuel'), 'the manual test is offered without any connection: ' + norm(text(row(ui, 'inquiry'))));
  assert.ok(norm(text(row(ui, 'prepare'))).includes('disponible'), 'the actions of the fixture are counted'); assert.ok(norm(text(row(ui, 'corrections'))).includes('disponible') || norm(text(row(ui, 'corrections'))).includes('rien à faire'), 'the correction state is read from the counts'); assert.ok(norm(text(row(ui, 'review'))).includes('s’ouvre à la date de revue'));
  assert.ok(norm(text(row(ui, 'creator'))).includes('ne produit pas encore'), 'the limit of Creator is said');
});

test('GUI-2 the guided-preview link is offered on the merchant\'s app only when configured; the preview itself says its data is fictitious; "Aller à" says so when there is nothing to open', async () => {
  const withLink = await open(await habb({ guide: { previewUrl: 'http://127.0.0.1:4414/#/opportunities', isPreview: false } })); const a = all(guide(withLink), (n) => n.tagName === 'A' && n.getAttribute('data-guide-preview') === 'link')[0];
  assert.ok(a && a.getAttribute('href') === 'http://127.0.0.1:4414/#/opportunities' && a.getAttribute('target') === '_blank' && a.getAttribute('rel').includes('noopener')); assert.ok(norm(text(guide(withLink))).includes('Essayer toutes les fonctions sur l’aperçu guidé'));
  const bad = await open(await habb({ guide: { previewUrl: 'javascript:alert(1)', isPreview: false } })); assert.equal(all(guide(bad), (n) => n.tagName === 'A').length, 0, 'only an http(s) address is ever linked');
  const none = await open(await habb()); assert.equal(all(guide(none), (n) => n.tagName === 'A').length, 0, 'no link when none is configured');
  const prev = await open(await habb({ guide: { isPreview: true, previewUrl: null } })); const t = norm(text(guide(prev))); assert.ok(t.includes('Aperçu guidé : boutique, comptes, clients et chiffres FICTIFS') && t.includes('aperçu guidé'), t.slice(0, 400)); assert.equal(all(guide(prev), (n) => n.tagName === 'A').length, 0);
  const go = all(row(withLink, 'ads'), (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-guide-go'))[0]; click(go); assert.ok(norm(text(guide(withLink))).includes('Rien à ouvrir pour l’instant'), 'a missing target is said, not ignored');
});

test('GUI-3 the state of each function follows the data: available with a count, unavailable, not connected, absent', async () => {
  const ui = await open(await habb()); const st = (id, d) => { const f = ui.ctx.GUIDE_FUNCTIONS.find((x) => x.id === id); const r = f.state(d); return `${r.kind}${r.n ?? ''}`; };
  assert.equal(st('ads', { ads: { state: 'OK', items: [1, 2] } }), 'count2'); assert.equal(st('site', { site: { state: 'OK', items: [1] } }), 'count1'); assert.equal(st('calendar', { social: { state: 'OK', items: [1] } }), 'count1');
  assert.equal(st('ads', { ads: { state: 'UNAVAILABLE', items: [] } }), 'UNAVAILABLE'); assert.equal(st('ads', { ads: { state: 'NOT_CONNECTED', items: [] } }), 'NOT_CONNECTED'); assert.equal(st('ads', {}), 'absent');
  assert.equal(st('inquiry', { inbox: { state: 'NOT_CONNECTED', items: [1] } }), 'count1', 'a test offered for a manual statement is available even when nothing is connected');
  assert.equal(st('corrections', { counts: { fixCorrections: 10 } }), 'count10'); assert.equal(st('corrections', { counts: { fixCorrections: 0 } }), 'none');
  assert.equal(st('priorities', { weekly: { items: [{ id: 'a' }, { id: 'b' }] } }), 'count2', 'the weekly block is { items }'); assert.equal(st('prepare', { sections: { commercial: [{ id: 'x' }] }, weekly: { items: [{ id: 'x' }, { id: 'y' }] } }), 'count2', 'an action present in both lists counts once');
});

test('GUI-4 FR / NL / EN: no raw key, names and statuses translated', async () => {
  for (const lang of ['nl', 'en', 'fr']) { const ui = await open(await habb({ guide: { previewUrl: 'http://127.0.0.1:4414/#/opportunities', isPreview: false } }), lang); const tx = text(guide(ui)); const rk = tx.match(/gr\.(guide|op|fiche|follow|inbox|pipe)\.[\w.]+/); assert.ok(!rk, `${lang}: raw key ${rk && rk[0]}`); }
  const nl = await open(await habb(), 'nl'); assert.ok(norm(text(guide(nl))).includes('Gids van de functies') && norm(text(row(nl, 'email'))).includes('E-mailcampagnes') && norm(text(row(nl, 'ads'))).includes('niet verbonden'));
  const en = await open(await habb(), 'en'); assert.ok(norm(text(row(en, 'email'))).includes('E-mail campaigns') && norm(text(row(en, 'ads'))).includes('not connected') && norm(text(row(en, 'review'))).includes('Review a result'));
});
