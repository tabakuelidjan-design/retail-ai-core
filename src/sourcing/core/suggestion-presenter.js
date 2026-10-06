// Conversation First: WHEN to show a suggestion. A pure state machine with an injected clock (milliseconds); no timer, no DOM, nothing stored in the case. The screen calls it at every render and, when
// it answers `hold.until`, wakes up once at that time. Nordla never interrupts:
//  1. nothing while the owner is typing, or right after the supplier spoke (a silence of `quietMs`; pasted text has no streaming, so the screen passes lastUtteranceAt = null);
//  2. at most ONE suggestion on screen;
//  3. a suggestion stays (it is never replaced because another one became better). It disappears AT ONCE when it is answered, put aside or no longer proposed; when the subject merely moved on it stays
//     for `dwellMs` (time to read and tap) and is then dropped, so the strip never flickers;
//  4. a pause of `cooldownMs` after a suggestion was shown before the next one appears;
//  5. "Que dois-je demander maintenant ?" (signals.explicit) overrides 1, 3 and 4;
//  6. alerts (contradiction, safety) are passed through at once, never held back, never modal.
// The delays are configurable DEFAULTS (to adjust after the physical test), not business rules.
export const DEFAULT_TIMING = Object.freeze({ quietMs: 1500, dwellMs: 8000, cooldownMs: 10000 });

/** Merges a partial setting over the defaults; anything that is not a finite number >= 0 is ignored. */
export function normalizeTiming(t) {
  const out = { ...DEFAULT_TIMING }; if (!t || typeof t !== 'object') return out;
  for (const k of Object.keys(DEFAULT_TIMING)) if (typeof t[k] === 'number' && Number.isFinite(t[k]) && t[k] >= 0) out[k] = t[k];
  return out;
}

/**
 * @param {null|{shownId:string,shownAt:number,topicId:string,origin:string,lastShownAt:number}} prev what this function returned last time (kept by the screen, not stored in the case)
 * @param {{topic:{id:string},suggestion:object|null,all:object[],alerts:object[]}} ctx the result of planContext
 * @param {{composing?:boolean,lastUtteranceAt?:number|null,explicit?:boolean}} signals
 * @param {number} now milliseconds
 * @returns {{show:object|null,hold:null|{reason:string,until:number|null},alerts:object[],state:object|null}}
 */
export function presentSuggestion(prev, ctx, signals = {}, now, timing = DEFAULT_TIMING) {
  const tm = normalizeTiming(timing); const alerts = ctx.alerts ?? []; const list = ctx.all ?? (ctx.suggestion ? [ctx.suggestion] : []);
  let state = prev ? { ...prev } : null; const lastShownAt = state?.lastShownAt ?? null;
  const showNow = (q) => ({ show: q, hold: null, alerts, state: { shownId: q.id, shownAt: state?.shownId === q.id ? state.shownAt : now, topicId: state?.shownId === q.id ? state.topicId : (ctx.topic?.id ?? 'OTHER'), origin: q.origin ?? 'GLOBAL', lastShownAt: state?.shownId === q.id ? state.lastShownAt : now } });
  const cleared = () => (state ? { shownId: null, shownAt: null, topicId: null, origin: null, lastShownAt } : null);

  if (signals.explicit) { const q = ctx.suggestion; return q ? showNow(q) : { show: null, hold: null, alerts, state: cleared() }; }

  // the suggestion on screen: keep it while it is still proposed and still about the subject
  if (state?.shownId) {
    const q = list.find((x) => x.id === state.shownId); const moved = state.origin === 'ADJACENT' && (ctx.topic?.id ?? 'OTHER') !== state.topicId;
    if (q && (!moved || now - state.shownAt < tm.dwellMs)) return showNow(q);
    state = cleared();
  }
  const q = ctx.suggestion; if (!q) return { show: null, hold: null, alerts, state };
  if (signals.composing) return { show: null, hold: { reason: 'COMPOSING', until: null }, alerts, state };
  if (signals.lastUtteranceAt !== null && signals.lastUtteranceAt !== undefined && now - signals.lastUtteranceAt < tm.quietMs) return { show: null, hold: { reason: 'QUIET', until: signals.lastUtteranceAt + tm.quietMs }, alerts, state };
  if (lastShownAt !== null && now - lastShownAt < tm.cooldownMs) return { show: null, hold: { reason: 'COOLDOWN', until: lastShownAt + tm.cooldownMs }, alerts, state };
  return showNow(q);
}
