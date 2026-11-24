// GET /sso?t=<ticket>&to=<screen> : single sign-on from the Nordla server (src/identity/handoff.js).
// PUBLIC route (the visitor has no Growth session yet), so it is strict: one signed, short-lived, single-use ticket for THIS merchant; the session is then opened by the
// database function that re-checks membership and the Growth module and reads the CURRENT role (a person without Growth access gets NO session, hence no data).
// Every refusal is the same bare page (no reason, no data) with a link back to the plain Growth sign-in. Failures are rate limited per client address.
import { HANDOFF_DESTINATIONS } from '../../identity/handoff.js';

const PAGE = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Nordla · Développement des ventes</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">Connexion automatique impossible</h1><p>Le lien a expiré ou n’est pas valable. Revenez à Nordla et rouvrez Développement des ventes, ou <a href="/">connectez-vous ici</a>.</p></body></html>';
const HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };

/** The form body (application/x-www-form-urlencoded), at most 2 KB; anything else is an empty form (so the ticket check refuses it). */
function readForm(req) {
  return new Promise((resolve) => {
    const chunks = []; let n = 0; let big = false;
    req.on('data', (c) => { n += c.length; if (n > 2048) big = true; else chunks.push(c); });
    req.on('end', () => resolve(big ? new URLSearchParams() : new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', () => resolve(new URLSearchParams()));
  });
}

/** @param {{ verifier: { verify(t: string): { ok: boolean, userId?: string } }, openSession: (userId: string) => Promise<{ ok: boolean, token?: string }>, cookiesFor: (token: string) => string[], clientIp?: (req: any) => string, maxFailures?: number, blockMs?: number, now?: () => number }} d */
export function createGrowthSso({ verifier, openSession, cookiesFor, clientIp = (req) => String(req.socket?.remoteAddress ?? ''), maxFailures = 5, blockMs = 5 * 60_000, now = Date.now }) {
  const failures = new Map(); // ip -> { n, until }
  const refuse = (res, status) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...HEADERS }); res.end(PAGE); };
  return async function handleSso(req, res, url) {
    // POST only: the ticket travels in the request body, never in a URL (history, server logs, Referer). A GET with a ticket is refused.
    if (String(req.method ?? '').toUpperCase() !== 'POST') return refuse(res, 405);
    const form = await readForm(req);
    const ip = clientIp(req); const f = failures.get(ip) ?? { n: 0, until: 0 };
    if (f.until > now()) return refuse(res, 429);
    const fail = () => { f.n += 1; if (f.n >= maxFailures) { f.until = now() + blockMs; f.n = 0; } failures.set(ip, f); if (failures.size > 5000) failures.clear(); return refuse(res, 403); };
    const v = verifier.verify(form.get('t') ?? '');
    if (!v.ok) return fail();
    let r; try { r = await openSession(v.userId, v.authSessionId); } catch { r = { ok: false }; }
    if (!r?.ok || typeof r.token !== 'string') return fail();
    failures.delete(ip);
    const to = form.get('to') ?? 'dropoff';
    const location = Object.hasOwn(HANDOFF_DESTINATIONS, to) ? HANDOFF_DESTINATIONS[to] : HANDOFF_DESTINATIONS.dropoff; // an allow-list: never a free redirect
    res.writeHead(302, { location, 'set-cookie': cookiesFor(r.token), ...HEADERS });
    res.end();
  };
}
