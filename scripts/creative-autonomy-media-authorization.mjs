// Drafts the owner's media record for the visual critic: ONE photo (by SHA-256), Alibaba Frankfurt only, purpose NORDLA_CREATIVE_CRITIQUE only, the photo and the
// renders derived from it only. The draft is INACTIVE by construction (revoked: true, retention not acknowledged): the existing guard refuses it until the owner
// has read it and both fields are switched. Nothing is sent by this script.
//   node scripts/creative-autonomy-media-authorization.mjs --photo <file> --out <file outside the repo>
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { VISION_PURPOSE } from '../src/creative-autonomy/providers.js';
import { FRANKFURT_CATALOGUE } from '../src/creative-autonomy/trial.js';

const argv = process.argv.slice(2); const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
const bytes = readFileSync(arg('photo')); const sha = createHash('sha256').update(bytes).digest('hex');
const record = {
  kind: 'EXTERNAL_MEDIA_AUTHORIZATION', authorization_id: `authz://nordla/critique/${sha.slice(0, 16)}`,
  purpose_note: 'Critique visuelle des propositions de Nordla Création pour ce produit, pendant le premier essai. Rien d\'autre.',
  asset: { asset_ref: `asset://habb/photo/${sha.slice(0, 16)}`, asset_sha256: sha, data_class: 'MERCHANT_PRIVATE_MEDIA', contains_personal_data: false, contains_face: false },
  provider: { provider_id: 'alibaba-cloud-model-studio', region: 'eu-central-1' }, purpose: VISION_PURPOSE, allowed_operations: ['VISION_CRITIQUE'],
  transmissible: 'THE_SOURCE_ASSET_AND_IMAGES_DERIVED_FROM_IT_FOR_THIS_PURPOSE_ONLY',
  retention: { standard_inference_retention_days_max: FRANKFURT_CATALOGUE.retention.standard_inference_retention_days_max, zdr_status: 'NOT_CONFIRMED', zdr_claimed: false, zdr_evidence_ref: null, acknowledged: false },
  authorization: { revoked: true }, state: { draft: true, activated_by: null }, global_policy: { changed_by_this_record: false },
};
writeFileSync(arg('out'), JSON.stringify(record, null, 1), { mode: 0o600 });
console.log(JSON.stringify({ draft: arg('out'), photo_sha256: sha, active: false, to_activate: ['retention.acknowledged = true', 'authorization.revoked = false', 'state.activated_by = owner'] }, null, 1));
