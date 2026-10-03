// Hard caps for a real-provider run. The guard wraps the fetch handed to an adapter, so it sees EVERY HTTP attempt - retries and corrective re-asks included -
// and refuses the next one once a cap is reached. It cannot be bypassed by a format/retry loop: the loop simply gets BUDGET_EXCEEDED.
//   maxRequests   the number of HTTP requests, counted before they are sent
//   maxCostUsd    a soft cap on the cost reported so far by the tracked adapters (checked before each request; one request can still overshoot it by at most its own
//                 cost, bounded by maxOutputTokens)

import { AdapterError } from '../adapters/shared/http.js';

export function createBudget({ maxRequests, maxCostUsd = null }) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new RangeError('maxRequests must be a positive integer');
  const providers = []; let requests = 0; let exceeded = null;
  const spent = () => Math.round(providers.reduce((a, p) => a + (p.metadata?.().usageTotals?.costUsd ?? 0), 0) * 1e8) / 1e8;
  const trip = (reason) => { exceeded ??= { reason, requests, costUsd: spent() }; throw new AdapterError('BUDGET_EXCEEDED', `benchmark budget reached (${reason}): no further request is sent`); };
  return {
    /** the adapter instances whose reported cost counts against maxCostUsd */
    track(provider) { providers.push(provider); return provider; },
    wrapFetch(realFetch) {
      return async (url, init) => {
        if (exceeded) trip(exceeded.reason);
        if (requests >= maxRequests) trip('MAX_REQUESTS');
        if (maxCostUsd !== null && spent() >= maxCostUsd) trip('MAX_COST');
        requests += 1;
        return realFetch(url, init);
      };
    },
    /** a request was refused: something was cut short */
    isExceeded: () => exceeded !== null,
    /** the request cap is fully used: nothing more can be sent */
    isExhausted: () => requests >= maxRequests,
    snapshot: () => ({ maxRequests, maxCostUsd, requests, costUsd: spent(), exceeded }),
  };
}
