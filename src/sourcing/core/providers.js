// The PROVIDER BOUNDARY for audio / speech-to-text / translation / OCR. Pure contract + registry + policy; NO provider is shipped: in V1 the registry is empty, every stage answers UNAVAILABLE, and the
// product works without any (typed or pasted text, the fixed phrasebook, deterministic extraction, human correction).
//   - Providers are interchangeable ADAPTERS, not a router: the OWNER selects one per kind (settings.selected); nothing is chosen by cost, quality or availability, and a failing provider never falls back to
//     another one (an automatic multi-model router is a deferred Level 3 capability, NORDLA-DEFERRED L3-001).
//   - Policy is checked BEFORE any call: the owner's consent for that provider, no recurring cost unless the owner approved it, no confidential data to a China-hosted service unless allowed, no remote
//     provider while offline, a declared licence.
//   - A provider answers OK / UNKNOWN / UNAVAILABLE. Anything else, an empty text or an exception is UNKNOWN. A provider never writes into the case: an OK result can only become a CONVERSATION_DERIVE event
//     (provider + version + review MACHINE) next to the untouched original; facts taken from it are capped, tagged and confirmed individually (see core/conversation.js and core/understanding.js).
export const PROVIDER_KIND = Object.freeze({ STT: 'STT', TRANSLATE: 'TRANSLATE', OCR: 'OCR' });
export const RESULT = Object.freeze({ OK: 'OK', UNKNOWN: 'UNKNOWN', UNAVAILABLE: 'UNAVAILABLE' });
const KINDS = new Set(Object.values(PROVIDER_KIND)); const STATUSES = new Set(Object.values(RESULT));

export const createRegistry = () => ({ providers: new Map() });

/** Registers a provider after checking that it declares what the owner needs to know (kind, version, languages, cost, licence, data class, region). */
export function registerProvider(reg, p) {
  if (!p || typeof p.id !== 'string' || !p.id) throw new Error('a provider needs an id');
  if (!KINDS.has(p.kind)) throw new Error(`provider ${p.id}: kind must be one of ${[...KINDS].join(', ')}`);
  if (typeof p.version !== 'string' || !p.version) throw new Error(`provider ${p.id}: a version is required`);
  const c = p.capabilities; if (!c || !Array.isArray(c.langs)) throw new Error(`provider ${p.id}: capabilities.langs is required`);
  if (typeof c.recurringCostEur !== 'number' || !(c.recurringCostEur >= 0)) throw new Error(`provider ${p.id}: the recurring cost (EUR, 0 if none) must be declared`);
  if (typeof c.license !== 'string' || !c.license.trim()) throw new Error(`provider ${p.id}: the licence must be declared`);
  if (!['LOCAL', 'REMOTE'].includes(c.dataClass) || typeof c.region !== 'string') throw new Error(`provider ${p.id}: dataClass (LOCAL|REMOTE) and region are required`);
  if (typeof p.status !== 'function' || typeof p.run !== 'function') throw new Error(`provider ${p.id}: status() and run() are required`);
  if (reg.providers.has(p.id)) throw new Error(`provider ${p.id} is already registered`);
  reg.providers.set(p.id, p); return reg;
}

const NO = (code, fr, en, extra = {}) => ({ status: RESULT.UNAVAILABLE, code, reason: { fr, en }, ...extra });
const REASONS = {
  NO_PROVIDER: ['Aucun service n\'est choisi pour cette fonction : rien n\'est simulé. Tapez ou collez le texte.', 'No service is selected for this function: nothing is simulated. Type or paste the text.'],
  NOT_REGISTERED: ['Le service choisi n\'est pas installé.', 'The selected service is not installed.'],
  CONSENT_MISSING: ['Vous n\'avez pas autorisé ce service.', 'You have not allowed this service.'],
  PAID_NOT_APPROVED: ['Ce service est payant : il n\'est pas autorisé.', 'This service has a recurring cost and is not approved.'],
  REGION_BLOCKED: ['Les données confidentielles ne partent pas vers un service hébergé en Chine sans votre accord.', 'Confidential data does not go to a China-hosted service without your permission.'],
  OFFLINE: ['Ce service demande une connexion et vous êtes hors ligne.', 'This service needs a connection and you are offline.'],
};
const refuse = (code) => NO(code, REASONS[code][0], REASONS[code][1]);

/** The policy, applied before anything is sent. Returns null when the call is allowed, otherwise the refusal. */
export function checkPolicy(p, settings = {}, { dataClass = 'CONFIDENTIAL' } = {}) {
  if (settings.consent?.[p.id] !== true) return refuse('CONSENT_MISSING');
  if (p.capabilities.recurringCostEur > 0 && settings.allowPaid?.[p.id] !== true) return refuse('PAID_NOT_APPROVED');
  if (p.capabilities.dataClass === 'REMOTE') {
    if (dataClass !== 'PUBLIC' && p.capabilities.region === 'CN' && settings.allowChina !== true) return refuse('REGION_BLOCKED');
    if (settings.online === false) return refuse('OFFLINE');
  }
  return null;
}

/** Emails and phone numbers never leave in confidential text (the supplier's contact details are not needed to transcribe or translate). */
export function minimizeInput(input, dataClass = 'CONFIDENTIAL') {
  if (dataClass === 'PUBLIC' || typeof input?.text !== 'string') return { ...input };
  return { ...input, text: input.text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]').replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]') };
}

/** Runs one stage with the provider the owner selected. Never throws and never invents: the answer is OK with a text, UNKNOWN, or UNAVAILABLE. */
export async function runStage(reg, kind, input, settings = {}, { dataClass = 'CONFIDENTIAL' } = {}) {
  const id = settings.selected?.[kind]; if (!id) return refuse('NO_PROVIDER');
  const p = reg.providers.get(id); if (!p || p.kind !== kind) return refuse('NOT_REGISTERED');
  const denied = checkPolicy(p, settings, { dataClass }); if (denied) return { ...denied, provider: p.id };
  let st; try { st = await p.status(); } catch { st = RESULT.UNKNOWN; }
  if (st !== RESULT.OK) return { status: STATUSES.has(st) ? st : RESULT.UNKNOWN, code: 'PROVIDER_STATUS', provider: p.id, version: p.version, reason: { fr: 'Le service n\'est pas prêt.', en: 'The service is not ready.' } };
  let r; try { r = await p.run(minimizeInput(input, dataClass), {}); } catch { return { status: RESULT.UNKNOWN, code: 'PROVIDER_ERROR', provider: p.id, version: p.version, reason: { fr: 'Le service a échoué : rien n\'est enregistré.', en: 'The service failed: nothing is recorded.' } }; }
  if (!r || !STATUSES.has(r.status)) return { status: RESULT.UNKNOWN, code: 'BAD_RESULT', provider: p.id, version: p.version, reason: { fr: 'Réponse inexploitable.', en: 'Unusable answer.' } };
  if (r.status !== RESULT.OK) return { status: r.status, code: 'PROVIDER_ANSWER', provider: p.id, version: p.version, reason: { fr: 'Le service n\'a pas pu répondre avec certitude.', en: r.reason ?? 'The service could not answer with certainty.' } };
  if (typeof r.text !== 'string' || !r.text.trim()) return { status: RESULT.UNKNOWN, code: 'EMPTY', provider: p.id, version: p.version, reason: { fr: 'Rien de lisible n\'a été obtenu.', en: 'Nothing readable was obtained.' } };
  return { status: RESULT.OK, text: r.text, lang: r.lang ?? null, segments: r.segments ?? null, confidence: r.confidence ?? null, provider: p.id, version: p.version };
}

/** The only way a provider result reaches a case: a DERIVED item (never the original), reviewed as MACHINE. `extract: true` also proposes candidate facts from it (capped, tagged, individual). */
export function deriveEvent(result, { convId, itemId, kind, extract = false }) {
  if (!result || result.status !== RESULT.OK) return null;
  return { type: 'CONVERSATION_DERIVE', convId, itemId, kind, text: result.text, lang: result.lang, provider: result.provider, version: result.version, review: 'MACHINE', extract: !!extract };
}
