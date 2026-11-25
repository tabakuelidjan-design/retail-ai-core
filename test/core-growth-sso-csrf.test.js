// The Core opens Growth with a one-time ticket: POST /growth/sso. Every authenticated POST through the Core needs the CSRF header
// (security guardMutation refuses it with 403 FORBIDDEN otherwise, before Growth reads the ticket). This pins the browser call to the
// same header the Core's own api() helper sends, in the same auth mode, so the Growth ticket POST cannot silently lose it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/sourcing/ui/app.js', import.meta.url), 'utf8');

test('the Growth ticket POST sends the CSRF header the Core api() helper sends, in the same auth mode', () => {
  const start = SRC.indexOf("fetch('/growth/sso'");
  assert.ok(start > 0, 'the Growth ticket POST exists in the Core UI');
  const call = SRC.slice(start, SRC.indexOf('.toString() });', start) + 14);
  assert.match(call, /method: 'POST'/);
  assert.match(call, /'content-type': 'application\/x-www-form-urlencoded'/);
  assert.match(call, /S\.authMode === 'session' \? \{ 'x-nordla-csrf': csrfToken\(\) \} : \{\}/, 'the header is sent in session mode, like api()');
});

test('the same header name is used by the Core api() helper (no second spelling)', () => {
  const apiLine = SRC.split('\n').find((l) => l.startsWith('const api = async'));
  assert.ok(apiLine && apiLine.includes("'x-nordla-csrf': csrfToken()"));
  assert.ok(SRC.includes("import { csrfToken"), 'csrfToken is imported in the Core UI');
});
