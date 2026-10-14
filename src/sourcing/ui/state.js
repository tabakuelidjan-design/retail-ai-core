// The one shared UI state object (extracted from app.js). Screens READ it; only app.js (and the shell) change it.
import { ls } from './storage.js';

// NORDLA TERRAIN (mobile V2) is the normal way in: ONE navigation (Accueil, Fournisseurs, Noter, Visites, Plus). One-time migration per UI generation: the first launch of this generation opens it (even if an older test left 'field' or 'expert'
// stored); after that the owner's own choice sticks. The guided and the expert modes stay reachable, explicitly, from "Plus".
const UI_GEN = 'terrain-v2';
function initialMode() { try { if (ls.get('nordla.sourcing.uiGen', null) !== UI_GEN) { ls.set('nordla.sourcing.uiGen', UI_GEN); ls.set('nordla.sourcing.modeDefault', 'field-v1'); ls.set('nordla.sourcing.mode', 'salon'); return 'salon'; } } catch { /* storage unavailable: Terrain */ } return ls.get('nordla.sourcing.mode', 'salon'); }
export const S = { cases: ls.get('nordla.sourcing.cases', {}), currentId: ls.get('nordla.sourcing.current', null), tab: 'quick', token: ls.get('nordla.sourcing.token', ''), offlineChoice: ls.get('nordla.sourcing.offlineChoice', false), authFailed: false, lockedOut: false, verifiedAt: 0, online: false, busy: '', flash: '', whatIf: null, A: null, error: null, suggestions: [], ai: null, fstep: null, correcting: null, mode: ['field', 'salon'].includes(initialMode()) ? initialMode() : 'expert', fview: 'talk', returnMode: null, groupEdit: false, attach: false, captureDraft: ls.get('nordla.sourcing.capdraft', {}) };
export const cur = () => S.cases[S.currentId];
