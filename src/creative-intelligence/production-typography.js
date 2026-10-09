// Production typography: real font bytes -> bidi -> shaping -> positioned glyphs. Deterministic, offline, no system fonts.
//
//   font_ref -> (trusted FONT resolution) -> font bytes (hash-checked) -> Unicode bidi (paragraph levels) -> word / run segmentation
//   -> HarfBuzz shaping (GSUB / GPOS, Arabic joining and marks, RTL mirroring) -> shaped advances -> word-aware line breaking
//   -> per-line visual reordering (UBA rule L2 over runs) -> positioned glyphs (outline paths come from the same font file).
//
// Stack (see docs/architecture/creative-pre-c2-foundation.md): harfbuzzjs (shaping, WASM), bidi-js (Unicode Bidirectional Algorithm).
// There is no average-character width, no manual Arabic joining table, no string reversal, no CSS font fallback and no system font: a
// character the font has no glyph for is reported (MISSING_GLYPH), never substituted.
//
// This module is NOT re-exported by the C1 index on purpose: importing it loads the HarfBuzz WASM module. The C1 declared-metrics engine
// (typography.js) stays available for structural inspection; a PRODUCTION render requires fonts built here.

import { createHash } from 'node:crypto';
import {
  Blob as HbBlob, Buffer as HbBuffer, Direction, Face, Font, Variation, shape,
} from 'harfbuzzjs';
import bidiFactory from 'bidi-js';
import { CI_ERROR as E, SCRIPT } from './constants.js';
import { deepFreeze, fail, ref } from './validation.js';

const bidi = bidiFactory();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const EPS = 1e-6;

// Script classes of LETTERS (digits, punctuation, spaces and combining marks inherit the class of what precedes them).
const CLASS_TESTS = [
  [SCRIPT.ARABIC, /\p{Script=Arabic}/u], [SCRIPT.HEBREW, /\p{Script=Hebrew}/u], [SCRIPT.CYRILLIC, /\p{Script=Cyrillic}/u],
  [SCRIPT.GREEK, /\p{Script=Greek}/u], [SCRIPT.LATIN, /\p{Script=Latin}/u],
  [SCRIPT.CJK, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
];
const classOf = (ch) => {
  if (!/\p{L}/u.test(ch)) return null;
  const hit = CLASS_TESTS.find(([, re]) => re.test(ch));
  return hit ? hit[0] : SCRIPT.OTHER;
};
const SCRIPT_PROBES = {
  [SCRIPT.LATIN]: 'AaZz', [SCRIPT.ARABIC]: 'ابتج', [SCRIPT.CYRILLIC]: 'АаЯя', [SCRIPT.GREEK]: 'Αα', [SCRIPT.HEBREW]: 'אב',
};

/**
 * Builds a REAL font from trusted bytes. `metadata` is what the FONT resource declared (family, style, weight, version, content_hash,
 * license_ref): the bytes must match the declared hash. The bytes are used for this font object only and are never stored elsewhere.
 *
 * `variations` selects an instance of a VARIABLE font ({ wght: 600 }): the same hash-checked bytes, a fixed design-space position. It is applied to
 * measuring, shaping and outlines alike, and is reported on the font. Absent, the font's default instance is used.
 */
export function createRealFont({
  font_ref: fontRef, bytes, metadata, variations = null,
}) {
  ref(fontRef, 'font_ref');
  if (!(bytes instanceof Uint8Array) || bytes.length < 64) fail(E.FONT_INVALID, 'a real font needs its bytes', { field: 'bytes' });
  const hash = sha256(bytes);
  if (metadata?.content_hash !== hash) fail(E.FONT_INVALID, 'the font bytes do not match the content hash their owner declared', { field: 'content_hash' });
  let face;
  let font;
  try {
    face = new Face(new HbBlob(bytes));
    font = new Font(face);
  } catch {
    return fail(E.FONT_INVALID, 'the font bytes could not be parsed as an OpenType font', { field: 'bytes' });
  }
  const axes = variations === null ? {} : variations;
  if (typeof axes !== 'object' || Array.isArray(axes)) fail(E.FONT_INVALID, 'variations must be an object of axis tag to value', { field: 'variations' });
  for (const [tag, value] of Object.entries(axes)) {
    if (!/^[A-Za-z0-9 ]{4}$/.test(tag) || !Number.isFinite(value)) fail(E.FONT_INVALID, 'a variation is a four-character axis tag and a finite number', { field: 'variations' });
  }
  if (Object.keys(axes).length > 0) font.setVariations(Object.entries(axes).sort(([a], [b]) => (a < b ? -1 : 1)).map(([tag, value]) => Variation.fromString(`${tag}=${value}`)));
  const upem = face.upem;
  if (!(upem >= 16 && upem <= 16384)) fail(E.FONT_INVALID, 'the font has an invalid units-per-em', { field: 'bytes' });
  const extents = font.hExtents();
  const shapeCache = new Map();
  const pathCache = new Map();
  const extentsCache = new Map();

  const glyphFor = (codePoint) => font.nominalGlyph(codePoint);
  const spaceGlyph = glyphFor(0x20);
  if (spaceGlyph === undefined) fail(E.FONT_INVALID, 'the font has no space glyph', { field: 'bytes' });
  const spaceAdvance = font.glyphHAdvance(spaceGlyph);

  function shapeSegment(segment, rtl, language) {
    const key = `${rtl ? 'r' : 'l'}|${language ?? ''}|${segment}`;
    const hit = shapeCache.get(key);
    if (hit) return hit;
    const buffer = new HbBuffer();
    buffer.addText(segment);
    buffer.setDirection(rtl ? Direction.RTL : Direction.LTR);
    if (language) buffer.setLanguage(language);
    buffer.guessSegmentProperties();
    shape(font, buffer);
    const infos = buffer.getGlyphInfos();
    const positions = buffer.getGlyphPositions();
    const glyphs = infos.map((info, i) => ({
      gid: info.codepoint, cluster: info.cluster, advance: positions[i].xAdvance, dx: positions[i].xOffset, dy: positions[i].yOffset,
    }));
    shapeCache.set(key, glyphs);
    return glyphs;
  }

  /** Distinct characters (other than spaces / controls / line breaks) for which the font has no glyph: never substituted. */
  function missingChars(content) {
    const out = new Set();
    for (const ch of content) {
      if (/[\s\p{Cc}\p{Cf}]/u.test(ch)) continue;
      if (glyphFor(ch.codePointAt(0)) === undefined) out.add(ch);
    }
    return [...out];
  }

  // one run = same bidi level + same script class, shaped as one unit; digits, punctuation and combining marks join the run they sit in
  function wordRuns(paragraph, levels, start, end) {
    const runs = [];
    let current = null;
    let index = start;
    for (const ch of paragraph.slice(start, end)) {
      const own = classOf(ch);
      const level = levels[index];
      if (current && current.level === level && (own === null || current.cls === null || current.cls === own)) {
        current.text += ch;
        if (current.cls === null && own) current.cls = own;
      } else {
        current = {
          text: ch, level, cls: own, start: index,
        };
        runs.push(current);
      }
      index += ch.length;
    }
    return runs;
  }

  function measureRun(run, { fontSize, tracking, language }) {
    const rtl = run.level % 2 === 1;
    const glyphs = shapeSegment(run.text, rtl, language);
    const scale = fontSize / upem;
    // letter-spacing never breaks cursive joining: no tracking inside an Arabic run
    const extra = run.cls === SCRIPT.ARABIC ? 0 : tracking * fontSize;
    let x = 0;
    const placed = glyphs.map((g) => {
      const out = {
        gid: g.gid, x, y: g.dy * scale, ox: g.dx * scale, advance: g.advance * scale + extra,
      };
      x += out.advance;
      return out;
    });
    return {
      level: run.level, rtl, text: run.text, width: x, glyphs: placed,
    };
  }

  // UBA rule L2 over a line's runs: from the highest level down to the lowest odd level, reverse every maximal sequence at that level or above
  function reorder(runs) {
    const levels = runs.map((r) => r.level);
    const max = Math.max(...levels);
    const odd = levels.filter((l) => l % 2 === 1);
    if (!odd.length) return runs;
    const minOdd = Math.min(...odd);
    const order = runs.map((_, i) => i);
    for (let level = max; level >= minOdd; level -= 1) {
      let i = 0;
      while (i < order.length) {
        if (levels[order[i]] >= level) {
          let j = i;
          while (j + 1 < order.length && levels[order[j + 1]] >= level) j += 1;
          const slice = order.slice(i, j + 1).reverse();
          order.splice(i, slice.length, ...slice);
          i = j + 1;
        } else i += 1;
      }
    }
    return order.map((i) => runs[i]);
  }

  /**
   * Lays out a paragraph (content may hold \n) into lines that fit `maxWidth`, measured AFTER real shaping.
   * Returns { lines: [{ text, width, runs: [{ x, level, rtl, text, glyphs }] }], too_wide: [word], missing: [char] }.
   */
  function layout(content, {
    fontSize, tracking = 0, direction = 'LTR', maxWidth, language = null,
  }) {
    const base = direction === 'RTL' ? 'rtl' : 'ltr';
    const lang = language ? language.split('-')[0] : null;
    const lines = [];
    const tooWide = [];
    for (const paragraph of content.split('\n')) {
      const { levels } = bidi.getEmbeddingLevels(paragraph, base);
      // words (maximal runs of non-space characters) in LOGICAL order; a word's end index tells the level of the space after it
      const words = [];
      let i = 0;
      while (i < paragraph.length) {
        if (paragraph[i] === ' ') { i += 1; continue; }
        let j = i;
        while (j < paragraph.length && paragraph[j] !== ' ') j += 1;
        const runs = wordRuns(paragraph, levels, i, j).map((r) => measureRun(r, { fontSize, tracking, language: lang }));
        words.push({ text: paragraph.slice(i, j), runs, width: runs.reduce((sum, r) => sum + r.width, 0), endIndex: j });
        i = j;
      }
      const makeSpace = (level) => measureRun({ text: ' ', level, cls: null, start: 0 }, { fontSize, tracking, language: lang });
      const spaceWidth = makeSpace(0).width;
      let lineWords = [];
      let lineWidth = 0;
      const flush = () => {
        if (!lineWords.length) {
          if (paragraph === '') lines.push({ text: '', width: 0, runs: [] });
          return;
        }
        const logical = [];
        lineWords.forEach((w, k) => {
          if (k > 0) logical.push(makeSpace(levels[lineWords[k - 1].endIndex] ?? (base === 'rtl' ? 1 : 0)));
          logical.push(...w.runs);
        });
        let x = 0;
        const runs = reorder(logical).map((r) => { const placed = { ...r, x }; x += r.width; return placed; });
        lines.push({ text: lineWords.map((w) => w.text).join(' '), width: x, runs });
        lineWords = [];
        lineWidth = 0;
      };
      for (const w of words) {
        if (lineWords.length && lineWidth + spaceWidth + w.width > maxWidth + EPS) flush();
        if (w.width > maxWidth + EPS) tooWide.push(w.text);
        lineWidth += (lineWords.length ? spaceWidth : 0) + w.width;
        lineWords.push(w);
      }
      flush();
    }
    return { lines, too_wide: tooWide, missing: missingChars(content) };
  }

  function glyphPath(gid) {
    const hit = pathCache.get(gid);
    if (hit !== undefined) return hit;
    const d = font.glyphToPath(gid);
    pathCache.set(gid, d);
    return d;
  }
  function glyphExtents(gid) {
    if (!extentsCache.has(gid)) extentsCache.set(gid, font.glyphExtents(gid) ?? null);
    return extentsCache.get(gid);
  }

  const covered = Object.entries(SCRIPT_PROBES).filter(([, probe]) => missingChars(probe).length === 0).map(([name]) => name);

  const engine = Object.freeze({
    layout, missingChars, glyphPath, glyphExtents, glyphFor, spaceAdvance: (size) => (spaceAdvance * size) / upem, units_per_em: upem,
  });
  return Object.freeze({
    kind: 'REAL',
    font_ref: fontRef,
    family: metadata.family,
    style: metadata.style ?? null,
    weight: metadata.weight ?? null,
    variations: Object.freeze({ ...axes }),
    version: metadata.version ?? null,
    content_hash: hash,
    license_ref: metadata.license_ref ?? null,
    units_per_em: upem,
    ascent: extents.ascender,
    descent: -extents.descender,
    scripts: Object.freeze([...covered].sort()),
    shaping: 'EXACT',
    engine,
  });
}

/** A registry of REAL fonts. A font_ref that is not here has no fallback: there is no system font to fall back to. */
export function createRealFontRegistry(fontList = []) {
  const map = new Map();
  for (const f of fontList) {
    if (f?.kind !== 'REAL') fail(E.FONT_INVALID, 'a real font registry only holds real fonts', { field: 'fonts' });
    if (map.has(f.font_ref)) fail(E.FONT_INVALID, 'the same font_ref is registered twice', { field: 'fonts' });
    map.set(f.font_ref, f);
  }
  return Object.freeze({
    has: (r) => map.has(r), get: (r) => map.get(r) ?? null, refs: () => [...map.keys()].sort(),
  });
}

/** One registry over several (declared-metrics for inspection, real for production). The first registry that knows the reference answers. */
export function combineFontRegistries(...registries) {
  return Object.freeze({
    has: (r) => registries.some((x) => x.has(r)),
    get: (r) => { for (const x of registries) { const f = x.get(r); if (f) return f; } return null; },
    refs: () => [...new Set(registries.flatMap((x) => x.refs()))].sort(),
  });
}

/**
 * Loads a REAL font through the common resource resolver: FONT must resolve ACTIVE, its payload comes from the owning adapter
 * (hash-verified) and is wrapped here. The bytes stay inside the returned font; nothing is persisted.
 */
export async function loadRealFont({
  resolver, font_ref: fontRef, tenant, instance_ref: instanceRef = null, variations = null,
}) {
  const resolution = await resolver.require(fontRef, ['FONT'], tenant);
  const payload = await resolver.loadPayload(fontRef, tenant);
  // a layer addresses a font by ONE reference: an instance of a variable font (a weight) gets its own reference, over the same resource and bytes
  return createRealFont({
    font_ref: instanceRef ?? fontRef, bytes: payload.bytes, metadata: resolution.metadata, variations,
  });
}

/**
 * The analytic ink bounds of a positioned line (from glyph extents), in canvas pixels. Used to prove that the rasterized PNG and the
 * layout agree (see PARITY_TOLERANCE_PX).
 */
export function lineInkBounds(font, line, { originX, baseline, fontSize }) {
  const scale = fontSize / font.units_per_em;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const run of line.runs) {
    for (const g of run.glyphs) {
      const ext = font.engine.glyphExtents(g.gid);
      if (!ext || ext.width === 0) continue;
      const gx = originX + run.x + g.x + g.ox;
      const gy = baseline - g.y;
      minX = Math.min(minX, gx + ext.xBearing * scale);
      maxX = Math.max(maxX, gx + (ext.xBearing + ext.width) * scale);
      minY = Math.min(minY, gy - ext.yBearing * scale);
      maxY = Math.max(maxY, gy - (ext.yBearing + ext.height) * scale);
    }
  }
  return minX === Infinity ? null : deepFreeze({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

/** The tolerance (in pixels) allowed between the analytic ink bounds and the rasterized pixels: anti-aliasing of one pixel plus rounding. */
export const PARITY_TOLERANCE_PX = 1.5;
