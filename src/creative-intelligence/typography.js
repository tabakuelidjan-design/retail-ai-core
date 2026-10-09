// Typography engine V1: exact measurement -> deterministic line breaking -> positioned lines. No LLM, no randomness, no I/O.
//
// Measurement is EXACT with respect to the font metrics the registry declares (advance widths per code point, in font units).
// The metrics must come from the real font file (a later step generates them); C1 never claims that an undeclared font was
// measured. A script whose shaping an advance table cannot express (Arabic joining) is reported NOT_MEASURABLE, never "fits".
//
// Line breaking is greedy on word boundaries. A word is never broken: a word wider than the box is an overflow, and the text is
// never silently shrunk below `min_font_size`, silently truncated or silently rewritten.

import { CI_ERROR as E, SCRIPT, TEXT_ALIGNMENT, TEXT_DIRECTION } from './constants.js';
import {
  closedObject, deepFreeze, enumValue, fail, integer, number, ref,
} from './validation.js';

const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const GENERIC = ['serif', 'sans-serif', 'monospace', 'cursive'];
const FONT_KEYS = ['font_ref', 'family', 'generic', 'units_per_em', 'ascent', 'descent', 'default_advance', 'advances', 'scripts', 'shaping'];
export const SHAPING = Object.freeze({ ADVANCE_TABLE: 'ADVANCE_TABLE', EXACT: 'EXACT' });

export function normalizeFontMetrics(input, field = 'font') {
  closedObject(input, FONT_KEYS, field, E.FONT_INVALID);
  if (typeof input.family !== 'string' || !FAMILY.test(input.family)) fail(E.FONT_INVALID, `${field}.family must be a plain family name`, { field });
  const advances = input.advances ?? {};
  if (advances == null || typeof advances !== 'object' || Array.isArray(advances) || Object.keys(advances).length > 5000) fail(E.FONT_INVALID, `${field}.advances must be an object`, { field });
  const table = {};
  for (const [char, w] of Object.entries(advances)) {
    if (Array.from(char).length !== 1) fail(E.FONT_INVALID, `${field}.advances keys are single characters`, { field });
    table[char] = number(w, `${field}.advances[]`, { min: 0, max: 10000, code: E.FONT_INVALID });
  }
  const scripts = Array.isArray(input.scripts) && input.scripts.length ? input.scripts.map((s, i) => enumValue(s, SCRIPT, `${field}.scripts[${i}]`, E.FONT_INVALID)) : fail(E.FONT_INVALID, `${field}.scripts must list the supported scripts`, { field });
  return deepFreeze({
    font_ref: ref(input.font_ref, `${field}.font_ref`),
    family: input.family,
    generic: enumValue(input.generic, GENERIC, `${field}.generic`, E.FONT_INVALID),
    units_per_em: integer(input.units_per_em, `${field}.units_per_em`, { min: 100, max: 10000, code: E.FONT_INVALID }),
    ascent: number(input.ascent, `${field}.ascent`, { min: 0, max: 10000, code: E.FONT_INVALID }),
    descent: number(input.descent, `${field}.descent`, { min: 0, max: 10000, code: E.FONT_INVALID }),
    default_advance: number(input.default_advance, `${field}.default_advance`, { min: 1, max: 10000, code: E.FONT_INVALID }),
    advances: table,
    scripts: [...new Set(scripts)].sort(),
    shaping: enumValue(input.shaping ?? SHAPING.ADVANCE_TABLE, SHAPING, `${field}.shaping`, E.FONT_INVALID),
  });
}

/** A registry is an explicit, immutable lookup: no font is ever resolved from the environment. */
export function createFontRegistry(entries = []) {
  const map = new Map();
  entries.forEach((entry, i) => {
    const font = normalizeFontMetrics(entry, `fonts[${i}]`);
    if (map.has(font.font_ref)) fail(E.FONT_INVALID, 'the same font_ref is registered twice', { field: 'fonts' });
    map.set(font.font_ref, font);
  });
  return Object.freeze({
    has: (fontRef) => map.has(fontRef),
    get: (fontRef) => map.get(fontRef) ?? null,
    refs: () => [...map.keys()].sort(),
  });
}

const SCRIPT_TESTS = [
  [SCRIPT.LATIN, /\p{Script=Latin}/u], [SCRIPT.CYRILLIC, /\p{Script=Cyrillic}/u], [SCRIPT.GREEK, /\p{Script=Greek}/u],
  [SCRIPT.ARABIC, /\p{Script=Arabic}/u], [SCRIPT.HEBREW, /\p{Script=Hebrew}/u],
  [SCRIPT.CJK, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
];
/** The scripts of the LETTERS of a text (digits, spaces and punctuation belong to every script). */
export function scriptsOf(content) {
  const found = new Set();
  for (const ch of content) {
    if (!/\p{L}/u.test(ch)) continue;
    const hit = SCRIPT_TESTS.find(([, re]) => re.test(ch));
    found.add(hit ? hit[0] : SCRIPT.OTHER);
  }
  return [...found].sort();
}

export function measureText(content, font, fontSize, tracking = 0) {
  const chars = Array.from(content);
  let units = 0;
  for (const ch of chars) units += font.advances[ch] ?? font.default_advance;
  return (units / font.units_per_em) * fontSize + tracking * fontSize * Math.max(0, chars.length - 1);
}

const EPS = 1e-6;

export function breakLines(content, font, fontSize, tracking, maxWidth) {
  const lines = [];
  const tooWide = [];
  for (const paragraph of content.split('\n')) {
    const words = paragraph.split(' ').filter((w) => w.length > 0);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(candidate, font, fontSize, tracking) <= maxWidth + EPS) line = candidate;
      else if (!line) {
        line = word;
        tooWide.push(word);
      } else {
        lines.push(line);
        line = word;
        if (measureText(word, font, fontSize, tracking) > maxWidth + EPS) tooWide.push(word);
      }
    }
    lines.push(line);
  }
  return { lines, tooWide };
}

/**
 * Lays one text layer out at a given font size. Returns the lines with their measured widths, whether the text fits its box, why it
 * does not, and whether the measurement is trustworthy for these scripts.
 */
export function layoutText(layer, font, fontSize = layer.font_size) {
  const pad = layer.box.padding;
  const innerW = layer.geometry.width - 2 * pad;
  const innerH = layer.geometry.height - 2 * pad;
  const scripts = scriptsOf(layer.content);
  const unsupported = scripts.filter((s) => !font.scripts.includes(s));
  const measurable = !(scripts.includes(SCRIPT.ARABIC) && font.shaping !== SHAPING.EXACT);
  if (innerW <= 0 || innerH <= 0) {
    return deepFreeze({
      font_size: fontSize, lines: [], line_height_px: fontSize * layer.line_height, block_height: 0, fits: false, measurable,
      reasons: ['BOX_TOO_SMALL'], unsupported_scripts: unsupported, max_line_width: 0,
    });
  }
  const { lines, tooWide } = breakLines(layer.content, font, fontSize, layer.tracking, innerW);
  const lh = fontSize * layer.line_height;
  const widths = lines.map((l) => measureText(l, font, fontSize, layer.tracking));
  const block = lines.length * lh;
  const reasons = [];
  if (lines.length > layer.max_lines) reasons.push('TOO_MANY_LINES');
  if (block > innerH + EPS) reasons.push('TOO_TALL');
  if (tooWide.length) reasons.push('WORD_TOO_WIDE');
  return deepFreeze({
    font_size: fontSize,
    lines: lines.map((t, i) => ({ text: t, width: widths[i] })),
    line_height_px: lh,
    block_height: block,
    fits: reasons.length === 0,
    measurable,
    reasons,
    unsupported_scripts: unsupported,
    max_line_width: widths.length ? Math.max(...widths) : 0,
  });
}

/**
 * Fits a text layer by shrinking its font size one pixel at a time, never below `min_font_size`. If it still does not fit, the
 * smallest allowed size is returned with `fits: false`: the caller must rewrite or relayout - the text is never shrunk further.
 */
export function fitText(layer, font) {
  const start = layer.font_size;
  const floor = Math.min(start, layer.min_font_size);
  let size = start;
  let result = layoutText(layer, font, size);
  while (!result.fits && size - 1 >= layer.min_font_size && size - 1 >= floor) {
    size -= 1;
    result = layoutText(layer, font, size);
  }
  return result;
}

/** Physical anchor of a line for a logical alignment under a text direction. */
export function lineAnchor(layer) {
  const left = layer.geometry.x + layer.box.padding;
  const right = layer.geometry.x + layer.geometry.width - layer.box.padding;
  const center = layer.geometry.x + layer.geometry.width / 2;
  const rtl = layer.direction === TEXT_DIRECTION.RTL;
  if (layer.alignment === TEXT_ALIGNMENT.CENTER) return { x: center, anchor: 'middle', side: 'CENTER' };
  const atStart = layer.alignment === TEXT_ALIGNMENT.START;
  const physicalRight = rtl ? atStart : !atStart;
  return { x: physicalRight ? right : left, anchor: atStart ? 'start' : 'end', side: physicalRight ? 'RIGHT' : 'LEFT' };
}

/** Positions the lines of a laid-out text inside its layer: baseline per line and the ink rectangle. Deterministic. */
export function positionLines(layer, font, laidOut) {
  const { x, anchor, side } = lineAnchor(layer);
  const pad = layer.box.padding;
  const innerH = layer.geometry.height - 2 * pad;
  const free = Math.max(0, innerH - laidOut.block_height);
  const offset = layer.box.vertical_align === 'MIDDLE' ? free / 2 : layer.box.vertical_align === 'BOTTOM' ? free : 0;
  const top = layer.geometry.y + pad + offset;
  const size = laidOut.font_size;
  const ascent = (font.ascent / font.units_per_em) * size;
  const descent = (font.descent / font.units_per_em) * size;
  const lh = laidOut.line_height_px;
  const out = laidOut.lines.map((line, i) => ({
    text: line.text,
    width: line.width,
    x,
    y: top + i * lh + (lh - (ascent + descent)) / 2 + ascent,
    anchor,
  }));
  const ink = (() => {
    if (!out.length) return { x: layer.geometry.x, y: top, width: 0.0001, height: 0.0001 };
    const w = laidOut.max_line_width;
    const left = side === 'LEFT' ? x : side === 'RIGHT' ? x - w : x - w / 2;
    return { x: left, y: top, width: Math.max(w, 0.0001), height: Math.max(laidOut.block_height, 0.0001) };
  })();
  return deepFreeze({ lines: out, ink, font_size: size });
}
