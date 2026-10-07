export function assertPublicCreativeInput({
  classification,
  contains_personal_data = false,
  contains_face = false,
  reason = null,
} = {}) {
  if (classification !== 'PUBLIC') {
    throw new Error('premium challenger V0 only accepts PUBLIC data');
  }
  if (contains_personal_data || contains_face) {
    throw new Error('premium challenger V0 rejects personal data and faces');
  }
  return Object.freeze({
    classification,
    contains_personal_data: false,
    contains_face: false,
    reason,
  });
}

export function assertPublicHttpsUrl(value, field = 'url') {
  if (typeof value !== 'string' || !value) {
    throw new TypeError(`${field} is required`);
  }
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
