// Server-Timing: safe timings for the Finance answers (durations only). No ticket, no secret, no business value in the header.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './finance-dashboard-helpers.js';

test('a Finance answer reports its own processing time and the route step, and nothing secret', async () => {
  const h = await startApp();
  try {
    h.app.sessions.set('timing-1', { csrf: 'c'.repeat(48), expires: Date.now() + 3600_000 });
    const r = await fetch(`${h.base}/api/overview`, { headers: { Cookie: 'fin_sid=timing-1' } });
    assert.equal(r.status, 200);
    const timing = r.headers.get('server-timing');
    assert.ok(timing, 'Server-Timing is present');
    assert.match(timing, /app;dur=\d+(\.\d+)?/);
    assert.match(timing, /route;desc="\/api\/overview";dur=\d+(\.\d+)?/);
    assert.doesNotMatch(timing, /c{48}|fin_sid|secret|token|ticket|eyJ/i, 'no session, secret, token or ticket in the timing');
  } finally { await h.server.close(); }
});

test('the explicit start reports the settings step as its own duration', async () => {
  const h = await startApp();
  try {
    h.app.sessions.set('timing-2', { csrf: 'd'.repeat(48), expires: Date.now() + 3600_000 });
    const r = await fetch(`${h.base}/api/session?include=settings`, { headers: { Cookie: 'fin_sid=timing-2' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('server-timing') ?? '', /settings;dur=\d/);
  } finally { await h.server.close(); }
});
