// The media-transmission recorder of ONE creative run: it turns what really happened at the provider boundary into the ledger's lifecycle.
//   AUTHORIZED  the standing tenant policy allowed this operation for this source SHA (run level, before any spending)
//   RESERVED    the durable ledger reserved the run ceiling (run level)
//   ATTEMPTED   a provider port is about to send media (its own RESERVED journal event, emitted BEFORE the request). If the ledger REFUSES it
//               (no live reservation, not authorised for this source SHA / policy version), the port's journal append throws and the request is
//               never sent: enforcement at the media boundary, not only bookkeeping.
//   SENT        the provider answered (a provider request id exists): the media reached it
//   SUCCEEDED / FAILED   the call's outcome; a FAILED without request id is recorded with transmission UNKNOWN (no SENT is claimed)
//   CANCELLED   the run stopped before any attempt of that operation
// An authorization is never presented as proof of transmission: SENT exists only with a provider request id.
import { randomUUID } from 'node:crypto';
import { LEDGER_EVENT as EV, MEDIA_OPERATIONS } from './creative-ledger.js';

export class TransmissionRefused extends Error {
  constructor(reason) { super(`MEDIA_TRANSMISSION_REFUSED: ${reason}`); this.name = 'TransmissionRefused'; this.code = 'MEDIA_TRANSMISSION_REFUSED'; this.reason = reason; }
}

/**
 * ctx: { merchantId, runId, policyId, policyVersion, sourceSha256, now }
 * targets: { VISION_CRITIQUE: { authorizationId, providerId, region }, IMAGE_EDIT?: {...} }
 */
export function createTransmissionRecorder({ ledger, ctx, targets, mirror = null }) {
  const id = `transmissions:${ctx.runId}:${randomUUID()}`;
  const attempts = new Map(); // operation -> count of ATTEMPTED recorded
  const write = async (operation, attemptRef, event, extra = {}) => {
    const t = targets[operation];
    const e = { merchantId: ctx.merchantId, runId: ctx.runId, operation, attemptRef, event, policyId: ctx.policyId, policyVersion: ctx.policyVersion,
      authorizationId: t.authorizationId, sourceSha256: ctx.sourceSha256, providerId: t.providerId, region: t.region, now: ctx.now(), ...extra };
    const r = await ledger.record(e);
    mirror?.append?.({ ...e, now: new Date(e.now).toISOString(), ledger_status: r?.status ?? null });
    return r;
  };
  const runEvent = async (event, extra) => { for (const op of Object.keys(targets)) await write(op, 'run', event, extra); };

  /** A journal for the provider ports: forwards every event to `base` and maps media events to the lifecycle. */
  const providerJournal = (base = null) => Object.freeze({
    id,
    async append(event) {
      const op = event?.operation;
      if (MEDIA_OPERATIONS.includes(op) && targets[op]) {
        const ref = String(event.operation_id ?? '');
        if (event.event === 'RESERVED') {
          const r = await write(op, ref, EV.ATTEMPTED, { detail: { estimated_cost_eur: event.estimated_cost_eur ?? null } });
          if (r?.status !== 'RECORDED') throw new TransmissionRefused(r?.reason ?? r?.status ?? 'LEDGER_REFUSED'); // the request is NOT sent
          attempts.set(op, (attempts.get(op) ?? 0) + 1);
        } else if (event.event === 'SUCCEEDED' || event.event === 'FAILED') {
          const requestId = event.request_id ?? null;
          if (requestId) await write(op, ref, EV.SENT, { requestId });
          await write(op, ref, event.event === 'SUCCEEDED' ? EV.SUCCEEDED : EV.FAILED, { requestId,
            detail: { ...(event.reason ? { reason: String(event.reason).slice(0, 64) } : {}), ...(requestId ? {} : { transmission: 'UNKNOWN' }), ...(event.actual_cost_eur != null ? { actual_cost_eur: event.actual_cost_eur } : {}) } });
        }
      }
      return base?.append ? base.append(event) : undefined;
    },
  });

  return Object.freeze({
    id, providerJournal,
    authorized: () => runEvent(EV.AUTHORIZED),
    reserved: () => runEvent(EV.RESERVED),
    cancelled: async (reason) => { for (const op of Object.keys(targets)) if (!attempts.get(op)) await write(op, 'run', EV.CANCELLED, { detail: { reason: String(reason).slice(0, 64) } }); },
    attemptedAny: () => [...attempts.values()].some((n) => n > 0),
  });
}
