// SIMULATION ONLY: a Creator delivery for a social brief. Creator has no production route for a social brief yet (it receives and shows it: src/creative-autonomy/creator/social-brief.js), so this
// stands in for it, to exercise the calendar path (proposal -> draft -> validation -> simulated publication -> Growth review) offline. It is NOT a creation: its asset is a labelled placeholder,
// its caption says SIMULATION, every link carries `simulated: true`, and nothing here is ever imported into a real installation.
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s).digest('hex');
export const merchantRef = (merchantId) => sha(String(merchantId));
const FORMAT = { reel: 'REEL', image: 'IMAGE', carousel: 'CAROUSEL', video: 'REEL' };

/**
 * @param {object} brief the brief exported by Growth (buildBrief)
 * @param {{ merchantId: string, creationVersion?: number, hook?: string, suggestedDate?: string|null }} o
 * @returns {object} a social-post-proposal.v1 whose proposal_id is stable per brief (a new creation VERSION edits the same post; a new brief version is a new proposal)
 */
export function simulatedCreation(brief, { merchantId, creationVersion = 1, hook = null, suggestedDate = null } = {}) {
  const format = FORMAT[String(brief.format).toLowerCase()]; if (!format || format === 'CAROUSEL') throw new Error(`the simulated Creator covers Reel and image (got ${brief.format})`);
  const text = hook ?? brief.hook?.text ?? 'sans accroche';
  return {
    schema: 'social-post-proposal.v1', proposal_id: `growth-${brief.briefId}`, producer: 'creator-SIMULATED',
    subject: { kind: 'brand', ref: `growth://test/${brief.opportunityId}`, label: 'SIMULATION — test Growth' },
    asset: { ref: `asset://SIMULATION/creator/${brief.briefId}`, version: creationVersion, sha256: sha(`SIMULATION|${brief.briefId}|${creationVersion}`), content_type: format === 'REEL' ? 'video/mp4' : 'image/jpeg', width: 1080, height: format === 'REEL' ? 1920 : 1350 },
    caption: `SIMULATION — ${text}. Version ${creationVersion} de la création simulée.`, hashtags: [],
    ...(suggestedDate ? { suggested_date: suggestedDate } : {}),
    targets: [{ platform: brief.network, format, account_ref: brief.account.id }],
    links: { growth_test_id: brief.opportunityId, brief_id: brief.briefId, brief_version: brief.version, creation_id: `sim-creation-${brief.briefId}`, creation_version: creationVersion, merchant_ref: merchantRef(merchantId),
      account: { network: brief.network, id: brief.account.id }, observation_days: brief.successMetric.observationDays, simulated: true },
  };
}
