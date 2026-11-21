// One canonical public origin for the hosted Nordla server. Older Railway addresses are only REDIRECTED to it (GET/HEAD):
// they are never added to the allowed hosts, so their API calls and sessions are refused. No wildcard, ever.
//   SOURCING_PUBLIC_ORIGIN   the canonical https origin (its host is the only host the API accepts)
//   SOURCING_LEGACY_HOSTS    optional, comma-separated exact host names that redirect to the canonical origin

const HOST_NAME = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,63}$/;

/** Pure. Throws on a wildcard, an invalid name, or the canonical host itself. */
export function legacyHostsFrom(value, canonicalHost) {
  const list = String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const h of list) {
    if (!HOST_NAME.test(h)) throw new Error('SOURCING_LEGACY_HOSTS: each entry must be one exact host name (no wildcard, no port, no path)');
    if (h === canonicalHost) throw new Error('SOURCING_LEGACY_HOSTS must not repeat the canonical host');
  }
  return [...new Set(list)];
}

/**
 * Pure. Where a request on a legacy host goes, or null when it is not a redirect.
 * "/" goes to "/sourcing" (the Sourcing module); other paths keep their path and query, on the canonical origin.
 */
export function redirectTarget({ host, method, url, canonicalOrigin, legacyHosts }) {
  const h = String(host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (!legacyHosts || !legacyHosts.includes(h)) return null;
  if (method !== 'GET' && method !== 'HEAD') return null;
  const raw = String(url ?? '/');
  const q = raw.indexOf('?');
  let path = q >= 0 ? raw.slice(0, q) : raw;
  const search = q >= 0 ? raw.slice(q) : '';
  if (!path.startsWith('/') || path.startsWith('//')) path = '/';
  if (path === '/') path = '/sourcing';
  return `${String(canonicalOrigin).replace(/\/$/, '')}${path}${search}`;
}
