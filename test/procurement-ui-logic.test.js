import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecimal, parseInteger, buildQuotePayload, microToString, fmtMoney, poActions, describeOffer, addToCart, classifyHttp, backoffMs, PO_STATUS_FR } from '../src/procurement/ui/logic.js';

test('what a person types is read exactly or refused, never guessed', () => {
  assert.equal(parseDecimal('0,52'), '0.52'); assert.equal(parseDecimal(' 3.5 '), '3.5'); assert.equal(parseDecimal('0.035'), '0.035');
  for (const bad of ['', 'about 3', '¥3', '3 USD', '-1', '0', '1,2,3', '1e3', '0.1234567', null, undefined]) assert.equal(parseDecimal(bad), null, String(bad));
  assert.equal(parseInteger('500'), 500); for (const bad of ['0', '-5', '1.5', '5 000', '', 'abc']) assert.equal(parseInteger(bad), null, bad);
});

test('quote payload: single price, tiers, MOQ, Incoterm; every mistake is named in French', () => {
  const ok = buildQuotePayload({ currency: 'usd', unitPrice: '0,085', moq: '1000', tiers: [{ minQty: '5000', unitPrice: '0,072' }, { minQty: '', unitPrice: '' }], incoterm: 'FOB', leadTimeDays: '25', note: ' stand B12 ' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.quote, { currency: 'USD', tiers: [{ minQty: 1000, unitPrice: '0.085' }, { minQty: 5000, unitPrice: '0.072' }], moq: 1000, incoterm: 'FOB', leadTimeDays: 25, note: 'stand B12' });
  assert.deepEqual(buildQuotePayload({ currency: 'CNY', unitPrice: '2', tiers: [] }).quote, { currency: 'CNY', tiers: [{ minQty: 1, unitPrice: '2' }] });
  assert.deepEqual(buildQuotePayload({ currency: 'CNY', unitPrice: '', tiers: [{ minQty: '100', unitPrice: '1.5' }] }).quote.tiers, [{ minQty: 100, unitPrice: '1.5' }], 'tiers alone are enough');
  const e = (f) => buildQuotePayload({ currency: 'CNY', unitPrice: '1', moq: '', tiers: [], ...f });
  assert.match(e({ unitPrice: 'cheap' }).errors[0], /illisible/); assert.match(e({ currency: '' }).errors[0], /devise/);
  assert.match(e({ moq: 'many' }).errors.join(), /MOQ/); assert.match(e({ leadTimeDays: 'soon' }).errors.join(), /Délai/);
  assert.match(e({ tiers: [{ minQty: '1000', unitPrice: '2' }] }).errors.join(), /plus cher/); // a higher tier costs more than the base price
  assert.match(e({ moq: '100', tiers: [{ minQty: '100', unitPrice: '0.5' }] }).errors.join(), /même quantité/);
  assert.match(e({ tiers: [{ minQty: 'x', unitPrice: '1' }] }).errors.join(), /Palier 1/);
  assert.match(buildQuotePayload({ currency: 'USD', unitPrice: '', tiers: [] }).errors[0], /prix unitaire/i);
  assert.equal(buildQuotePayload({ currency: 'USD', unitPrice: '1', incoterm: 'XYZ' }).quote.incoterm, undefined, 'an unknown Incoterm is dropped, not sent');
});

test('formatting', () => {
  assert.equal(microToString(35000), '0.035'); assert.equal(microToString(500000), '0.5'); assert.equal(microToString(2_000_000), '2.0');
  assert.match(fmtMoney(36000, 'EUR'), /360[,.]00/); assert.match(fmtMoney(1050, 'USD'), /10[,.]50/);
  assert.equal(PO_STATUS_FR.PENDING_APPROVAL, 'À approuver');
});

test('which buttons a person sees on an order: no self-approval, no ordering without the right, engaging steps only for those who may', () => {
  const po = (status, over = {}) => ({ id: 'p', status, createdBy: 'terrain', submittedBy: 'terrain', ...over });
  const ids = (po_, me) => poActions(po_, me).map((a) => a.id);
  const field = { id: 'terrain', canApprove: false }; const owner = { id: 'owner', canApprove: true }; const preparer = { id: 'terrain', canApprove: true };
  assert.deepEqual(ids(po('DRAFT'), field), ['submit', 'cancel']);
  assert.deepEqual(ids(po('PENDING_APPROVAL'), field), []);
  assert.deepEqual(ids(po('PENDING_APPROVAL'), owner), ['approve', 'reject']);
  assert.deepEqual(ids(po('PENDING_APPROVAL'), preparer), ['blocked', 'reject'], 'the preparer is told why, and has no Approve button');
  assert.deepEqual(ids(po('APPROVED'), owner), ['order']); assert.ok(poActions(po('APPROVED'), owner)[0].confirm.includes('n’envoie rien'));
  assert.deepEqual(ids(po('APPROVED'), field), ['wait']);
  for (const st of ['ORDERED', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']) assert.deepEqual(ids(po(st), owner), [], st);
});

test('offer cards: landed, goods-only, and every reason an offer is not ranked, in plain French', () => {
  const base = { supplier: 'S', currency: 'USD', unitPrice: '0.085', incoterm: 'FOB', leadTimeDays: 25 };
  const landed = describeOffer({ ...base, status: 'LANDED', landedPerUnit: 78, estimated: true }, 5000);
  assert.equal(landed.usable, true); assert.match(landed.headline, /0[,.]78/); assert.ok(landed.chips.some((c) => /ESTIMÉ/.test(c.t))); assert.match(landed.detail, /pas un montant fiscal définitif/);
  const goods = describeOffer({ ...base, status: 'GOODS_ONLY', goodsUnitEur: 0.078 }, 5000);
  assert.equal(goods.usable, true); assert.match(goods.headline, /marchandises seules/); assert.match(goods.detail, /Transport et droits non saisis/);
  assert.match(describeOffer({ ...base, status: 'NOT_COMPARABLE', reason: 'FX_REQUIRED' }, 5000).headline, /taux USD → EUR/);
  const moq = describeOffer({ ...base, status: 'NOT_ELIGIBLE', reason: 'BELOW_MOQ' }, 100);
  assert.equal(moq.usable, false); assert.match(moq.headline, /MOQ/); assert.match(moq.detail, /100 pièces/);
});

test('the selection holds ONE supplier: a second supplier needs an explicit replace; one line per product', () => {
  const l = (supplierId, itemId, qty = 100) => ({ quoteId: `q-${supplierId}-${itemId}`, supplierId, itemId, qty });
  let r = addToCart([], l('s1', 'a')); assert.equal(r.cart.length, 1);
  r = addToCart(r.cart, l('s1', 'b')); assert.equal(r.cart.length, 2);
  r = addToCart(r.cart, l('s1', 'a', 999)); assert.deepEqual(r.cart.map((x) => [x.itemId, x.qty]), [['b', 100], ['a', 999]], 're-adding a product updates it, never duplicates it');
  const conflict = addToCart(r.cart, l('s2', 'c')); assert.equal(conflict.conflict, true); assert.equal(conflict.cart.length, 2, 'nothing changed without consent');
  assert.deepEqual(addToCart(r.cart, l('s2', 'c'), { replace: true }).cart.map((x) => x.supplierId), ['s2']);
});

test('the send queue: what to do with every answer from the server', () => {
  for (const s of [200, 201, 204]) assert.equal(classifyHttp(s), 'DONE', 'a replayed duplicate (200) is as good as a first success');
  for (const s of [0, 408, 425, 429, 500, 502, 503, 504]) assert.equal(classifyHttp(s), 'RETRY', String(s));
  for (const s of [400, 401, 403, 404, 409, 415, 422]) assert.equal(classifyHttp(s), 'REJECT', `${s} must not loop forever`);
  assert.deepEqual([1, 2, 3, 4, 10].map(backoffMs), [2000, 4000, 8000, 16000, 60000]);
});
