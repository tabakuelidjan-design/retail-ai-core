// Minimum shared Business Profile (Analyses Phase 0). One place decides the merchant's time zone and the few facts the metric layer needs.
//
// FAIL CLOSED: there is NO default time zone. A missing zone is an error (TIMEZONE_NOT_CONFIGURED), an invalid one is an error (TIMEZONE_INVALID).
// Sources, in order: the merchant_profile row (Core, validated by the database), then the MERCHANT_TIMEZONE environment variable as an EXPLICIT fallback
// that is reported (`timezoneSource: 'env'`). Nothing is ever assumed.
//
// Not the Finance seller legal profile, not AI memory.

export class ProfileError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'ProfileError'; this.code = code; }
}

/** An IANA zone name (Europe/Brussels) or UTC. Abbreviations (EST), POSIX strings (UTC+1) and unknown names are refused. */
const validZones = new Set(['UTC']); // zones already proven valid (validation builds a formatter: done once per zone)
export function isIanaTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim() || tz !== tz.trim()) return false;
  if (validZones.has(tz)) return true;
  if (!tz.includes('/')) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { return false; }
  validZones.add(tz);
  return true;
}

/** @returns {string} the zone, or throws ProfileError. `who` names the caller in the message. */
export function requireTimeZone(tz, who = '') {
  if (tz === undefined || tz === null || (typeof tz === 'string' && tz.trim() === '')) {
    throw new ProfileError('TIMEZONE_NOT_CONFIGURED', `${who ? `${who}: ` : ''}no merchant time zone is configured (merchant_profile.timezone or MERCHANT_TIMEZONE); refusing to assume UTC`);
  }
  if (!isIanaTimeZone(tz)) throw new ProfileError('TIMEZONE_INVALID', `${who ? `${who}: ` : ''}"${tz}" is not an IANA time zone name`);
  return tz;
}

/** The merchant_profile row of THIS merchant, or null. A deployment where the table does not exist yet reads as "no profile" (the environment fallback then applies explicitly). */
export async function loadMerchantProfile(supabase, merchantId) {
  let rows;
  try {
    rows = await supabase.select('merchant_profile', { select: 'merchant_id,timezone,currency,country,excluded_order_statuses,online_channel_handles,pos_channel_handles,channel_aliases,fiscal_year_start_month', merchant_id: `eq.${merchantId}`, limit: '1' });
  } catch (e) {
    if (/merchant_profile/.test(String(e.message)) && /(404|PGRST205|42P01|does not exist|schema cache)/.test(String(e.message))) return null;
    throw e;
  }
  return rows[0] && rows[0].merchant_id === merchantId ? rows[0] : null;
}

/**
 * The profile the metric layer runs with. Throws ProfileError when the time zone cannot be established.
 * @returns {{ merchantId: string, timezone: string, timezoneSource: 'profile'|'env', currency: string|null, country: string|null, excludedOrderStatuses: string[]|null,
 *             onlineChannelHandles: string[]|null, posChannelHandles: string[]|null, channelAliases: object, fiscalYearStartMonth: number, hasProfileRow: boolean }}
 */
export async function resolveBusinessProfile({ supabase, merchantId, env = process.env }) {
  const row = supabase ? await loadMerchantProfile(supabase, merchantId) : null;
  const fromRow = row?.timezone ?? null;
  const timezone = requireTimeZone(fromRow ?? env.MERCHANT_TIMEZONE, 'business profile');
  return {
    merchantId, timezone, timezoneSource: fromRow ? 'profile' : 'env',
    currency: row?.currency ?? null, country: row?.country ?? null,
    excludedOrderStatuses: row?.excluded_order_statuses ?? null,
    onlineChannelHandles: row?.online_channel_handles ?? null, posChannelHandles: row?.pos_channel_handles ?? null,
    channelAliases: row?.channel_aliases ?? {}, fiscalYearStartMonth: row?.fiscal_year_start_month ?? 1, hasProfileRow: !!row,
  };
}

/** The metric config with the profile's explicit choices applied (statuses, channel handles). Returns a new object. */
export function applyProfileToConfig(config, profile) {
  const next = { ...config, marketing: { ...config.marketing } };
  if (profile?.excludedOrderStatuses) next.excludedOrderStatuses = [...profile.excludedOrderStatuses];
  if (profile?.onlineChannelHandles) next.marketing.onlineChannelHandles = [...profile.onlineChannelHandles];
  if (profile?.posChannelHandles) next.marketing.posChannelHandles = [...profile.posChannelHandles];
  return next;
}
