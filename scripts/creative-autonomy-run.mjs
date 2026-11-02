// CLI: one autonomous Nordla run on a saved Shopify snapshot. Uses ONLY the providers really configured in the environment.
// usage: node scripts/creative-autonomy-run.mjs <snapshot.json> <photo> <workdir> --objective "..." [--variant Noir] [--format INSTAGRAM_FEED_4_5] [--audience "..."] [--occasion "..."]
import { readFileSync } from 'node:fs';
import { runAutonomous, localEngines } from '../src/creative-autonomy/run.js';
import { connectProviders } from '../src/creative-autonomy/providers.js';
import { loadMerchantCreativeBrand as __loadBrand, resolveBrandProfile as __resolveProfile, artDirectionHintFor as __hintFor } from '../src/creative-autonomy/brand-profile.js';
const HABB_BRAND = __loadBrand('habb'); // HABB is tenant configuration (config/merchants/habb/creative-brand.json)
const HABB = __resolveProfile(HABB_BRAND);


const [snapshotPath, photoPath, workdir, ...rest] = process.argv.slice(2);
const opt = (k, d = null) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const ports = connectProviders();
const media = photoPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
const result = await runAutonomous({
  input: {
    product: snap.product, variantTitle: opt('variant'), readAt: snap.read_at, objective: opt('objective'), audience: opt('audience'), occasion: opt('occasion'),
    brand: HABB_BRAND, format: opt('format', 'INSTAGRAM_FEED_4_5'), photoPath, photoMeta: { media_type: media, width_px: null, height_px: null, origin: 'MERCHANT_UPLOAD', rights_class: 'UNKNOWN' },
  },
  ports, engines: localEngines(), workdir,
});
console.log(JSON.stringify({ status: result.status, stopped_at: result.stopped_at ?? null, engines: result.engines, cost_eur: result.cost_eur, missing: ports.missing,
  trace: result.trace.map((t) => `${t.n}. ${t.step}${t.concept_id ? ` [${t.concept_id}]` : ''} | ${t.kind} | ${t.provider} | ${t.outcome} | ${t.cost_eur} € | ${t.ms} ms`) }, null, 1));
