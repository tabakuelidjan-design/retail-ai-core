// AI provider boundary. AI may only SUGGEST: recognise a product, read a label, extract document fields, summarise, translate. It is never authoritative for law,
// tariffs, fees, arithmetic, compliance status or the verdict (those are deterministic modules). Default = DISABLED: the whole workflow works without AI.
// Privacy: data is classified before it leaves; CONFIDENTIAL / PERSONAL data never goes to a provider whose region is 'CN' unless the owner explicitly allows it.
export const DATA_CLASS = Object.freeze({ PUBLIC: 'PUBLIC', CONFIDENTIAL: 'CONFIDENTIAL', PERSONAL: 'PERSONAL' });
export class ProviderPolicyError extends Error { constructor(code, msg) { super(msg ?? code); this.code = code; } }

/** Strips what a provider does not need. Supplier identity, prices, contacts and quotes are never part of a recognition request. */
export function minimizePayload(payload, dataClass = DATA_CLASS.CONFIDENTIAL) {
  const out = { text: payload.text ?? null, imageBase64: payload.imageBase64 ?? null, imageMime: payload.imageMime ?? null, task: payload.task ?? null, language: payload.language ?? null };
  if (dataClass !== DATA_CLASS.PUBLIC && out.text) out.text = out.text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]').replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]');
  return out;
}
export function assertProviderAllowed(provider, dataClass, { allowChinaProviders = false } = {}) {
  if (provider.region === 'CN' && dataClass !== DATA_CLASS.PUBLIC && !allowChinaProviders) throw new ProviderPolicyError('PROVIDER_REGION_BLOCKED', `provider ${provider.name} is hosted in China: ${dataClass} data is not sent unless the owner explicitly allows it`);
  return true;
}
import { CATEGORY_IDS } from '../core/taxonomy.js';

/**
 * Replaceable vision provider over the Anthropic Messages API (region 'US'). It is a SUGGESTION engine only:
 *  - describe(): a product photo -> up to 3 category suggestions, validated against Nordla's own category list (anything else is dropped); level is always AI_SUGGESTED
 *  - readDocument(): a photographed paper document -> its text (OCR by a vision model); the result is UNVERIFIED until the owner confirms it
 * Only the (already downscaled) image is sent: no supplier name, price, contact or case data. Needs an API key; never used unless configured AND the caller passed the owner's consent.
 * NOT exercised against the live API in this repository's tests (no key there): the tests use a mock fetch.
 */
export function createVisionProvider({ apiKey, model = 'claude-haiku-4-5-20251001', fetchImpl = (...a) => fetch(...a), region = 'US', name = 'anthropic-vision' } = {}) {
  if (!apiKey) throw new Error('an API key is required for the vision provider');
  const ask = async ({ imageBase64, imageMime }, prompt, maxTokens) => {
    const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: imageMime || 'image/jpeg', data: imageBase64 } }, { type: 'text', text: prompt }] }] };
    const r = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`vision provider HTTP ${r.status}`);
    const j = await r.json(); return (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(String.fromCharCode(10));
  };
  return {
    name, region, enabled: true,
    async describe(p) {
      if (!p.imageBase64) return { status: 'NO_IMAGE', suggestions: [] };
      try {
        const txt = await ask(p, `Identify the consumer product in this photo. Answer ONLY with JSON: {"suggestions":[{"categoryId":"<one of ${CATEGORY_IDS.join(', ')}>","confidence":"LOW|MEDIUM|HIGH","why":"<max 15 words>"}]} with at most 3 entries. If you cannot tell, return {"suggestions":[]}. Do not invent brands or models.`, 300);
        const m = /\{[\s\S]*\}/.exec(txt); const j = m ? JSON.parse(m[0]) : { suggestions: [] };
        const suggestions = (j.suggestions ?? []).filter((x) => CATEGORY_IDS.includes(x.categoryId)).slice(0, 3).map((x) => ({ categoryId: x.categoryId, confidence: ['LOW', 'MEDIUM', 'HIGH'].includes(x.confidence) ? x.confidence : 'LOW', why: String(x.why ?? '').slice(0, 120), level: 'AI_SUGGESTED' }));
        return { status: 'OK', suggestions, provider: name };
      } catch (e) { return { status: 'ERROR', suggestions: [], error: String(e.message ?? e) }; }
    },
    async readDocument(p) {
      if (!p.imageBase64) return { status: 'NO_IMAGE', text: null };
      try { const text = await ask(p, 'Transcribe ALL the text visible in this photographed document exactly as written, line by line, keeping model numbers, standard numbers, dates and names unchanged. Mark any unreadable part as [unreadable]. Do not summarise, correct or add anything.', 2000); return { status: 'OK', text, provider: name }; }
      catch (e) { return { status: 'ERROR', text: null, error: String(e.message ?? e) }; }
    },
    async readLabel(p) { return this.readDocument(p); },
  };
}

export function createDisabledProvider() {
  return { name: 'disabled', region: 'LOCAL', enabled: false, async describe() { return { status: 'DISABLED', suggestions: [], note: 'No AI provider configured: type the product description, or pick the category yourself.' }; }, async readLabel() { return { status: 'DISABLED', text: null }; }, async readDocument() { return { status: 'DISABLED', text: null }; } };
}
/** Test double with scripted answers. */
export function createFakeProvider({ describe = { suggestions: [] }, label = { text: '' }, region = 'LOCAL' } = {}) {
  const calls = [];
  return { name: 'fake', region, enabled: true, calls, async describe(p) { calls.push({ op: 'describe', p }); return { status: 'OK', ...describe }; }, async readLabel(p) { calls.push({ op: 'readLabel', p }); return { status: 'OK', ...label }; }, async readDocument(p) { calls.push({ op: 'readDocument', p }); return { status: 'OK', ...label }; } };
}
/** Guarded call: checks the region policy, minimises, THEN calls the provider. */
export async function callProvider(provider, op, payload, { dataClass = DATA_CLASS.CONFIDENTIAL, allowChinaProviders = false } = {}) {
  assertProviderAllowed(provider, dataClass, { allowChinaProviders });
  return provider[op](minimizePayload(payload, dataClass));
}
