import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseClient } from '../src/supabase/client.js';

// Transient Supabase failures are retried; permanent ones and non-idempotent inserts are not. SYNTHETIC responses only.
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const bad = (status) => ({ ok: false, status, text: async () => '{"message":"Bad Gateway"}' });
const withFetch = async (responses, fn, cfg = {}) => {
  const real = globalThis.fetch; const calls = []; const pauses = [];
  globalThis.fetch = async (url, opts) => { calls.push(opts.method || 'GET'); const r = responses.shift(); if (r instanceof Error) throw r; return r; };
  try { return await fn(createSupabaseClient({ url: 'https://x.example.test', serviceRoleKey: 'k'.repeat(30), sleep: async (ms) => { pauses.push(ms); }, ...cfg }), calls, pauses); }
  finally { globalThis.fetch = real; }
};

test('a 502 then success: the read succeeds after one retry', () => withFetch([bad(502), ok([{ a: 1 }])], async (c, calls, pauses) => {
  assert.deepEqual(await c.select('t', {}), [{ a: 1 }]); assert.equal(calls.length, 2); assert.deepEqual(pauses, [500]);
}));

test('a network reset is retried, pauses grow, and after the limit the last error is thrown', () => withFetch([new Error('ECONNRESET'), bad(503), bad(504), bad(502)], async (c, calls, pauses) => {
  await assert.rejects(c.select('t', {}), /HTTP 502/); assert.equal(calls.length, 4, '1 try + 3 retries'); assert.deepEqual(pauses, [500, 1000, 2000]);
}));

test('a permanent error (400, 404, 409) is NOT retried', () => withFetch([bad(400)], async (c, calls) => {
  await assert.rejects(c.select('t', {}), /HTTP 400/); assert.equal(calls.length, 1);
}));

test('upserts are retried (safe to repeat) but the plain append-only insert is not', () => withFetch([bad(502), ok([{ id: 1 }])], async (c, calls) => {
  assert.deepEqual(await c.upsert('t', [{ a: 1 }], { onConflict: 'a' }), [{ id: 1 }]); assert.equal(calls.length, 2);
}).then(() => withFetch([bad(502), ok([{ id: 1 }])], async (c, calls) => {
  await assert.rejects(c.insert('t', [{ a: 1 }]), /HTTP 502/); assert.equal(calls.length, 1, 'a repeated plain insert could duplicate rows');
})));

test('retries can be turned off with retries: 0', () => withFetch([bad(502)], async (c, calls) => {
  await assert.rejects(c.select('t', {}), /HTTP 502/); assert.equal(calls.length, 1);
}, { retries: 0 }));

test('RPCs are never retried (a function may have run before the response was lost), while reads, upserts and deletes still are', () => withFetch([bad(504)], async (c, calls, pauses) => {
  await assert.rejects(c.rpc('fin_next_number', { p_type: 'invoice' }), /HTTP 504/); assert.equal(calls.length, 1, 'a repeated RPC could burn an invoice number'); assert.deepEqual(pauses, []);
}).then(() => withFetch([new Error('ECONNRESET')], async (c, calls) => {
  await assert.rejects(c.rpc('fin_issue_document', {}), /ECONNRESET/); assert.equal(calls.length, 1);
})).then(() => withFetch([bad(503), ok([{ a: 1 }]), bad(429), ok([{ id: 1 }]), bad(502), ok([])], async (c, calls) => {
  assert.deepEqual(await c.select('t', {}), [{ a: 1 }]);
  assert.deepEqual(await c.upsert('t', [{ a: 1 }], { onConflict: 'a' }), [{ id: 1 }]);
  assert.deepEqual(await c.delete('t', { id: 'eq.1' }), []);
  assert.deepEqual(calls, ['GET', 'GET', 'POST', 'POST', 'DELETE', 'DELETE']);
})));
