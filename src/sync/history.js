// Full-history readiness. Without the `read_all_orders` scope Shopify only exposes the last 60 days of orders. With it, a one-time
// backfill can import earlier orders so closed accounting periods can be complete. Nothing here adds a field to the order query:
// the same selection (no customer name/email/phone/address) is used, only the date window of the search widens.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const COVERAGE_PATH = 'data/local/sync-coverage.json';
const DAY = 86400000;
export const SIXTY_DAYS = 60;

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** The scopes the CURRENT access token really carries (never assumed from the app settings). */
export async function getGrantedScopes(config, fetchImpl = fetch) {
  const res = await fetchImpl(`https://${config.shopDomain}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  const j = await res.json();
  return String(j.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Decide whether an orders sync from `since` is allowed. A window inside the last 60 days needs nothing; anything older needs
 * read_all_orders on the live token, otherwise it is refused with an explicit reason (Shopify would silently return partial data).
 */
export function planOrdersSync({ since, now = new Date(), grantedScopes = [] }) {
  if (since == null) return { ok: true, mode: 'last_60_days', since: null, needsScope: false };
  if (!isDate(since)) return { ok: false, reason: 'SINCE_MUST_BE_YYYY_MM_DD' };
  const today = now.toISOString().slice(0, 10);
  if (since > today) return { ok: false, reason: 'SINCE_IS_IN_THE_FUTURE' };
  const older = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY > SIXTY_DAYS;
  if (!older) return { ok: true, mode: 'recent', since, needsScope: false };
  if (!grantedScopes.includes('read_all_orders')) return { ok: false, reason: 'READ_ALL_ORDERS_NOT_GRANTED', needsScope: true, message: 'Orders older than 60 days need the read_all_orders scope on the app, released and approved on the store. The current token does not carry it, so nothing was fetched.' };
  return { ok: true, mode: 'backfill', since, needsScope: true };
}

/** Search-string for an orders sync from a date (the same selection as the normal sync; only the window differs). */
export const historySearchQuery = (since) => `created_at:>=${since}`;

export async function readCoverage(path = COVERAGE_PATH) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

/** Atomic write (temp file + rename), keeping a .bak of the previous marker. */
export async function writeCoverage(cov, path = COVERAGE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) await writeFile(`${path}.bak`, await readFile(path));
  await writeFile(`${path}.tmp`, JSON.stringify(cov, null, 2));
  await rename(`${path}.tmp`, path);
}

/** Marker after a successful orders sync. `completeFrom` only ever moves EARLIER, and only for a verified backfill. */
export function nextCoverage(prev, { plan, now, storeCreatedOn = null }) {
  const completeFrom = plan.mode === 'backfill' ? (prev?.completeFrom && prev.completeFrom < plan.since ? prev.completeFrom : plan.since) : (prev?.completeFrom ?? null);
  return { completeFrom, storeCreatedOn: storeCreatedOn ?? prev?.storeCreatedOn ?? null, lastSyncedAt: now.toISOString(), note: 'completeFrom is set only by a backfill run with the read_all_orders scope and no errors.' };
}

/**
 * Does the synced retail history cover the start of a period? Yes if a verified backfill reaches back to the period start, or to the
 * day the store was created when the period begins before the store existed (no sales can exist before that).
 */
export function historyCoversPeriod(coverage, periodStart) {
  if (!coverage?.completeFrom) return false;
  const floor = coverage.storeCreatedOn && coverage.storeCreatedOn > periodStart ? coverage.storeCreatedOn : periodStart;
  return coverage.completeFrom <= floor;
}
