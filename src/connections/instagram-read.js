// Settings -> Connections: the READ of one connected Instagram account (profile + the figures of the most recent publication), and the secret-free snapshot kept with the connector.
//
// The snapshot is stored in merchant_connectors.config.last_read (non secret: counts, a permalink, a caption cut to 80 characters, the date) so that the page can say WHEN Nordla really read data:
//   last_read_ok_at   the last time the profile was actually read (the proof that data came back)
//   last_read         the last ATTEMPT: { at, outcome: OK | PARTIAL | FAILED, problem?, profile?, publication? } (no profile when the whole read could not happen)
//   last_read_ok      the last snapshot in which the profile was actually read: a later failure NEVER erases what was last read
// Reading changes nothing at Instagram. The reader's token comes from the Provider Token Manager; this file never sees it.
import { PC_ERROR as E, ProvisioningError } from '../provider-connections/constants.js';

export const READ_OUTCOME = Object.freeze({ OK: 'OK', PARTIAL: 'PARTIAL', FAILED: 'FAILED' });
const FIGURES = new Set(['VALUE', 'ZERO', 'UNAVAILABLE', 'PERMISSION_MISSING']);
const WHOLE_READ_FAILURES = new Set(['TOKEN_REJECTED', 'RATE_LIMITED', 'SOURCE_UNREACHABLE']);

const outcomeOf = (r) => {
  const stats = r.publication?.item?.stats ?? [];
  const missing = r.profile.state === 'PERMISSION_MISSING' || r.publication.state === 'PERMISSION_MISSING' || stats.some((s) => s.state === 'PERMISSION_MISSING');
  const failed = r.profile.state === 'ERROR' || r.publication.state === 'ERROR';
  if (r.profile.state === 'OK' && !missing && !failed) return READ_OUTCOME.OK;
  return r.profile.state === 'OK' || r.publication.state === 'OK' ? READ_OUTCOME.PARTIAL : READ_OUTCOME.FAILED;
};

/** What the page may show of a stored snapshot: an allowlist, anything unexpected is dropped. */
export function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fig = (f) => (f && FIGURES.has(f.state) ? { name: String(f.name ?? ''), label: String(f.label ?? ''), state: f.state, value: Number.isFinite(f.value) ? f.value : null, permission: f.permission ?? null, reason: f.reason ?? null } : null);
  const p = raw.profile ?? {}; const d = p.data;
  const item = raw.publication?.item;
  return {
    at: typeof raw.at === 'string' ? raw.at : null, outcome: READ_OUTCOME[raw.outcome] ?? null, problem: typeof raw.problem === 'string' ? raw.problem : null,
    profile: !raw.profile ? null : { state: String(p.state ?? 'ERROR'), permission: p.permission ?? null, problem: p.problem ?? null, data: d ? { username: d.username ?? null, name: d.name ?? null, accountType: d.accountType ?? null, followers: fig(d.followers), follows: fig(d.follows), mediaCount: fig(d.mediaCount) } : null },
    publication: !raw.publication ? null : { state: String(raw.publication?.state ?? 'ERROR'), permission: raw.publication?.permission ?? null, problem: raw.publication?.problem ?? null,
      item: item ? { type: item.type ?? null, postedAt: item.postedAt ?? null, permalink: typeof item.permalink === 'string' && /^https:\/\//.test(item.permalink) ? item.permalink : null, caption: item.caption ?? null, stats: (item.stats ?? []).map(fig).filter(Boolean) } : null },
  };
}

/** @param {{ readerFor: (o: { merchantId, connectorId, grantedScopes }) => { read: () => Promise<object> }, connectorRepository: object, now?: () => Date }} deps */
export function createInstagramReadService({ readerFor, connectorRepository, now = () => new Date() }) {
  async function persist(stored, merchantId, snapshot, okAt) {
    const config = { ...stored.config, last_read: snapshot, ...(okAt ? { last_read_ok_at: okAt, last_read_ok: snapshot } : {}) };
    await connectorRepository.update({ merchantId, connectorId: stored.id, status: stored.status, config });
  }
  return Object.freeze({
    /** Reads now. A permission or a figure that is missing is part of the ANSWER (states); a refused token, a rate limit or an unreachable Instagram is thrown after the failed attempt is recorded. */
    async read({ tenant, connectorId }) {
      const merchantId = tenant.merchantId;
      const stored = (await connectorRepository.listForMerchant(merchantId)).find((c) => c.id === connectorId && c.kind === 'instagram');
      if (!stored) throw new ProvisioningError(E.CONNECTOR_NOT_FOUND, 'unknown Instagram connection for this merchant');
      if (stored.status !== 'CONFIGURED') throw Object.assign(new Error('NOT_CONNECTED'), { code: 'NOT_CONNECTED' });
      const granted = Array.isArray(stored.config?.granted_scopes) && stored.config.granted_scopes.length ? stored.config.granted_scopes : null;
      const at = now().toISOString();
      let result;
      try { result = await readerFor({ merchantId, connectorId: stored.id, grantedScopes: granted }).read(); }
      catch (error) {
        const problem = WHOLE_READ_FAILURES.has(error?.code) ? error.code : (error instanceof ProvisioningError ? error.code : 'READ_FAILED');
        await persist(stored, merchantId, { at, outcome: READ_OUTCOME.FAILED, problem }, null);
        throw error;
      }
      const outcome = outcomeOf(result);
      const snapshot = { at: result.fetchedAt ?? at, outcome, profile: result.profile, publication: result.publication };
      await persist(stored, merchantId, snapshot, result.profile.state === 'OK' ? snapshot.at : null);
      return sanitizeSnapshot(snapshot);
    },
  });
}
