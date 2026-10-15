// Création in Nordla Core WITHOUT a generation provider: the first real, local capability, built only from the existing engines.
//   the owner's photo (kept pixel-exact, PIXEL_PRESERVE) + one headline in the merchant's configured typography
//   -> design document (src/creative-intelligence) -> real shaping + resvg PNG (deterministic bytes) -> product fidelity MEASURED on the PNG
//   -> Branding on the headline (official Guardian if approved, else labelled preview) -> OWNER decision with reason. Nothing is published.
// No AI, no network, no paid call. The product mask (known non-determinism PM-6) is NOT used on this path: the photo is drawn as supplied.
// The merchant's choices (font family, colours) are configuration: config/merchants/<id>/creation.json.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as CI from '../creative-intelligence/index.js';
import * as P from '../creative-intelligence/production.js';
import { dimensionsOf } from '../creative-e2e/asset.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const CANVAS = Object.freeze({ width: 1080, height: 1350 });
export const CREATION_MAX_PHOTO_BYTES = 6 * 1024 * 1024;
export const CREATION_LAYOUT = 'feed-4x5-photo-headline@1';
const REQUIRED_PASS = ['PRODUCT_IDENTITY', 'PRODUCT_GEOMETRY', 'PIECE_COUNT', 'PRODUCT_COLOR'];
const DECISIONS = ['APPROVED', 'REJECTED'];

export async function loadCreationConfig(env = {}, root = process.cwd()) {
  const id = String(env.SOURCING_MERCHANT_ID ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) return null;
  try { return { ...JSON.parse(await readFile(join(root, 'config', 'merchants', id, 'creation.json'), 'utf8')), root }; } catch { return null; }
}

/** Real transparency, measured on the pixels (an encoder often writes an alpha channel that is fully opaque). A JPEG has none. */
function hasTransparency(bytes, media) {
  if (media !== 'image/png' || ![4, 6].includes(bytes[25])) return false;
  const { pixels } = P.decodePng(bytes);
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return true;
  return false;
}

/**
 * @param {{ merchantId: string, config: object|null, branding?: object|null, dir: string, now?: () => string }} o
 *   dir = where the PNGs and the journal are kept (the server volume)
 */
export function createCreationService({ merchantId, config, branding = null, dir, now = () => new Date().toISOString() }) {
  const journal = join(dir, 'creations.jsonl');
  let fontsP = null;
  async function fonts() {
    if (!config) throw err('CREATION_NOT_CONFIGURED', 'Aucune typographie configurée pour ce marchand.', 503);
    fontsP ??= (async () => {
      const file = join(config.root, config.fonts_manifest);
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      const f = manifest.fonts.find((x) => x.family === config.headline_family);
      if (!f) throw err('FONT_NOT_IN_MANIFEST', `Police « ${config.headline_family} » absente du manifeste.`, 503);
      const bytes = new Uint8Array(await readFile(join(dirname(file), f.file)));
      if (sha(bytes) !== f.font_sha256) throw err('FONT_HASH_MISMATCH', 'Le fichier de police ne correspond pas à son empreinte.', 503);
      return { registry: P.createRealFontRegistry([P.createRealFont({ font_ref: f.record.ref, bytes, metadata: f.record.metadata })]), ref: f.record.ref, family: f.family, license: f.license?.id ?? null };
    })();
    try { return await fontsP; } catch (e) { fontsP = null; throw e; }
  }
  async function entries() { try { return (await readFile(journal, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
  async function append(e) { await mkdir(dir, { recursive: true }); await appendFile(journal, `${JSON.stringify(e)}\n`, { mode: 0o600 }); return e; }

  function status() {
    return config
      ? { status: 'LOCAL_AVAILABLE', what: 'Visuel 4:5 : votre photo telle quelle + un titre, PNG, contrôles de fidélité mesurés.', typography: config.headline_family, typography_evidence: config.typography_evidence ?? null, brand_colours: 'non approuvées (fond et texte neutres)', ai_generation: 'non connectée', layout: CREATION_LAYOUT }
      : { status: 'NOT_CONFIGURED', what: 'Aucune typographie configurée pour ce marchand : aucun visuel local.' };
  }

  function documentFor({ assetRef, headline, font }) {
    const geo = (x, y, width, height) => ({ x, y, width, height, rotation_deg: 0 });
    const base = (id, type, z, g, origin) => ({ id, type, z_index: z, geometry: g, visibility: 'VISIBLE', locked: false, source_ref: null, constraints: [], effects: [], provenance: { origin, producer_ref: null, evidence_refs: [] } });
    return CI.buildDesignDocument({
      version: 1, merchant_id: merchantId, brand_id: merchantId, brief_ref: 'brief:nordla-local-visual', direction_ref: 'direction:nordla-local-visual-v1',
      output_context: { content_kind: 'IMAGE', channel: 'SOCIAL_FEED', placement: 'FEED_POST', format_ref: 'format://nordla/feed-4x5', canvas: { ...CANVAS }, aspect_ratio: '4:5', physical_or_digital: 'DIGITAL', viewing_distance_m: null, expected_dwell_time_s: 2, safe_zones: [], forbidden_zones: [], locale: config.locale ?? 'fr-BE', direction: 'LTR', production_constraints: [] },
      canvas: { ...CANVAS, background_color: config.background ?? '#FFFFFF' },
      layers: [
        { ...base('bg', 'BACKGROUND', 0, geo(0, 0, CANVAS.width, CANVAS.height), 'ENGINE'), fill: config.background ?? '#FFFFFF' },
        { ...base('product', 'PRODUCT', 10, geo(90, 90, 900, 950), 'PROVIDED_ASSET'), product_ref: `product://nordla/${assetRef.slice(-16)}`, asset_ref: assetRef, preservation_mode: 'PIXEL_PRESERVE', protected_regions: [], allow_crop: false, allow_relight: false, allow_shadow: false, allow_rotation: false },
        { ...base('headline', 'TEXT', 20, geo(90, 1090, 900, 200), 'ENGINE'), content: headline, font_ref: font.ref, font_size: 64, min_font_size: 32, line_height: 1.15, tracking: 0, alignment: 'CENTER', max_lines: 2, color: config.text_color ?? '#1E1E1E', box: { padding: 0, vertical_align: 'TOP' }, overflow_policy: 'RELAYOUT_REQUIRED', locale: config.locale ?? 'fr-BE', direction: 'LTR', text_role: 'HEADLINE', text_kind: 'NON_CLAIM_CREATIVE_TEXT', claim_ref: null, approved_digest: null },
      ],
      constraints: [], asset_refs: [assetRef], claim_refs: [],
      provenance: { schema_version: CI.CI_VERSION, derivation: 'CREATE', parent_document_ref: null, created_by: 'ENGINE', producer_refs: ['engine:nordla-local-visual-v1'], evidence_refs: [] },
      created_at: '2026-10-15T12:00:00.000Z', // fixed: the same photo + headline give the same document and the same PNG bytes
    });
  }

  /** Render one local visual from the owner's photo and a headline. Returns the journal entry (the PNG is kept beside it). */
  async function render({ photo, headline }, actor) {
    const text = String(headline ?? '').replace(/\s+/g, ' ').trim();
    if (!text) throw err('FIELD_REQUIRED', 'champ manquant : titre');
    if (text.length > 80) throw err('HEADLINE_TOO_LONG', 'Titre trop long (80 caractères au plus).');
    if (!(photo instanceof Uint8Array) || !photo.length) throw err('PHOTO_REQUIRED', 'Photo manquante.');
    if (photo.length > CREATION_MAX_PHOTO_BYTES) throw err('PHOTO_TOO_LARGE', 'Photo trop lourde (6 Mo au plus).', 413);
    const dims = dimensionsOf(photo);
    if (!dims) throw err('PHOTO_FORMAT', 'Format non pris en charge : JPEG ou PNG seulement.');
    if (hasTransparency(photo, dims.media)) throw err('PHOTO_TRANSPARENT', 'Photo avec transparence : non prise en charge pour l’instant (JPEG ou PNG opaque).');
    const font = await fonts();
    const brand = branding ? await branding.checkText(text) : { status: 'NOT_CONNECTED', official: false, findings: [] };
    const by = actor?.userId ? `user:${actor.userId}` : 'local-owner';
    const photoSha = sha(photo); const assetRef = `asset://nordla/photo-${photoSha.slice(0, 24)}`;
    if (brand.official && brand.outcome === 'FAIL') {
      return append({ kind: 'CREATION', id: `cr-blocked-${sha(photoSha + text).slice(0, 16)}`, at: now(), by, status: 'BLOCKED_BY_BRAND', headline: text, brand, photo_sha256: photoSha, png: null, published: false });
    }
    const log = P.createRenderLog((r) => (r === assetRef ? photo : null));
    let document; let rendered;
    try { document = documentFor({ assetRef, headline: text, font }); rendered = CI.renderDesignDocument({ document, fonts: font.registry, assetResolver: log.resolver }); } catch (e) { throw err(e.code ?? 'RENDER_FAILED', `Rendu impossible : ${e.message}`, 422); }
    const png = P.renderProductionPng(rendered);
    const observations = P.measureProductFidelity({
      source: { bytes: photo, sha256: photoSha, origin: 'MERCHANT_PROVIDED', width_px: dims.width, height_px: dims.height, has_alpha: false },
      candidate: { png_bytes: png.bytes }, canvas: { ...CANVAS, background: document.canvas.background_color },
      product_layers: document.layers.filter((l) => l.type === 'PRODUCT'), raster_layer_count: 0, render_log: log.finish(rendered.svg),
      expected: { asset_ref: assetRef, pinned_sha256: photoSha, piece_count: 1 }, text_regions: [],
    });
    const fidelity = observations.map((o) => ({ check: o.code, outcome: o.outcome, reason: o.evidence?.reason ?? null }));
    const fidelityOk = REQUIRED_PASS.every((c) => fidelity.find((f) => f.check === c)?.outcome === 'PASS');
    const id = `cr-${png.sha256.slice(0, 16)}`;
    const same = (await entries()).find((e) => e.kind === 'CREATION' && e.id === id); if (same) return same; // same photo + headline = same bytes: kept once
    if (fidelityOk) { const f = join(dir, `${id}.png`); await mkdir(dir, { recursive: true }); await writeFile(`${f}.tmp`, png.bytes, { mode: 0o600 }); await rename(`${f}.tmp`, f); }
    return append({
      kind: 'CREATION', id, at: now(), by, status: fidelityOk ? 'TO_OWNER_REVIEW' : 'FIDELITY_FAILED', headline: text, layout: CREATION_LAYOUT,
      typography: { family: font.family, license: font.license, evidence: config.typography_evidence ?? null },
      photo_sha256: photoSha, photo_px: { width: dims.width, height: dims.height }, png: fidelityOk ? { sha256: png.sha256, width: png.width, height: png.height, engine: png.engine } : null,
      fidelity, brand, limits: ['Aucune génération IA : la photo est utilisée telle quelle.', 'Texte imprimé sur la photo : non mesuré (aucune zone protégée annotée).', 'Couleurs de marque non approuvées : fond et texte neutres.'],
      owner_approval: 'PENDING', published: false,
    });
  }

  async function decide(id, { decision, reason }, actor) {
    if (actor?.role !== 'OWNER') throw err('APPROVAL_ROLE_REQUIRED', 'Seul le propriétaire valide un visuel.', 403);
    if (!DECISIONS.includes(decision)) throw err('INVALID_DECISION', `décision : ${DECISIONS.join(', ')}`);
    if (!String(reason ?? '').trim()) throw err('REASON_REQUIRED', 'raison obligatoire');
    const all = await entries();
    if (!all.some((e) => e.kind === 'CREATION' && e.id === id && e.status === 'TO_OWNER_REVIEW')) throw err('NOT_FOUND', 'visuel introuvable', 404);
    if (all.some((e) => e.kind === 'DECISION' && e.id === id)) throw err('ALREADY_DECIDED', 'décision déjà enregistrée', 409);
    return append({ kind: 'DECISION', id, at: now(), by: actor.userId ? `user:${actor.userId}` : 'local-owner', decision, reason: String(reason).trim(), published: false });
  }

  async function list() {
    const all = await entries(); const dec = new Map(all.filter((e) => e.kind === 'DECISION').map((e) => [e.id, e]));
    return all.filter((e) => e.kind === 'CREATION').map((c) => ({ ...c, decision: dec.get(c.id) ?? null })).reverse();
  }

  /** The PNG bytes of a rendered visual, or null. */
  async function image(id) {
    if (!/^cr-[0-9a-f]{16}$/.test(id)) return null;
    try { return await readFile(join(dir, `${id}.png`)); } catch { return null; }
  }

  return Object.freeze({ status, render, decide, list, image });
}
