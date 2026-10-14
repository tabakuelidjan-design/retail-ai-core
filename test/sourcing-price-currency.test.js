// NORDLA price + currency: a price is an amount AND a currency, and each is CONFIRMED, PROPOSED or UNKNOWN. "$" is never USD by itself; an unknown currency is never turned into a confirmed one by a display, a calculation or a comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSalonViews } from './sourcing-salon-load.js';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { createFieldEngine } from '../src/sourcing/core/field/engine.js';
import { compareDeals } from '../src/sourcing/core/field/deal.js';
import { landedCost } from '../src/sourcing/core/landed.js';
import { priceOfCase, priceWording, priceOfQuote, PRICE_STATUS } from '../src/sourcing/core/price-display.js';
import { quoteFormEvent, quickQuoteEvent } from '../src/sourcing/core/form-events.js';

const V = await loadSalonViews(); const N = await import(new URL('../src/sourcing/ui/screens/nx.js', import.meta.url).href);
const T0 = new Date('2026-10-20T08:00:00Z'); const at = (m) => new Date(T0.getTime() + m * 60000);
/** a case where the supplier said `text`; `confirm` lists the candidate keys the owner confirms (nothing is confirmed by itself) */
function supplier(name, text, confirm = []) {
  let c = newCase({ id: name.toLowerCase(), name: 'produit', now: T0 }); c = dispatch(c, { type: 'SUPPLIER', supplier: { name } }, at(0));
  c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: name, lang: 'auto' }, at(1)); c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: c.conversations[0].id, speaker: 'supplier', lang: 'auto', text }, at(2));
  for (const k of c.candidates.filter((x) => confirm.includes(x.key))) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(3));
  return c;
}
const PRICE = 'quote.unitPrice'; const CUR = 'quote.currency';

test('1. 12 USD confirmed (amount AND currency confirmed by the owner): "12 USD"', () => {
  const p = priceOfCase(supplier('A', 'price 12 USD, MOQ 60', [PRICE, CUR]));
  assert.equal(p.status, PRICE_STATUS.CONFIRMED); assert.equal(p.text, '12 USD'); assert.equal(p.currency, 'USD');
});
test('2. 12 EUR confirmed: "12 EUR" (the currency is the one the supplier said, not a default)', () => {
  const p = priceOfCase(supplier('B', 'price 12 EUR, MOQ 60', [PRICE, CUR])); assert.equal(p.text, '12 EUR'); assert.equal(p.status, PRICE_STATUS.CONFIRMED);
});
test('3. Sonny: amount confirmed, currency read from "$" is only PROPOSED -> "12 — devise à confirmer" (the USD proposal is kept as a proposal, never written next to the amount as a fact)', () => {
  const c = supplier('Sonny', 'prix 12$, MOQ 60', [PRICE, 'quote.moq']); const k = c.candidates.find((x) => x.key === CUR); assert.equal(k.state, 'PROPOSED'); assert.equal(k.value, 'USD', '"$" is proposed as USD, nothing more');
  const p = priceOfCase(c); assert.equal(p.status, PRICE_STATUS.CURRENCY_TO_CONFIRM); assert.equal(p.text, '12 — devise à confirmer'); assert.equal(p.currency, null); assert.equal(p.proposedCurrency, 'USD'); assert.doesNotMatch(p.text, /USD/);
  assert.equal(c.ledger.some((e) => e.key === CUR), false, 'no currency fact'); assert.equal(c.quotes.at(-1).currency, undefined, 'the quote holds no currency');
});
test('4. 12 with NO currency at all: "12 — devise à confirmer", nothing proposed either', () => {
  const c = supplier('C', 'prix 12, MOQ 60', [PRICE]); assert.equal(c.candidates.some((x) => x.key === CUR), false); const p = priceOfCase(c); assert.equal(p.text, '12 — devise à confirmer'); assert.equal(p.proposedCurrency, null);
});
test('5. amount only PROPOSED, currency unknown or proposed: the price says it still has to be confirmed', () => {
  const none = priceOfCase(supplier('D', 'prix 12$')); assert.equal(none.status, PRICE_STATUS.PRICE_TO_CONFIRM); assert.equal(none.text, '12 — prix et devise à confirmer'); assert.equal(none.proposedCurrency, 'USD'); assert.doesNotMatch(none.text, /USD/);
  const curOnly = priceOfCase(supplier('E', 'price 12 EUR', [CUR])); assert.equal(curOnly.text, '12 EUR — prix à confirmer'); assert.equal(curOnly.status, PRICE_STATUS.PRICE_TO_CONFIRM);
  assert.equal(priceOfCase(newCase({ id: 'z', name: 'x', now: T0 })).text, 'inconnu'); assert.equal(priceWording({ amount: null }).status, PRICE_STATUS.UNKNOWN);
});
test('6. a currency CORRECTED by the owner replaces the proposal: "12 USD" -> "12 EUR"; the earlier value stays in the history, the correction is attributed to the owner', () => {
  let c = supplier('F', 'price 12 USD', [PRICE, CUR]); assert.equal(priceOfCase(c).text, '12 USD');
  c = dispatch(c, { type: 'FACT_CORRECT', factType: 'CURRENCY', value: 'EUR', mode: 'salon' }, at(10)); assert.equal(priceOfCase(c).text, '12 EUR'); assert.equal(c.quotes.at(-1).currency, 'EUR');
  assert.ok(c.ledger.some((e) => e.key === CUR && e.value === 'USD'), 'the USD entry is kept'); const eur = c.ledger.find((e) => e.key === CUR && e.value === 'EUR'); assert.ok(eur && eur.status === 'USER_PROVIDED', 'EUR is the owner\'s word, not the supplier\'s');
  const sonny = supplier('G', 'prix 12$', [PRICE]); const k = sonny.candidates.find((x) => x.key === CUR); const fixed = dispatch(sonny, { type: 'CANDIDATE_CORRECT', id: k.id, value: 'CNY' }, at(10)); assert.equal(priceOfCase(fixed).text, '12 CNY');
});
test('7. economics: an unknown currency is NEVER treated as USD or EUR - the landed cost, the maximum price and the brief stay unavailable until the owner confirms it', () => {
  let c = supplier('Sonny', 'prix 12$, MOQ 60', [PRICE, 'quote.moq']); c = dispatch(c, { type: 'COSTS', costs: { fx: { rate: 0.92, date: '2026-10-02', source: 'USER_ENTERED' }, costs: { freight: { total: 100, status: 'ESTIMATED' } } } }, at(5));
  let a = assess(c, { now: at(6), externals: {} }); assert.equal(a.landed.status, 'INFORMATION_INSUFFICIENT'); assert.ok(a.landed.criticalUnknown.includes('supplier.currency'), JSON.stringify(a.landed.criticalUnknown)); assert.equal(a.landed.totals?.landedPerUnitEurMinor ?? null, null);
  const k = c.candidates.find((x) => x.key === CUR); c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(7)); a = assess(c, { now: at(8), externals: {} }); assert.equal(a.landed.criticalUnknown?.includes('supplier.currency') ?? false, false, 'once the owner confirms USD the rate applies');
  const direct = landedCost({ supplier: { unitPrice: '12', qty: 60 }, fx: { rate: 0.92 }, costs: {} }); assert.equal(direct.status, 'INFORMATION_INSUFFICIENT'); assert.ok(direct.criticalUnknown.includes('supplier.currency'));
  const eur = landedCost({ supplier: { unitPrice: '12', currency: 'EUR', qty: 60 }, costs: {} }); assert.ok(!eur.criticalUnknown.includes('supplier.currency'), 'an explicit EUR needs no rate');
});
test('8. comparison of two suppliers: different currencies, or one currency unconfirmed -> the unit prices are NOT ranked, and the reason says so', () => {
  const deal = (cur, unit) => ({ quoted: { status: 'SUPPLIER_CLAIM', unitPrice: unit, currency: cur, incoterm: null }, landed: { perUnitEurMinor: null, isLowerBound: false, unknownCostComponents: [] } });
  const e = (id, cur, unit) => ({ caseId: id, name: id, deal: deal(cur, unit) });
  assert.equal(compareDeals([e('a', 'USD', 12), e('b', 'EUR', 9)]).cheapestQuote, null, 'USD vs EUR: not ranked');
  const unknown = compareDeals([e('a', null, 12), e('b', null, 9)]); assert.equal(unknown.cheapestQuote, null, 'two UNKNOWN currencies are not "the same currency"'); assert.ok(unknown.reasons.some((r) => /no confirmed currency/.test(r)));
  assert.equal(compareDeals([e('a', null, 12), e('b', 'USD', 9)]).cheapestQuote, null, 'unknown vs USD: not ranked');
  const same = compareDeals([e('a', 'USD', 12), e('b', 'USD', 9)]); assert.equal(same.cheapestQuote.caseId, 'b'); assert.equal(same.cheapestQuote.currency, 'USD');
  const eng = createFieldEngine({ now: () => at(20) }); const a = supplier('Sonny', 'prix 12$, MOQ 60', [PRICE, 'quote.moq']); const b = supplier('Lina', 'price 9 EUR, MOQ 100', [PRICE, CUR, 'quote.moq']);
  const { view } = eng.compare([a, b]); assert.equal(view.summary.answers.cheapest.caseId, null, 'no cheapest winner between "12 — devise à confirmer" and "9 EUR"'); const cards = Object.fromEntries(view.cards.map((c) => [c.caseId, c.price.text]));
  assert.match(cards[a.id], /12 — currency to confirm/); assert.match(cards[b.id], /9 EUR/);
  const ov = Object.fromEntries(eng.overview([a, b]).map((o) => [o.caseId, o.price])); assert.equal(ov[a.id], '12 — devise à confirmer'); assert.equal(ov[b.id], '9 EUR');
});
test('9. the cards, the sheet strip and the fact lists word the price the same way (no bare "12", no "12 USD" for an unconfirmed currency)', () => {
  const line = (price) => N.factsLine({ price, moq: '60', model: 'AB521' });
  assert.match(line(priceWording({ amount: '12', amountConfirmed: true, currency: 'USD' })), /<b>12 USD<\/b>/);
  const cur = line(priceWording({ amount: '12', amountConfirmed: true, currency: null, proposedCurrency: 'USD' })); assert.match(cur, /<b>12<\/b> <span class="nx-pw">— devise à confirmer<\/span>/); assert.doesNotMatch(cur, /12 USD/);
  assert.match(line(priceWording({ amount: '12', amountConfirmed: false, currency: null })), /12 — prix et devise à confirmer/); assert.doesNotMatch(N.factsLine({ price: priceWording({}), moq: null, model: null }), /<b>/);
  assert.match(N.factsLine({ price: priceWording({}), moq: null, model: null }), /Rien de confirmé/);
  assert.match(V.factValueText({ fact_type: 'PRICE', value: '12', unit: null }), /^12 — devise à confirmer$/); assert.equal(V.factValueText({ fact_type: 'PRICE', value: '12', unit: 'EUR' }), '12 EUR');
  const deal = V.dealHtml({ quoted: { status: 'SUPPLIER_CLAIM', unitPrice: '12', currency: null, atQty: 60, moq: 60, incoterm: null }, landed: { display: null, reason: '' }, maxPurchasePrice: { display: null }, targetPurchasePrice: { display: null }, margin: { pct: null }, cash: { goodsEurMinor: null, sample: { status: 'UNKNOWN' } }, breakpoints: [{ minQty: 60, unitPrice: '12', currency: null, landedPerUnitEurMinor: null, cashTotalEurMinor: null }], insights: [], unknown: [], incotermEffect: { text: '' }, note: '' });
  assert.match(deal, /12 — devise à confirmer pour 60/); assert.doesNotMatch(deal, /12\s+null|12\s+pour|12 USD/); assert.equal(priceOfQuote('12', undefined).text, '12 — devise à confirmer');
});
test('10. the forms never write a default currency: an untouched "?" currency is left out of the quote event, a chosen one is kept', () => {
  assert.equal('currency' in quoteFormEvent({ unitPrice: '12', currency: '' }).quote, false); assert.equal(quoteFormEvent({ unitPrice: '12', currency: 'EUR' }).quote.currency, 'EUR'); assert.equal('currency' in quickQuoteEvent({ unitPrice: '12', currency: '' }).quote, false);
  const ui = (f) => readFileSync(new URL(`../src/sourcing/ui/screens/${f}`, import.meta.url), 'utf8'); for (const f of ['quick.js', 'money.js']) { assert.match(ui(f), /\['', '\? \(to confirm\)'\]/, `${f}: an empty option while the currency is unknown`); assert.doesNotMatch(ui(f), /q\.currency \?\? 'USD'/, `${f}: no USD default`); }
  const src = (f) => readFileSync(new URL(`../src/sourcing/${f}`, import.meta.url), 'utf8'); for (const f of ['core/case.js', 'core/comparison.js', 'core/field/deal.js', 'ui/screens/decision.js', 'ui/app.js']) assert.doesNotMatch(src(f), /currency \?\? 'USD'/, `${f}: no silent USD`);
});
test('11. the five tabs of the sheet: a scrolling row, never five squeezed columns; each tab is at least 44 px; the page itself never scrolls sideways', () => {
  const css = readFileSync(new URL('../src/sourcing/ui/nx.css', import.meta.url), 'utf8'); const tabs = css.match(/\.nx-tabs\{[^}]*\}/)[0]; const btn = css.match(/\.nx-tabs button\{[^}]*\}/)[0];
  assert.match(tabs, /display:flex/); assert.match(tabs, /overflow-x:auto/); assert.doesNotMatch(tabs, /grid-template-columns/); assert.match(btn, /flex:1 0 auto/); assert.match(btn, /white-space:nowrap/); assert.match(btn, /min-height:4[4-9]px|min-height:[5-9]\d px/); assert.match(btn, /min-width:44px/);
  assert.deepEqual(N.FICHE_TABS.map(([, l]) => l), ['Aperçu', 'Infos', 'Questions', 'Chiffres', 'Plus']);
});
