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
export function createDisabledProvider() {
  return { name: 'disabled', region: 'LOCAL', enabled: false, async describe() { return { status: 'DISABLED', suggestions: [], note: 'No AI provider configured: type the product description, or pick the category yourself.' }; }, async readLabel() { return { status: 'DISABLED', text: null }; } };
}
/** Test double with scripted answers. */
export function createFakeProvider({ describe = { suggestions: [] }, label = { text: '' }, region = 'LOCAL' } = {}) {
  const calls = [];
  return { name: 'fake', region, enabled: true, calls, async describe(p) { calls.push({ op: 'describe', p }); return { status: 'OK', ...describe }; }, async readLabel(p) { calls.push({ op: 'readLabel', p }); return { status: 'OK', ...label }; } };
}
/** Guarded call: checks the region policy, minimises, THEN calls the provider. */
export async function callProvider(provider, op, payload, { dataClass = DATA_CLASS.CONFIDENTIAL, allowChinaProviders = false } = {}) {
  assertProviderAllowed(provider, dataClass, { allowChinaProviders });
  return provider[op](minimizePayload(payload, dataClass));
}
