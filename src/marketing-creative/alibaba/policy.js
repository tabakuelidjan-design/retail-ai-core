export const DATA_CLASS = Object.freeze({
  PUBLIC: 'PUBLIC',
  EU_CLOUD: 'EU_CLOUD',
  LOCAL_ONLY: 'LOCAL_ONLY',
});

export function normalizeExternalDataPolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('dataPolicy is required');
  }
  if (!Object.values(DATA_CLASS).includes(input.classification)) {
    throw new Error('Unsupported data classification');
  }
  return Object.freeze({
    classification: input.classification,
    contains_personal_data: input.contains_personal_data === true,
    contains_face: input.contains_face === true,
    consent_ref: input.consent_ref ?? null,
    reason: input.reason ?? null,
  });
}

export function assertAlibabaExternalUse(input) {
  const policy = normalizeExternalDataPolicy(input);
  if (policy.classification !== DATA_CLASS.PUBLIC) {
    throw new Error('Alibaba V0 only accepts PUBLIC data');
  }
  if (policy.contains_personal_data || policy.contains_face) {
    throw new Error('Alibaba V0 rejects personal data and faces');
  }
  return policy;
}

export function assertHttpsPublicUrl(value, field = 'url') {
  if (typeof value !== 'string' || !value) throw new TypeError(`${field} is required`);

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${field} must be a valid URL`);
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${field} must be a credential-free HTTPS URL`);
  }

  return url.toString();
}
