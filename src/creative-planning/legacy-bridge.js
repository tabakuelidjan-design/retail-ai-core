import { BRAIN_ERROR, fail } from '../creative-brain/validation.js';
import {
  CONSTRAINT, COPY_MODE, EXECUTION, FORMAT_KIND,
} from './constants.js';
import { CARRIER } from './request.js';

// THE LEGACY BRIDGE: a single-image brief (the shape the Creative Brain and the runtime already consume) is read as a content request with the three constraints that describe it (one asset, every
// approved text on the asset, a format that is given), and a planned asset is turned back into the same brief shape. For a brief that was valid before, the round trip returns an identical brief, so
// the single-image workflow, its ids and its ledger are unchanged.

/** @returns {object} a content request equivalent to a single-image brief. */
export function requestFromBrief(brief, { requestRef = null } = {}) {
  const copy = [
    ...brief.approved_copy.map((c) => ({ copy_ref: c.ref, mode: COPY_MODE.COPY_LOCKED, role: c.role, carrier: CARRIER.APPROVED_COPY, text: c.content })),
    ...brief.claims.map((c) => ({ copy_ref: c.ref, mode: COPY_MODE.COPY_LOCKED, role: c.role, carrier: CARRIER.CLAIM, text: c.wording })),
  ];
  const f = brief.format ?? {};
  return {
    request_ref: requestRef ?? brief.ids?.brief_ref ?? 'request:legacy-brief',
    locale: f.locale ?? 'en',
    objective: brief.public_facts?.objective ?? null,
    audience: brief.public_facts?.audience ?? null,
    requested_format: FORMAT_KIND.SINGLE_IMAGE,
    constraints: [{ kind: CONSTRAINT.SINGLE_ASSET_ONLY }, { kind: CONSTRAINT.ALL_TEXT_ON_ASSET }, { kind: CONSTRAINT.FORMAT_IS_FIXED }],
    copy,
    canvas: f.canvas ? {
      format_ref: f.ref, canvas: { width: f.canvas.width, height: f.canvas.height, unit: f.canvas.unit ?? 'px' }, medium: f.medium ?? 'DIGITAL', aspect_ratio: f.aspect_ratio, safe_zones: f.safe_zones ?? [], forbidden_zones: f.forbidden_zones ?? [],
    } : null,
  };
}

/**
 * The brief of ONE planned asset: the original brief, with exactly the texts placed on that asset (a text placed whole keeps its original item, so nothing about it changes) and the asset's canvas.
 * Refuses an asset that is planned but not executable, and a plan that needs a user decision.
 */
export function briefForAsset({ brief, plan, assetIndex = 0 }) {
  const asset = plan.assets[assetIndex];
  if (!asset) fail(BRAIN_ERROR.RULE_VIOLATION, 'the plan has no such asset', 'asset_index');
  if (asset.execution.status !== EXECUTION.EXECUTABLE_NOW) fail(BRAIN_ERROR.RULE_VIOLATION, 'the asset is planned but cannot be produced yet', 'asset', { problem: 'ASSET_NOT_EXECUTABLE', reasons: asset.execution.reasons });
  const originals = new Map([...brief.approved_copy.map((c) => [c.ref, { carrier: CARRIER.APPROVED_COPY, item: c, text: c.content }]), ...brief.claims.map((c) => [c.ref, { carrier: CARRIER.CLAIM, item: c, text: c.wording }])]);
  const keep = new Set(); const added = { approved_copy: [], claims: [] };
  for (const slot of asset.slots) {
    for (const piece of slot.pieces) {
      const original = originals.get(piece.unit_ref);
      const whole = original && piece.origin === 'LOCKED' && piece.text === original.text && slot.role === original.item.role;
      if (whole) { keep.add(piece.unit_ref); continue; }
      const carrier = original?.carrier ?? CARRIER.APPROVED_COPY;
      const ref = `${piece.unit_ref}#${piece.piece_id}`;
      if (carrier === CARRIER.CLAIM) added.claims.push({ ref, role: slot.role, wording: piece.text });
      else added.approved_copy.push({ ref, role: slot.role, content: piece.text });
    }
  }
  const useCaller = asset.canvas_source === 'CALLER_RESOURCE';
  const format = useCaller ? brief.format : {
    ...brief.format, ref: asset.format_resource_ref, canvas: { ...asset.canvas }, medium: asset.medium, aspect_ratio: asset.aspect_ratio, safe_zones: [], forbidden_zones: [],
  };
  return {
    ...brief,
    format,
    approved_copy: [...brief.approved_copy.filter((c) => keep.has(c.ref)), ...added.approved_copy],
    claims: [...brief.claims.filter((c) => keep.has(c.ref)), ...added.claims],
  };
}
