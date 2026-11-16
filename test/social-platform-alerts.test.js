import test from 'node:test';
import assert from 'node:assert/strict';

import {
  igRoutes, fbRoutes, ok, runtime, scheduled, PAGE_ID,
} from './social-fixtures.js';

const DUE = Date.parse('2026-10-17T17:00:30Z');

test('NP-1 the live connection check failing on the network is a plain retry: nothing was sent, so never UNKNOWN, and the post is published once the network is back', async () => {
  let down = true;
  const rt = runtime({ ig: igRoutes({ 'GET /me': () => (down ? new Error('ECONNRESET') : ok({ user_id: '17841400000000001', username: 'habb.be', account_type: 'Business' })) }) });
  const p = await scheduled(rt);
  rt.clock.now = DUE;
  await rt.publisher.runDue();
  let cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'SCHEDULED');
  assert.equal(cur.publication.last_error, 'PROVIDER_UNAVAILABLE');
  assert.equal(rt.igHttp.count('POST', '/media'), 0, 'no container created while the account could not be checked');
  down = false;
  rt.clock.tick(2 * 60_000);
  await rt.publisher.runDue();
  cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'PUBLISHED');
  assert.equal(rt.igHttp.count('POST', '/media_publish'), 1);
});

test('NP-2 the container status read timing out (nothing was published yet) retries and RESUMES the same container, never UNKNOWN, never a second container', async () => {
  let failStatus = true;
  const rt = runtime({ ig: igRoutes({ 'GET /container-1': () => (failStatus ? new Error('timeout') : ok({ status_code: 'FINISHED' })) }) });
  const p = await scheduled(rt);
  rt.clock.now = DUE;
  await rt.publisher.runDue();
  let cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'SCHEDULED');
  assert.equal(rt.igHttp.count('POST', '/media_publish'), 0);
  failStatus = false;
  rt.clock.tick(5 * 60_000);
  await rt.publisher.runDue();
  cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'PUBLISHED');
  assert.equal(rt.igHttp.count('POST', '/media'), 1, 'one container');
  assert.equal(rt.igHttp.count('POST', '/media_publish'), 1, 'one publication');
});

test('NP-3 a Facebook copy held by the platform that is STILL unpublished long after its time is signalled to the owner (not silently ignored)', async () => {
  const rt = runtime({ withFacebook: true });
  const p = await scheduled(rt, { platform: 'facebook', publish_at: '2026-10-20T17:00:00Z' });
  await rt.publisher.runDue(); // armed natively; the fake keeps answering is_published:false
  rt.clock.now = Date.parse('2026-10-20T17:00:00Z') + 3 * 3600_000; // 3 h after the scheduled time
  await rt.publisher.runDue();
  const cur = await rt.service.get(p.id);
  assert.equal(cur.state, 'SCHEDULED');
  assert.ok(cur.history.some((h) => h.detail?.alert === 'PLATFORM_SCHEDULE_OVERDUE'), 'the history must say that the platform copy did not publish');
});

test('NP-4 the same overdue alert is written once, not on every pass', async () => {
  const rt = runtime({ withFacebook: true });
  const p = await scheduled(rt, { platform: 'facebook', publish_at: '2026-10-20T17:00:00Z' });
  await rt.publisher.runDue();
  rt.clock.now = Date.parse('2026-10-20T17:00:00Z') + 3 * 3600_000;
  for (let i = 0; i < 5; i += 1) { await rt.publisher.runDue(); rt.clock.tick(60_000); }
  const cur = await rt.service.get(p.id);
  assert.equal(cur.history.filter((h) => h.detail?.alert === 'PLATFORM_SCHEDULE_OVERDUE').length, 1);
});
test('NP-5 a platform copy that vanished is signalled once, not on every pass', async () => {
  const rt = runtime({ withFacebook: true, fb: fbRoutes({ [`GET /${PAGE_ID}_9001`]: { status: 404, headers: {}, body: { error: { code: 100 } } } }) });
  const p = await scheduled(rt, { platform: 'facebook', publish_at: '2026-10-20T17:00:00Z' });
  await rt.publisher.runDue();
  rt.clock.now = Date.parse('2026-10-20T17:10:00Z');
  for (let i = 0; i < 5; i += 1) { await rt.publisher.runDue(); rt.clock.tick(60_000); }
  const cur = await rt.service.get(p.id);
  assert.equal(cur.history.filter((h) => h.detail?.alert === 'PLATFORM_SCHEDULE_MISSING').length, 1);
});

