import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as CI from '../src/creative-intelligence/index.js';
import {
  createApprovedCopyAgent, createCreativeDirector, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst, createVisualProductionDirector, DECISION, DIRECTOR_CONSTANTS,
  runProductPreservingCreative,
} from '../src/creative-runtime/index.js';
import {
  BRAND, buildBrief, fakeEnvironmentPort, fonts,
} from './runtime-world.js';

// A failing agent must not hide WHY it failed (`// AD-N` markers). The first autonomous HABB run stopped with a bare CI_AGENT_FAILED although the Director's text call had been
// refused by the provider (HTTP 403 access_denied): the wrapper swallowed every diagnostic. It now keeps the SAFE ones (name, code token, HTTP status, request id, transient),
// never a message.

const providerRefusal = () => Object.assign(new Error('Alibaba Model Studio request failed: access_denied (Bearer sk-SECRET-KEY-0123456789)'), {
  name: 'AlibabaProviderError', code: 'access_denied', status: 403, requestId: '77af93e6-9c06-9eed-be5a-216a4ca2cf29', transient: false,
});

test('A failing agent handler keeps the safe diagnostics of its cause and never its message', async () => {
  const agent = CI.defineCreativeAgent(CI.AGENT_ROLE.CREATIVE_DIRECTOR, () => { throw providerRefusal(); });
  const error = await agent.invoke({}, {}).catch((e) => e);
  // AD-1 still the stable AGENT_FAILED, with the role and the cause's safe fields
  assert.equal(error.code, CI.CI_ERROR.AGENT_FAILED);
  assert.equal(error.detail.role, CI.AGENT_ROLE.CREATIVE_DIRECTOR);
  assert.deepEqual(error.detail.cause, { name: 'AlibabaProviderError', code: 'access_denied', status: 403, request_id: '77af93e6-9c06-9eed-be5a-216a4ca2cf29', transient: false });
  // AD-2 the message of the cause (which carried a key here) appears nowhere
  assert.doesNotMatch(`${error.message} ${JSON.stringify(error.detail)} ${error.stack?.split('\n')[0]}`, /sk-SECRET|Bearer|Alibaba Model Studio request failed/);
  // AD-3 anything that is not a safe scalar of the expected shape is dropped
  const odd = CI.defineCreativeAgent(CI.AGENT_ROLE.CREATIVE_DIRECTOR, () => { throw Object.assign(new Error('x'), { name: 'a b', code: 'has spaces and is long'.repeat(10), status: '403', requestId: { nested: true }, transient: 'no' }); });
  assert.deepEqual((await odd.invoke({}, {}).catch((e) => e)).detail.cause, {});
  assert.deepEqual((await CI.defineCreativeAgent(CI.AGENT_ROLE.CREATIVE_DIRECTOR, () => { throw 'a string'; }).invoke({}, {}).catch((e) => e)).detail.cause, {});
});

test('In the runtime, a provider refusal of the Director stops the run with its diagnostics, before any environment call and without any decision made for it', async () => {
  const ledger = createDecisionLedger();
  const environment = fakeEnvironmentPort();
  const agents = {
    analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }),
    director: createCreativeDirector({ ledger, complete: async () => { throw providerRefusal(); }, constants: DIRECTOR_CONSTANTS }),
    copy: createApprovedCopyAgent({ ledger }),
    visual_director: createVisualProductionDirector({ ledger, expression: BRAND.expression }),
  };
  const error = await runProductPreservingCreative({
    at: '2026-10-10T12:00:00.000Z', brief: buildBrief(), fonts, agents, ports: { segmenter: createLocalProductSegmenter({ ledger }), environment }, ledger,
  }).catch((e) => e);
  // AD-4 the run fails as a Director failure, with the provider's HTTP status, code and request id preserved
  assert.equal(error.code, CI.CI_ERROR.AGENT_FAILED);
  assert.equal(error.detail.role, CI.AGENT_ROLE.CREATIVE_DIRECTOR);
  assert.equal(error.detail.cause.status, 403);
  assert.equal(error.detail.cause.code, 'access_denied');
  assert.equal(error.detail.cause.request_id, '77af93e6-9c06-9eed-be5a-216a4ca2cf29');
  // AD-5 nothing was decided in the Director's place: no direction in the ledger, no environment call, nothing composed
  assert.equal(ledger.of(DECISION.CREATIVE_DIRECTION).length, 0);
  assert.equal(environment.calls.length, 0);
  assert.equal(ledger.of(DECISION.LAYOUT_RECIPE).length, 0);
});

test('The run script reports the diagnostics of a failing agent', async () => {
  const source = await readFile(new URL('../scripts/run-c2-habb-creative.mjs', import.meta.url), 'utf8');
  // AD-6 the runtime error record carries the role, the cause's code, HTTP status and request id
  assert.match(source, /error\.detail\?\.cause/);
  assert.match(source, /cause_code/);
  assert.match(source, /request_id: cause\.request_id/);
});
