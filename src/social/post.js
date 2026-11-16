// The post record: what the owner approves, how its exact version is fingerprinted, and the claim lint.
//
// content_hash covers EVERYTHING that would change what is published, where, or when (asset id + version + sha256, caption, hashtags,
// platform, format, account, subject, publish_at). An approval is bound to that hash: change any of it and the approval no longer matches.

import { createHash, randomUUID } from 'node:crypto';
import {
  FORMAT, LIMITS, MANUAL_ONLY_FORMATS, PLATFORM, PLATFORM_FORMATS, POST_STATE, SOCIAL_ERROR as E, fail,
} from './constants.js';

const HEX64 = /^[a-f0-9]{64}$/;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const text = (v, field, { max, required = false } = {}) => {
  if (v == null || v === '') { if (required) fail(E.INVALID, `${field} is required`, { field }); return ''; }
  if (typeof v !== 'string') fail(E.INVALID, `${field} must be a string`, { field });
  const t = v.replace(/\r\n/g, '\n').trim();
  if (max && t.length > max) fail(E.INVALID, `${field} is too long (${t.length} > ${max})`, { field });
  return t;
};

export function normalizeHashtags(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) fail(E.INVALID, 'hashtags must be a list', { field: 'hashtags' });
  const out = [];
  for (const raw of list) {
    const tag = String(raw).trim().replace(/^#+/, '');
    if (!tag) continue;
    if (!/^[\p{L}\p{N}_]+$/u.test(tag) || tag.length > LIMITS.HASHTAG_MAX_LEN) fail(E.INVALID, `hashtag "${tag.slice(0, 20)}" is not valid`, { field: 'hashtags' });
    if (!out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  if (out.length > LIMITS.HASHTAGS_MAX) fail(E.INVALID, `at most ${LIMITS.HASHTAGS_MAX} hashtags`, { field: 'hashtags' });
  return out;
}

const normalizeOneAsset = (asset, wantsVideo, field = 'asset') => {
  if (!isObj(asset)) fail(E.INVALID, `${field} must be an object`, { field });
  const ref = text(asset.ref, `${field}.ref`, { max: 300, required: true });
  const version = asset.version;
  if (!Number.isInteger(version) || version < 1) fail(E.INVALID, `${field}.version must be an integer >= 1`, { field: `${field}.version` });
  const sha = String(asset.sha256 ?? '').toLowerCase();
  if (!HEX64.test(sha)) fail(E.INVALID, `${field}.sha256 must be the 64-hex fingerprint of the exact file`, { field: `${field}.sha256` });
  const contentType = text(asset.content_type, `${field}.content_type`, { max: 80, required: true }).toLowerCase();
  const typeOk = wantsVideo === true ? contentType.startsWith('video/') : wantsVideo === false ? contentType.startsWith('image/') : /^(image|video)\//.test(contentType);
  if (!typeOk) fail(E.INVALID, `${field}.content_type ${contentType} does not match the format`, { field: `${field}.content_type` });
  const dim = (n, f) => (n == null ? null : Number.isInteger(n) && n > 0 ? n : fail(E.INVALID, `${f} must be a positive integer`, { field: f }));
  return {
    ref, version, sha256: sha, content_type: contentType, width: dim(asset.width, `${field}.width`), height: dim(asset.height, `${field}.height`),
    ai_generated: asset.ai_generated === true, // transparency flag from chantier D (Meta offers a self-disclosure parameter)
    ...(typeof asset.alt_text === 'string' && asset.alt_text.trim() ? { alt_text: asset.alt_text.trim().slice(0, 1000) } : {}),
  };
};

/**
 * The final asset(s) the owner will see and that will be sent: a durable reference + an immutable version + a fingerprint each.
 * A post MAY have no asset yet (brief delivered, picture missing): it is kept, shown as "visuel manquant", and cannot be submitted.
 * Returns { asset, assets }: `asset` for IMAGE / REEL / STORY, `assets` (2 to 10) for CAROUSEL, neither for TEXT.
 */
export function normalizeAssets(input, format) {
  if (format === FORMAT.TEXT) {
    if (input.asset != null || input.assets != null) fail(E.INVALID, 'a TEXT post carries no asset', { field: 'asset' });
    return { asset: null, assets: null };
  }
  if (format === FORMAT.CAROUSEL) {
    if (input.asset != null) fail(E.INVALID, 'a carousel carries `assets` (2 to 10), not `asset`', { field: 'asset' });
    if (input.assets == null) return { asset: null, assets: null };
    if (!Array.isArray(input.assets) || input.assets.length < 2 || input.assets.length > 10) fail(E.INVALID, 'a carousel needs 2 to 10 assets', { field: 'assets' });
    return { asset: null, assets: input.assets.map((a, i) => normalizeOneAsset(a, null, `assets[${i}]`)) };
  }
  if (input.assets != null) fail(E.INVALID, 'only a carousel carries `assets`', { field: 'assets' });
  if (input.asset == null) return { asset: null, assets: null };
  return { asset: normalizeOneAsset(input.asset, format === FORMAT.REEL ? true : format === FORMAT.STORY ? null : false), assets: null };
}

export function normalizeSubject(subject) {
  if (!isObj(subject)) fail(E.INVALID, 'subject ({kind, ref, label}) is required: which product or campaign is this about', { field: 'subject' });
  if (!['product', 'campaign', 'brand', 'store'].includes(subject.kind)) fail(E.INVALID, 'subject.kind must be product | campaign | brand | store', { field: 'subject.kind' });
  return { kind: subject.kind, ref: text(subject.ref, 'subject.ref', { max: 200, required: true }), label: text(subject.label, 'subject.label', { max: 200 }) };
}

/** The part of a post that the owner approves. publish_at is part of it: approving "this visual, this text, THIS moment". */
export function contentOf(post) {
  return {
    platform: post.platform, format: post.format, account_ref: post.account_ref ?? null, subject: post.subject, asset: post.asset ?? null, assets: post.assets ?? null,
    caption: post.caption, hashtags: post.hashtags, publish_at: post.publish_at ?? null,
  };
}
export const contentHashOf = (post) => sha256(canonical(contentOf(post)));

export function normalizePublishAt(value) {
  if (value == null || value === '') return null;
  const t = Date.parse(value);
  if (Number.isNaN(t) || !/Z$|[+-]\d\d:?\d\d$/.test(String(value))) fail(E.INVALID, 'publish_at must be an ISO instant with a zone (stored as UTC)', { field: 'publish_at' });
  return new Date(t).toISOString();
}

/** Builds a validated post body (no id, no state). Throws SocialError(SOCIAL_INVALID). */
export function normalizeContent(input) {
  const platform = input.platform;
  if (!Object.values(PLATFORM).includes(platform)) fail(E.INVALID, `platform must be ${Object.values(PLATFORM).join(' | ')}`, { field: 'platform' });
  const format = input.format;
  if (!PLATFORM_FORMATS[platform].includes(format)) fail(E.INVALID, `${platform} does not support format ${format} in V1`, { field: 'format' });
  const caption = text(input.caption, 'caption', { max: LIMITS.CAPTION_MAX, required: format === FORMAT.TEXT });
  return {
    platform, format, account_ref: input.account_ref == null ? null : text(input.account_ref, 'account_ref', { max: 200 }),
    subject: normalizeSubject(input.subject), ...normalizeAssets(input, format), caption, hashtags: normalizeHashtags(input.hashtags),
    publish_at: normalizePublishAt(input.publish_at),
  };
}

// --- claim lint: no price, discount, delay or promise that nobody confirmed ---------------------------------------------------------
const CLAIM_RULES = [
  ['PRICE', /(\d+[.,]?\d*\s?(€|eur\b|euros?)|€\s?\d)/gi],
  ['DISCOUNT', /(\d+\s?%|\b(promo|promotion|soldes?|réduction|remise|rabais|offert(e|s)?|gratuit(e|s)?|cadeau offert|black friday|bon plan)\b)/gi],
  ['DELIVERY_DELAY', /(livraison\s+(en|sous|rapide|express|gratuite|offerte|garantie)|expédi\w+\s+(en|sous|le jour)|\b(24|48)\s?h\b|\d+\s?(jours?|heures?|semaines?)\s+(ouvrables?|max)?)/gi],
  ['GUARANTEE', /(garanti(e|s)?\b|satisfait ou rembours|meilleur prix|moins cher|prix imbattable|stock limité|dernières? (pièces|chances)|plus que \d+)/gi],
  ['URGENCY', /(\baujourd'hui seulement\b|\bjusqu'à (ce soir|demain|dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi)\b|\bdernier jour\b|\bvite\b.*\b(avant|plus)\b)/gi],
];
const squash = (t) => t.toLowerCase().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Returns blocking findings (one per unconfirmed excerpt). `confirmed` is the owner's registry of facts he has explicitly confirmed:
 * [{ id, excerpts: ['25 €', '25,00 €'], requires: 'coque', source, confirmed_at }] - an excerpt is let through only when the registry
 * names it AND the caption contains the required word. The lint never rewrites anything.
 */
export function lintClaims(post, { confirmed = [] } = {}) {
  const body = `${post.caption}\n${(post.hashtags ?? []).map((h) => `#${h}`).join(' ')}`;
  const findings = [];
  for (const [code, re] of CLAIM_RULES) {
    for (const m of body.matchAll(new RegExp(re.source, re.flags))) {
      const excerpt = m[0];
      const ok = confirmed.some((f) => f.excerpts.some((x) => squash(x) === squash(excerpt)) && (!f.requires || squash(body).includes(squash(f.requires))));
      if (!ok) findings.push({ code, excerpt: excerpt.slice(0, 40) });
    }
  }
  return findings;
}

/** Everything that must be true before a post may be shown as "ready" / approved. Pure; no network. */
export function readinessProblems(post, { confirmed = [] } = {}) {
  const problems = [];
  if (post.format === FORMAT.CAROUSEL ? !post.assets : post.format !== FORMAT.TEXT && !post.asset) problems.push('ASSET_MISSING');
  if (!post.caption && post.format !== FORMAT.STORY) problems.push('CAPTION_MISSING');
  for (const f of lintClaims(post, { confirmed })) problems.push(`UNCONFIRMED_CLAIM_${f.code}`);
  return problems;
}
/**
 * Why a machine must NOT publish this post (it can still be approved and published by hand). Not a content problem: a technical one.
 * Instagram's API only takes JPEG images; carousels and stories are not automated in V1.
 */
export function autoPublishBlockers(post) {
  const blockers = [];
  if (MANUAL_ONLY_FORMATS.includes(post.format)) blockers.push(`FORMAT_${post.format}_IS_MANUAL_IN_V1`);
  if (post.platform === PLATFORM.INSTAGRAM && post.format === FORMAT.IMAGE && post.asset && post.asset.content_type !== 'image/jpeg') blockers.push('INSTAGRAM_API_REQUIRES_JPEG');
  return blockers;
}
export const isManualOnly = (post) => autoPublishBlockers(post).length > 0;

export const newPostId = () => `post_${randomUUID()}`;

export function newPost(input, { actor, now, id = newPostId() }) {
  const content = normalizeContent(input);
  const post = {
    id, schema: 'social-post.v1', rev: 1, state: POST_STATE.DRAFT, ...content,
    origin: isObj(input.origin) ? { producer: String(input.origin.producer ?? '').slice(0, 80), proposal_id: String(input.origin.proposal_id ?? '').slice(0, 200) } : null,
    notes: text(input.notes, 'notes', { max: 1000 }), created_at: now, updated_at: now, created_by: actor.id,
    approval: null, // { approved_by, approved_at, content_hash }
    publication: null, // { mode, submission_id, post_id, permalink, published_at, attempts, ... }
    verification: null,
    history: [],
  };
  return post;
}

/** The exact text sent to the platform: the caption, then the hashtags. What the owner reads is what is published. */
export const composeCaption = (post) => (post.hashtags?.length ? `${post.caption}${post.caption ? '\n\n' : ''}${post.hashtags.map((h) => `#${h}`).join(' ')}` : post.caption);
