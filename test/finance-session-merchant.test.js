// Finance: the merchant of a request comes from the server-side session, which was opened from a Core ticket verified for this server's
// merchant. A session of one merchant is never served by another merchant's server, and the Shopify data of one merchant is never read
// for another. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSessionStore, sessionServesMerchant } from '../src/finance/server/session-store.js';
import { createTicketVerifier, issueTicket } from '../src/finance/sso-ticket.js';
import { createShopifyConnector } from '../src/connectors/shopify.js';
import { createConnectorRepository } from '../src/tenant/connectors.js';

const FIRST = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb';
const OTHER = '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0';
const SECRET = Buffer.alloc(32, 7).toString('base64url'); // a canonical 32-byte SSO key (43 base64url characters)
const PERSON = { userId: '11111111-1111-4111-8111-111111111111', role: 'OWNER', module: 'finance' };
const SID = '22222222-2222-4222-8222-222222222222';

test('an SSO session opened for FIRST is served by FIRST and by no other merchant', () => {
  const firstSession = { csrf: 'c', expires: Date.now() + 60_000, sso: { userId: PERSON.userId, role: 'OWNER', merchantId: FIRST } };
  assert.equal(sessionServesMerchant(firstSession, FIRST, { ssoOnly: true }), true);
  assert.equal(sessionServesMerchant(firstSession, OTHER, { ssoOnly: true }), false, 'another merchant\'s server refuses it');
  assert.equal(sessionServesMerchant(firstSession, OTHER, { ssoOnly: false }), false, 'also in local mode: a bound session is never shared');
});

test('hosted (SSO-only) mode refuses any session that is not bound to a merchant; the local token mode keeps working', () => {
  const unbound = { csrf: 'c', expires: Date.now() + 60_000 };
  assert.equal(sessionServesMerchant(unbound, FIRST, { ssoOnly: true }), false);
  assert.equal(sessionServesMerchant(unbound, FIRST, { ssoOnly: false }), true);
  assert.equal(sessionServesMerchant(null, FIRST, { ssoOnly: false }), false);
});

test('the merchant is kept by the session store across a round trip (persisted form included)', async () => {
  const store = createSessionStore();
  store.set(SID, { csrf: 'c', expires: Date.now() + 60_000, sso: { userId: PERSON.userId, role: 'OWNER', merchantId: FIRST } });
  assert.equal(store.get(SID).sso.merchantId, FIRST);
  const saved = []; const persistence = { load: () => saved, save: (s) => { saved.length = 0; saved.push(...s); } };
  const a = createSessionStore({ persistence });
  a.set(SID, { csrf: 'c', expires: Date.now() + 60_000, sso: { userId: PERSON.userId, role: 'OWNER', merchantId: FIRST } });
  await a.flush();
  const b = createSessionStore({ persistence });
  assert.equal(b.get(SID)?.sso?.merchantId, FIRST);
});

test('a ticket issued for FIRST is refused by another merchant\'s server (no session can be opened for the wrong merchant)', () => {
  const ticket = issueTicket({ secret: SECRET, merchantId: FIRST, person: PERSON, id: () => 'a'.repeat(32) });
  const otherServer = createTicketVerifier({ secret: SECRET, merchantId: OTHER, module: 'finance', requirePerson: true });
  assert.equal(otherServer.verify(ticket).code, 'SSO_WRONG_MERCHANT');
  const firstServer = createTicketVerifier({ secret: SECRET, merchantId: FIRST, module: 'finance', requirePerson: true });
  assert.equal(firstServer.verify(ticket).ok, true);
});

test('the merchant is never taken from the request: a forged merchant in the URL or the body changes nothing', () => {
  const ticket = issueTicket({ secret: SECRET, merchantId: FIRST, person: PERSON, id: () => 'b'.repeat(32) });
  const verifier = createTicketVerifier({ secret: SECRET, merchantId: OTHER, module: 'finance', requirePerson: true });
  const forgedUrl = `${ticket}&merchantId=${FIRST}`;
  assert.notEqual(verifier.verify(forgedUrl).ok, true, 'a ticket with an appended merchant is not a valid ticket');
  assert.equal(verifier.verify(ticket).code, 'SSO_WRONG_MERCHANT', 'the ticket still names FIRST and is refused by OTHER');
});

test('FIRST\'s session cannot reach another merchant\'s Shopify: the connector of the other merchant never uses FIRST\'s credentials', async () => {
  const firstOAuth = { id: 'c-first', merchant_id: FIRST, kind: 'shopify', external_id: 'gid://shopify/Shop/900011', status: 'CONFIGURED', config: { provisioned_via: 'oauth', shop_domain: 'first-shop.myshopify.example' } };
  const rows = [firstOAuth];
  const supabase = { select: async (table, params = {}) => (table === 'merchant_connectors' ? rows.filter((r) => !params.merchant_id || params.merchant_id === `eq.${r.merchant_id}`) : []) };
  const built = [];
  const connectors = createConnectorRepository({ supabase });
  const other = createShopifyConnector({ env: {}, merchantId: OTHER, connectors, credentialsFor: async (id) => ({ state: id === FIRST ? 'CONFIGURED' : 'NOT_CONNECTED', shopDomain: 'first-shop.myshopify.example', apiVersion: '2024-10', accessToken: 'shpat_first_secret_0001' }), createClient: (c) => { built.push(c); return { graphql: async () => ({ shop: { id: 'x' } }) }; } });
  assert.equal(await other.state({ verify: true }), 'NOT_CONFIGURED', 'OTHER has no Shopify connection');
  assert.equal(built.length, 0, 'no client, so FIRST\'s token and shop are never used for OTHER');
});
