// Local indexer: walks folders and proposes library entries. It only OBSERVES (hash, size, type) and PROPOSES an origin class
// from file names and folders. Rights stay UNVERIFIED and approval stays NOT_REVIEWED: no script can decide either.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { ASSET_KIND, ASSET_STAGE, ORIGIN_CLASS } from './constants.js';
import { assetIdFor, normalizeEntry, sha256Hex } from './entry.js';
import { readImageInfo } from './image-info.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);

/**
 * Ordered, first match wins. Every rule is a hint about the FILE NAME / FOLDER, recorded in `notes`; a person reviews the result.
 * Marketplace / social names are strong signals (they are literally what those sites name their downloads).
 */
export const CLASSIFICATION_RULES = Object.freeze([
  { id: 'ai-nanobanana', test: /nanobanana|nano-banana|gemini[_ -]generated/i, origin: ORIGIN_CLASS.AI_GENERATED },
  { id: 'ai-chatgpt', test: /chatgpt image/i, origin: ORIGIN_CLASS.AI_GENERATED },
  { id: 'brand-icon', test: /(^|[\\/])HABB-icone[\\/]|habb-(icone|wordmark)/i, origin: ORIGIN_CLASS.BRAND_ELEMENT, stage: ASSET_STAGE.BRAND },
  { id: 'habb-mockup-pack', test: /Pack Mockups HABB/i, origin: ORIGIN_CLASS.HABB_DESIGN },
  { id: 'habb-brand-tile', test: /[\\/]brand-tiles[\\/]|HABB[_ -](coque|Hero|affiche)|carte-visite/i, origin: ORIGIN_CLASS.HABB_DESIGN },
  { id: 'habb-catalogue-ecritures', test: /^(Habb[\/])?[1-9]\.png$/, origin: ORIGIN_CLASS.HABB_DESIGN },
  { id: 'habb-logo-file', test: /^Habb\.jpg$/, origin: ORIGIN_CLASS.BRAND_ELEMENT, stage: ASSET_STAGE.BRAND },
  { id: 'habb-font-catalogue', test: /(^|[\/])(catalogue polices|vignettes-[a-z0-9x]+|coques)[\/]/i, origin: ORIGIN_CLASS.HABB_DESIGN },
  { id: 'supplier-folder', test: /(^|[\/])(images gift boxes|habb images[\/]habb_images_4k)[\/]/i, origin: ORIGIN_CLASS.SUPPLIER_IMAGE },
  { id: 'supplier-brand-name', test: /tyeso|remax|dofon|artronyx|^cb ?23|^cm-6048|^d0f5f930|_thumbnail_|^\d_[0-9a-f-]{36}|certificate|^Image_2025\d+|power bank|cable|chargeur|casque|tw flair|^2079034|^318\.jpg|^0ce683f5/i, origin: ORIGIN_CLASS.SUPPLIER_IMAGE },
  { id: 'social-instagram', test: /^\d{6,}_\d{6,}_\d{6,}_n\./, origin: ORIGIN_CLASS.SCREENSHOT_OR_SOCIAL },
  { id: 'social-tiktok', test: /tplv-/i, origin: ORIGIN_CLASS.SCREENSHOT_OR_SOCIAL },
  { id: 'supplier-shopee', test: /^(sg|tw)-\d{8}/i, origin: ORIGIN_CLASS.SUPPLIER_IMAGE },
  { id: 'supplier-amazon', test: /_AC_|_SL\d{3,4}_|\._AC/i, origin: ORIGIN_CLASS.SUPPLIER_IMAGE },
  { id: 'supplier-alibaba', test: /^H[0-9a-f]{20,}|_960x960|_thumbnail_\d+x|resize_w\d+/i, origin: ORIGIN_CLASS.SUPPLIER_IMAGE },
  { id: 'supplier-hex-id', test: /^[0-9a-f]{24}\.(jpg|png|webp)$/i, origin: ORIGIN_CLASS.SUPPLIER_IMAGE },
]);

export function classify(relPath) {
  const name = basename(relPath);
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.test.test(name) || rule.test.test(relPath)) return { origin_class: rule.origin, stage: rule.stage ?? ASSET_STAGE.ORIGINAL, rule: rule.id };
  }
  return { origin_class: ORIGIN_CLASS.UNCLASSIFIED, stage: ASSET_STAGE.ORIGINAL, rule: 'none' };
}

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walk(full);
    else yield { full, size: st.size };
  }
}

/**
 * @param {string} root folder to index
 * @param {{ namespace: string, maxFiles?: number, maxBytes?: number }} options namespace names the opaque references
 * @returns {{ entries: object[], skipped: {name: string, reason: string}[], duplicates: {name: string, same_as: string}[] }}
 */
export function indexFolder(root, { namespace, maxFiles = 5000, maxBytes = 60 * 1024 * 1024 } = {}) {
  if (!/^[a-z0-9-]{2,40}$/.test(namespace ?? '')) throw new TypeError('namespace must be a short slug');
  const entries = [];
  const skipped = [];
  const duplicates = [];
  const seen = new Map();
  let count = 0;
  for (const { full, size } of walk(root)) {
    const rel = relative(root, full).replaceAll('\\', '/');
    const ext = extname(full).toLowerCase();
    const isImage = IMAGE_EXT.has(ext);
    const isVideo = VIDEO_EXT.has(ext);
    if (!isImage && !isVideo) { skipped.push({ name: rel, reason: 'NOT_A_MEDIA_FILE' }); continue; }
    if (++count > maxFiles) { skipped.push({ name: rel, reason: 'MAX_FILES' }); continue; }
    if (size > maxBytes) { skipped.push({ name: rel, reason: 'TOO_LARGE' }); continue; }
    const bytes = readFileSync(full);
    const hash = sha256Hex(bytes);
    if (seen.has(hash)) { duplicates.push({ name: rel, same_as: seen.get(hash) }); continue; }
    seen.set(hash, rel);
    const info = isImage ? readImageInfo(new Uint8Array(bytes)) : null;
    if (isImage && !info) { skipped.push({ name: rel, reason: 'UNREADABLE_IMAGE' }); continue; }
    const hint = classify(rel);
    entries.push(normalizeEntry({
      asset_id: assetIdFor(hash),
      source_ref: `private-asset://${namespace}/${hash.slice(0, 16)}`,
      kind: isImage ? ASSET_KIND.IMAGE : ASSET_KIND.VIDEO,
      stage: hint.stage,
      media_type: info?.media_type ?? (ext === '.mov' ? 'video/quicktime' : 'video/mp4'),
      width_px: info?.width_px ?? null,
      height_px: info?.height_px ?? null,
      has_alpha: info?.has_alpha === true,
      content_hash: hash,
      bytes: size,
      original_name: basename(rel),
      origin_class: hint.origin_class,
      notes: [`folder:${rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')).slice(0, 100) : '.'}`, `rule:${hint.rule}`],
    }));
  }
  return { entries, skipped, duplicates };
}
