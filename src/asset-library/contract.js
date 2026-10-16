// Transmission contract between Chantier D (branding / marketing / creative) and Chantier E / the central system.
// D PRODUCES these records; the receiver validates them with the same functions. D never publishes, spends or writes to a production system:
// `published` is always false and `execution` is always PROPOSAL_ONLY. See docs/chantier-d/CONTRAT-CHANTIER-E.md.

import { APPROVAL_STATUS, ASSET_STAGE, AssetLibraryError, CHANNEL_FORMATS, CHANNELS, LIBRARY_ERROR as E, ORIGIN_CLASS } from './constants.js';
import { publishability } from './entry.js';

export const ASSET_HANDOFF = 'nordla.chantier-d.asset-handoff';
export const CAMPAIGN_HANDOFF = 'nordla.chantier-d.campaign-handoff';
export const CONTRACT_VERSION = 1;

export const PRODUCED_BY = Object.freeze({
  NORDLA_ENGINE: 'NORDLA_ENGINE', // output of the Creative chain (engine_run_id required)
  HUMAN_DESIGNER: 'HUMAN_DESIGNER', // made by a person (owner / designer)
  ASSISTANT_PROPOSAL: 'ASSISTANT_PROPOSAL', // authored by an assistant session: a proposal, never evidence of Nordla's capability
});
export const VALIDATION_STATUS = Object.freeze({ PROPOSED: 'PROPOSED', IN_REVIEW: 'IN_REVIEW', APPROVED: 'APPROVED', REJECTED: 'REJECTED' });
export const ITEM_KIND = Object.freeze({ POST: 'POST', STORY: 'STORY', REEL: 'REEL' });

const HEX64 = /^[0-9a-f]{64}$/;
const fail = (message, detail) => { throw new AssetLibraryError(E.INVALID_CONTRACT, message, detail); };
const closed = (o, keys, field) => {
  if (o == null || typeof o !== 'object' || Array.isArray(o)) fail(`${field} must be an object`, { field });
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${field}.${k} is not part of the contract`, { field, key: k });
};
const oneOf = (v, set, field) => { if (!Object.values(set).includes(v)) fail(`${field} is not an allowed value`, { field }); return v; };
const text = (v, field, max) => { if (typeof v !== 'string' || !v.trim() || v.length > max) fail(`${field} must be a non-empty string (max ${max})`, { field }); return v; };

export function validateAssetHandoff(input) {
  closed(input, ['contract', 'version', 'asset_id', 'content_hash', 'source_ref', 'media_type', 'width_px', 'height_px', 'channel', 'stage', 'asset_version', 'origin_class', 'rights_status', 'approval', 'product_refs', 'derived_from', 'produced_by', 'engine_run_id', 'published'], 'asset_handoff');
  if (input.contract !== ASSET_HANDOFF || input.version !== CONTRACT_VERSION) fail('wrong contract or version', { field: 'contract' });
  if (!HEX64.test(input.content_hash)) fail('content_hash must be a sha-256 digest', { field: 'content_hash' });
  if (typeof input.source_ref !== 'string' || !/^(private-asset|asset):\/\/[A-Za-z0-9._:/-]+$/.test(input.source_ref)) fail('source_ref must be opaque', { field: 'source_ref' });
  oneOf(input.channel, Object.fromEntries(CHANNELS.map((c) => [c, c])), 'channel');
  oneOf(input.stage, ASSET_STAGE, 'stage');
  oneOf(input.produced_by, PRODUCED_BY, 'produced_by');
  if (input.published !== false) fail('Chantier D never publishes: published must be false', { field: 'published' });
  const [w, h] = CHANNEL_FORMATS[input.channel];
  if (input.width_px !== w || input.height_px !== h) fail(`format for ${input.channel} is ${w}x${h}`, { field: 'width_px' });
  if (input.produced_by === PRODUCED_BY.NORDLA_ENGINE && !input.engine_run_id) fail('an engine output names its run', { field: 'engine_run_id' });
  closed(input.approval, ['status', 'ref'], 'asset_handoff.approval');
  oneOf(input.approval.status, APPROVAL_STATUS, 'approval.status');
  if (input.approval.status === APPROVAL_STATUS.APPROVED && !input.approval.ref) fail('approved needs a reference', { field: 'approval.ref' });
  if (input.stage === ASSET_STAGE.PUBLISH_READY || input.stage === ASSET_STAGE.APPROVED_CREATION) {
    const p = publishability({ origin_class: input.origin_class, rights_status: input.rights_status, approval_status: input.approval.status });
    if (!p.publishable) fail(`stage ${input.stage} requires a publishable asset`, { reasons: p.reasons });
  }
  return input;
}

export function validateCampaignHandoff(input) {
  closed(input, ['contract', 'version', 'campaign_id', 'window', 'items', 'status', 'execution'], 'campaign_handoff');
  if (input.contract !== CAMPAIGN_HANDOFF || input.version !== CONTRACT_VERSION) fail('wrong contract or version', { field: 'contract' });
  if (input.execution !== 'PROPOSAL_ONLY') fail('execution must be PROPOSAL_ONLY', { field: 'execution' });
  text(input.campaign_id, 'campaign_id', 64);
  closed(input.window, ['start', 'end'], 'window');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.window.start) || !/^\d{4}-\d{2}-\d{2}$/.test(input.window.end) || input.window.end < input.window.start) fail('window must be an ISO date range', { field: 'window' });
  oneOf(input.status, VALIDATION_STATUS, 'status');
  if (!Array.isArray(input.items) || input.items.length === 0) fail('items must be a non-empty list', { field: 'items' });
  const seen = new Set();
  for (const [i, it] of input.items.entries()) {
    const f = `items[${i}]`;
    closed(it, ['item_id', 'kind', 'channel', 'day', 'product_ref', 'objective', 'concept', 'hook', 'caption', 'asset_refs', 'asset_status', 'claims', 'validation_status', 'blockers'], f);
    text(it.item_id, `${f}.item_id`, 64);
    if (seen.has(it.item_id)) fail('duplicate item_id', { field: f });
    seen.add(it.item_id);
    oneOf(it.kind, ITEM_KIND, `${f}.kind`);
    oneOf(it.channel, Object.fromEntries(CHANNELS.map((c) => [c, c])), `${f}.channel`);
    text(it.product_ref, `${f}.product_ref`, 160);
    text(it.objective, `${f}.objective`, 300);
    text(it.concept, `${f}.concept`, 1500);
    text(it.hook, `${f}.hook`, 200);
    if (!Array.isArray(it.asset_refs)) fail(`${f}.asset_refs must be a list`, { field: f });
    oneOf(it.validation_status, VALIDATION_STATUS, `${f}.validation_status`);
    if (!Array.isArray(it.claims)) fail(`${f}.claims must be a list`, { field: f });
    for (const c of it.claims) {
      closed(c, ['text', 'claim_ref'], `${f}.claims[]`);
      text(c.text, `${f}.claims[].text`, 200);
    }
    // an approved item must stand on approved claims and on assets that exist
    if (it.validation_status === VALIDATION_STATUS.APPROVED) {
      if (it.claims.some((c) => !c.claim_ref)) fail('an approved item cannot carry a claim without an approved claim_ref', { field: f });
      if (it.asset_refs.length === 0 || it.asset_status !== 'READY') fail('an approved item needs ready assets', { field: f });
    }
  }
  return input;
}

/** Builds the asset handoff for a library entry (never PUBLISH_READY unless the entry really is publishable). */
export function assetHandoffFor(entry, { channel, produced_by, engine_run_id = null }) {
  const p = publishability(entry);
  const stage = entry.stage === ASSET_STAGE.PUBLISH_READY && !p.publishable ? ASSET_STAGE.CREATION : entry.stage;
  return validateAssetHandoff({
    contract: ASSET_HANDOFF,
    version: CONTRACT_VERSION,
    asset_id: entry.asset_id,
    content_hash: entry.content_hash,
    source_ref: entry.source_ref,
    media_type: entry.media_type,
    width_px: entry.width_px,
    height_px: entry.height_px,
    channel,
    stage,
    asset_version: entry.version,
    origin_class: entry.origin_class,
    rights_status: entry.rights_status,
    approval: { status: entry.approval_status, ref: entry.approval_ref },
    product_refs: entry.product_refs,
    derived_from: entry.derived_from,
    produced_by,
    engine_run_id,
    published: false,
  });
}

export { ORIGIN_CLASS };
