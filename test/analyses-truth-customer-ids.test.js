import test from 'node:test';
import assert from 'node:assert/strict';
import { safeCustomerIds, LABEL_MIN_CHARS } from '../src/report/customers-workspace.js';

// Found by the Phase 0 serving benchmark: the pseudonymous label of each customer (shortest unique upper-case prefix) was computed in cubic time
// (every key compared with every other key at every prefix length): 8 s for 6 000 customers, blocking the whole server. The result must not change.
const MAX = 12;
/** The previous implementation, verbatim: the reference the fast one must equal. */
function reference(keys) {
  const out = new Map(); const list = [...new Set(keys)];
  for (const k of list) {
    let n = LABEL_MIN_CHARS;
    while (n < MAX && list.some((o) => o !== k && o.slice(0, n).toUpperCase() === k.slice(0, n).toUpperCase())) n += 1;
    out.set(k, k.slice(0, n).toUpperCase());
  }
  return out;
}
const prng = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; };

test('K1. same labels as the reference on 400 random key sets (collisions, mixed case, case-only duplicates, short keys, long shared prefixes)', () => {
  const rnd = prng(7);
  for (let t = 0; t < 400; t += 1) {
    const alphabet = ['ab', 'abAB', 'abcdef0123', 'aAbBcC'][t % 4]; const n = 1 + Math.floor(rnd() * 40); const keys = [];
    for (let i = 0; i < n; i += 1) { const len = 1 + Math.floor(rnd() * 16); let k = ''; for (let j = 0; j < len; j += 1) k += alphabet[Math.floor(rnd() * alphabet.length)]; keys.push(k); }
    if (t % 5 === 0) keys.push(keys[0].toUpperCase(), `${keys[0]}z`);
    assert.deepEqual([...safeCustomerIds(keys)], [...reference(keys)], `trial ${t}: ${JSON.stringify(keys)}`);
  }
});

test('K2. the documented behaviour still holds (existing contract)', () => {
  const ids = safeCustomerIds(['abcd1111', 'abcd2222', 'ffff0000']);
  assert.equal(ids.get('ffff0000'), 'FFFF'); assert.equal(ids.get('abcd1111'), 'ABCD1'); assert.equal(ids.get('abcd2222'), 'ABCD2');
});

test('K3. 6 000 customers are labelled in well under a second (it was 8 seconds)', () => {
  const rnd = prng(11); const keys = Array.from({ length: 6000 }, () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join(''));
  const t0 = performance.now(); const ids = safeCustomerIds(keys); const ms = performance.now() - t0;
  assert.equal(ids.size, 6000); assert.equal(new Set(ids.values()).size, 6000, 'labels are unique');
  assert.ok(ms < 500, `took ${Math.round(ms)} ms`);
});

test('K4. local-date helpers reuse their formatters: far cheaper than building a formatter per call, results unchanged across a DST change', async () => {
  // The property under test is REUSE (building an Intl.DateTimeFormat costs ~100 us). It is asserted as a RATIO against the naive per-call construction measured in the same process, back to back,
  // so a loaded machine (parallel suites, CI) slows both sides equally. An absolute wall-clock bound made this test fail intermittently under CPU load. Without reuse the ratio is about 1; with reuse about 50.
  const { localDateString, localMidnight } = await import('../src/metrics/windows.js');
  const base = Date.parse('2026-03-28T00:00:00Z'); const step = 3_600_000 / 4; let last = '';
  const perCall = (fn, n) => { const t0 = performance.now(); for (let i = 0; i < n; i += 1) last = fn(new Date(base + i * step)); return (performance.now() - t0) / n; };
  const cached = (d) => localDateString(d, 'Europe/Brussels');
  const naive = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  perCall(cached, 2000); perCall(naive, 100); // warm-up
  const ratios = []; for (let r = 0; r < 5; r += 1) ratios.push(perCall(naive, 400) / perCall(cached, 20000));
  ratios.sort((x, y) => x - y); const median = ratios[2];
  assert.equal(localDateString(new Date('2026-03-28T23:30:00Z'), 'Europe/Brussels'), '2026-03-29'); assert.equal(localDateString(new Date('2026-03-28T22:30:00Z'), 'Europe/Brussels'), '2026-03-28');
  assert.equal(localMidnight('2026-03-29', 'Europe/Brussels').toISOString(), '2026-03-28T23:00:00.000Z'); assert.equal(localMidnight('2026-03-30', 'Europe/Brussels').toISOString(), '2026-03-29T22:00:00.000Z');
  assert.ok(last); assert.ok(median >= 10, `formatters are not being reused: cached call is only ${median.toFixed(1)}x cheaper than building one per call (expected about 50x)`);
});
