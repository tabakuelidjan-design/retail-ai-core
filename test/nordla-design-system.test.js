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
  const css = readFileSync(new URL('../src/sourcing/nordla-ui/nordla-ds.css', import.meta.url), 'utf8');
  const tok = (n) => new RegExp(`--nd-${n}:\\s*(#[0-9A-Fa-f]{6})`).exec(css)[1];
  assert.equal(tok('bg'), '#F5F6F8'); assert.equal(tok('card'), '#FFFFFF'); assert.equal(tok('nav'), '#FAFBFC'); assert.equal(tok('bronze'), '#95652F');
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const fg of ['text', 'text-2', 'bronze', 'success', 'error']) for (const bg of ['bg', 'card', 'nav']) assert.ok(ratio(tok(fg), tok(bg)) >= 4.5, `${fg} on ${bg}: ${ratio(tok(fg), tok(bg)).toFixed(2)}`);
  for (const [fg, bg] of [['success', 'success-tint'], ['error', 'error-tint'], ['warning', 'warning-tint'], ['bronze-strong', 'bronze-tint']]) assert.ok(ratio(tok(fg), tok(bg)) >= 4.5, `${fg} on ${bg}`);
  assert.doesNotMatch(css, /gradient\(/i, 'no gradients');
  assert.doesNotMatch(css, /background:\s*#0{3,6}\b|background:\s*black/i, 'no black background');
  assert.doesNotMatch(css, /#(FFF8E7|FAF3E0|F5F0E6|FFFDD0|F5F5DC|1B4332|14532D)/i, 'no cream / dark-green');
});

test('the /nordla files stay OUT of the field app UI folder: the China Sourcing offline shell (built from src/sourcing/ui) is not changed', () => {
  const walk = (u) => readdirSync(u, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, u)) : [e.name]));
  const inUi = walk(new URL('../src/sourcing/ui/', import.meta.url)).filter((f) => /^nordla-(ds|view|home|mark)\.|^nordla\.html$/.test(f));
  assert.deepEqual(inUi, []);
});
