import { safeCause } from '../creative-brain/model-port.js';
import {
  BRAIN_ERROR, deepFreeze, deriveId, fail,
} from '../creative-brain/validation.js';
import { COMPONENT, DECISION } from '../creative-runtime/ledger.js';
import {
  ASSET_ROLE, CANVAS_SOURCE, CHANNEL_PROFILE, channelProfileOf, CONSTRAINT, COPY_MODE, DENSITY_BAND, EXECUTABLE_ROLES, EXECUTION, EXECUTION_REASON, FORMAT_BASIS, FORMAT_KIND, FORMAT_RULE, LIMITS,
  MULTI_ASSET_KINDS, PIECE_ORIGIN, PLAN_STATUS, QUESTION_CODE, ROLE_ORDER, SCHEMA, SINGLE_CANVAS_KINDS, TEXT_ROLE, USABLE_FACT_STATUS, VIDEO_KINDS,
} from './constants.js';
import { callerResource, FORMAT_RESOURCES, standardResourceFor } from './format-resources.js';
import { buildInventory } from './inventory.js';
import { normalizeRequest, sourceBytesOf } from './request.js';
import {
  codePoints, firstSentence, measure, sentenceAtoms, sliceText, verifyVerbatim,
} from './text-units.js';
import { understandInputs } from './understanding.js';

// THE CONTENT FORMAT PLANNER. It decides WHAT to create before anything decides how to produce it: from the request, the content inventory and the channel it chooses a FORMAT (a single image, a
// carousel, a series, a story sequence, a poster, a flyer, a campaign, or a video), then distributes the text over the assets and the caption, and only then gives each asset its canvas.
//   CONTENT_ANALYSIS (inventory, density)  ->  FORMAT_PLAN (format, assets, on-asset vs caption)  ->  canvas of each asset
// It is deterministic: every figure is measured, every decision names its rule, nothing depends on a provider. Language models are reached only through the two copy ports (adapt, write), and only
// where the copy policy allows. A plan is honest about what exists: a format the production path cannot make yet is PLANNED_NOT_EXECUTABLE, never faked.

const CAPTION_MAX_CHARS = 2200;
const REFERENCE_CAPACITY = FORMAT_RESOURCES[0].text_capacity;
const roleCap = (role) => REFERENCE_CAPACITY[role]?.chars ?? 0;
const isExecutableRole = (role) => EXECUTABLE_ROLES.includes(role);
const PURPOSE_ROLE = Object.freeze({ HEADLINE: TEXT_ROLE.HEADLINE, SUBHEADLINE: TEXT_ROLE.SUBHEADLINE, BODY: TEXT_ROLE.BODY, CTA: TEXT_ROLE.CTA, CAPTION: TEXT_ROLE.CAPTION });
const BODY_CAP_REFERENCE = REFERENCE_CAPACITY[TEXT_ROLE.BODY].chars;

const record = (ledger, decision, component, rule, outcome) => ledger?.record({ decision, decided_by: component, rule, basis: [], outcome });

// ---- working units: the texts of the inventory as the planner moves them. `range` is the part of the text not yet placed (only a LOCKED text is ever sliced).
function workingUnits(inventory) {
  return inventory.units.map((u) => ({
    ref: u.unit_ref, mode: u.mode, declared: u.role, role: null, carrier: u.carrier, text: u.text, origin: u.mode === COPY_MODE.COPY_GENERATABLE ? PIECE_ORIGIN.PENDING_GENERATION : PIECE_ORIGIN.LOCKED,
    purpose: u.purpose, fact_refs: [...u.fact_refs], range: u.text ? { start: 0, end: u.text.length } : null, notes: [],
  }));
}
const rangeText = (u) => (u.text == null ? '' : u.text.slice(u.range.start, u.range.end).trim());
const unitChars = (u) => codePoints(rangeText(u));

function pieceOf(unit, locale, slice = null) {
  const sliced = unit.origin === PIECE_ORIGIN.LOCKED;
  const start = sliced ? (slice ? slice.start : unit.range.start) : null;
  const end = sliced ? (slice ? slice.end : unit.range.end) : null;
  const text = sliced ? unit.text.slice(start, end).trim() : (unit.text ?? '');
  return {
    unit_ref: unit.ref, origin: unit.origin, start, end, text, chars: codePoints(text), words: measure(text, locale).words,
  };
}

// ---- layout of the working units on the assets of a kind (pure, no model)
const emptySlots = () => Object.fromEntries(ROLE_ORDER.map((r) => [r, []]));
const sumChars = (pieces) => pieces.reduce((n, p) => n + p.chars, 0) + Math.max(0, pieces.length - 1);

function layoutSingle({ units, captionAllowed, allText, bodyCap, locale }) {
  const slots = emptySlots(); const caption = []; let unplaced = 0;
  for (const u of units) {
    if (u.role === TEXT_ROLE.CAPTION) { (captionAllowed ? caption : slots.BODY).push(pieceOf(u, locale)); continue; }
    if (u.role === TEXT_ROLE.BODY) { ((captionAllowed && !allText) ? caption : slots.BODY).push(pieceOf(u, locale)); continue; }
    slots[u.role].push(pieceOf(u, locale));
  }
  if (sumChars(slots.BODY) > bodyCap) unplaced += sumChars(slots.BODY) - bodyCap;
  if (sumChars(caption) > CAPTION_MAX_CHARS) unplaced += sumChars(caption) - CAPTION_MAX_CHARS;
  return { feasible: unplaced === 0, unplaced, assets: [{ asset_role: ASSET_ROLE.SINGLE, slots }], caption };
}

/**
 * The best split of consecutive pieces into exactly `groups` groups: the largest group is as small as it can be, so the slides carry about the same amount of text (a linear partition). Null if there are
 * fewer pieces than groups (no split exists), or if the best split still has a group over `cap`.
 */
export function partitionPieces(pieces, groups, cap) {
  const n = pieces.length;
  if (groups < 1) return null;
  const prefix = [0]; for (const p of pieces) prefix.push(prefix[prefix.length - 1] + p.chars);
  const size = (i, j) => prefix[j] - prefix[i] + (j - i - 1); // pieces i..j-1 joined by one space
  // the cost of a split is (the largest group, then the number of cuts that fall inside a paragraph): the slides are as even as possible and, among equal splits, cut where the author did
  const better = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const best = Array.from({ length: groups + 1 }, () => Array(n + 1).fill(null)); const cut = Array.from({ length: groups + 1 }, () => Array(n + 1).fill(0));
  best[0][0] = [0, 0];
  for (let g = 1; g <= groups; g += 1) {
    for (let j = g; j <= n; j += 1) {
      for (let i = g - 1; i < j; i += 1) {
        if (!best[g - 1][i]) continue;
        const inside = (i > 0 && !pieces[i - 1].paragraph_end) ? 1 : 0;
        const cost = [Math.max(best[g - 1][i][0], size(i, j)), best[g - 1][i][1] + inside];
        if (!best[g][j] || better(cost, best[g][j])) { best[g][j] = cost; cut[g][j] = i; }
      }
    }
  }
  if (!best[groups][n] || best[groups][n][0] > cap) return null;
  const out = []; let j = n;
  for (let g = groups; g >= 1; g -= 1) { const i = cut[g][j]; out.unshift({ pieces: pieces.slice(i, j), chars: size(i, j) }); j = i; }
  return out;
}

function layoutMulti({
  kind, units, slideCap, maxAssets, requestedCount, captionAllowed, allText, locale,
}) {
  const bodyCap = slideCap;
  const heads = []; const closing = []; const body = []; const caption = [];
  for (const u of units) {
    if (u.role === TEXT_ROLE.HEADLINE || u.role === TEXT_ROLE.SUBHEADLINE) heads.push(u);
    else if (u.role === TEXT_ROLE.CTA || u.role === TEXT_ROLE.PRICE) closing.push(u);
    else if (u.role === TEXT_ROLE.CAPTION && captionAllowed) caption.push(pieceOf(u, locale));
    else body.push(u);
  }
  // body pieces: each unit cut at the best boundary into pieces that fit a slide, then grouped in order
  const pieces = [];
  for (const u of body) {
    if (u.origin === PIECE_ORIGIN.LOCKED) {
      const base = u.range.start;
      const text = u.text.slice(u.range.start, u.range.end);
      for (const a of sentenceAtoms(text, bodyCap, locale)) pieces.push({ ...pieceOf(u, locale, { start: base + a.start, end: base + a.end }), paragraph_end: a.paragraph_end });
    } else pieces.push({ ...pieceOf(u, locale), paragraph_end: true });
  }
  let groups = [];
  for (const p of pieces) {
    const last = groups.at(-1);
    if (last && last.chars + 1 + p.chars <= bodyCap) { last.pieces.push(p); last.chars += 1 + p.chars; } else groups.push({ pieces: [p], chars: p.chars });
  }
  // the slides carry about the same amount of text: the same number of groups, split evenly; a requested number of slides is honoured when the text can be split that far
  const reservedCount = (heads.length ? 1 : 0) + (closing.length ? 1 : 0);
  const wanted = requestedCount ? requestedCount - reservedCount : groups.length;
  if (wanted >= 1 && wanted <= pieces.length) groups = partitionPieces(pieces, wanted, bodyCap) ?? groups;
  const make = (slotsOf, assetRole) => ({ asset_role: assetRole, slots: slotsOf });
  const assets = [];
  if (heads.length) { const s = emptySlots(); for (const u of heads) s[u.role].push(pieceOf(u, locale)); assets.push(make(s, ASSET_ROLE.COVER)); }
  const bodyAssets = groups.map((g) => { const s = emptySlots(); s.BODY.push(...g.pieces.map(({ paragraph_end: _p, ...rest }) => rest)); return make(s, ASSET_ROLE.CONTENT); });
  let closingAsset = null;
  if (closing.length) { const s = emptySlots(); for (const u of closing) s[u.role].push(pieceOf(u, locale)); closingAsset = make(s, ASSET_ROLE.CLOSING); }
  const reserved = assets.length + (closingAsset ? 1 : 0);
  const limit = Math.min(maxAssets, requestedCount ?? Infinity);
  let unplaced = 0;
  let kept = bodyAssets;
  if (reserved + bodyAssets.length > limit) {
    const room = Math.max(0, limit - reserved);
    kept = bodyAssets.slice(0, room);
    const overflow = bodyAssets.slice(room).flatMap((a) => a.slots.BODY);
    if (captionAllowed && !allText) caption.push(...overflow); else unplaced += sumChars(overflow);
  }
  assets.push(...kept);
  // a requested number of assets larger than the text needs: the extra assets carry no text (they are visual assets)
  if (requestedCount && reserved + kept.length < requestedCount) for (let i = reserved + kept.length; i < requestedCount; i += 1) assets.push(make(emptySlots(), ASSET_ROLE.CONTENT));
  if (closingAsset) assets.push(closingAsset);
  if (assets.length === 0) assets.push(make(emptySlots(), ASSET_ROLE.CONTENT));
  if (kind === FORMAT_KIND.MULTI_VISUAL_SERIES) assets.forEach((a) => { a.asset_role = ASSET_ROLE.ITEM; });
  else { assets[0].asset_role = ASSET_ROLE.COVER; if (closingAsset) assets.at(-1).asset_role = ASSET_ROLE.CLOSING; }
  if (sumChars(caption) > CAPTION_MAX_CHARS) unplaced += sumChars(caption) - CAPTION_MAX_CHARS;
  return { feasible: unplaced === 0 && assets.length <= maxAssets, unplaced, assets, caption };
}

/** The invariant that makes "locked text is never altered" a fact: for every locked unit, its placed pieces are consecutive slices that hold exactly its words. */
export function assertLockedTextUnaltered(inventoryUnits, assets, caption) {
  const all = [...assets.flatMap((a) => a.slots.flatMap((s) => s.pieces)), ...(caption?.pieces ?? [])];
  for (const u of inventoryUnits) {
    if (u.mode === COPY_MODE.COPY_GENERATABLE || !u.text) continue;
    const mine = all.filter((p) => p.unit_ref === u.unit_ref);
    if (!mine.length) continue;
    const altered = mine.some((p) => p.origin !== PIECE_ORIGIN.LOCKED);
    // a LOCKED text has no piece that is not its own words; an ADAPTABLE text that was adapted in part is not held to this
    if (altered && u.mode === COPY_MODE.COPY_LOCKED) fail(BRAIN_ERROR.RULE_VIOLATION, 'a locked text was altered by the distribution', 'content_plan', { problem: 'LOCKED_TEXT_ALTERED', unit_ref: u.unit_ref });
    if (altered) continue;
    const slices = mine.map((p) => ({ start: p.start, end: p.end })).sort((a, b) => a.start - b.start);
    if (!verifyVerbatim(u.text, slices)) fail(BRAIN_ERROR.RULE_VIOLATION, 'a locked text was altered by the distribution', 'content_plan', { problem: 'LOCKED_TEXT_ALTERED', unit_ref: u.unit_ref });
  }
}

const cloneUnit = (u) => ({
  ...u, notes: [...u.notes], fact_refs: [...u.fact_refs], range: u.range ? { ...u.range } : null,
});

const ASK = (code, field, question, options = [], blocking = true) => ({
  code, blocking, field, question, options,
});

/** Creates a planner. Every port is optional; a missing port degrades honestly (never silently). */
export function createContentFormatPlanner({
  understanding = {}, copyAdapter = null, copyWriter = null, ledger = null,
} = {}) {
  /** Roles of the working units, with the adaptations and generations the copy policy allows. */
  async function fitRoles({ units, request, inventory, events }) {
    const taken = new Set();
    const usable = inventory.facts.filter((f) => USABLE_FACT_STATUS.includes(f.status));
    const questions = [];
    for (const u of units) {
      if (u.mode === COPY_MODE.COPY_GENERATABLE) {
        u.role = PURPOSE_ROLE[u.purpose];
        const cap = u.role === TEXT_ROLE.CAPTION ? CAPTION_MAX_CHARS : (u.role === TEXT_ROLE.BODY ? BODY_CAP_REFERENCE : roleCap(u.role));
        const allowed = u.fact_refs.length ? usable.filter((f) => u.fact_refs.includes(f.fact_ref)) : usable;
        if (allowed.length === 0 && u.purpose !== 'CTA') {
          questions.push(ASK(QUESTION_CODE.NOTHING_VERIFIED_TO_GENERATE_FROM, u.ref, 'There is no verified or approved fact to write this text from. Which facts may it rest on?', [], true));
          continue;
        }
        if (copyWriter) {
          try {
            const written = await copyWriter.write({ purpose: u.purpose, facts: allowed, objective: inventory.objective, audience: inventory.audience, capacityChars: cap, locale: request.locale });
            u.text = written.text; u.origin = PIECE_ORIGIN.GENERATED; u.range = { start: 0, end: u.text.length }; u.notes.push('GENERATED_FROM_VERIFIED_FACTS');
            events.push({ kind: 'GENERATED', unit_ref: u.ref, role: u.role, uses_fact_refs: written.uses_fact_refs, request_id: written.meta?.request_id ?? null });
            record(ledger, DECISION.COPY_GENERATION, COMPONENT.COPY_WRITER, 'GENERATE_ONLY_FROM_VERIFIED_FACTS', { unit_ref: u.ref, role: u.role, uses_fact_refs: written.uses_fact_refs, request_id: written.meta?.request_id ?? null });
          } catch (error) {
            u.notes.push('GENERATION_REFUSED_OR_FAILED');
            events.push({ kind: 'GENERATION_FAILED', unit_ref: u.ref, role: u.role, ...safeCause(error), problem: error?.detail?.problem ?? null });
            record(ledger, DECISION.COPY_GENERATION, COMPONENT.COPY_WRITER, 'GENERATE_ONLY_FROM_VERIFIED_FACTS', { unit_ref: u.ref, outcome: 'REFUSED', problem: error?.detail?.problem ?? null });
          }
        } else { u.notes.push('COPY_WRITER_NOT_CONNECTED'); events.push({ kind: 'GENERATION_PENDING', unit_ref: u.ref, role: u.role }); }
        continue;
      }
      const chars = unitChars(u);
      const declared = u.declared;
      if (declared && isExecutableRole(declared)) {
        if (chars <= roleCap(declared) && !taken.has(declared)) { u.role = declared; taken.add(declared); continue; }
        if (chars <= roleCap(declared)) { u.role = TEXT_ROLE.BODY; u.notes.push('SLOT_ALREADY_TAKEN'); continue; }
        if (u.mode === COPY_MODE.COPY_ADAPTABLE && copyAdapter) {
          try {
            const adapted = await copyAdapter.adapt({ source: rangeText(u), role: declared, capacityChars: roleCap(declared), locale: request.locale });
            events.push({ kind: 'ADAPTED', unit_ref: u.ref, role: declared, request_id: adapted.meta?.request_id ?? null });
            record(ledger, DECISION.COPY_ADAPTATION, COMPONENT.COPY_ADAPTER, 'ADAPT_ONLY_WHEN_THE_POLICY_ALLOWS_AND_THE_TEXT_DOES_NOT_FIT', { unit_ref: u.ref, role: declared, request_id: adapted.meta?.request_id ?? null });
            u.original_text = u.text; u.text = adapted.text; u.origin = PIECE_ORIGIN.ADAPTED; u.range = { start: 0, end: u.text.length }; u.role = declared; taken.add(declared); u.notes.push('ADAPTED_TO_FIT');
            continue;
          } catch (error) {
            events.push({ kind: 'ADAPTATION_REFUSED', unit_ref: u.ref, role: declared, ...safeCause(error), problem: error?.detail?.problem ?? null });
            record(ledger, DECISION.COPY_ADAPTATION, COMPONENT.COPY_ADAPTER, 'ADAPT_ONLY_WHEN_THE_POLICY_ALLOWS_AND_THE_TEXT_DOES_NOT_FIT', { unit_ref: u.ref, outcome: 'REFUSED', problem: error?.detail?.problem ?? null });
            u.notes.push('ADAPTATION_REFUSED_TEXT_STAYS_UNCHANGED');
          }
        } else if (u.mode === COPY_MODE.COPY_ADAPTABLE) u.notes.push('ADAPTER_NOT_CONNECTED_TEXT_STAYS_UNCHANGED');
        u.role = TEXT_ROLE.BODY; u.notes.push(`DEMOTED_FROM_${declared}`); continue;
      }
      u.role = declared === TEXT_ROLE.CAPTION ? TEXT_ROLE.CAPTION : TEXT_ROLE.BODY;
    }
    // a text nobody gave a role to takes the most prominent free role it fits (whole, unchanged)
    for (const u of units) {
      if (u.declared || u.role !== TEXT_ROLE.BODY || !u.text || u.origin === PIECE_ORIGIN.PENDING_GENERATION) continue;
      const chars = unitChars(u);
      if (!taken.has(TEXT_ROLE.HEADLINE) && chars <= roleCap(TEXT_ROLE.HEADLINE)) { u.role = TEXT_ROLE.HEADLINE; taken.add(TEXT_ROLE.HEADLINE); u.notes.push('TOOK_THE_HEADLINE_ROLE'); } else if (!taken.has(TEXT_ROLE.SUBHEADLINE) && chars <= roleCap(TEXT_ROLE.SUBHEADLINE)) { u.role = TEXT_ROLE.SUBHEADLINE; taken.add(TEXT_ROLE.SUBHEADLINE); u.notes.push('TOOK_THE_SUBHEADLINE_ROLE'); }
    }
    // a locked body with no headline: its first whole sentence becomes the headline when it fits (a cut, never a rewrite); the rest stays the body
    const out = [];
    for (const u of units) {
      if (!taken.has(TEXT_ROLE.HEADLINE) && u.role === TEXT_ROLE.BODY && u.origin === PIECE_ORIGIN.LOCKED && u.text) {
        const rest = rangeText(u);
        const base = u.text.indexOf(rest, u.range.start);
        const fs = firstSentence(rest, request.locale);
        if (fs && codePoints(rest.slice(fs.start, fs.end)) <= roleCap(TEXT_ROLE.HEADLINE) && rest.slice(fs.end).trim()) {
          out.push({
            ...u, role: TEXT_ROLE.HEADLINE, range: { start: base + fs.start, end: base + fs.end }, notes: [...u.notes, 'FIRST_SENTENCE_PROMOTED_TO_HEADLINE'],
          });
          out.push({ ...u, range: { start: base + fs.end, end: u.range.end }, notes: [...u.notes] });
          taken.add(TEXT_ROLE.HEADLINE);
          continue;
        }
      }
      out.push(u);
    }
    return { units: out, questions };
  }

  function layoutFor({ kind, units, ctx, resource }) {
    const bodyCap = resource.text_capacity.BODY.chars;
    if (SINGLE_CANVAS_KINDS.includes(kind)) return layoutSingle({ units, captionAllowed: ctx.captionAllowed, allText: ctx.allText, bodyCap, locale: ctx.locale });
    // the text a slide of a sequence carries is bounded by its density class (measured against the text-led layout spec); without a stated class a slide shares its space with the image (HIGH)
    const slideCap = resource.slide_capacity[ctx.slideDensity ?? 'HIGH'].chars;
    return layoutMulti({
      kind, units, slideCap, maxAssets: Math.min(LIMITS.max_assets[kind] ?? 1, ctx.maxAssets), requestedCount: ctx.requestedCount, captionAllowed: ctx.captionAllowed, allText: ctx.allText, locale: ctx.locale,
    });
  }

  const resourceFor = (kind, ctx) => (ctx.callerCanvas && (SINGLE_CANVAS_KINDS.includes(kind) || ctx.callerCanvasAny) ? { resource: callerResource(ctx.callerCanvas), source: CANVAS_SOURCE.CALLER_RESOURCE } : { resource: standardResourceFor(kind, ctx.profileName), source: CANVAS_SOURCE.STANDARD_RESOURCE });

  /** The format decision: which kind, by which rule. Returns { kind, basis, rule, layout, resource, source } or { ask }. */
  function decide({ units, ctx }) {
    const body = units.filter((u) => u.role === TEXT_ROLE.BODY);
    const bodyChars = body.reduce((n, u) => n + unitChars(u), 0);
    const sections = body.reduce((n, u) => n + measure(rangeText(u), ctx.locale).paragraphs, 0);
    const tryKind = (kind) => { const { resource, source } = resourceFor(kind, ctx); return { kind, resource, source, layout: layoutFor({ kind, units, ctx, resource }) }; };
    const usableKinds = (list) => list.filter((k) => !(ctx.singleOnly && !SINGLE_CANVAS_KINDS.includes(k)) && !VIDEO_KINDS.includes(k) && k !== FORMAT_KIND.MULTI_ASSET_CAMPAIGN);
    let overridden = null;
    if (ctx.requested && !VIDEO_KINDS.includes(ctx.requested) && ctx.requested !== FORMAT_KIND.MULTI_ASSET_CAMPAIGN) {
      const t = tryKind(ctx.requested);
      if (t.layout.feasible) return { ...t, basis: FORMAT_BASIS.REQUESTED, rule: FORMAT_RULE.EXPLICIT_REQUEST_IS_HONOURED, density: { bodyChars, sections } };
      if (ctx.fixed) return { ask: ASK(QUESTION_CODE.REQUESTED_FORMAT_CANNOT_HOLD_THE_LOCKED_TEXT, 'requested_format', `The requested format cannot hold this text without changing it. Allow a caption, allow more assets, or allow the text to be condensed?`, ['ALLOW_CAPTION', 'ALLOW_MORE_ASSETS', 'ALLOW_CONDENSING']) };
      overridden = ctx.requested;
    }
    if (!ctx.requested && ctx.requestedCount > 1) {
      const t = tryKind(FORMAT_KIND.MULTI_VISUAL_SERIES);
      if (t.layout.feasible) return { ...t, basis: FORMAT_BASIS.REQUESTED, rule: FORMAT_RULE.EXPLICIT_REQUEST_IS_HONOURED, density: { bodyChars, sections } };
    }
    const profileKinds = usableKinds(ctx.profile.kinds);
    const kinds = profileKinds.length ? profileKinds : usableKinds(CHANNEL_PROFILE.GENERIC_DIGITAL.kinds);
    const singles = kinds.filter((k) => SINGLE_CANVAS_KINDS.includes(k)); const multis = kinds.filter((k) => MULTI_ASSET_KINDS.includes(k));
    const defaulted = ctx.channelDefaulted ? FORMAT_BASIS.DEFAULTED : FORMAT_BASIS.CHANNEL;
    const withNote = (r) => ({ ...r, overridden, density: { bodyChars, sections } });
    if (bodyChars === 0 || (ctx.captionAllowed && !ctx.allText && !(sections >= 3 && bodyChars > BODY_CAP_REFERENCE && multis.length))) {
      const kind = singles[0] ?? multis[0];
      if (kind) { const t = tryKind(kind); if (t.layout.feasible) return withNote({ ...t, basis: bodyChars === 0 ? defaulted : FORMAT_BASIS.DENSITY, rule: bodyChars === 0 ? (ctx.channelDefaulted ? FORMAT_RULE.NO_CHANNEL_MEANS_A_GENERIC_DIGITAL_FEED : FORMAT_RULE.TEXT_THAT_FITS_STAYS_ON_ONE_ASSET) : FORMAT_RULE.BODY_TEXT_GOES_TO_THE_CAPTION_WHEN_THE_ASSET_HAS_NO_BODY_SLOT }); }
    }
    if (ctx.captionAllowed && !ctx.allText) {
      // a sequence is chosen only if the whole text fits on its assets: a sequence with a stray fragment in the caption is not a sequence
      for (const kind of multis) { const t = tryKind(kind); if (t.layout.feasible && t.layout.caption.length === units.filter((u) => u.role === TEXT_ROLE.CAPTION).length) return withNote({ ...t, basis: FORMAT_BASIS.DENSITY, rule: FORMAT_RULE.SECTIONED_LONG_TEXT_BECOMES_A_SEQUENCE }); }
      const single = singles[0];
      if (single) { const t = tryKind(single); if (t.layout.feasible) return withNote({ ...t, basis: FORMAT_BASIS.DENSITY, rule: FORMAT_RULE.BODY_TEXT_GOES_TO_THE_CAPTION_WHEN_THE_ASSET_HAS_NO_BODY_SLOT }); }
    }
    for (const kind of [...singles, ...multis]) { const t = tryKind(kind); if (t.layout.feasible) return withNote({ ...t, basis: FORMAT_BASIS.DENSITY, rule: FORMAT_RULE.ALL_TEXT_ON_ASSET_NEEDS_THE_SMALLEST_FORMAT_THAT_HOLDS_IT }); }
    return { ask: ASK(QUESTION_CODE.TEXT_CANNOT_BE_PLACED_WITHOUT_ALTERING_IT, 'copy', 'This text cannot be placed as written in any available format. May it be condensed, may part of it go in a caption, or may more assets be used?', ['ALLOW_CONDENSING', 'ALLOW_CAPTION', 'ALLOW_MORE_ASSETS']) };
  }

  function densityReport(inventory, picked, locale) {
    const textChars = inventory.totals.chars;
    const bodyChars = picked?.density?.bodyChars ?? 0;
    const carouselRoom = BODY_CAP_REFERENCE * (LIMITS.max_assets.CAROUSEL - 2);
    return {
      units: inventory.totals.text_units, chars: textChars, words: inventory.totals.words, body_chars: bodyChars, sections: picked?.density?.sections ?? 0,
      band: bodyChars <= BODY_CAP_REFERENCE ? DENSITY_BAND.LOW : (bodyChars <= carouselRoom ? DENSITY_BAND.MEDIUM : DENSITY_BAND.HIGH), locale,
    };
  }

  function executionOf({ kind, asset, resource, pending }) {
    const reasons = [];
    if (MULTI_ASSET_KINDS.includes(kind)) reasons.push(EXECUTION_REASON.MULTI_ASSET_PRODUCTION_NOT_AVAILABLE);
    if (!resource.within_current_production_limit) reasons.push(EXECUTION_REASON.CANVAS_EXCEEDS_THE_CURRENT_PRODUCTION_LIMIT);
    const used = ROLE_ORDER.filter((r) => asset.slots[r].length);
    for (const r of used) if (!isExecutableRole(r)) reasons.push(`${EXECUTION_REASON.ROLE_HAS_NO_LAYOUT_SLOT}:${r}`);
    if (pending) reasons.push(EXECUTION_REASON.COPY_NOT_YET_GENERATED);
    if (used.length === 0) reasons.push(EXECUTION_REASON.ASSET_HAS_NO_TEXT);
    const executable = reasons.length === 0;
    return { status: executable ? EXECUTION.EXECUTABLE_NOW : EXECUTION.PLANNED_NOT_EXECUTABLE, reasons };
  }

  function sealAsset({ index, asset, kind, resource, source, pending, locale }) {
    const slots = ROLE_ORDER.filter((r) => asset.slots[r].length).map((role) => {
      const pieces = asset.slots[role].map((p) => ({ piece_id: deriveId('pce', { u: p.unit_ref, o: p.origin, s: p.start, e: p.end, t: p.text }), ...p }));
      const text = pieces.map((p) => p.text).join(' ');
      return { role, text, chars: codePoints(text), words: measure(text, locale).words, pieces };
    });
    const body = {
      index, asset_role: asset.asset_role, format_resource_ref: resource.format_ref, canvas_source: source, canvas: resource.canvas, medium: resource.medium, aspect_ratio: resource.aspect_ratio, slots,
      execution: executionOf({ kind, asset: { slots: asset.slots }, resource, pending }),
    };
    return { asset_id: deriveId('ast', body), ...body };
  }

  const sealCaption = (pieces, locale) => {
    if (!pieces.length) return null;
    const sealed = pieces.map((p) => ({ piece_id: deriveId('pce', { u: p.unit_ref, o: p.origin, s: p.start, e: p.end, t: p.text }), ...p }));
    const text = sealed.map((p) => p.text).join('\n\n');
    return { text, chars: codePoints(text), words: measure(text, locale).words, pieces: sealed };
  };

  async function planInternal({ request, inventory, observations, force = null }) {
    const questions = [];
    const events = [];
    const get = (kind) => request.constraints.find((c) => c.kind === kind);
    const allText = Boolean(get(CONSTRAINT.ALL_TEXT_ON_ASSET));
    const singleOnly = Boolean(get(CONSTRAINT.SINGLE_ASSET_ONLY)) || get(CONSTRAINT.MAX_ASSETS)?.value === 1;
    const fixed = Boolean(get(CONSTRAINT.FORMAT_IS_FIXED));
    const maxAssets = get(CONSTRAINT.MAX_ASSETS)?.value ?? Infinity;
    const noGeneration = Boolean(get(CONSTRAINT.NO_GENERATED_COPY));
    const requested = force?.requested === undefined ? request.requested_format : force.requested;
    const requestedMulti = (requested && (MULTI_ASSET_KINDS.includes(requested))) || (request.requested_asset_count ?? 1) > 1;
    if (singleOnly && requestedMulti) questions.push(ASK(QUESTION_CODE.CONSTRAINTS_CONTRADICT_EACH_OTHER, 'constraints', 'A single asset is required, but a format of several assets was requested. Which one applies?', ['SINGLE_ASSET', 'SEVERAL_ASSETS']));
    if ((request.requested_asset_count ?? 0) > maxAssets) questions.push(ASK(QUESTION_CODE.CONSTRAINTS_CONTRADICT_EACH_OTHER, 'requested_asset_count', 'More assets were requested than the maximum allowed. Which one applies?', ['REQUESTED_COUNT', 'MAXIMUM']));
    if (noGeneration && inventory.units.some((u) => u.mode === COPY_MODE.COPY_GENERATABLE)) questions.push(ASK(QUESTION_CODE.CONSTRAINTS_CONTRADICT_EACH_OTHER, 'copy', 'Generated copy is asked for, but generating copy is forbidden. Which one applies?', ['ALLOW_GENERATED_COPY', 'PROVIDE_THE_TEXT']));
    if (inventory.units.length === 0 && inventory.facts.length === 0) questions.push(ASK(QUESTION_CODE.NOTHING_TO_SAY, 'copy', 'There is no text and no fact to build from. What should the content say?', []));

    const channels = force?.channels ?? request.channels;
    const first = channelProfileOf(channels[0] ?? null);
    const profileName = force?.profileName ?? first.name;
    const profile = force?.profile ?? first.profile;
    const channelDefaulted = !channels.length;
    const locale = request.locale;
    const base = {
      locale, profile, profileName, channelDefaulted, captionAllowed: profile.caption, allText, singleOnly, maxAssets, fixed, requested, requestedCount: request.requested_asset_count, callerCanvas: request.canvas, slideDensity: force?.slideDensity ?? request.slide_density,
    };
    const empty = (status) => ({
      status, kind: null, questions, events, assets: [], caption: null, members: [], alternative: null, format: null, density: densityReport(inventory, null, locale), executable: false, execution: null,
    });
    if (questions.some((q) => q.blocking)) return empty(PLAN_STATUS.NEEDS_USER_DECISION);

    let fitted;
    if (force?.fitted) {
      // the roles, adaptations and generations were decided once (prepare); every plan from the same preparation works on its own copy of them
      fitted = { units: force.fitted.units.map(cloneUnit), questions: [...force.fitted.questions] };
      events.push(...force.fitted.events);
    } else fitted = await fitRoles({ units: workingUnits(inventory), request, inventory, events });
    questions.push(...fitted.questions);
    if (questions.some((q) => q.blocking)) return empty(PLAN_STATUS.NEEDS_USER_DECISION);
    let units = fitted.units;
    const pending = units.some((u) => u.origin === PIECE_ORIGIN.PENDING_GENERATION);
    units = units.filter((u) => u.text != null || u.origin === PIECE_ORIGIN.PENDING_GENERATION);

    // ---- video: planned, never produced; the static alternative is a full plan of its own
    const wantsVideo = VIDEO_KINDS.includes(requested) || (!requested && profile.kinds.every((k) => VIDEO_KINDS.includes(k)));
    if (wantsVideo && !force?.noVideo) {
      const altProfileName = profileName === 'VIDEO_FEED' ? 'SOCIAL_STORY' : profileName;
      const altRequested = request.requested_format && !VIDEO_KINDS.includes(request.requested_format) ? request.requested_format : null;
      const alternative = await planInternal({
        request, inventory, observations, force: {
          noVideo: true, noCampaign: true, requested: altRequested, profileName: altProfileName, profile: channelProfileOf(altProfileName === 'SOCIAL_STORY' ? 'STORY' : channels[0] ?? null).profile, channels, fitted: { units, questions: [], events: [] }, slideDensity: force?.slideDensity,
        },
      });
      const explicit = VIDEO_KINDS.includes(requested);
      const kind = requested ?? FORMAT_KIND.SHORT_VIDEO;
      questions.push(ASK(QUESTION_CODE.VIDEO_NOT_PRODUCIBLE_CHOOSE_ALTERNATIVE, 'requested_format', 'Video cannot be produced yet. The plan includes a still alternative; use it, or wait for video?', ['USE_THE_STILL_ALTERNATIVE', 'WAIT_FOR_VIDEO'], false));
      return {
        status: PLAN_STATUS.PLANNED, kind, questions, events, assets: [], caption: null, members: [], alternative, density: alternative.density, executable: false,
        format: { kind, basis: explicit ? FORMAT_BASIS.REQUESTED : FORMAT_BASIS.CHANNEL, rule: FORMAT_RULE.VIDEO_IS_PLANNED_NOT_PRODUCED, channel_profile: profileName },
        execution: { status: EXECUTION.PLANNED_NOT_EXECUTABLE, reasons: [EXECUTION_REASON.VIDEO_PRODUCTION_NOT_AVAILABLE] },
      };
    }

    // ---- several channels (or a requested campaign): a campaign whose members are decided per channel; their production belongs to later phases
    if ((channels.length > 1 || requested === FORMAT_KIND.MULTI_ASSET_CAMPAIGN) && !force?.noCampaign) {
      const members = [];
      for (const channel of (channels.length ? channels : [null])) {
        const p = channelProfileOf(channel);
        const ctx = { ...base, profile: p.profile, profileName: p.name, channelDefaulted: !channel, captionAllowed: p.profile.caption, requested: null, requestedCount: null };
        if (p.profile.kinds.every((k) => VIDEO_KINDS.includes(k))) {
          members.push({ channel: channel ?? 'UNSPECIFIED', channel_profile: p.name, kind: FORMAT_KIND.SHORT_VIDEO, format_resource_ref: null, asset_count: 0, caption_used: false, question: null });
          continue;
        }
        const picked = decide({ units, ctx });
        members.push(picked.ask ? { channel: channel ?? 'UNSPECIFIED', channel_profile: p.name, kind: null, format_resource_ref: null, asset_count: 0, caption_used: false, question: picked.ask } : {
          channel: channel ?? 'UNSPECIFIED', channel_profile: p.name, kind: picked.kind, format_resource_ref: picked.resource.format_ref, asset_count: picked.layout.assets.length, caption_used: picked.layout.caption.length > 0,
        });
      }
      if (members.some((m) => m.question)) questions.push(...members.filter((m) => m.question).map((m) => m.question));
      return {
        status: questions.some((q) => q.blocking) ? PLAN_STATUS.NEEDS_USER_DECISION : PLAN_STATUS.PLANNED, kind: FORMAT_KIND.MULTI_ASSET_CAMPAIGN, questions, events, assets: [], caption: null, members, alternative: null,
        density: densityReport(inventory, null, locale), executable: false,
        format: { kind: FORMAT_KIND.MULTI_ASSET_CAMPAIGN, basis: channels.length > 1 ? FORMAT_BASIS.CHANNEL : FORMAT_BASIS.REQUESTED, rule: FORMAT_RULE.SEVERAL_CHANNELS_MAKE_A_CAMPAIGN, channel_profile: profileName },
        execution: { status: EXECUTION.PLANNED_NOT_EXECUTABLE, reasons: [EXECUTION_REASON.CAMPAIGN_PRODUCTION_NOT_AVAILABLE] },
      };
    }

    let picked = decide({ units, ctx: base });
    if (picked.ask) {
      // a condensable (ADAPTABLE) body is condensed ONLY when nothing else can hold it, and only if the policy and a connected adapter allow it
      const adaptable = units.filter((u) => u.mode === COPY_MODE.COPY_ADAPTABLE && u.role === TEXT_ROLE.BODY && u.origin === PIECE_ORIGIN.LOCKED);
      if (adaptable.length && copyAdapter) {
        const firstSingle = profile.kinds.find((k) => SINGLE_CANVAS_KINDS.includes(k)) ?? FORMAT_KIND.SINGLE_IMAGE;
        const target = resourceFor(firstSingle, base).resource.text_capacity.BODY.chars;
        const share = Math.max(1, Math.floor(target / adaptable.length));
        for (const u of adaptable) {
          try {
            const adapted = await copyAdapter.adapt({ source: rangeText(u), role: TEXT_ROLE.BODY, capacityChars: share, locale });
            events.push({ kind: 'ADAPTED', unit_ref: u.ref, role: TEXT_ROLE.BODY, request_id: adapted.meta?.request_id ?? null });
            record(ledger, DECISION.COPY_ADAPTATION, COMPONENT.COPY_ADAPTER, 'ADAPT_ONLY_WHEN_THE_POLICY_ALLOWS_AND_NOTHING_ELSE_HOLDS_THE_TEXT', { unit_ref: u.ref, request_id: adapted.meta?.request_id ?? null });
            u.original_text = u.text; u.text = adapted.text; u.origin = PIECE_ORIGIN.ADAPTED; u.range = { start: 0, end: u.text.length }; u.notes.push('ADAPTED_TO_FIT');
          } catch (error) {
            events.push({ kind: 'ADAPTATION_REFUSED', unit_ref: u.ref, role: TEXT_ROLE.BODY, ...safeCause(error), problem: error?.detail?.problem ?? null });
            record(ledger, DECISION.COPY_ADAPTATION, COMPONENT.COPY_ADAPTER, 'ADAPT_ONLY_WHEN_THE_POLICY_ALLOWS_AND_NOTHING_ELSE_HOLDS_THE_TEXT', { unit_ref: u.ref, outcome: 'REFUSED', problem: error?.detail?.problem ?? null });
          }
        }
        picked = decide({ units, ctx: base });
      }
    }
    if (picked.ask) { questions.push(picked.ask); return empty(PLAN_STATUS.NEEDS_USER_DECISION); }

    const { kind, layout, resource, source } = picked;
    const assets = layout.assets.map((asset, index) => sealAsset({ index, asset, kind, resource, source, pending, locale }));
    const caption = sealCaption(layout.caption, locale);
    return {
      status: PLAN_STATUS.PLANNED, kind, questions, events, assets, caption, members: [], alternative: null, density: densityReport(inventory, picked, locale),
      format: {
        kind, basis: picked.basis, rule: picked.rule, channel_profile: profileName, ...(picked.overridden ? { requested_format_not_applicable: picked.overridden } : {}),
      },
      executable: assets.every((a) => a.execution.status === EXECUTION.EXECUTABLE_NOW), execution: null, notes: units.flatMap((u) => u.notes.map((n) => ({ unit_ref: u.ref, note: n }))),
    };
  }

  function seal({ request, inventory, observations, result }) {
    const base = {
      schema: SCHEMA.plan,
      request_ref: request.request_ref,
      status: result.questions.some((q) => q.blocking) ? PLAN_STATUS.NEEDS_USER_DECISION : PLAN_STATUS.PLANNED,
      inventory_id: inventory.inventory_id,
      observation_ids: observations.map((o) => o.observation_id),
      format: result.format,
      density: result.density,
      assets: result.assets,
      caption: result.caption,
      members: result.members,
      alternative: result.alternative,
      executable: result.executable,
      execution: result.execution,
      questions: result.questions,
      events: result.events,
      notes: result.notes ?? [],
    };
    return deepFreeze({ content_plan_id: deriveId('cpl', base), ...base });
  }

  async function prepare(rawRequest) {
    const request = normalizeRequest(rawRequest);
    const observations = await understandInputs({ sources: request.sources, bytes: sourceBytesOf(rawRequest), ports: understanding, locale: request.locale });
    record(ledger, DECISION.INPUT_UNDERSTANDING, COMPONENT.INPUT_UNDERSTANDING, 'ONE_NORMALIZED_OBSERVATION_PER_INPUT', { observations: observations.map((o) => [o.source_kind, o.analysis.status]) });
    const inventory = buildInventory({ request, observations });
    record(ledger, DECISION.CONTENT_ANALYSIS, COMPONENT.CONTENT_ANALYST, 'DETERMINISTIC_INVENTORY_BEFORE_ANY_FORMAT_DECISION', { inventory_id: inventory.inventory_id, units: inventory.totals.units, chars: inventory.totals.chars, words: inventory.totals.words });
    // the roles of the texts, and the adaptations and generations the copy policy allows, are decided ONCE: every plan made from this preparation works on its own copy of them
    const events = [];
    const blocked = { ...request };
    const fitted = (inventory.units.length === 0 && inventory.facts.length === 0) ? { units: [], questions: [] } : await fitRoles({ units: workingUnits(inventory), request: blocked, inventory, events });
    return { request, observations, inventory, fitted: { units: fitted.units, questions: fitted.questions, events } };
  }

  async function planPrepared(prepared, options = {}) {
    const { request, inventory, observations } = prepared;
    const result = await planInternal({ request, inventory, observations, force: { fitted: prepared.fitted, ...options } });
    assertLockedTextUnaltered(inventory.units, result.assets, result.caption);
    const plan = seal({ request, inventory, observations, result });
    if (!options.quiet) recordPlan(plan);
    return plan;
  }

  /** The ledger rows of a content plan (a plan made `quiet` for exploration is recorded only if it is the one that is kept). */
  function recordPlan(plan) {
    record(ledger, DECISION.FORMAT_PLAN, COMPONENT.FORMAT_PLANNER, plan.format?.rule ?? 'NO_FORMAT_WITHOUT_A_DECISION', {
      content_plan_id: plan.content_plan_id, status: plan.status, kind: plan.format?.kind ?? null, basis: plan.format?.basis ?? null, assets: plan.assets.length, caption: Boolean(plan.caption), executable: plan.executable, questions: plan.questions.map((q) => q.code),
    });
    for (const q of plan.questions) record(ledger, DECISION.CLARIFICATION, COMPONENT.FORMAT_PLANNER, 'ASK_ONLY_WHEN_MEANING_OR_A_HARD_CONSTRAINT_REQUIRES_IT', { code: q.code, blocking: q.blocking });
  }

  return Object.freeze({
    /**
     * @param {object} rawRequest a content request (see request.js)
     * @returns {Promise<object>} the ContentPlan
     */
    async plan(rawRequest) { return planPrepared(await prepare(rawRequest)); },
    /** The part of planning that may call a model (roles, adaptation, generation), done once. */
    prepare,
    /**
     * A plan from a preparation: a pure decision, repeatable for another channel, density class or format without asking a model again.
     * @param {object} options { slideDensity, channels, profileName, profile, requested }
     */
    planPrepared,
    recordPlan,
  });
}
