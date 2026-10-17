// Adapter: the editorial reserve delivered by chantier D (reports/editorial-14j/posts.json, version 1) -> social-post-proposal.v1.
//
// D's files are only READ. Pictures are copied into Nordla's own asset library (fingerprinted); nothing is moved, edited or deleted there.
// What this adapter decides, and what it does NOT:
//   - it maps each channel of an item to a (platform, format) target Nordla supports: Instagram feed / carousel / story / reel, Facebook
//     photo / carousel. TikTok, Google Business Profile and Facebook Reels are reported as skipped, never silently dropped;
//   - the caption is register A (vouvoiement) by default; register B is kept in the notes. Choosing the register is the owner's decision;
//   - a story's "legende" is a production note (screens, stickers), not a publishable caption: it goes to the notes;
//   - an item whose picture does not exist yet (BRIEF / NON TOURNÉE) is imported WITHOUT an asset: it shows as "visuel manquant".

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROPOSAL_SCHEMA } from '../constants.js';
import { brusselsToUtc } from '../calendar.js';

const slug = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** @returns {{platform, format}|{skip}} */
export function mapChannel(channel, itemFormat) {
  const c = channel.trim();
  if (/^Instagram \(feed\)/i.test(c)) return { platform: 'instagram', format: 'IMAGE' };
  if (/^Instagram \(carrousel\)/i.test(c)) return { platform: 'instagram', format: 'CAROUSEL' };
  if (/^Instagram Stories?/i.test(c)) return { platform: 'instagram', format: 'STORY' };
  if (/^Instagram Reel/i.test(c)) return { platform: 'instagram', format: 'REEL' };
  if (/^Facebook Reel/i.test(c)) return { skip: 'FACEBOOK_REEL_NOT_SUPPORTED_V1' };
  if (/^Facebook/i.test(c)) return { platform: 'facebook', format: /^Carrousel/i.test(itemFormat) ? 'CAROUSEL' : 'IMAGE' };
  if (/^TikTok/i.test(c)) return { skip: 'TIKTOK_OUT_OF_SCOPE_CHANTIER_E' };
  if (/^Google Business/i.test(c)) return { skip: 'GOOGLE_BUSINESS_OUT_OF_SCOPE_CHANTIER_E' };
  return { skip: 'UNKNOWN_CHANNEL' };
}

function pngSize(bytes) {
  return bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : {};
}

/** Picture file names named in an item's visual status or production note, in order of appearance, that exist in `visualsDir`. */
export function visualFilesOf(item, visualsDir) {
  const text = `${item.etat_visuel ?? ''} ${item.legende ?? ''}`;
  if (/^\s*(BRIEF|NON TOURN)/i.test(item.etat_visuel ?? '')) return [];
  const seen = [];
  for (const m of text.matchAll(/([A-Za-z0-9_-]+\.(?:png|jpe?g))/g)) {
    if (!seen.includes(m[1]) && existsSync(join(visualsDir, m[1]))) seen.push(m[1]);
  }
  return seen;
}

/**
 * @param {object} posts   parsed posts.json
 * @param {{dir:string, library:{register:Function}, register?:'A'|'B', ids?:string[]}} options
 * @returns {Promise<{proposals:object[], skipped:object[]}>}
 */
export async function mapEditorialReserve(posts, { dir, library, register = 'A', ids = null }) {
  const proposals = [];
  const skipped = [];
  for (const item of posts.items) {
    if (ids && !ids.includes(item.id)) continue;
    const targets = [];
    for (const channel of item.canal) {
      const t = mapChannel(channel, item.format);
      if (t.skip) skipped.push({ id: item.id, channel, reason: t.skip });
      else if (!targets.some((x) => x.platform === t.platform && x.format === t.format)) targets.push(t);
    }
    if (!targets.length) continue;

    const files = visualFilesOf(item, join(dir, 'visuels'));
    const registered = [];
    for (const file of files) {
      const full = join(dir, 'visuels', file);
      const bytes = await readFile(full);
      const entry = await library.register({ ref: `asset://habb-editorial-2026-10/${file.replace(/\.[^.]+$/, '')}`, version: 1, file: full, bytes });
      registered.push({ ref: entry.ref, version: entry.version, sha256: entry.sha256, content_type: entry.content_type, ...pngSize(bytes), ...(item.alt_text && files.length === 1 ? { alt_text: item.alt_text } : {}) });
    }

    const isStory = /^S\d+/.test(item.id);
    const captionA = isStory ? '' : (item.legende ?? '');
    const caption = register === 'B' && item.legende_variante_b ? item.legende_variante_b : captionA;
    const notes = [
      isStory ? `Note de production (story) : ${item.legende ?? ''}` : null,
      !isStory && item.legende_variante_b ? `Variante ${register === 'B' ? 'A (vouvoiement)' : 'B (tutoiement)'} : ${register === 'B' ? captionA : item.legende_variante_b}` : null,
      `Statut visuel selon D : ${item.etat_visuel ?? 'inconnu'}`,
    ].filter(Boolean).join('\n').slice(0, 1000);

    const time = item.heure_suggeree ?? '18:00';
    const proposal = {
      schema: PROPOSAL_SCHEMA,
      proposal_id: `habb-editorial-2026-10-16:${item.id}`,
      producer: 'chantier-d',
      subject: { kind: 'campaign', ref: `pilier:${slug(item.pilier ?? 'divers')}`, label: item.pilier ?? 'HABB' },
      caption,
      hashtags: isStory ? [] : (item.hashtags ?? []),
      notes,
      suggested_date: brusselsToUtc(item.date_proposee, time),
      targets,
    };
    if (registered.length) {
      if (targets.some((t) => t.format === 'CAROUSEL')) proposal.assets = registered;
      if (targets.some((t) => t.format !== 'CAROUSEL')) proposal.asset = registered[0];
    }
    proposals.push(proposal);
  }
  return { proposals, skipped };
}
