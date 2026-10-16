// verdictDisplay: an ADDITIVE field of the decision card. `verdict` is untouched (the engine tests pin CONDITIONAL_GO for "documents missing");
// verdictDisplay is what an interface should show: a CONDITIONAL_GO that still has a HARD blocker is never displayed as a bare go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { NOW, LIVE_CLEAN, ident, traits, importer, commercial, extraTraits } from './sourcing-fixtures.js';

const mk = (events, id) => { let c = newCase({ id, name: 'x', now: NOW }); for (const e of events) c = dispatch(c, e, NOW); return c; };
const run = (c) => assess(c, { now: NOW, externals: { safety: LIVE_CLEAN } }).decision;

test('hard blocker + CONDITIONAL_GO: verdict unchanged, verdictDisplay says it is blocked, money cannot be committed', () => {
  const d = run(mk([...ident({ name: 'USB charger', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({})], 'c'));
  assert.equal(d.verdict, 'CONDITIONAL_GO'); assert.ok(d.hardBlockers.length > 0);
  assert.equal(d.verdictDisplay, 'CONDITIONAL_GO_BLOCKED'); assert.equal(d.canCommitMoney, false);
});

test('no hard blocker: verdictDisplay equals verdict (GO stays GO, INSUFFICIENT_INFORMATION stays itself)', () => {
  const go = run(mk([...ident({ name: 'Bamboo kitchen organiser', category: 'household_general' }), ...traits({}), ...importer, ...commercial({})], 'g'));
  assert.equal(go.verdict, 'GO'); assert.equal(go.verdictDisplay, 'GO');
  const bare = run(mk([...ident({ name: 'Mug', category: 'household_general' })], 'b'));
  assert.equal(bare.verdictDisplay, bare.verdict);
});

test('invariant: whenever a hard blocker is open the displayed verdict never reads as a go', () => {
  for (const c of [mk([...ident({ name: 'USB charger', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...importer, ...commercial({})], 'x'), mk([...ident({ name: 'Mug', category: 'household_general' })], 'y')]) {
    const d = run(c);
    if (d.hardBlockers.length) assert.ok(!['GO', 'CONDITIONAL_GO'].includes(d.verdictDisplay), `${d.verdict} / ${d.verdictDisplay}`);
  }
});
