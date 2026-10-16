// D -> E: builds `social-post-proposal.v1` (the contract owned by chantier E, docs/architecture/social-publishing-e-v1.md §3 on feature/social-publishing-e)
// and a delivery package E can mount as-is. D owns the creation (asset reference + immutable version + sha256, caption, hashtags, AI flag);
// E owns the calendar, the approval and the publication. Nothing here approves, schedules or publishes, and `suggested_date` is only a suggestion.
//
// The validation below mirrors E's own rules (post.js: normalizeContent / lintClaims) so a proposal that E would reject is refused here, with the same reason.
// `test/social-compat.test.js` runs E's real code against D's output whenever E's checkout is available (SOCIAL_E_DIR), so any drift is detected.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './entry.js';
import { lintPriceChannel, lintProcessClaims } from './claims.js';

export const PROPOSAL_SCHEMA = 'social-post-proposal.v1';
const PLATFORM_FORMATS = { instagram: ['IMAGE', 'REEL', 'CAROUSEL', 'STORY'], facebook: ['IMAGE', 'TEXT', 'CAROUSEL'] };
const LIMITS = { CAPTION_MAX: 2200, HASHTAGS_MAX: 30, HASHTAG_MAX_LEN: 60, NOTE_MAX: 1000 };
const CLAIM_RULES = [
  ['PRICE', /(\d+[.,]?\d*\s?(€|eur\b|euros?)|€\s?\d)/gi],
  ['DISCOUNT', /(\d+\s?%|\b(promo|promotion|soldes?|réduction|remise|rabais|offert(e|s)?|gratuit(e|s)?|cadeau offert|black friday|bon plan)\b)/gi],
  ['DELIVERY_DELAY', /(livraison\s+(en|sous|rapide|express|gratuite|offerte|garantie)|expédi\w+\s+(en|sous|le jour)|\b(24|48)\s?h\b|\d+\s?(jours?|heures?|semaines?)\s+(ouvrables?|max)?)/gi],
  ['GUARANTEE', /(garanti(e|s)?\b|satisfait ou rembours|meilleur prix|moins cher|prix imbattable|stock limité|dernières? (pièces|chances)|plus que \d+)/gi],
  ['URGENCY', /(\baujourd'hui seulement\b|\bjusqu'à (ce soir|demain|dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi)\b|\bdernier jour\b|\bvite\b.*\b(avant|plus)\b)/gi],
];
const squash = (t) => t.toLowerCase().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

export class ProposalError extends Error {
  constructor(message, detail = {}) { super(message); this.name = 'ProposalError'; this.code = 'PROPOSAL_INVALID'; this.detail = detail; }
}
const fail = (message, detail) => { throw new ProposalError(message, detail); };

/** Findings of E's claim lint for a text. `confirmed` is E's owner registry: [{ excerpts: [...], requires: 'coque' }]. */
export function lintClaimsLikeE(textValue, { confirmed = [] } = {}) {
  const findings = [];
  for (const [code, re] of CLAIM_RULES) {
    for (const m of textValue.matchAll(new RegExp(re.source, re.flags))) {
      const ok = confirmed.some((f) => f.excerpts.some((x) => squash(x) === squash(m[0])) && (!f.requires || squash(textValue).includes(squash(f.requires))));
      if (!ok) findings.push({ code, excerpt: m[0].slice(0, 40) });
    }
  }
  return findings;
}

function checkAsset(a, field, { wantsJpeg }) {
  if (!a || typeof a !== 'object') fail(`${field} is required`, { field });
  if (typeof a.ref !== 'string' || !/^asset:\/\/[A-Za-z0-9._:/-]+$/.test(a.ref)) fail(`${field}.ref must be an opaque asset:// reference`, { field });
  if (!Number.isInteger(a.version) || a.version < 1) fail(`${field}.version must be an integer >= 1`, { field });
  if (!/^[a-f0-9]{64}$/.test(a.sha256 ?? '')) fail(`${field}.sha256 must be the 64-hex fingerprint of the exact file`, { field });
  if (!/^image\//.test(a.content_type ?? '')) fail(`${field}.content_type must be an image type`, { field });
  if (wantsJpeg && a.content_type !== 'image/jpeg') fail(`${field}: Instagram's publishing API takes JPEG only`, { field });
  if (typeof a.ai_generated !== 'boolean') fail(`${field}.ai_generated must be stated: false for a composed or photographed asset, true when any part (a plate) came from an image model`, { field });
  if (typeof a.alt_text !== 'string' || !a.alt_text.trim()) fail(`${field}.alt_text is required (accessibility)`, { field });
  for (const k of ['width', 'height']) if (!Number.isInteger(a[k]) || a[k] < 1) fail(`${field}.${k} must be a positive integer`, { field });
  return a;
}

/**
 * @param {object} p
 * @param {string} p.proposal_id stable per creative decision (a new decision = a new id)
 * @param {{kind:'product'|'campaign'|'brand'|'store', ref:string, label:string}} p.subject
 * @param {object} [p.asset] IMAGE / STORY
 * @param {object[]} [p.assets] CAROUSEL, 2..10
 * @param {string} p.caption
 * @param {string[]} [p.hashtags]
 * @param {{platform:string, format:string}[]} p.targets
 * @param {string} [p.suggested_date] ISO with zone
 * @param {string} [p.notes]
 * @param {object[]} [confirmed] E's confirmed-facts registry
 */
export function buildSocialProposal(p, { confirmed = [] } = {}) {
  if (typeof p.proposal_id !== 'string' || p.proposal_id.length < 4 || p.proposal_id.length > 200) fail('proposal_id is required (4..200 chars)', { field: 'proposal_id' });
  if (!['product', 'campaign', 'brand', 'store'].includes(p.subject?.kind) || !p.subject.ref) fail('subject {kind, ref, label} is required', { field: 'subject' });
  if (!Array.isArray(p.targets) || !p.targets.length) fail('targets: at least one { platform, format }', { field: 'targets' });
  const seen = new Set();
  for (const t of p.targets) {
    if (!PLATFORM_FORMATS[t.platform]?.includes(t.format)) fail(`${t.platform} does not support ${t.format} in V1`, { field: 'targets' });
    if (seen.has(`${t.platform}|${t.format}`)) fail('duplicate target', { field: 'targets' });
    seen.add(`${t.platform}|${t.format}`);
    const carousel = t.format === 'CAROUSEL';
    const jpeg = t.platform === 'instagram' && t.format === 'IMAGE';
    if (carousel) {
      if (!Array.isArray(p.assets) || p.assets.length < 2 || p.assets.length > 10) fail('a carousel needs 2 to 10 assets', { field: 'assets' });
      p.assets.forEach((a, i) => checkAsset(a, `assets[${i}]`, { wantsJpeg: false }));
    } else if (t.format !== 'TEXT') checkAsset(p.asset, 'asset', { wantsJpeg: jpeg });
  }
  const caption = (p.caption ?? '').replace(/\r\n/g, '\n').trim();
  if (caption.length > LIMITS.CAPTION_MAX) fail('caption is too long', { field: 'caption' });
  if (!caption && p.targets.some((t) => t.format !== 'STORY')) fail('caption is required except for a story', { field: 'caption' });
  const hashtags = [];
  for (const raw of p.hashtags ?? []) {
    const tag = String(raw).trim().replace(/^#+/, '');
    if (!/^[\p{L}\p{N}_]+$/u.test(tag) || tag.length > LIMITS.HASHTAG_MAX_LEN) fail(`hashtag "${tag.slice(0, 20)}" is not valid`, { field: 'hashtags' });
    if (!hashtags.some((t) => t.toLowerCase() === tag.toLowerCase())) hashtags.push(tag);
  }
  if (hashtags.length > LIMITS.HASHTAGS_MAX) fail('too many hashtags', { field: 'hashtags' });
  const body = `${caption}\n${hashtags.map((h) => `#${h}`).join(' ')}`;
  const claims = lintClaimsLikeE(body, { confirmed });
  if (claims.length) fail('the text carries a claim nobody confirmed (E would block it)', { claims });
  const processClaims = lintProcessClaims(body);
  if (processClaims.length) fail('the text promises a checking process that is not confirmed', { claims: processClaims });
  const channelClaims = lintPriceChannel(body, { confirmed });
  if (channelClaims.length) fail('a price must say whether it is the shop price or the web price', { claims: channelClaims });
  const alternatives = [...new Set(p.alternative_to ?? [])];
  if (alternatives.length > 5 || alternatives.some((a) => typeof a !== 'string' || a.length < 4 || a.length > 200 || a === p.proposal_id)) fail('alternative_to must list at most 5 other proposal ids', { field: 'alternative_to' });
  const notes = (p.notes ?? '').slice(0, LIMITS.NOTE_MAX);
  const out = {
    schema: PROPOSAL_SCHEMA, proposal_id: p.proposal_id, producer: 'chantier-d', subject: { kind: p.subject.kind, ref: p.subject.ref, label: p.subject.label ?? '' },
    caption, hashtags, notes, targets: p.targets.map((t) => ({ platform: t.platform, format: t.format })),
  };
  if (alternatives.length) out.alternative_to = alternatives.sort();
  if (p.asset) out.asset = p.asset;
  if (p.assets) out.assets = p.assets;
  if (p.suggested_date) { if (Number.isNaN(Date.parse(p.suggested_date)) || !/Z$|[+-]\d\d:?\d\d$/.test(p.suggested_date)) fail('suggested_date must be an ISO instant with a zone', { field: 'suggested_date' }); out.suggested_date = p.suggested_date; }
  return out;
}

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png' };

/**
 * Writes the package E mounts: `proposals.json`, and `assets/` in E's own asset-library layout (index.json + files/<sha256><ext>).
 * @param {string} dir
 * @param {{ proposals: object[], files: {ref:string, version:number, content_type:string, bytes:Uint8Array}[] }} pkg
 */
export function writeDeliveryPackage(dir, { proposals, files }) {
  mkdirSync(join(dir, 'assets', 'files'), { recursive: true });
  const index = { assets: [] };
  for (const f of files) {
    const sha = sha256Hex(f.bytes);
    const name = `${sha}${EXT[f.content_type] ?? ''}`;
    writeFileSync(join(dir, 'assets', 'files', name), f.bytes);
    index.assets.push({ ref: f.ref, version: f.version, sha256: sha, content_type: f.content_type, file: name, bytes: f.bytes.length });
  }
  for (const p of proposals) {
    for (const a of [p.asset, ...(p.assets ?? [])].filter(Boolean)) {
      const entry = index.assets.find((x) => x.ref === a.ref && x.version === a.version);
      if (!entry || entry.sha256 !== a.sha256) fail('a proposal names an asset that is not delivered with the exact same fingerprint', { ref: a.ref });
    }
  }
  writeFileSync(join(dir, 'assets', 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(join(dir, 'proposals.json'), `${JSON.stringify(proposals, null, 2)}\n`);
  return { proposals: proposals.length, assets: index.assets.length };
}
