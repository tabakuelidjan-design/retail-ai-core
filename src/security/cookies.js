// Nordla HTTP security (Core C4) - session and CSRF cookies: build, read, clear. Nothing here sends a response.
//
// Hosted (production / staging), one pair per module so services never overwrite each other:
//   __Host-nordla_<module>_sid    HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age <= 12 h; no Domain
//   __Host-nordla_<module>_csrf             Secure; SameSite=Lax; Path=/; Max-Age <= 12 h; no Domain   (readable by the page script)
// Local (loopback http only): nordla_dev_<module>_sid / nordla_dev_<module>_csrf, same attributes WITHOUT Secure - and therefore
// without the __Host- prefix, which browsers only accept with Secure. The local mode cannot be enabled hosted (config.js).
// Clearing repeats the exact same name, Path and flags with an empty value, Max-Age=0 and an expiry in 1970.

const VALUE = /^[A-Za-z0-9_-]{16,128}$/; // opaque base64url values only (session token, CSRF token)

export class CookieError extends Error {
  constructor(code) { super(code); this.name = 'CookieError'; this.code = code; }
}

/** The two cookie names of a module in a mode. */
export function cookieNames(moduleCode, secure) {
  return Object.freeze(secure
    ? { session: `__Host-nordla_${moduleCode}_sid`, csrf: `__Host-nordla_${moduleCode}_csrf` }
    : { session: `nordla_dev_${moduleCode}_sid`, csrf: `nordla_dev_${moduleCode}_csrf` });
}

/**
 * @param {{ moduleCode: string, secure: boolean, maxAgeSeconds: number }} cfg
 */
export function createCookieJar({ moduleCode, secure, maxAgeSeconds }) {
  const names = cookieNames(moduleCode, secure);
  const flags = (httpOnly) => [httpOnly ? 'HttpOnly' : null, secure ? 'Secure' : null, 'SameSite=Lax', 'Path=/'].filter(Boolean).join('; ');
  const build = (name, value, httpOnly) => {
    if (typeof value !== 'string' || !VALUE.test(value)) throw new CookieError('COOKIE_VALUE_INVALID');
    return `${name}=${value}; ${flags(httpOnly)}; Max-Age=${maxAgeSeconds}`;
  };
  const clear = (name, httpOnly) => `${name}=; ${flags(httpOnly)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

  /**
   * Reads this module's two cookies from a Cookie header. A cookie present twice (ambiguous) or with a malformed value counts as
   * absent. Other cookies are ignored.
   * @returns {{ session: string|null, csrf: string|null }}
   */
  function read(cookieHeader) {
    const found = { [names.session]: [], [names.csrf]: [] };
    for (const part of String(cookieHeader ?? '').split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim();
      if (k in found) found[k].push(v);
    }
    const one = (list) => (list.length === 1 && VALUE.test(list[0]) ? list[0] : null);
    return { session: one(found[names.session]), csrf: one(found[names.csrf]) };
  }

  return Object.freeze({
    names,
    sessionCookie: (token) => build(names.session, token, true),
    csrfCookie: (csrfToken) => build(names.csrf, csrfToken, false),
    clearSessionCookie: () => clear(names.session, true),
    clearCsrfCookie: () => clear(names.csrf, false),
    read,
  });
}
