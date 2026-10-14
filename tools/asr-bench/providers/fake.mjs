// TEST DOUBLE: a deterministic stand-in that "transcribes" from the benchmark script (an oracle) with configurable, reproducible defects. It exists ONLY to prove that the scoring, the context lift and the verdict
// behave as specified (tests); it is never a candidate and never touches a network. The defects are applied to the transcript the way a real ASR would err (a digit lost, a letter changed), never as post-correction.
import { PROVIDER_META, validateResult } from '../provider.mjs';
import { canonId } from '../corpus.mjs';

const hash = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
const SPOKEN_DIGITS = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine' };
/** Defect model of identifiers: drop a digit, or swap the last letter (deterministic per item). */
const damage = (id, key) => { const h = hash(key); if (h < 0.5) return id.replace(/\d(?=[A-Z]*$)/, ''); return id.replace(/[A-Z](?=[^A-Z]*$)/, (c) => String.fromCharCode(((c.charCodeAt(0) - 64) % 26) + 65)); };

export default {
  id: 'fake', model: 'oracle', meta: PROVIDER_META.fake,
  /** options: windows [{id,startSec,endSec}], script, references {id: text}, behavior { identifierErrorRate, contextLift, silenceChatter, loop, dropNatural, alwaysSayDigits } */
  async transcribe(audio, { pass, context, windows, script, references = {}, behavior = {} } = {}) {
    const items = new Map(script.items.map((i) => [i.id, i])); const segs = []; const terms = new Set((context?.payload?.terms ?? []).map(canonId));
    for (const w of windows) {
      const it = items.get(w.id); if (!it) continue; const mid = w.startSec + 0.4; let text = '';
      if (it.kind === 'silence' || it.kind === 'noise') { if (behavior.silenceChatter) text = 'you'; }
      else if (it.kind === 'natural') { text = references[it.id] ?? ''; if (behavior.dropNatural) text = text.split(' ').filter((_, i) => i % Math.round(1 / behavior.dropNatural) !== 0).join(' '); if (behavior.loop) text = `${text} ${'the model is the model '.repeat(8)}`.trim(); }
      else {
        const base = it.say ?? it.display.replace(/^Référence\s+/, '');
        let ident = it.expect.identifier; const inCtx = ident && terms.has(canonId(ident)); const rate = (behavior.identifierErrorRate ?? 0) * (pass === 'B' && inCtx ? 1 - (behavior.contextLift ?? 0) : 1);
        const broken = ident && hash(`${it.id}|${pass}|${behavior.seed ?? 0}`) < rate; text = ident ? (it.kind === 'mixed' ? base.replace(ident, broken ? damage(ident, it.id) : ident) : (broken ? damage(ident, it.id) : ident)) : base;
        if (!ident) text = base;
        if (it.kind === 'identifier' && !it.say) text = broken ? damage(ident, it.id) : ident;
      }
      if (text) segs.push({ text, startSec: mid, endSec: Math.min(w.endSec, mid + Math.max(0.8, text.split(' ').length * 0.35)), isFinal: true });
    }
    void SPOKEN_DIGITS; const now = new Date().toISOString();
    return validateResult({ provider: 'fake', model: 'oracle', mode: 'test-double', pass, audioSha256: audio.sha256, startedAt: now, finishedAt: now, wallMs: 0, audioSec: audio.durationSec, pace: 0, rawTranscript: segs.map((s) => s.text).join(' '), segments: segs, contextApplied: { mechanism: context?.mechanism ?? 'none', payload: context?.payload ?? {} }, providerMeta: { behavior }, events: {}, errors: [] });
  },
};
