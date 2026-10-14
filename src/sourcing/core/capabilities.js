// Deterministic OFFLINE CAPABILITY MATRIX. For every major feature: what it REQUIRES (its class) and whether it works RIGHT NOW given the real connection state.
//   AVAILABLE_OFFLINE          works with nothing but the installed app (all arithmetic and decision logic run on the phone)
//   AVAILABLE_FROM_CACHE       works from data kept on the phone from an earlier connection (rulebook shipped with the app, Safety Gate copy)
//   REQUIRES_NETWORK           needs internet itself
//   REQUIRES_SERVER            needs your Nordla server to be reachable
//   REQUIRES_EXTERNAL_PROVIDER needs an external AI provider (server + internet + provider configured + your consent for each image)
//   UNAVAILABLE                cannot work at all in the current state
// `availableNow` is the truth for the current state; the UI shows `note`, and never shows LIVE for something that comes from a cache (see liveLabel).
export const CAPABILITY_CLASS = Object.freeze({ AVAILABLE_OFFLINE: 'AVAILABLE_OFFLINE', AVAILABLE_FROM_CACHE: 'AVAILABLE_FROM_CACHE', REQUIRES_NETWORK: 'REQUIRES_NETWORK', REQUIRES_SERVER: 'REQUIRES_SERVER', REQUIRES_EXTERNAL_PROVIDER: 'REQUIRES_EXTERNAL_PROVIDER', UNAVAILABLE: 'UNAVAILABLE' });

/**
 * @param {{ serverReachable: boolean, appCached: boolean, safetyCache: { present: boolean, ageDays?: number|null }|null, aiConfigured: boolean, aiRegion?: string|null }} s
 */
export function capabilityMatrix(s) {
  const server = s.serverReachable === true; const cache = s.safetyCache?.present === true; const ai = s.aiConfigured === true;
  const F = (id, label, klass, availableNow, note) => ({ id, label, class: klass, availableNow, note });
  const off = CAPABILITY_CLASS.AVAILABLE_OFFLINE; const fc = CAPABILITY_CLASS.AVAILABLE_FROM_CACHE; const rs = CAPABILITY_CLASS.REQUIRES_SERVER; const ep = CAPABILITY_CLASS.REQUIRES_EXTERNAL_PROVIDER;
  return [
    F('case', 'Product case (create, edit, reopen)', off, true, 'kept on this phone first'),
    F('photo', 'Photo as evidence', off, true, 'stored on this phone; never sent anywhere unless you tap OK for an AI reader'),
    F('manual_identification', 'Manual identification (category, traits, model)', off, true, 'you confirm; this is the default path'),
    F('ai_vision', 'AI vision identification (a suggestion only)', ep, server && ai, ai ? (server ? `available: asks your consent per image (${s.aiRegion ?? 'region unknown'})` : 'needs the server: not reachable now') : 'no provider configured: identify it by hand'),
    F('supplier_questions', 'Supplier questions (EN + 中文) and show-to-supplier screen', off, true, 'fixed phrasebook inside the app'),
    F('document_text', 'Document: paste or type from the paper', off, true, 'works offline; typed documents count as your transcription'),
    F('pdf_extraction', 'Document: read a PDF text layer', rs, server, server ? 'read on your server' : 'needs the server: paste or type the text instead'),
    F('document_photo_ai', 'Document photo: AI reading', ep, server && ai, ai ? (server ? 'available with your consent per image; the result stays UNVERIFIED until you confirm it' : 'needs the server: type what the paper says') : 'no provider configured: type what the paper says'),
    F('document_confirm', 'Document: manual confirmation against the paper', off, true, 'always possible; OCR is never upgraded by itself'),
    F('rulebook', 'Regulatory rulebook (31 rules, review status, sources)', fc, s.appCached !== false, 'shipped inside the app; its review date is shown (stale after 180 days)'),
    F('safety_gate', 'EU Safety Gate matching', fc, cache, cache ? `uses the copy on this phone${s.safetyCache.ageDays != null ? ` (${s.safetyCache.ageDays} day(s) old)` : ''}: shown as CACHED unless the server is reachable and the copy is under 24 h old` : 'no copy on this phone yet: OFFLINE - VERIFICATION REQUIRED (this is not a clean result)'),
    F('safety_gate_refresh', 'Safety Gate refresh', rs, server, server ? 'available' : 'needs the server'),
    F('customs', 'Customs input (HS/CN candidate, duty you provide)', off, true, 'no official lookup is integrated: the duty is USER PROVIDED, never verified'),
    F('amazon_observations', 'Amazon observations (typed)', off, true, 'no scraping, no Amazon data feed'),
    F('landed_cost', 'Landed cost', off, true, 'recalculated on the phone at every change; unknown costs stay visible'),
    F('max_purchase_price', 'Maximum purchase price and what-if', off, true, 'recalculated on the phone'),
    F('verdict', 'Verdict (GO / CONDITIONAL GO / NO GO / INFORMATION INSUFFICIENT)', off, true, 'deterministic, computed on the phone'),
    F('save', 'Save', off, true, 'saved on this phone at every change; copied to your server when it is reachable'),
    F('case_history', 'Case history (events and decisions)', off, true, 'append-only on this phone'),
    F('fx_rate', 'ECB exchange rate', rs, server, server ? 'available' : 'type the rate yourself'),
    F('sync', 'Sync with your server', rs, server, server ? 'automatic; a case changed on two devices is reported, never overwritten' : 'changes wait on this phone and are sent when the server is reachable'),
  ];
}

/** What the header may say about the Safety Gate data: LIVE only when the server is reachable NOW and the copy is under 24 h old; a copy is otherwise CACHED; none is OFFLINE. */
export function liveLabel({ serverReachable, safetyCache }) {
  if (!safetyCache?.present) return 'OFFLINE_VERIFICATION_REQUIRED';
  return serverReachable === true && safetyCache.ageHours != null && safetyCache.ageHours < 24 && safetyCache.serverMode === 'LIVE_VERIFIED' ? 'LIVE_VERIFIED' : 'CACHED';
}
