// The integration face of Social Publishing (chantier E): ONE adapter for the hub. It exposes reads and a single proposal command; it has NO command that approves, schedules
// or publishes (and the policy BLOCKS those names too: social-policy.js). Publication stays where it is guarded: the owner app (signed approvals) and the publisher (claim, duplicates).
// Results carry ids, states and counts - never a caption body, a token or a key.
import { ERR, fail } from './constants.js';
import { hasValidApproval } from '../social/workflow.js';

const brief = (p, integrity) => ({
  post_id: p.id, platform: p.platform, format: p.format, state: p.state, publish_at: p.publish_at ?? null,
  approval_valid: hasValidApproval(p, integrity), published: ['PUBLISHED', 'VERIFIED'].includes(p.state), proposal_id: p.origin?.proposal_id ?? null,
});

/**
 * @param {{ service: object, credentialPort?: { describe(platform): object } }} social  the Social Publishing service (createSocialService) and, optionally, its credential port
 */
export function createSocialAdapter({ service, credentialPort = null }) {
  if (!service?.store || typeof service.list !== 'function' || typeof service.importProposals !== 'function') fail(ERR.HANDOFF_INVALID, 'a Social Publishing service is required');
  return {
    available: () => true,
    commands: {
      read_calendar: async ({ platform = null, state = null } = {}) => {
        const posts = (await service.list()).filter((p) => (!platform || p.platform === platform) && (!state || p.state === state));
        return { count: posts.length, posts: posts.map((p) => brief(p, service.integrity)) };
      },
      read_post: async ({ post_id }) => {
        const p = await service.get(post_id);
        if (!p) fail(ERR.HANDOFF_INVALID, 'unknown post');
        return brief(p, service.integrity);
      },
      read_connections: async () => ({
        connections: ['instagram', 'facebook'].map((platform) => (credentialPort ? credentialPort.describe(platform) : { platform, configured: false, state: 'NOT_CONFIGURED' })),
      }),
      // a proposal from Creative becomes a DRAFT / review-ready post: the service acts as the creative AGENT (cannot approve, schedule or publish)
      propose_post: async ({ proposals }) => {
        if (!Array.isArray(proposals) || !proposals.length) fail(ERR.HANDOFF_INVALID, 'proposals: at least one social-post-proposal.v1');
        const report = await service.importProposals(proposals);
        return {
          proposed: report.filter((r) => ['CREATED', 'UPDATED'].includes(r.result)).length,
          report: report.map((r) => ({
            proposal_id: r.proposal_id, platform: r.platform, format: r.format, post_id: r.post_id, result: r.result, duplicate_of: r.duplicate_of ?? null,
          })),
          published: 0,
        };
      },
    },
  };
}
