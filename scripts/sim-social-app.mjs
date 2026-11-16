#!/usr/bin/env node
// SIMULATION ONLY (port 8980): the real Publication sociale app in SIMULATE mode (a publisher that publishes NOTHING), with the SIMULATED Creator delivery of the Growth test already imported, approved and
// scheduled, so the calendar can be opened from the Growth simulation. Temporary folders, fictitious merchant 'sim-merchant' and account 'ig-9001'. Nothing is sent to any network.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { startSocialServer } from '../src/social/server/index.js';
import { createSocialSource } from '../src/growth/server/social.js';
import { simulatedCreation } from './lib/social-creation-sim.mjs';

const NOW = new Date('2026-11-15T12:00:00Z');
const post = (id, structure, reach, follows) => ({ id, url: `https://www.instagram.com/reel/${id}/`, posted_at: '2026-10-20', format: 'reel', paid: 'organic', hook: 'Du plateau vide au cadeau fini', topic: 'impression UV', structure, observed: { age_days: 7, reach, follows_attributed: follows } });
const FACTS = { source_system: 'instagram_insights_SIM', network: 'instagram', account: { id: 'ig-9001', handle: '@atelier_sim' }, market: 'BE', window: { start: '2026-10-18', end: '2026-11-15' }, retrieved_at: '2026-11-15T06:00:00Z', followers: { start_total: 1000, end_total: 1060 }, brand: { tone: 'chaleureux, direct', process: 'impression UV' }, capabilities: { trial_reels: true }, posts: [post('demo', 'démonstration', 1200, 12), post('presentation', 'présentation produit', 4000, 8)] };
const brief = (await createSocialSource({ now: () => NOW, cacheMs: 0, merchantId: 'sim-merchant', loaders: { instagram: async () => FACTS } })()).items[0].preparedAction.brief;
const root = mkdtempSync(join(tmpdir(), 'nordla-social-sim-')); const token = 'sim-publication-sociale-0123456789-token';
const env = { SOCIAL_MODE: 'simulate', SOCIAL_TOKEN: token, SOCIAL_KEY_DIR: join(root, 'keys'), NORDLA_MERCHANT_ID: 'sim-merchant', SOCIAL_INSTAGRAM_ACCOUNT_ID: 'ig-9001', SOCIAL_PORT: '8980' };
const srv = await startSocialServer({ env, dir: join(root, 'data'), port: 8980, log: () => {} });
const OWNER = { id: 'owner:sim', role: 'owner' }; const AGENT = { id: 'creator-SIMULATED', role: 'agent' };
const [line] = await srv.service.importProposals([simulatedCreation(brief, { merchantId: 'sim-merchant' })]);
const when = new Date(Date.now() + 26 * 3600_000).toISOString();
await srv.service.editPost(line.post_id, { publish_at: when }, OWNER); await srv.service.act(line.post_id, 'submit', AGENT).catch(() => {});
const hash = srv.service.contentHashOf(await srv.service.get(line.post_id)); await srv.service.act(line.post_id, 'approve', OWNER, { expected_hash: hash }); await srv.service.act(line.post_id, 'schedule', OWNER, { expected_hash: hash });
writeFileSync(join(root, 'url.txt'), `http://127.0.0.1:8980/#t=${token}`);
console.log(`Publication sociale (SIMULATION, publisher that publishes nothing): http://127.0.0.1:8980/#t=${token}`);
