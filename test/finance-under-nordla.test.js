// Finance served under https://<nordla>/finance through the Core proxy. Pages, resources and API calls stay under /finance,
// the proxy rules keep Core's and Finance's cookies, origins and redirects apart, and the Finance service refuses direct calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rewriteLocation, rewriteSetCookie, filterCookies, originDecision } from '../src/shared/nordla-gateway.js';
const PREFIX = '/finance';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const uiDir = path.join(root, 'src/finance/ui');
const uiScripts = readdirSync(uiDir).filter((f) => f.endsWith('.js'));

test('the Finance page sets its base to /finance/ and references its resources relatively (no root-absolute URL)', () => {
  const html = read('src/finance/ui/index.html');
  assert.ok(html.includes('<base href="/finance/">'), 'the base is the Finance prefix');
  assert.doesNotMatch(html.replace('<base href="/finance/">', ''), /(href|src)="\/(?!\/)/, 'no root-absolute href or src (the base tag is the one allowed)');
  assert.doesNotMatch(read('src/finance/ui/style.css'), /url\(\s*['"]?\//, 'no root-absolute url() in the Finance stylesheet');
});

test('no Finance script builds a root-absolute address: every API call and link is relative to /finance/', () => {
  for (const f of uiScripts) {
    const src = read(`src/finance/ui/${f}`);
    assert.doesNotMatch(src, /['"`]\/api\//, `${f}: no root /api/ literal (would reach Core)`);
    assert.doesNotMatch(src, /['"`]\/nordla-/, `${f}: no root /nordla- asset literal`);
    assert.doesNotMatch(src, /url\(\s*['"]?\/(?!\/)/, `${f}: no root url()`);
  }
});

test('the API client is the only fetch site and takes the relative path', () => {
  const app = read('src/finance/ui/app.js');
  const fetches = uiScripts.flatMap((f) => [...read(`src/finance/ui/${f}`).matchAll(/\bfetch\(([^,)]*)/g)].map((m) => `${f}: ${m[1]}`));
  assert.deepEqual(fetches, ['app.js: path'], 'every request goes through api(path)');
  assert.match(app, /async function api\(method, path, body\) \{[\s\S]*?const res = await fetch\(path,/);
  assert.match(app, /function coreCsrf\(\) \{[^}]*__Host-nordla_sourcing_csrf=/, 'the Core CSRF token is read from the Core cookie, never stored or invented');
  assert.match(app, /'x-nordla-csrf': core/, 'every change carries the Core CSRF token; Finance keeps its own X-CSRF-Token');
  assert.ok(app.includes("path !== 'api/login'"), 'the login check uses the relative path');
});

test('the Finance service refuses a direct call without the Nordla proxy secret (and the CSP lets the base tag work)', () => {
  const app = read('src/finance/server/app.js');
  assert.match(app, /if \(deps\.proxySecret && !proxySecretOk\(req, deps\.proxySecret\)\) throw new HttpError\(403, 'PROXY_SECRET_REQUIRED'\)/);
  assert.match(app, /base-uri 'self'; form-action 'self'/);
  assert.doesNotMatch(app, /base-uri 'none'/);
});

test('proxy: Finance paths stay under /finance on the Nordla origin; redirects and session cookies are rewritten', () => {
  assert.equal(PREFIX, '/finance');
  assert.equal(rewriteLocation('/', 'http://f.internal'), '/finance/');
  assert.equal(rewriteLocation('/#/purchases?open=x', 'http://f.internal'), '/finance/#/purchases?open=x');
  assert.equal(rewriteLocation('http://f.internal/#/todo', 'http://f.internal'), '/finance/#/todo');
  assert.equal(rewriteLocation('https://elsewhere.example/', 'http://f.internal'), 'https://elsewhere.example/', 'foreign addresses untouched');
  assert.equal(rewriteSetCookie('fin_sid=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800'), 'fin_sid=abc; HttpOnly; SameSite=Strict; Path=/finance; Max-Age=28800');
});

test('proxy: Core cookies never reach Finance; only the Finance session cookie is forwarded', () => {
  assert.equal(filterCookies('core_session=1; fin_sid=abc; other=2'), 'fin_sid=abc');
  assert.equal(filterCookies('fin_demo_sid=xyz'), 'fin_demo_sid=xyz');
  assert.equal(filterCookies('core_session=1'), undefined);
  assert.equal(filterCookies(undefined), undefined);
});

test('proxy: a mutation is accepted only from the Nordla origin itself (rewritten to the upstream origin); a foreign origin is refused', () => {
  const pub = 'https://staging.nordla.app'; const up = 'http://f.internal';
  assert.deepEqual(originDecision(pub, pub, up), { ok: true, origin: up });
  assert.deepEqual(originDecision(undefined, pub, up), { ok: true, origin: undefined });
  assert.deepEqual(originDecision('https://evil.example', pub, up), { ok: false, status: 403, code: 'ORIGIN_NOT_ALLOWED' });
  assert.deepEqual(originDecision('https://staging.nordla.app.evil.example', pub, up), { ok: false, status: 403, code: 'ORIGIN_NOT_ALLOWED' });
});

test('the Core CSRF token is read from the Core cookie by running the Finance code (a regex that reads the wrong text fails here)', () => {
  const app = read('src/finance/ui/app.js');
  const fn = app.match(/function coreCsrf\(\) \{[\s\S]*?\n\}/)?.[0] ?? app.match(/function coreCsrf\(\) \{.*\}/)?.[0];
  assert.ok(fn, 'coreCsrf is defined');
  const token = 'A'.repeat(43);
  const run = (cookie) => new Function('document', `${fn}; return coreCsrf();`)({ cookie });
  assert.equal(run(`fin_sid=x; __Host-nordla_sourcing_csrf=${token}; other=1`), token);
  assert.equal(run(`__Host-nordla_sourcing_csrf=${token}`), token);
  assert.equal(run('fin_sid=x; other=1'), '', 'no Core cookie: nothing is sent');
  assert.equal(run(`xx__Host-nordla_sourcing_csrf=${token}`), '', 'a cookie only matches by its exact name');
  assert.equal(run('__Host-nordla_sourcing_csrf=short'), '', 'a token of the wrong shape is not sent');
});
