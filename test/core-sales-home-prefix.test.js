import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSalesHome } from '../src/core-pilot/sales-home.js';

// Analytics under the Nordla origin: its public base keeps the gateway prefix, so the ticket and the brief stay under /analyses.
test('Core sales home keeps the /analyses prefix when Analytics is reached through the Nordla origin', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).includes('/sso?t=')) return new Response(null, { status: 302, headers: { 'set-cookie': 'an_sid=abc; Path=/; HttpOnly' } });
    return new Response('{}', { status: 404 });
  };
  const s = await loadSalesHome({ publicUrl: 'https://staging.nordla.app/analyses', ticket: 'tk.1', fetchImpl });
  assert.equal(s.status, 'NOT_CONNECTED');
  assert.ok(seen[0].startsWith('https://staging.nordla.app/analyses/sso?t=tk.1'), seen[0]);
  assert.equal(seen[1], 'https://staging.nordla.app/analyses/api/brief');
});

test('Core sales home still works with Analytics on its own domain (no prefix)', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(String(url)); return String(url).includes('/sso?t=') ? new Response(null, { status: 302, headers: { 'set-cookie': 'an_sid=abc; Path=/' } }) : new Response('{}', { status: 404 }); };
  await loadSalesHome({ publicUrl: 'https://analytics.example.app', ticket: 'tk.2', fetchImpl });
  assert.ok(seen[0].startsWith('https://analytics.example.app/sso?t=tk.2'), seen[0]);
  assert.equal(seen[1], 'https://analytics.example.app/api/brief');
});

test('Core sales home sends the proxy secret on the ticket call, and the brief with the session cookie only', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), h: opts.headers ?? {} });
    return String(url).includes('/sso?t=') ? new Response(null, { status: 302, headers: { 'set-cookie': 'an_sid=abc; Path=/' } }) : new Response('{}', { status: 404 });
  };
  await loadSalesHome({ publicUrl: 'https://analytics-up.example.app', ticket: 'tk.3', headers: { 'x-nordla-proxy-secret': 'S'.repeat(24) }, fetchImpl });
  assert.equal(calls[0].h['x-nordla-proxy-secret'], 'S'.repeat(24));
  assert.equal(calls[1].h['x-nordla-proxy-secret'], undefined, 'the brief carries no proxy secret');
  assert.equal(calls[1].h.cookie, 'an_sid=abc');
});
