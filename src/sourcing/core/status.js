// What the header may say. TWO independent facts, never mixed (the physical-phone defect was one badge saying "OFFLINE - VERIFY" while the authenticated health check had
// succeeded through the tunnel, because the badge really described the Safety Gate copy):
//   1. SERVER: is your Nordla server VERIFIED right now? Only an AUTHENTICATED live check that succeeded recently counts (a 200 from /api/health needs the token).
//   2. SAFETY GATE: what copy does THIS PHONE hold, and how fresh is it? LIVE needs BOTH a verified server NOW and a copy downloaded live less than 24 h ago;
//      otherwise it is CACHED; none is NONE. Nothing is ever called LIVE on any other basis, and a missing / refused token fails closed.
export const SERVER_VERIFY_MAX_AGE_MS = 90_000; // the app re-checks every 30 s; a check older than this no longer counts
export const SAFETY_LIVE_MAX_AGE_MS = 24 * 3600 * 1000;

/** @returns {{ state: 'VERIFIED'|'UNREACHABLE'|'TOKEN_REFUSED'|'LOCKED_OUT'|'NOT_SIGNED_IN'|'PHONE_ONLY', label: string, tone: 'ok'|'warn'|'bad' }} */
export function serverState({ hasToken = false, offlineChoice = false, authFailed = false, lockedOut = false, verifiedAt = 0, now = Date.now() } = {}) {
  if (!hasToken) return offlineChoice ? { state: 'PHONE_ONLY', label: 'PHONE ONLY', tone: 'warn' } : { state: 'NOT_SIGNED_IN', label: 'NOT SIGNED IN', tone: 'bad' };
  if (lockedOut) return { state: 'LOCKED_OUT', label: 'TOO MANY ATTEMPTS', tone: 'bad' };
  if (authFailed) return { state: 'TOKEN_REFUSED', label: 'TOKEN REFUSED', tone: 'bad' };
  if (verifiedAt > 0 && now - verifiedAt <= SERVER_VERIFY_MAX_AGE_MS) return { state: 'VERIFIED', label: 'SERVER VERIFIED', tone: 'ok' };
  return { state: 'UNREACHABLE', label: 'NO SERVER', tone: 'warn' };
}

/** @param {{ serverVerified: boolean, copy: { present: boolean, fetchedAt?: number, serverMode?: string }|null, now?: number }} a */
export function safetyState({ serverVerified, copy, now = Date.now() }) {
  if (!copy?.present) return { state: 'NONE', label: 'SAFETY GATE: NONE ON THIS PHONE', tone: 'bad', action: serverVerified ? 'DOWNLOAD' : 'NEEDS_SERVER' };
  const ageHours = copy.fetchedAt ? Math.floor((now - copy.fetchedAt) / 3600e3) : null;
  const fresh = copy.fetchedAt != null && now - copy.fetchedAt < SAFETY_LIVE_MAX_AGE_MS;
  if (serverVerified && fresh && copy.serverMode === 'LIVE_VERIFIED') return { state: 'LIVE', label: 'SAFETY GATE LIVE', tone: 'ok', action: null, ageHours };
  return { state: 'CACHED', label: `SAFETY GATE CACHED${ageHours != null ? ` (${ageHours} h old)` : ''}`, tone: 'warn', action: serverVerified ? 'DOWNLOAD' : 'NEEDS_SERVER', ageHours };
}

export function headerStatus({ hasToken, offlineChoice, authFailed, lockedOut, verifiedAt, copy, now = Date.now() }) {
  const server = serverState({ hasToken, offlineChoice, authFailed, lockedOut, verifiedAt, now });
  return { server, safety: safetyState({ serverVerified: server.state === 'VERIFIED', copy, now }) };
}
