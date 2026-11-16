// Approval-policy entries for Social Publishing (chantier E). Kept in their own file so the shared policy table (approval.js) changes by ONE spread line.
//   - reading the calendar, a post, the connections (presence/expiry only): READ_ONLY;
//   - proposing a post: OWNER_REVIEW - it only ever creates a DRAFT (or sends the post back to DRAFT); the owner reviews it in the phone app;
//   - approving, scheduling, publishing: BLOCKED through the hub, whoever asks and whatever approval record is attached. In Social Publishing an approval is a SIGNED record
//     made by the OWNER in the owner app, bound to the exact content (src/social/integrity.js); a generic integration approval is not that, and must not stand in for it.
import { LEVEL as L, MODULE as M } from './constants.js';

export const SOCIAL_ACTIONS = Object.freeze({
  [`${M.SOCIAL_PUBLISHING}.read_calendar`]: L.READ_ONLY,
  [`${M.SOCIAL_PUBLISHING}.read_post`]: L.READ_ONLY,
  [`${M.SOCIAL_PUBLISHING}.read_connections`]: L.READ_ONLY,
  [`${M.SOCIAL_PUBLISHING}.propose_post`]: L.OWNER_REVIEW,
  [`${M.SOCIAL_PUBLISHING}.approve_post`]: L.BLOCKED,
  [`${M.SOCIAL_PUBLISHING}.schedule_post`]: L.BLOCKED,
  [`${M.SOCIAL_PUBLISHING}.publish_now`]: L.BLOCKED,
});
