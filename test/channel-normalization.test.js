// Sales-channel normalization: `pos` and `point_of_sale` are the same in-store channel for every engine that classifies
// an order's channel (customers, marketing, Growth). Existing channels keep their meaning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig } from '../src/metrics/config.js';
import { normalizeChannelHandle, isPosChannel, isOnlineChannel, CHANNEL_ALIASES } from '../src/metrics/channels.js';
import { orderGroup, buildCustomerFacts } from '../src/customers/facts.js';
import { classifyOrder } from '../src/marketing/taxonomy.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { audienceFacts } from '../src/growth/audience/facts.js';
import { buildAudience } from '../src/growth/audience/audience.js';
import { makeAudienceData, NOW, TZ } from './fixtures/audience-sample.js';

const config = mergeConfig();

test('channels: pos and point_of_sale (any case / separator) normalize to the same in-store channel', () => {
  assert.deepEqual(CHANNEL_ALIASES, { point_of_sale: 'pos' });
  for (const h of ['pos', 'POS', ' pos ', 'point_of_sale', 'Point_Of_Sale', 'point-of-sale', 'point of sale']) {
    assert.equal(normalizeChannelHandle(h), 'pos', h);
    assert.equal(isPosChannel(h, config), true, h);
    assert.equal(isOnlineChannel(h, config), false, h);
  }
  assert.equal(normalizeChannelHandle(null), null);
  assert.equal(normalizeChannelHandle('  '), null);
});

test('channels: existing channels keep their meaning (online stays online, other channels stay other)', () => {
  for (const h of ['web', 'online_store', 'Online-Store']) { assert.equal(isOnlineChannel(h, config), true, h); assert.equal(isPosChannel(h, config), false, h); }
  for (const h of ['facebook', 'google', 'shop', 'draft_order', null]) { assert.equal(isPosChannel(h, config), false, String(h)); assert.equal(isOnlineChannel(h, config), false, String(h)); }
  // A merchant list written with the long spelling matches the short one too.
  const custom = mergeConfig({ marketing: { posChannelHandles: ['point_of_sale'] } });
  assert.equal(isPosChannel('pos', custom), true);
});

test('channels: customers engine - a first in-store order is "first_recorded_pos" with either spelling (never "new")', () => {
  for (const h of ['pos', 'point_of_sale']) {
    const g = orderGroup({ customer_order_index: 1, journey_ready: true, channel_handle: h }, { online: isOnlineChannel(h, config), pos: isPosChannel(h, config) });
    assert.equal(g, 'first_recorded_pos', h);
  }
  // Through the full customers facts: same groups for the two spellings.
  const facts = (h) => {
    const data = makeAudienceData({ new: 3 });
    for (const o of data.orders) o.channel_handle = h;
    return buildCustomerFacts({ ledger: buildLedger(data, { config }), data, now: NOW, config }).new_vs_returning.groups;
  };
  const a = facts('pos'); const b = facts('point_of_sale');
  assert.equal(a.first_recorded_pos.orders, 3);
  assert.deepEqual(b, a);
});

test('channels: marketing taxonomy - point_of_sale is classified "pos" (it was "other_channel")', () => {
  for (const h of ['pos', 'point_of_sale']) {
    const c = classifyOrder({ channel_handle: h, source_name: null }, {}, config);
    assert.equal(c.channel, 'pos', h);
    assert.equal(c.rule, 'order_channel:pos');
  }
  assert.equal(classifyOrder({ channel_handle: 'online_store', source_name: null }, {}, config).channel, 'unattributed');
  assert.equal(classifyOrder({ channel_handle: 'facebook', source_name: null }, {}, config).channel, 'other_channel');
});

test('channels: Growth Audience - pos and point_of_sale produce the same payload', () => {
  const run = (h) => {
    const data = makeAudienceData({ new: 40, unknown: 10, anonymous: 35 });
    for (const o of data.orders) if (o.channel_handle === 'pos') o.channel_handle = h;
    // In-store first orders with a trusted index: the case where the channel decides the group.
    for (const o of data.orders) if (o.channel_handle === h) { o.journey_ready = true; o.customer_order_index = 1; }
    const f = audienceFacts({ data, now: NOW, timeZone: TZ, config });
    return buildAudience({ orders: f.orders, window: f.window, historyStart: f.historyStart, config, currency: f.currency });
  };
  const a = run('pos'); const b = run('point_of_sale');
  assert.ok(a.orderFacts.current.groups.first_recorded_pos > 0);
  assert.deepEqual(b, a);
});
