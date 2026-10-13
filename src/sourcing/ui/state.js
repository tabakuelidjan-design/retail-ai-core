// The one shared UI state object (extracted from app.js). Screens READ it; only app.js (and the shell) change it.
import { ls } from './storage.js';

// FIELD MODE is the normal way in to China Sourcing. One-time migration: the first launch of this version opens Field (even if an older test left 'expert' stored); after that the owner's own choice sticks. Expert stays one tap away (menu).
function initialMode() { try { if (ls.get('nordla.sourcing.modeDefault', null) !== 'field-v1') { ls.set('nordla.sourcing.modeDefault', 'field-v1'); ls.set('nordla.sourcing.mode', 'field'); return 'field'; } } catch { /* storage unavailable: Field */ } return ls.get('nordla.sourcing.mode', 'field'); }
export const S = { cases: ls.get('nordla.sourcing.cases', {}), currentId: ls.get('nordla.sourcing.current', null), tab: 'quick', token: ls.get('nordla.sourcing.token', ''), offlineChoice: ls.get('nordla.sourcing.offlineChoice', false), authFailed: false, lockedOut: false, verifiedAt: 0, online: false, busy: '', flash: '', whatIf: null, A: null, error: null, suggestions: [], ai: null, fstep: null, correcting: null, mode: ['field', 'salon'].includes(initialMode()) ? initialMode() : 'expert', fview: 'talk', returnMode: null, groupEdit: false, attach: false, captureDraft: ls.get('nordla.sourcing.capdraft', {}) };
export const cur = () => S.cases[S.currentId];
