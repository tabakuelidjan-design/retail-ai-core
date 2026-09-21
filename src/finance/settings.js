// Merchant-local finance settings: validated, sanitised, saved atomically (with a .bak of the previous file).
// The file lives in data/local/finance/ (gitignored). It holds business details only: NO secrets (the dashboard token and any
// provider credentials live in environment variables, never here and never in what the browser receives).

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeBelgianNumber } from './company.js';
import { percentToBp } from './money.js';

export const SETTINGS_PATH = 'data/local/finance/merchant.json';
export const LOGO_DIR = 'data/local/finance';

export const DEFAULT_SETTINGS = {
  seller: { name: null, vatNumber: null, enterpriseNumber: null, iban: null, bic: null, email: null, phone: null, address: { street: null, postalCode: null, city: null, countryCode: 'BE' } },
  vat: { allowedRatesBp: [] },
  defaults: { currency: 'EUR', language: 'fr', paymentTermsDays: 30, paymentTerms: null },
  numbering: { invoice: { prefix: 'INV', pad: 4 }, credit_note: { prefix: 'CN', pad: 4 }, quote: { prefix: 'QT', pad: 4 }, format: '{prefix}-{year}-{seq}' },
  branding: { logoPath: null, footer: null, accent: '#183247', structuredCommunication: true, paymentInstructions: null },
  companyLookup: { provider: 'vies' }, // VAT-number lookup: 'vies' | 'manual'
  stock: { mode: 'off', locationId: null }, // stock synchronisation of standalone B2B sales: 'off' | 'dry_run' | 'live'
  companySearch: { registry: 'cbeapi', provider: 'peppol_directory' }, // registry (primary): 'cbeapi' | 'none'; provider (secondary name search): 'peppol_directory' | 'none'
  peppol: { defaultBuyerReference: 'document_number' },
  linking: { dupWindowDays: 3, toleranceCents: 1 },
  dashboard: { dueSoonDays: 7 },
};

const LANGS = ['fr', 'nl', 'en'];
const PROVIDERS = ['manual', 'vies'];
const SEARCH_PROVIDERS = ['peppol_directory', 'none'];
const REGISTRY_PROVIDERS = ['cbeapi', 'none'];
const PLACEHOLDERS = ['{prefix}', '{year}', '{seq}'];

/** Remove control characters, collapse nothing else, cap the length. Free text is also escaped at render time and by the PDF library. */
export function sanitizeText(v, max = 200) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  return s === '' ? null : s.slice(0, max);
}

export function isValidIban(input) {
  const s = String(input ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  return BigInt(digits) % 97n === 1n;
}
const isEmail = (s) => /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,}$/.test(s);

const merge = (base, over) => {
  if (Array.isArray(base) || base === null || typeof base !== 'object') return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(base)) out[k] = over && k in over && over[k] !== undefined ? merge(base[k], over[k]) : base[k];
  return out;
};

/**
 * Validate and normalise a settings payload from the UI. Unknown keys are dropped (no mass assignment). Returns the CLEAN settings
 * and a list of field errors; the caller must refuse to save when there are errors.
 */
export function validateSettings(input, current = DEFAULT_SETTINGS) {
  const errors = [];
  const err = (field, code) => errors.push({ field, code });
  const src = input && typeof input === 'object' ? input : {};
  const out = merge(DEFAULT_SETTINGS, current);

  if (src.seller) {
    const s = src.seller;
    const o = out.seller;
    if ('name' in s) { o.name = sanitizeText(s.name, 120); if (!o.name) err('seller.name', 'REQUIRED'); }
    if ('email' in s) { o.email = sanitizeText(s.email, 200); if (o.email && !isEmail(o.email)) err('seller.email', 'EMAIL_INVALID'); }
    if ('phone' in s) o.phone = sanitizeText(s.phone, 40);
    if ('iban' in s) { o.iban = sanitizeText(s.iban, 40)?.toUpperCase().replace(/\s+/g, ' ') ?? null; if (o.iban && !isValidIban(o.iban)) err('seller.iban', 'IBAN_INVALID'); }
    if ('bic' in s) { o.bic = sanitizeText(s.bic, 11)?.toUpperCase() ?? null; if (o.bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(o.bic)) err('seller.bic', 'BIC_INVALID'); }
    if (s.address) {
      for (const k of ['street', 'postalCode', 'city']) if (k in s.address) o.address[k] = sanitizeText(s.address[k], 120);
      if ('countryCode' in s.address) { o.address.countryCode = sanitizeText(s.address.countryCode, 2)?.toUpperCase() ?? null; if (!/^[A-Z]{2}$/.test(o.address.countryCode ?? '')) err('seller.address.countryCode', 'COUNTRY_CODE_INVALID'); }
    }
    for (const k of ['vatNumber', 'enterpriseNumber']) {
      if (!(k in s)) continue;
      const raw = sanitizeText(s[k], 30);
      if (!raw) { o[k] = null; continue; }
      const n = normalizeBelgianNumber(raw);
      if (o.address.countryCode === 'BE' || raw.toUpperCase().startsWith('BE') || k === 'enterpriseNumber') {
        if (!n.ok) err(`seller.${k}`, `BELGIAN_NUMBER_${n.reason}`); else o[k] = k === 'vatNumber' ? n.vatNumber : n.enterpriseNumber;
      } else o[k] = raw.toUpperCase();
    }
  }
  if (src.vat && 'allowedRatesPercent' in src.vat) {
    const bps = [];
    for (const r of Array.isArray(src.vat.allowedRatesPercent) ? src.vat.allowedRatesPercent : []) { const bp = percentToBp(r); if (bp === null || bp < 0 || bp > 10000) err('vat.allowedRatesPercent', 'RATE_INVALID'); else bps.push(bp); }
    out.vat.allowedRatesBp = [...new Set(bps)].sort((a, b) => b - a);
  } else if (src.vat && 'allowedRatesBp' in src.vat) {
    if (!Array.isArray(src.vat.allowedRatesBp) || !src.vat.allowedRatesBp.every((b) => Number.isInteger(b) && b >= 0 && b <= 10000)) err('vat.allowedRatesBp', 'RATE_INVALID'); else out.vat.allowedRatesBp = [...new Set(src.vat.allowedRatesBp)].sort((a, b) => b - a);
  }
  if (src.defaults) {
    const d = src.defaults;
    if ('currency' in d) { out.defaults.currency = sanitizeText(d.currency, 3)?.toUpperCase() ?? null; if (!/^[A-Z]{3}$/.test(out.defaults.currency ?? '')) err('defaults.currency', 'CURRENCY_INVALID'); }
    if ('language' in d) { out.defaults.language = d.language; if (!LANGS.includes(d.language)) err('defaults.language', 'LANGUAGE_INVALID'); }
    if ('paymentTermsDays' in d) { out.defaults.paymentTermsDays = d.paymentTermsDays; if (!Number.isInteger(d.paymentTermsDays) || d.paymentTermsDays < 0 || d.paymentTermsDays > 365) err('defaults.paymentTermsDays', 'PAYMENT_TERMS_INVALID'); }
    if ('paymentTerms' in d) out.defaults.paymentTerms = sanitizeText(d.paymentTerms, 500);
  }
  if (src.numbering) {
    const n = src.numbering;
    for (const t of ['invoice', 'credit_note', 'quote']) {
      if (!n[t]) continue;
      if ('prefix' in n[t]) { out.numbering[t].prefix = sanitizeText(n[t].prefix, 8); if (!/^[A-Za-z0-9]{1,8}$/.test(out.numbering[t].prefix ?? '')) err(`numbering.${t}.prefix`, 'PREFIX_INVALID'); }
      if ('pad' in n[t]) { out.numbering[t].pad = n[t].pad; if (!Number.isInteger(n[t].pad) || n[t].pad < 1 || n[t].pad > 10) err(`numbering.${t}.pad`, 'PAD_INVALID'); }
    }
    if ('format' in n) {
      out.numbering.format = sanitizeText(n.format, 40);
      const f = out.numbering.format ?? '';
      const leftover = PLACEHOLDERS.reduce((s, p) => s.split(p).join(''), f);
      if (!f.includes('{seq}') || !/^[A-Za-z0-9\-_/.]*$/.test(leftover)) err('numbering.format', 'FORMAT_MUST_CONTAIN_SEQ_AND_ONLY_SAFE_CHARACTERS');
    }
  }
  if (src.branding) {
    const b = src.branding;
    if ('footer' in b) out.branding.footer = sanitizeText(b.footer, 500);
    if ('paymentInstructions' in b) out.branding.paymentInstructions = sanitizeText(b.paymentInstructions, 500);
    if ('accent' in b) { out.branding.accent = b.accent; if (!/^#[0-9a-fA-F]{6}$/.test(b.accent ?? '')) err('branding.accent', 'COLOUR_INVALID'); }
    if ('structuredCommunication' in b) out.branding.structuredCommunication = b.structuredCommunication === true;
    // logoPath is set ONLY by the logo upload endpoint, never accepted from the client (no arbitrary file reads).
  }
  if (src.companyLookup && 'provider' in src.companyLookup) { out.companyLookup.provider = src.companyLookup.provider; if (!PROVIDERS.includes(src.companyLookup.provider)) err('companyLookup.provider', 'PROVIDER_INVALID'); }
  if (src.stock && typeof src.stock === 'object') {
    if ('mode' in src.stock) { out.stock.mode = src.stock.mode; if (!['off', 'dry_run', 'live'].includes(src.stock.mode)) err('stock.mode', 'MODE_INVALID'); }
    if ('locationId' in src.stock) { out.stock.locationId = src.stock.locationId === '' ? null : src.stock.locationId; if (out.stock.locationId !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(String(out.stock.locationId))) err('stock.locationId', 'LOCATION_INVALID'); }
  }
  if (src.companySearch && 'registry' in src.companySearch) { out.companySearch.registry = src.companySearch.registry; if (!REGISTRY_PROVIDERS.includes(src.companySearch.registry)) err('companySearch.registry', 'PROVIDER_INVALID'); }
  if (src.companySearch && 'provider' in src.companySearch) { out.companySearch.provider = src.companySearch.provider; if (!SEARCH_PROVIDERS.includes(src.companySearch.provider)) err('companySearch.provider', 'PROVIDER_INVALID'); }
  if (src.peppol && 'defaultBuyerReference' in src.peppol) out.peppol.defaultBuyerReference = sanitizeText(src.peppol.defaultBuyerReference, 60);
  if (src.dashboard && 'dueSoonDays' in src.dashboard) { out.dashboard.dueSoonDays = src.dashboard.dueSoonDays; if (!Number.isInteger(src.dashboard.dueSoonDays) || src.dashboard.dueSoonDays < 1 || src.dashboard.dueSoonDays > 60) err('dashboard.dueSoonDays', 'DAYS_INVALID'); }
  return { settings: out, errors };
}

/** What still has to be filled before a real invoice can be issued. */
export function missingForInvoicing(settings) {
  const m = [];
  const s = settings.seller;
  for (const k of ['name', 'vatNumber', 'enterpriseNumber', 'iban', 'email']) if (!s[k]) m.push(`seller.${k}`);
  for (const k of ['street', 'postalCode', 'city', 'countryCode']) if (!s.address?.[k]) m.push(`seller.address.${k}`);
  if (!settings.vat.allowedRatesBp.length) m.push('vat.allowedRatesBp');
  return m;
}

export async function loadSettings(path = SETTINGS_PATH) {
  if (!existsSync(path)) return structuredClone(DEFAULT_SETTINGS);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  return merge(DEFAULT_SETTINGS, raw);
}

/** Atomic write (temp + rename); the previous file is kept as .bak so an edit can never silently destroy configuration. */
export async function saveSettings(settings, path = SETTINGS_PATH) {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) await writeFile(`${path}.bak`, await readFile(path));
  await writeFile(`${path}.tmp`, JSON.stringify(settings, null, 2));
  await rename(`${path}.tmp`, path);
}

/** Service configuration derived from settings. */
export function configFromSettings(settings, merchantId) {
  return { merchantId, seller: settings.seller, vat: settings.vat, defaults: settings.defaults, numbering: settings.numbering, linking: settings.linking };
}

/** Logo upload: PNG or JPEG data URL only, size-capped, verified by magic bytes. Returns { ext, bytes }. */
export function parseLogoDataUrl(dataUrl, maxBytes = 400 * 1024) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!m) return { error: 'LOGO_MUST_BE_A_PNG_OR_JPEG_DATA_URL' };
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length === 0 || bytes.length > maxBytes) return { error: 'LOGO_TOO_LARGE_OR_EMPTY' };
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if ((m[1] === 'png' && !png) || (m[1] === 'jpeg' && !jpg)) return { error: 'LOGO_CONTENT_DOES_NOT_MATCH_ITS_TYPE' };
  return { ext: m[1] === 'png' ? 'png' : 'jpg', bytes };
}
