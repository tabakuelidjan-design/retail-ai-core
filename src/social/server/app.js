// The owner's phone app backend (chantier E). Plain node:http, no framework, no dependency.
//
//   - every /api route needs the owner token (x-social-token), compared in constant time; too many bad guesses -> 429;
//   - every human decision runs as the OWNER actor and names the content_hash that was on screen;
//   - the publisher never starts from a request: it runs on its own timer, so the phone cannot "force" a publication;
//   - the connection view shows presence / expiry of a credential, never the credential.
//
// Nothing is deployed by this module. Binding a non-loopback host is the caller's decision (see index.js).

import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import {
  MODE, POST_STATE as S, ROLE, STATE_LABEL_FR, TIMEZONE,
} from '../constants.js';
import {
  BUCKET, brusselsParts, bucketOf, buildCalendar,
} from '../calendar.js';
import {
  autoPublishBlockers, composeCaption, isManualOnly, lintClaims, readinessProblems,
} from '../post.js';
import { brusselsToUtc } from '../calendar.js';
import { hasValidApproval } from '../workflow.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};
const OWNER_ACTOR = Object.freeze({ id: 'owner:habb', role: ROLE.OWNER });
const MODE_LABEL_FR = { [MODE.LIVE]: 'Publié sur la plateforme', [MODE.MANUAL]: 'Publié à la main (attesté)', [MODE.SIMULATION]: "SIMULÉ — rien n'a été publié" };

function sameToken(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}
const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
};
async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

/** What the phone shows for one post: the post plus everything derived (hash to name in a decision, bucket, problems, labels). */
export function describePost(post, { publishers = {}, nowMs = Date.now(), confirmed = [] } = {}) {
  const problems = readinessProblems(post, { confirmed });
  const when = post.publish_at ? brusselsParts(post.publish_at) : null;
  const publisher = publishers[post.platform];
  const alerts = [];
  if (post.publication?.remote_cancel_pending) alerts.push('REMOTE_CANCEL_PENDING');
  if (post.history.some((h) => h.detail?.alert === 'PLATFORM_SCHEDULE_MISSING') && post.state === S.SCHEDULED) alerts.push('PLATFORM_SCHEDULE_MISSING');
  if (post.state === S.PUBLICATION_UNKNOWN) alerts.push('OUTCOME_UNKNOWN');
  if (post.publication?.manual_cancel_required) alerts.push('MANUAL_CANCEL_REQUIRED');
  if (post.publication?.manual_schedule) alerts.push(post.publish_at && Date.parse(post.publish_at) < nowMs ? 'MANUAL_SCHEDULE_CHECK' : 'MANUAL_SCHEDULED');
  if (isManualOnly(post) && [S.APPROVED, S.SCHEDULED].includes(post.state)) alerts.push('MANUAL_ONLY');
  const autoBlockers = autoPublishBlockers(post);
  if (post.state === S.SCHEDULED && !publisher && !post.publication?.platform_schedule && !post.publication?.manual_schedule && !isManualOnly(post)) alerts.push('NO_CONNECTION_USE_MANUAL');
  if (post.state === S.SCHEDULED && post.publish_at && Date.parse(post.publish_at) < nowMs - 15 * 60_000) alerts.push('OVERDUE');
  return {
    ...post,
    current_hash: null, // filled by the caller (needs the service)
    bucket: bucketOf(post, { confirmed }),
    state_label: STATE_LABEL_FR[post.state],
    mode_label: post.publication?.mode ? MODE_LABEL_FR[post.publication.mode] : null,
    when_brussels: when,
    problems,
    claim_findings: lintClaims(post, { confirmed }),
    approval_valid: hasValidApproval(post),
    alerts,
    auto_blockers: autoBlockers,
    full_caption: composeCaption(post),
    connected: Boolean(publisher),
    publisher_mode: publisher?.mode ?? null,
  };
}

export function createSocialApp({
  token, service, publisher = null, publishers = {}, assets = null, credentialPort = null, uiDir, now = () => new Date(), connections = null,
}) {
  if (!token || String(token).length < 24) throw new Error('a token of at least 24 characters is required');
  const failures = new Map();
  const tooMany = (ip) => { const f = (failures.get(ip) ?? []).filter((t) => Date.now() - t < 60_000); failures.set(ip, f); return f.length >= 10; };
  const noteFailure = (ip) => { failures.get(ip)?.push(Date.now()); };

  const withHash = async (post) => ({ ...describePost(post, { publishers, nowMs: now().getTime(), confirmed: service.confirmedFacts }), current_hash: service.contentHashOf(post) });

  async function state() {
    const posts = await service.list();
    const described = await Promise.all(posts.map(withHash));
    const from = brusselsParts(now().toISOString()).date;
    const calendar = buildCalendar({ posts, from, days: 14, confirmed: service.confirmedFacts });
    const counts = Object.fromEntries(Object.values(BUCKET).map((b) => [b, calendar.buckets[b].length]));
    return {
      now: now().toISOString(), timezone: TIMEZONE, posts: described, calendar, counts,
      connections: connections ? await connections() : [],
    };
  }

  function exportPack(post) {
    const when = post.publish_at ? brusselsParts(post.publish_at) : null;
    return {
      post_id: post.id, platform: post.platform, format: post.format, state: post.state, approved: hasValidApproval(post),
      caption_full: composeCaption(post), when_brussels: when, assets: (post.assets ?? (post.asset ? [post.asset] : [])).map((a) => ({ ref: a.ref, version: a.version, sha256: a.sha256, content_type: a.content_type, alt_text: a.alt_text ?? null, download: `/api/asset?ref=${encodeURIComponent(a.ref)}&v=${a.version}&sha=${a.sha256}` })),
      steps_fr: post.platform === 'facebook'
        ? ['Ouvrez Meta Business Suite (ou l\'app Facebook Pages).', 'Créer une publication → ajoutez la photo téléchargée.', 'Collez le texte ci-dessus tel quel (ne le modifiez pas).', 'Choisissez « Programmer » avec la date et l\'heure indiquées (heure de Belgique), puis confirmez.', 'Revenez dans Nordla : « J\'ai publié à la main » et collez le lien.']
        : ['Ouvrez Meta Business Suite (ou l\'app Instagram → Créer → Publication).', 'Ajoutez la photo téléchargée.', 'Collez le texte ci-dessus tel quel (ne le modifiez pas).', 'Programmez à la date et l\'heure indiquées (heure de Belgique) ou publiez, puis confirmez.', 'Revenez dans Nordla : « J\'ai publié à la main » et collez le lien.'],
    };
  }

  async function api(req, res, url) {
    const m = url.pathname.match(/^\/api\/posts\/(post_[A-Za-z0-9-]+)(?:\/(act|edit|export))?$/);
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await state());
    if (req.method === 'GET' && url.pathname === '/api/audit') return json(res, 200, { events: (await service.audit()).slice(-300) });
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (!publisher) return json(res, 200, { ran: false, reason: 'NO_PUBLISHER' });
      return json(res, 200, { ran: true, ...(await publisher.runDue()) });
    }
    if (req.method === 'POST' && url.pathname === '/api/connections/check') { // a LIVE read of each connected account, on demand
      const out = [];
      for (const [platform, p] of Object.entries(publishers)) {
        try { out.push({ platform, mode: p.mode, ...(await p.verifyConnection()) }); } catch (e) { out.push({ platform, mode: p.mode, ok: false, reason: p.normalizeError(e).code }); }
      }
      return json(res, 200, { checked_at: now().toISOString(), results: out });
    }
    if (req.method === 'GET' && url.pathname === '/api/asset') {
      if (!assets) return json(res, 404, { error: 'NO_ASSET_LIBRARY' });
      const found = await assets.read({ ref: url.searchParams.get('ref'), version: Number(url.searchParams.get('v')), sha256: url.searchParams.get('sha') || undefined }).catch((e) => ({ error: e.message }));
      if (!found || found.error) return json(res, found?.error ? 409 : 404, { error: found?.error ?? 'ASSET_NOT_FOUND' });
      res.writeHead(200, { 'Content-Type': found.content_type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      return res.end(found.bytes);
    }
    if (m) {
      const [, id, sub] = m;
      const post = await service.get(id);
      if (!post) return json(res, 404, { error: 'SOCIAL_NOT_FOUND' });
      if (req.method === 'GET' && !sub) return json(res, 200, await withHash(post));
      if (req.method === 'GET' && sub === 'export') return json(res, 200, exportPack(post));
      if (req.method === 'POST' && sub === 'act') {
        const body = await readBody(req);
        return json(res, 200, await withHash(await service.act(id, String(body.action), OWNER_ACTOR, body.params ?? {})));
      }
      if (req.method === 'POST' && sub === 'edit') {
        const body = await readBody(req);
        const patch = { ...(body.patch ?? {}) };
        if (patch.publish_local) { // the phone speaks Brussels wall-clock time; storage is UTC
          try { patch.publish_at = brusselsToUtc(patch.publish_local.date, patch.publish_local.time); } catch (e) { return json(res, 422, { error: 'SOCIAL_INVALID', message: e.message }); }
          delete patch.publish_local;
        }
        return json(res, 200, await withHash(await service.editPost(id, patch, OWNER_ACTOR)));
      }
    }
    return json(res, 404, { error: 'NOT_FOUND' });
  }

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^([/\\])+/, '');
    if (rel.includes('..')) return json(res, 400, { error: 'BAD_PATH' });
    try {
      const body = await readFile(join(uiDir, rel));
      res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      return res.end(body);
    } catch { return json(res, 404, { error: 'NOT_FOUND' }); }
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (tooMany(ip)) return json(res, 429, { error: 'TOO_MANY_ATTEMPTS' });
        if (!sameToken(req.headers['x-social-token'], token)) { noteFailure(ip); return json(res, 401, { error: 'UNAUTHORIZED' }); }
        return await api(req, res, url);
      }
      return await serveStatic(res, url.pathname);
    } catch (error) {
      const status = error.status ?? ({ SOCIAL_NOT_FOUND: 404, SOCIAL_FORBIDDEN: 403, SOCIAL_STALE_VERSION: 409, SOCIAL_TRANSITION_REFUSED: 409, SOCIAL_CONFLICT: 409 }[error.code] ?? (error.name === 'SocialError' ? 422 : 500));
      return json(res, status, { error: error.code ?? 'INTERNAL', message: error.name === 'SocialError' || error.status ? error.message : 'internal error', detail: error.detail });
    }
  }

  return { handler, state, exportPack };
}
