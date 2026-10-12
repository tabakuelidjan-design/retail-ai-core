// CONVERSATION TURNS (pure, deterministic, provider-independent). A speech recogniser delivers many small FINAL segments; a spoken TURN is what a person says in one go. The chain kept in the case is
//
//   CAPTURE SESSION -> immutable ASR SEGMENTS -> CONVERSATION TURN (one item of the thread) -> DERIVED FACTS (each fact points back to the exact segment ids)
//
// This module only decides, from the segments' own timing and punctuation, whether a new segment CONTINUES the open turn or STARTS another one. It stores nothing and reads no clock: the caller
// passes the timestamps (the engine's own start/duration when they come from the same stream, otherwise the time the segment was received).
//
// THE NUMBERS BELOW ARE UNCALIBRATED DEFAULTS, not business rules. They are isolated here (and overridable through the `turnConfig` of an event / the phone's settings) so that they can be calibrated from
// real field sessions. Deterministic closers need no number at all: pause, stop, typed input, a question shown to the supplier, an established speaker change, the end of the conversation.
export const DEFAULT_TURN_CONFIG = Object.freeze({
  breakGapMs: 4000, // a silence longer than this always ends the turn
  sentenceGapMs: 1200, // after a segment that ENDS a sentence (. ? !), a silence longer than this ends the turn
  maxTurnMs: 30000, // a turn never spans more than this much speech ("do not concatenate indefinitely")
  maxTurnChars: 700,
  silenceCloseMs: 4000, // DISPLAY only: an open turn is shown as finished after this much silence (no event is needed)
});

export function normalizeTurnConfig(c) {
  const out = { ...DEFAULT_TURN_CONFIG }; if (!c || typeof c !== 'object') return out;
  for (const k of Object.keys(DEFAULT_TURN_CONFIG)) if (typeof c[k] === 'number' && Number.isFinite(c[k]) && c[k] > 0) out[k] = c[k];
  return out;
}

const TERMINAL = /[.?!。？！]["')\]]*\s*$/;
const ms = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t; };

/** The segments of an item. Items stored BEFORE turns existed (one transcription, no segments) read as ONE segment, so old voice items keep working. */
export function segmentsOf(item) {
  if (Array.isArray(item?.segments) && item.segments.length) return item.segments;
  if (item?.modality !== 'SPEECH') return [];
  const d = (item.derived ?? []).find((x) => x.kind === 'TRANSCRIPTION'); if (!d) return [];
  return [{ id: `${item.id}-s1`, text: d.text, startTime: null, duration: null, streamId: null, receivedAt: item.capture?.endedAt ?? item.at, provider: d.provider ?? null, version: d.version ?? null, lang: d.lang ?? item.lang ?? null, legacy: true }];
}
export const turnText = (segments) => segments.map((x) => String(x.text).trim()).filter(Boolean).join(' ');

/** Silence between two segments, in ms: the engine's own audio clock when both come from the same stream, otherwise the difference of the reception times. null = unknown. */
export function gapMs(prev, next) {
  if (prev.streamId && prev.streamId === next.streamId && Number.isFinite(prev.startTime) && Number.isFinite(prev.duration) && Number.isFinite(next.startTime)) return Math.max(0, (next.startTime - (prev.startTime + prev.duration)) * 1000);
  const a = ms(prev.receivedAt); const b = ms(next.receivedAt); return a === null || b === null ? null : Math.max(0, b - a);
}

/**
 * @param {{ open: null | { segments: object[], sessionId: string|null, speaker: string }, segment: object, sessionId?: string|null, config?: object }} a
 * @returns {{ action: 'APPEND'|'NEW', reason: string, gapMs: number|null }}
 */
export function decideTurn({ open, segment, sessionId = null, config }) {
  const cfg = normalizeTurnConfig(config);
  if (!open || !open.segments?.length) return { action: 'NEW', reason: 'NO_OPEN_TURN', gapMs: null };
  if ((open.sessionId ?? null) !== (sessionId ?? null)) return { action: 'NEW', reason: 'OTHER_CAPTURE_SESSION', gapMs: null };
  const prev = open.segments.at(-1); const gap = gapMs(prev, segment);
  if (gap !== null && gap > cfg.breakGapMs) return { action: 'NEW', reason: 'SILENCE', gapMs: gap };
  if (gap !== null && TERMINAL.test(String(prev.text)) && gap > cfg.sentenceGapMs) return { action: 'NEW', reason: 'SENTENCE_END_AND_PAUSE', gapMs: gap };
  const chars = turnText([...open.segments, segment]).length; if (chars > cfg.maxTurnChars) return { action: 'NEW', reason: 'TOO_LONG', gapMs: gap };
  const first = open.segments[0]; if (first.streamId && first.streamId === segment.streamId && Number.isFinite(first.startTime) && Number.isFinite(segment.startTime) && Number.isFinite(segment.duration) && (segment.startTime + segment.duration - first.startTime) * 1000 > cfg.maxTurnMs) return { action: 'NEW', reason: 'TOO_LONG', gapMs: gap };
  return { action: 'APPEND', reason: 'CONTINUES', gapMs: gap };
}

/** DISPLAY: is this turn still being spoken? An item with an explicit close (or none of the turn fields) is never open. */
export function isTurnOpen(item, nowMs, config) {
  if (!item?.turn || item.turn.status !== 'OPEN') return false;
  const last = ms(item.turn.lastSegmentAt); return last !== null && nowMs - last < normalizeTurnConfig(config).silenceCloseMs;
}
/** When the screen should look again so that an open turn stops looking open (ms epoch), or null. */
export function turnClosesAt(item, config) {
  if (!item?.turn || item.turn.status !== 'OPEN') return null; const last = ms(item.turn.lastSegmentAt); return last === null ? null : last + normalizeTurnConfig(config).silenceCloseMs;
}
