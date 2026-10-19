// Nordla Design System v1 (src/sourcing/nordla-ui/nordla-ds.*, nordla-view.js): the screen shows ONLY what the server answered, says
// "Non disponible" otherwise, never "Opérationnel" without the checks behind it, escapes every text, uses only official, non-defective
// icons, and its colour tokens keep text contrast at WCAG AA. Pure Node, no browser (the browser proof is test/e2e/nordla-design.e2e.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { buildDashboard, systemStatus, metrics, activity, moduleCards, navItems, coreNodes, ICON_FILES, STATE_TONE } from '../src/sourcing/nordla-ui/nordla-view.js';
import { esc, metricCard, moduleCard, activityFeed, sidebar, chartCard, mobileNav, coreDiagram } from '../src/sourcing/nordla-ui/nordla-ds.js';

const STATUS = { enabled: true, owner_rules: 'NOT_CONFIGURED', awaiting_human: 2, in_follow_up: 1, journal_head: 'abc', connected: { china_sourcing: 'CONNECTED', socle_decision: 'CONNECTED', finance: 'READ_ONLY (Finance)', stock_achats: 'NOT_CONNECTED', analytics: 'NOT_CONNECTED' } };
const MODULES = [
  { key: 'core', label: 'Nordla Core', state: 'DISPONIBLE', detail: 'd' }, { key: 'finance', label: 'Finance', state: 'LECTURE SEULE', detail: 'Factures…' },
  { key: 'analytics', label: 'Analytics', state: 'NON RACCORDÉ', detail: 'non raccordé' }, { key: 'procurement', label: 'Stock / Achats', state: 'NON RACCORDÉ', detail: 'x' },
  { key: 'sourcing', label: 'China Sourcing', state: 'DISPONIBLE', detail: 'y', offline: true }, { key: 'creative', label: 'Création', state: 'BLOQUÉ', detail: 'Aucun fournisseur' },
];

test('"Opérationnel" only when the Core runs AND the off-server backup is verified; otherwise the screen says what is missing', () => {
  assert.equal(systemStatus({ status: STATUS, backup: { status: 'OK', last_success_age_h: 3 }, now: '2026-10-17T08:00:00Z' }).tone, 'ok');
  assert.match(systemStatus({ status: STATUS, backup: { status: 'OK', last_success_age_h: 3 }, now: '2026-10-17T08:00:00Z' }).label, /^Opérationnel \(vérifié à 08:00 UTC\)$/);
  for (const backup of [null, { status: 'PENDING_FIRST_RUN' }, { status: 'FAILING', error_code: 'OFFSITE_UPLOAD_FAILED' }, { status: 'NOT_CONFIGURED' }]) {
    const s = systemStatus({ status: STATUS, backup }); assert.equal(s.tone, 'warn'); assert.doesNotMatch(s.label, /Opérationnel/);
  }
  assert.equal(systemStatus({ status: { enabled: false, reason: 'JOURNAL_NOT_ON_A_VOLUME' }, backup: { status: 'OK' } }).label, 'Core inactif');
  assert.equal(systemStatus({ status: null, backup: null }).label, 'État non vérifié');
  assert.equal(systemStatus({ status: STATUS, backup: { status: 'OK' }, online: false }).label, 'Hors ligne');
});

test('indicators come from named server fields, or are "Non disponible" with the reason - never an invented figure', () => {
  const m = metrics({ status: STATUS, decisions: [{}, {}, {}], backup: { status: 'OK', last_success_age_h: 5 } });
  assert.deepEqual(m.map((x) => x.value), [2, 1, 3, '5 h']);
  const none = metrics({ status: { enabled: false }, decisions: null, backup: null });
  assert.ok(none.every((x) => x.value === null && x.source));
  assert.match(metricCard(none[0]), /Non disponible/);
  const d = buildDashboard({ status: STATUS, modules: MODULES, decisions: [], backup: null, session: { mode: 'session', authenticated: true } });
  assert.equal(d.ai.value, null); assert.match(d.ai.source, /Non disponible/);
});

test('modules: exactly what the server reports, its state as a badge (unknown state never green), Sourcing opens the field app', () => {
  const cards = moduleCards({ modules: [...MODULES, { key: 'mystery', label: 'X', state: 'NOUVEAU', detail: '' }] });
  assert.equal(cards.length, MODULES.length + 1);
  assert.equal(cards.find((c) => c.key === 'sourcing').href, '/');
  assert.equal(cards.find((c) => c.key === 'mystery').tone, 'neutral');
  assert.equal(STATE_TONE['NON RACCORDÉ'], 'neutral'); assert.equal(STATE_TONE.BLOQUÉ, 'error');
  assert.match(moduleCard(cards.find((c) => c.key === 'creative')), /BLOQUÉ/);
  assert.deepEqual(moduleCards({ modules: null }), []);
});

test('activity: null = journal not read (said), [] = nothing yet (said), otherwise the journal newest first', () => {
  assert.equal(activity({ decisions: null }), null);
  assert.match(activityFeed(null), /non disponible/i); assert.match(activityFeed([]), /Aucune activité/);
  const a = activity({ decisions: [{ subject: { title: 'Bambou' }, created_at: '2026-10-16T10:00:00Z', recommendation: { label: 'Tester petit' }, human_decision: null }] });
  assert.equal(a[0].tone, 'warn'); assert.match(a[0].what, /à décider/);
});

test('diagram and navigation: a destination only where one exists; unavailable entries are disabled with their reason', () => {
  const nodes = coreNodes({ status: STATUS, modules: MODULES });
  assert.equal(nodes.find((n) => n.key === 'agents').href, null);
  assert.match(nodes.find((n) => n.key === 'data').detail, /^1 source\(s\) sur 3/);
  assert.match(coreDiagram(nodes), /<div class="nd-core-node" data-pos="top"/);
  const nav = navItems({ modules: MODULES, route: 'accueil' });
  assert.equal(nav.find((i) => i.label === 'Ventes & CRM').href, null);
  assert.equal(nav.find((i) => i.label === 'China Sourcing').href, '/');
  const html = sidebar(nav); assert.match(html, /aria-disabled="true"[^>]*title="bientôt"/); assert.match(html, /aria-current="page"/);
  assert.equal((mobileNav('parle').match(/<a /g) ?? []).length, 5);
});

test('every text is escaped; a chart is drawn from a real numeric series only', () => {
  assert.equal(esc('<img src=x onerror=1>&"\''), '&lt;img src=x onerror=1&gt;&amp;&quot;&#39;');
  const html = moduleCard({ key: 'x', name: '<script>', short: '"q"', state: 'DISPONIBLE', tone: 'ok', href: '#module/x' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(chartCard({ title: 'Ventes', series: null, reason: 'Aucune série' }), /Aucune série/);
  assert.match(chartCard({ title: 'Ventes', series: [{ label: 'a', value: Number.NaN }] }), /nd-empty/);
  assert.match(chartCard({ title: 'Ventes', series: [{ label: 'a', value: 2 }, { label: 'b', value: 4 }] }), /height:50%/);
});

test('icons: only official files that exist, none of the pack\'s DEFECTIVE exports', () => {
  const iconJs = readFileSync(new URL('../src/shared/nordla-icon.js', import.meta.url), 'utf8');
  const defective = iconJs.slice(iconJs.indexOf('const DEFECTIVE'));
  for (const f of Object.values(ICON_FILES)) {
    assert.ok(existsSync(new URL(`../src/shared/assets/nordla/official-icons/${f}`, import.meta.url)), f);
    assert.ok(iconJs.includes(`'${f}'`), `${f} is an official icon`); assert.ok(!defective.includes(`'${f}'`), `${f} is not defective`);
  }
});

test('tokens: validated palette, text contrast >= 4.5:1 on its backgrounds, no forbidden colours', () => {
  const css = readFileSync(new URL('../src/shared/nordla-ds.css', import.meta.url), 'utf8');
  const tok = (n) => new RegExp(`--nd-${n}:\\s*(#[0-9A-Fa-f]{6})`).exec(css)[1];
  assert.equal(tok('bg'), '#F5F6F8'); assert.equal(tok('card'), '#FFFFFF'); assert.equal(tok('nav'), '#FAFBFC'); assert.equal(tok('bronze'), '#95652F');
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const fg of ['text', 'text-2', 'bronze', 'success', 'error']) for (const bg of ['bg', 'card', 'nav']) assert.ok(ratio(tok(fg), tok(bg)) >= 4.5, `${fg} on ${bg}: ${ratio(tok(fg), tok(bg)).toFixed(2)}`);
  for (const [fg, bg] of [['success', 'success-tint'], ['error', 'error-tint'], ['warning', 'warning-tint'], ['bronze-strong', 'bronze-tint']]) assert.ok(ratio(tok(fg), tok(bg)) >= 4.5, `${fg} on ${bg}`);
  // owner rule (2026-10-19): backgrounds are white or a very light neutral grey. No cream, ivory or beige: every surface / tint token must be neutral or cool (red never exceeds blue by more than 6)
  for (const n of ['bg', 'card', 'nav', 'bronze-tint', 'warning-tint', 'neutral-tint']) { const h = tok(n); const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); assert.ok(r - b <= 6, `--nd-${n} ${h} is warm (cream / beige)`); }
  assert.doesNotMatch(css, /gradient\(/i, 'no gradients');
  assert.doesNotMatch(css, /background:\s*#0{3,6}\b|background:\s*black/i, 'no black background');
  assert.doesNotMatch(css, /#(FFF8E7|FAF3E0|F5F0E6|FFFDD0|F5F5DC|1B4332|14532D)/i, 'no cream / dark-green');
});

test('the /nordla files stay OUT of the field app UI folder: the China Sourcing offline shell (built from src/sourcing/ui) is not changed', () => {
  const walk = (u) => readdirSync(u, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, u)) : [e.name]));
  const inUi = walk(new URL('../src/sourcing/ui/', import.meta.url)).filter((f) => /^nordla-(ds|view|home|mark)\.|^nordla\.html$/.test(f));
  assert.deepEqual(inUi, []);
});

test('brand: the official pack files, unchanged (sha-256 prefix), no active content; the interface shows the official monogram, never the old provisional mark', async () => {
  const { createHash } = await import('node:crypto');
  const PINS = { 'nordla-monogram.svg': 'e6d6a56ae9a14f22', 'nordla-monogram-flat.svg': '40df16a995da6a1c', 'nordla-horizontal-light.svg': '0819326d02a730f1', 'nordla-horizontal-dark.svg': 'a498ff5c89e83fa8', 'nordla-app-navy.svg': '223e66d2054143f2', 'nordla-app-white.svg': '47ee9ab0e92a57d0', 'nordla-app-charcoal.svg': '51d5f13b4c25a627', 'nordla-app-32.png': 'e878a7311250bc50', 'nordla-app-256.png': 'bdad6f777c3c86e0' };
  for (const [f, pin] of Object.entries(PINS)) {
    const buf = readFileSync(new URL(`../src/shared/assets/nordla/brand/${f}`, import.meta.url));
    assert.equal(createHash('sha256').update(buf).digest('hex').slice(0, 16), pin, `${f} is the pack file`);
    if (f.endsWith('.svg')) assert.doesNotMatch(buf.toString('utf8'), /<script|foreignObject|href=|on[a-z]+=/i, `${f}: no active content`);
  }
  const { BRAND } = await import('../src/sourcing/nordla-ui/nordla-ds.js');
  for (const u of Object.values(BRAND)) assert.ok(existsSync(new URL(`../src/shared/assets/nordla/brand/${u.split('/').pop()}`, import.meta.url)), u);
  const ui = ['nordla-ds.js', 'nordla-home.js', 'nordla.html'].map((f) => readFileSync(new URL(`../src/sourcing/nordla-ui/${f}`, import.meta.url), 'utf8')).concat(readFileSync(new URL('../src/shared/nordla-ds.css', import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(ui, /nordla-mark\.svg/); assert.ok(!existsSync(new URL('../src/sourcing/nordla-ui/nordla-mark.svg', import.meta.url)));
  assert.match(brandHtml(), /src="\/nordla-assets\/brand\/nordla-monogram\.svg"[^>]*width="40"/);
  const css = readFileSync(new URL('../src/shared/nordla-ds.css', import.meta.url), 'utf8');
  const tok = (n) => new RegExp(`--nd-${n}:\\s*(#[0-9A-Fa-f]{6})`).exec(css)[1];
  assert.equal(tok('navy'), '#0F2A52'); assert.equal(tok('soft-white'), '#F8F5ED'); assert.equal(tok('ink'), '#111827');
  assert.doesNotMatch(css, /background(-color)?:\s*var\(--nd-soft-white\)|background(-color)?:\s*#F8F5ED/i, 'soft white is never a page/card background (no cream)');
  // the shaded monogram is never drawn under 32 px on a light background (its lightest bronze, #FFF0D0, is 1.13:1 on white)
  for (const m of css.matchAll(/\.nd-(?:brand-mark|core-hub img)[^{]*\{[^}]*width:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 32, m[0]);
});
const brandHtml = () => { const s = readFileSync(new URL('../src/sourcing/nordla-ui/nordla-ds.js', import.meta.url), 'utf8'); return s.slice(s.indexOf('export const brand')).split('\n')[0].replace('${BRAND.monogram}', '/nordla-assets/brand/nordla-monogram.svg'); };

test('every module icon the dashboard names resolves to an official file that exists (no broken image on any module card)', async () => {
  const { MODULE_META, ICON_FILES, iconUrl } = await import('../src/sourcing/nordla-ui/nordla-view.js');
  const { existsSync } = await import('node:fs');
  for (const [key, m] of Object.entries(MODULE_META)) {
    if (!m.icon) continue;
    assert.ok(ICON_FILES[m.icon], `${key}: icon "${m.icon}" is not in ICON_FILES (the card would render <img src="">)`);
    assert.ok(iconUrl(m.icon), `${key}: no URL`);
    assert.ok(existsSync(new URL(`../src/shared/assets/nordla/official-icons/${ICON_FILES[m.icon]}`, import.meta.url)), `${key}: ${ICON_FILES[m.icon]} does not exist`);
  }
});
