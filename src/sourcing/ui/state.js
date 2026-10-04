// The one shared UI state object (extracted from app.js). Screens READ it; only app.js (and the shell) change it.
import { ls } from './storage.js';

export const S = { cases: ls.get('nordla.sourcing.cases', {}), currentId: ls.get('nordla.sourcing.current', null), tab: 'quick', token: ls.get('nordla.sourcing.token', ''), offlineChoice: ls.get('nordla.sourcing.offlineChoice', false), authFailed: false, lockedOut: false, verifiedAt: 0, online: false, busy: '', flash: '', whatIf: null, A: null, error: null, suggestions: [], ai: null };
export const cur = () => S.cases[S.currentId];
