// TEXT UNITS: deterministic measurement and verbatim segmentation of a text. Pure: no clock, no randomness, no I/O, no model.
// A locked text is never rewritten: it is only CUT into consecutive slices at the best boundary available (paragraph, then sentence, then clause, then word). The slices are offsets into the text, so that
// "the words were not altered" is a checkable property (`verifyVerbatim`), not a promise. Measurement is script-independent (characters are code points; words use the ICU word segmenter, which also
// segments scripts without spaces).

const segmenterFor = (locale, granularity) => {
  try { return new Intl.Segmenter(locale, { granularity }); } catch { return new Intl.Segmenter('en', { granularity }); }
};

export const codePoints = (text) => [...String(text)].length;
const WHITESPACE = /\s/u;

/** @returns {{ chars, words, sentences, paragraphs }} the measured size of a text. */
export function measure(text, locale = 'en') {
  const t = String(text ?? '');
  if (!t.trim()) return { chars: 0, words: 0, sentences: 0, paragraphs: 0 };
  let words = 0; for (const s of segmenterFor(locale, 'word').segment(t)) if (s.isWordLike) words += 1;
  let sentences = 0; for (const s of segmenterFor(locale, 'sentence').segment(t)) if (s.segment.trim()) sentences += 1;
  const paragraphs = t.split(/\n[^\S\n]*\n/u).filter((p) => p.trim()).length;
  return { chars: codePoints(t.trim()), words, sentences, paragraphs };
}

// ---- boundaries: the offsets (UTF-16 indexes) after which a text may be cut, from the strongest to the weakest
function boundaries(text, locale) {
  const paragraph = new Set(); const sentence = new Set(); const clause = new Set(); const word = new Set();
  for (const m of text.matchAll(/\n[^\S\n]*\n/gu)) paragraph.add(m.index);
  for (const s of segmenterFor(locale, 'sentence').segment(text)) sentence.add(s.index + s.segment.length);
  for (const m of text.matchAll(/[;:,—–、，；：](?=\s|$)/gu)) clause.add(m.index + m[0].length);
  for (const s of segmenterFor(locale, 'word').segment(text)) word.add(s.index + s.segment.length);
  return [[...paragraph], [...sentence], [...clause], [...word]].map((list) => list.sort((a, b) => a - b));
}

const trimmedSlice = (text, start, end) => {
  let s = start; let e = end;
  while (s < e && WHITESPACE.test(text[s])) s += 1;
  while (e > s && WHITESPACE.test(text[e - 1])) e -= 1;
  return { start: s, end: e };
};
const lengthOf = (text, slice) => codePoints(text.slice(slice.start, slice.end));

const MIN_FILL = 0.4;

/**
 * Consecutive slices of the text, each at most `maxChars` characters, cut at the strongest boundary whose piece is reasonably full. Covers every non-whitespace character exactly once, in order.
 * @returns {{ start, end }[]}
 */
export function sliceText(text, maxChars, locale = 'en') {
  const source = String(text);
  if (!(maxChars >= 1)) throw new RangeError('maxChars must be at least 1');
  const levels = boundaries(source, locale);
  const slices = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (cursor < source.length && WHITESPACE.test(source[cursor])) cursor += 1;
    if (cursor >= source.length) break;
    const whole = trimmedSlice(source, cursor, source.length);
    if (lengthOf(source, whole) <= maxChars) { slices.push(whole); break; }
    // the farthest end that keeps the piece within the limit, found on the strongest boundary level that gives a reasonably full piece
    let chosen = null;
    for (const level of levels) {
      for (let i = level.length - 1; i >= 0; i -= 1) {
        const b = level[i];
        if (b <= cursor) break;
        const candidate = trimmedSlice(source, cursor, b);
        if (candidate.end <= candidate.start) continue;
        const len = lengthOf(source, candidate);
        if (len <= maxChars && len >= Math.ceil(maxChars * MIN_FILL)) { chosen = candidate; break; }
      }
      if (chosen) break;
    }
    if (!chosen) {
      // no boundary gives a reasonably full piece: the farthest word boundary within the limit, else a hard cut at the limit (a single word longer than the limit)
      const wordLevel = levels[3];
      for (let i = wordLevel.length - 1; i >= 0; i -= 1) {
        const b = wordLevel[i];
        if (b <= cursor) break;
        const candidate = trimmedSlice(source, cursor, b);
        if (candidate.end > candidate.start && lengthOf(source, candidate) <= maxChars) { chosen = candidate; break; }
      }
    }
    if (!chosen) {
      let end = cursor; let n = 0;
      for (const ch of source.slice(cursor)) { if (n >= maxChars) break; end += ch.length; n += 1; }
      chosen = trimmedSlice(source, cursor, end);
    }
    slices.push(chosen);
    cursor = chosen.end;
  }
  return slices;
}


/**
 * The smallest units a text is distributed in: its sentences (a sentence longer than `maxChars` is cut at the best boundary inside it). Each unit is a slice; `paragraph_end` says that a paragraph ends after it,
 * so a distribution can prefer to cut where the author did. Covers every non-whitespace character once, in order.
 * @returns {{ start, end, paragraph_end }[]}
 */
export function sentenceAtoms(text, maxChars, locale = 'en') {
  const source = String(text);
  const paragraphBreaks = [...source.matchAll(/\n[^\S\n]*\n/gu)].map((m) => m.index);
  // a paragraph ends after an atom if only whitespace lies between the atom and the next paragraph break
  const endsParagraph = (end) => paragraphBreaks.some((b) => b >= end && /^\s*$/u.test(source.slice(end, b)));
  const atoms = [];
  for (const s of segmenterFor(locale, 'sentence').segment(source)) {
    const slice = trimmedSlice(source, s.index, s.index + s.segment.length);
    if (slice.end <= slice.start) continue;
    if (lengthOf(source, slice) <= maxChars) { atoms.push({ ...slice, paragraph_end: false }); continue; }
    for (const part of sliceText(source.slice(slice.start, slice.end), maxChars, locale)) atoms.push({ start: slice.start + part.start, end: slice.start + part.end, paragraph_end: false });
  }
  atoms.forEach((a, i) => { a.paragraph_end = i === atoms.length - 1 || endsParagraph(a.end); });
  return atoms;
}

/** The first sentence of a text as a slice (null if the text is empty). */
export function firstSentence(text, locale = 'en') {
  const source = String(text);
  for (const s of segmenterFor(locale, 'sentence').segment(source)) {
    const slice = trimmedSlice(source, s.index, s.index + s.segment.length);
    if (slice.end > slice.start) return slice;
  }
  return null;
}

/** Groups consecutive slices into groups of at most `maxChars` characters (joined by one space), never reordering and never cutting a slice. A slice longer than the limit is its own group. */
export function groupSlices(text, slices, maxChars) {
  const groups = [];
  for (const slice of slices) {
    const len = lengthOf(text, slice);
    const last = groups.at(-1);
    if (last && last.chars + 1 + len <= maxChars) { last.slices.push(slice); last.chars += 1 + len; } else groups.push({ slices: [slice], chars: len });
  }
  return groups;
}

export const textOf = (source, slices) => slices.map((s) => source.slice(s.start, s.end)).join(' ');
export const stripSpace = (s) => String(s).replace(/\s+/gu, '');

/** The slices are ordered, disjoint and together hold exactly the non-whitespace characters of the source, in order: nothing was added, removed, reordered or rewritten. */
export function verifyVerbatim(source, slices) {
  let previousEnd = 0;
  for (const s of slices) {
    if (!(s.start >= previousEnd) || !(s.end > s.start) || s.end > source.length) return false;
    previousEnd = s.end;
  }
  return stripSpace(slices.map((s) => source.slice(s.start, s.end)).join('')) === stripSpace(source);
}
