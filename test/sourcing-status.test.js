// Regression for the physical-phone defect: through a real Cloudflare tunnel the authenticated health check SUCCEEDED (200) while the header said "OFFLINE - VERIFY",
// because one badge mixed two different facts: (1) is the server verified RIGHT NOW (authenticated), (2) what Safety Gate data does the phone hold and how fresh is it.
// Rules: SERVER VERIFIED only after an authenticated live check succeeded recently; the Safety Gate state is separate; LIVE needs BOTH; nothing is shown LIVE otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { headerStatus, serverState, safetyState } from '../src/sourcing/core/status.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const live = { present: true, fetchedAt: NOW - 3600e3, serverMode: 'LIVE_VERIFIED' };

test('server verified + NO Safety Gate copy yet: the server is VERIFIED, the Safety Gate is NONE - never "offline" (the physical-phone defect)', () => {
  const h = headerStatus({ hasToken: true, verifiedAt: NOW - 5000, now: NOW, copy: { present: false } });
  assert.equal(h.server.state, 'VERIFIED'); assert.equal(h.server.label, 'SERVER VERIFIED'); assert.equal(h.safety.state, 'NONE');
  assert.equal(/OFFLINE/.test(`${h.server.label} ${h.safety.label}`), false, 'a reachable, authenticated server must never be labelled offline');
  assert.match(h.safety.label, /NONE/); assert.equal(h.safety.action, 'DOWNLOAD', 'the app offers (and auto-starts) the download');
});

test('LIVE needs BOTH an authenticated server check AND a live, fresh copy; each missing piece fails closed', () => {
  assert.equal(headerStatus({ hasToken: true, verifiedAt: NOW - 5000, now: NOW, copy: live }).safety.state, 'LIVE');
  // server not verified (never, or too long ago): the same copy is CACHED, never LIVE
  assert.equal(headerStatus({ hasToken: true, verifiedAt: 0, now: NOW, copy: live }).safety.state, 'CACHED');
  assert.equal(headerStatus({ hasToken: true, verifiedAt: NOW - 10 * 60e3, now: NOW, copy: live }).safety.state, 'CACHED');
  // copy too old, or the server's own copy was not live
  assert.equal(headerStatus({ hasToken: true, verifiedAt: NOW - 5000, now: NOW, copy: { ...live, fetchedAt: NOW - 30 * 3600e3 } }).safety.state, 'CACHED');
  assert.equal(headerStatus({ hasToken: true, verifiedAt: NOW - 5000, now: NOW, copy: { ...live, serverMode: 'CACHED' } }).safety.state, 'CACHED');
  // no token / refused token: never verified, never LIVE
  assert.equal(headerStatus({ hasToken: false, verifiedAt: NOW - 1000, now: NOW, copy: live }).safety.state, 'CACHED');
  assert.equal(headerStatus({ hasToken: true, authFailed: true, verifiedAt: NOW - 1000, now: NOW, copy: live }).server.state, 'TOKEN_REFUSED');
  assert.equal(headerStatus({ hasToken: true, authFailed: true, verifiedAt: NOW - 1000, now: NOW, copy: live }).safety.state, 'CACHED');
});

test('server states are distinct and honest', () => {
  assert.equal(serverState({ hasToken: true, verifiedAt: NOW - 5000, now: NOW }).state, 'VERIFIED');
  assert.equal(serverState({ hasToken: true, verifiedAt: 0, now: NOW }).state, 'UNREACHABLE'); assert.equal(serverState({ hasToken: true, verifiedAt: 0, now: NOW }).label, 'NO SERVER');
  assert.equal(serverState({ hasToken: true, verifiedAt: NOW - 200e3, now: NOW }).state, 'UNREACHABLE', 'a verification older than the grace window no longer counts');
  assert.equal(serverState({ hasToken: false, offlineChoice: true, now: NOW }).state, 'PHONE_ONLY'); assert.equal(serverState({ hasToken: false, offlineChoice: false, now: NOW }).state, 'NOT_SIGNED_IN');
  assert.equal(serverState({ hasToken: true, lockedOut: true, now: NOW }).state, 'LOCKED_OUT');
});

test('a CACHED / NONE copy still says what to do next, and the label text never contains the word LIVE unless verified', () => {
  for (const copy of [{ present: false }, { ...live, serverMode: 'CACHED' }]) for (const verifiedAt of [0, NOW - 1000]) {
    const h = headerStatus({ hasToken: true, verifiedAt, now: NOW, copy });
    if (h.safety.state !== 'LIVE') assert.equal(/LIVE/.test(h.safety.label), false, h.safety.label);
  }
  assert.match(headerStatus({ hasToken: true, verifiedAt: 0, now: NOW, copy: live }).safety.label, /CACHED/);
  assert.equal(safetyState({ serverVerified: false, copy: live, now: NOW }).state, 'CACHED');
});
