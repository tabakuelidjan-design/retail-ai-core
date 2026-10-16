// Chantier E - Social Publishing / Activation. Vocabulary shared by the workflow, the store, the publisher and the UI.
//
// One publication = one post = one platform + one format. The state machine below is the ONLY way a post moves.
// Nothing here talks to a platform: this file is data.

export const SOCIAL_VERSION = 'social-publishing.v1';
export const PROPOSAL_SCHEMA = 'social-post-proposal.v1'; // the contract with chantier D (creation / assets)
export const TIMEZONE = 'Europe/Brussels';

export const POST_STATE = Object.freeze({
  DRAFT: 'DRAFT', // Brouillon
  READY_FOR_REVIEW: 'READY_FOR_REVIEW', // Prêt à examiner
  NEEDS_CHANGES: 'NEEDS_CHANGES', // À corriger
  REJECTED: 'REJECTED', // Refusé
  APPROVED: 'APPROVED', // Approuvé (this exact version)
  SCHEDULED: 'SCHEDULED', // Programmé (Nordla will publish at publish_at, or the platform will)
  PUBLISHING: 'PUBLISHING', // internal: claimed by one worker, a provider call may be in flight
  PUBLISHED: 'PUBLISHED', // Publié (the platform answered with a post id, or the owner attested a manual post)
  VERIFIED: 'VERIFIED', // Vérifié (a LIVE read of the platform, or an owner attestation, confirmed it)
  ERROR: 'ERROR', // Erreur (final, nothing published)
  PUBLICATION_UNKNOWN: 'PUBLICATION_UNKNOWN', // internal: a creating call may have reached the platform - never retried blindly
  CANCELLED: 'CANCELLED', // Annulé
});
const S = POST_STATE;

export const STATE_LABEL_FR = Object.freeze({
  DRAFT: 'Brouillon', READY_FOR_REVIEW: 'À examiner', NEEDS_CHANGES: 'À corriger', REJECTED: 'Refusé', APPROVED: 'Approuvé',
  SCHEDULED: 'Programmé', PUBLISHING: 'Publication en cours', PUBLISHED: 'Publié', VERIFIED: 'Vérifié', ERROR: 'Erreur',
  PUBLICATION_UNKNOWN: 'Résultat inconnu — à vérifier', CANCELLED: 'Annulé',
});

export const TRANSITIONS = Object.freeze({
  [S.DRAFT]: [S.READY_FOR_REVIEW, S.CANCELLED],
  [S.READY_FOR_REVIEW]: [S.APPROVED, S.REJECTED, S.NEEDS_CHANGES, S.DRAFT, S.CANCELLED],
  [S.NEEDS_CHANGES]: [S.DRAFT, S.READY_FOR_REVIEW, S.CANCELLED],
  [S.REJECTED]: [S.DRAFT, S.CANCELLED],
  [S.APPROVED]: [S.SCHEDULED, S.READY_FOR_REVIEW, S.DRAFT, S.CANCELLED, S.PUBLISHED], // PUBLISHED: manual publication attested by the owner
  [S.SCHEDULED]: [S.PUBLISHING, S.APPROVED, S.READY_FOR_REVIEW, S.DRAFT, S.CANCELLED, S.PUBLISHED, S.ERROR], // PUBLISHED: platform-side schedule confirmed published
  [S.PUBLISHING]: [S.PUBLISHED, S.SCHEDULED, S.ERROR, S.PUBLICATION_UNKNOWN],
  [S.PUBLISHED]: [S.VERIFIED],
  [S.PUBLICATION_UNKNOWN]: [S.PUBLISHED, S.SCHEDULED, S.ERROR, S.CANCELLED],
  [S.ERROR]: [S.DRAFT, S.SCHEDULED, S.CANCELLED, S.PUBLISHED],
  [S.VERIFIED]: [],
  [S.CANCELLED]: [],
});
export const TERMINAL_STATES = Object.freeze([S.VERIFIED, S.CANCELLED]);
/** States in which the content may still be edited (an edit of an approved version always sends it back to DRAFT). */
export const EDITABLE_STATES = Object.freeze([S.DRAFT, S.NEEDS_CHANGES, S.REJECTED, S.ERROR, S.READY_FOR_REVIEW, S.APPROVED, S.SCHEDULED]);
/** The platform may already hold the post: nothing about the content may change any more. */
export const FROZEN_STATES = Object.freeze([S.PUBLISHING, S.PUBLISHED, S.VERIFIED, S.PUBLICATION_UNKNOWN, S.CANCELLED]);

export const PLATFORM = Object.freeze({ INSTAGRAM: 'instagram', FACEBOOK: 'facebook' });
export const FORMAT = Object.freeze({ IMAGE: 'IMAGE', REEL: 'REEL', TEXT: 'TEXT', CAROUSEL: 'CAROUSEL', STORY: 'STORY' });
/** What each platform can carry in V1 (carousels and stories are approved and tracked here but published by hand). */
export const PLATFORM_FORMATS = Object.freeze({
  instagram: [FORMAT.IMAGE, FORMAT.REEL, FORMAT.CAROUSEL, FORMAT.STORY],
  facebook: [FORMAT.IMAGE, FORMAT.TEXT, FORMAT.CAROUSEL],
});
/** Formats Nordla can approve, schedule and track but that NO publisher sends automatically in V1 (carousels, stories): manual pack + attestation. */
export const MANUAL_ONLY_FORMATS = Object.freeze([FORMAT.CAROUSEL, FORMAT.STORY]);

export const ROLE = Object.freeze({ OWNER: 'owner', AGENT: 'agent', SYSTEM: 'system' });
/** Actions only the owner may take: they carry the human authorization (Nordla never approves for them). */
export const OWNER_ACTIONS = Object.freeze(['approve', 'reject', 'request_changes', 'revoke_approval', 'schedule', 'unschedule', 'cancel', 'retry', 'reconcile', 'attest_manual', 'verify_manual']);

export const MODE = Object.freeze({ LIVE: 'LIVE', SIMULATION: 'SIMULATION', MANUAL: 'MANUAL' });

export const LIMITS = Object.freeze({ CAPTION_MAX: 2200, HASHTAGS_MAX: 30, HASHTAG_MAX_LEN: 60, NOTE_MAX: 1000 });

export const SOCIAL_ERROR = Object.freeze({
  INVALID: 'SOCIAL_INVALID', TRANSITION: 'SOCIAL_TRANSITION_REFUSED', FORBIDDEN: 'SOCIAL_FORBIDDEN', STALE_VERSION: 'SOCIAL_STALE_VERSION',
  NOT_FOUND: 'SOCIAL_NOT_FOUND', CONFLICT: 'SOCIAL_CONFLICT', CLAIMS: 'SOCIAL_UNCONFIRMED_CLAIM', NO_VALID_APPROVAL: 'SOCIAL_NO_VALID_APPROVAL',
});

export class SocialError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SocialError';
    this.code = code;
    this.detail = detail;
  }
}
export const fail = (code, message, detail) => { throw new SocialError(code, message, detail); };
