// Restore drill for what the Core added to the server's data directory: the Branding approval, Marketing proposals + decisions and the
// Création visuals (journal + PNG files). They are written by their REAL services, the whole data directory is backed up (encrypted),
// restored into an EMPTY directory, and NEW services opened on the restored copy find the same approval, decisions and PNG bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { backup, restore } from '../tools/sourcing-backup.mjs';
import { createBrandingService, loadBrandProposal } from '../src/core-pilot/branding.js';
import { createCampaignService } from '../src/core-pilot/campaign.js';
import { createCreationService, loadCreationConfig } from '../src/core-pilot/creation.js';

const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5';
const ENV = { SOURCING_MERCHANT_ID: 'habb', SOURCING_BACKUP_PASSPHRASE: 'core restore drill passphrase' };
const OWNER = { role: 'OWNER', userId: '00000001-2222-4222-8222-000000000001' };
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function servicesOn(dir) {
  const branding = createBrandingService({ merchantId: M, proposal: await loadBrandProposal(ENV), file: join(dir, 'core', 'brand-approved.json') });
  const campaigns = createCampaignService({ merchantId: M, branding, file: join(dir, 'core', 'campaigns.jsonl'), env: {} });
  const creation = createCreationService({ merchantId: M, config: await loadCreationConfig(ENV), branding, dir: join(dir, 'core', 'creations') });
  return { branding, campaigns, creation };
}

test('backup covers the Core data: brand approval, campaign decisions and Création visuals come back identical from an encrypted restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nordla-core-restore-'));
  try {
    const live = join(root, 'live'); const restored = join(root, 'restored');
    const a = await servicesOn(live);
    await a.branding.approve(OWNER);
    const camp = await a.campaigns.prepare({ product: 'Mug', objective: 'boutique', audience: 'parents', channel: 'Instagram', copy: 'Un cadeau imprimé avec soin.' }, OWNER);
    await a.campaigns.decide(camp.id, { decision: 'DEFERRED', reason: 'restore drill' }, OWNER);
    const photo = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#222"/><rect x="10" y="10" width="280" height="380" fill="#c9a"/></svg>').render().asPng());
    const visual = await a.creation.render({ photo, headline: 'Un cadeau imprimé avec soin' }, OWNER);
    await a.creation.decide(visual.id, { decision: 'APPROVED', reason: 'restore drill' }, OWNER);
    const png = await a.creation.image(visual.id);

    const { file } = await backup(live, join(root, 'backups'), { env: ENV });
    await restore(file, restored, { env: ENV });

    const b = await servicesOn(restored);
    assert.equal((await b.branding.status()).status, 'APPROVED');
    assert.equal((await b.branding.checkText('Dernière chance !!!')).official, true, 'the restored approval still gives official verdicts');
    const camps = await b.campaigns.list(); assert.equal(camps.length, 1); assert.equal(camps[0].decision.decision, 'DEFERRED');
    const vis = await b.creation.list(); assert.equal(vis.length, 1); assert.equal(vis[0].decision.decision, 'APPROVED');
    assert.equal(sha(await b.creation.image(visual.id)), sha(png), 'the PNG comes back byte for byte');
    assert.equal(sha(png), visual.png.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});
